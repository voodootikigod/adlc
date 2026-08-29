// Assembly of the autopilot extensions (issue-autopilot-local §6.4, §14; fleet
// ticket items 11–15) on top of the isolated modules: the bounded model-plane
// profile with its synthetic HOME (bounded-model-plane.mjs, synthetic-home.mjs),
// the egress allowlist (egress-proxy.mjs + egress-bridge.mjs) and the git mirror
// (git-mirror.mjs). live-deps.mjs calls these at its seams; every host
// primitive arrives through `io` so the composition is unit-testable.

import { join, dirname } from 'node:path';
import { realpathSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BoundedModelSandbox, checkReadSetInvariant, SYSTEM_ROOTS } from './bounded-model-plane.mjs';
import { prepareSyntheticHome } from './synthetic-home.mjs';
import { startEgressProxy, egressEnv, DEFAULT_BRIDGE_PORT } from './egress-proxy.mjs';
import {
  assertBareMirror, assertMirrorConfigPristine, ensureWorkerBranchInRepo, cutMirrorWorktree, fetchBackWorkerBranch, ensureGateWorktree, detachGateWorktree, removeMirrorWorktree, refreshMirrorTip, HOST_SAFE_GIT_FLAGS, worktreesHoldingBranch } from './git-mirror.mjs';
import * as worktrees from './worktrees.mjs';

export const BRIDGE_PATH = fileURLToPath(new URL('./egress-bridge.mjs', import.meta.url));

export class SandboxPolicyError extends Error {
  constructor(detail) { super(`sandbox-policy-mismatch: ${detail}`); this.code = 'sandbox-policy-mismatch'; }
}

const realpathSafe = (p) => { try { return realpathSync(p); } catch { return p; } };

/**
 * Build the BOUNDED model-plane sandbox for one dispatch (items 11, 13, 14).
 *
 * @returns {{ sandbox, description, egress }} — `egress` is null in open mode,
 *   else `{ proxy, port, socketPath, env }`; the caller closes `proxy` after the
 *   dispatch.
 */
/** Bounded mode is claude-code only: its synthetic-HOME contract (item 14) is that adapter's. */
export const BOUNDED_ADAPTERS = Object.freeze(['claude-code']);

export async function buildBoundedModelSandbox({ config, io, sandboxSpec, worktree, adapter, ticketId, extraWritable = [], nodePath = process.execPath, tmpRoot = io.env?.TMPDIR || tmpdir(), repo = null }) {
  const hostHome = io.env.HOME;
  if (!hostHome) throw new SandboxPolicyError('HOME is unset; the synthetic home cannot be staged');
  if (!BOUNDED_ADAPTERS.includes(adapter?.name)) {
    // Fail closed rather than stage the wrong harness's files: the staged
    // credential/settings layout is claude-code's, and another adapter would
    // start without its auth and fail in a way that looks like a model error.
    throw new SandboxPolicyError(`bounded model plane supports ${BOUNDED_ADAPTERS.join('/')} only (adapter ${adapter?.name ?? '?'}); its synthetic-HOME contract is adapter-specific`);
  }
  // EPHEMERAL staging, OUTSIDE the repository: the credential copy lives here
  // for exactly one dispatch and is removed by `cleanup()` on every exit path —
  // success, failure, or a policy error raised after staging (the finding that
  // motivated this: a deterministic copy under .adlc outlived the tmpfs it fed).
  const stagingDir = mkdtempSync(join(tmpRoot, 'fleet-home-'));
  // The staged credential must never sit where the worker can write: not under the
  // worktree, the repository, the mirror or any writable root (a TMPDIR pointing
  // into the worktree would hand the secret to the model plane) (codex r9).
  const forbidden = [worktree, repo, ...extraWritable, ...(config.modelPlaneWritable ?? [])].filter(Boolean).map((p) => realpathSafe(p));
  const stagingReal = realpathSafe(stagingDir);
  const inside = forbidden.find((root) => stagingReal === root || stagingReal.startsWith(`${root}/`));
  if (inside) { rmSync(stagingDir, { recursive: true, force: true }); throw new SandboxPolicyError(`credential staging directory ${stagingReal} lies under the writable root ${inside}; set TMPDIR outside the repository and every writable root`); }
  let proxy = null; let socketPath = null;
  const cleanup = async () => {
    if (proxy) { try { await proxy.close(); } catch { /* best effort */ } proxy = null; }
    if (socketPath) { try { rmSync(socketPath, { force: true }); } catch { /* best effort */ } }
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    const home = prepareSyntheticHome({ hostHome, stagingDir: join(stagingDir, 'home'), adapter, fs: io.homeFs, uid: io.uid });
    // The FIXED system roots (runtime libraries, TLS trust store, resolver files) are
    // always in the bounded read set when the host has them — a non-node adapter needs
    // the TLS/DNS files for any HTTPS at all, and an operator following the documented
    // `/usr,/lib,/lib64` example must not end up with a model plane that cannot
    // complete a handshake (codex r23 #2). `--model-plane-read-only` EXTENDS this set.
    const pathExists = io.pathExists ?? existsSync;
    const readOnlyPaths = dedupeList([...SYSTEM_ROOTS.filter((p) => pathExists(p)), ...(config.modelPlaneReadOnly ?? [])]);
    const writableRoots = [...extraWritable, ...(config.modelPlaneWritable ?? [])];
    let egress = null;
    if (config.modelPlaneEgress === 'allowlist') {
      const allowlist = [...(adapter.egressHosts ?? [])];
      if (allowlist.length === 0) throw new SandboxPolicyError(`adapter ${adapter.name} declares no egressHosts; allowlist mode has nothing to permit`);
      const socketDir = join(stagingDir, 'egress');
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      socketPath = join(socketDir, 'proxy.sock');
      rmSync(socketPath, { force: true }); // a stale socket from a crashed run would EADDRINUSE
      const start = io.startEgressProxy ?? startEgressProxy;
      proxy = await start({ socketPath, allowlist, log: (m) => io.log?.(`egress: ${typeof m === 'string' ? m : JSON.stringify(m)}`) });
      const port = config.egressBridgePort ?? DEFAULT_BRIDGE_PORT;
      egress = { proxy, port, socketPath, env: egressEnv(port), allowlist: [...proxy.allowlist] };
      writableRoots.push(socketDir);
      // The bridge must be visible inside: a single-file bind.
      readOnlyPaths.push(realpathSafe(BRIDGE_PATH));
    }
    // The node runtime is bound in EVERY bounded mode: a harness launcher that is
    // a node script needs its interpreter whether or not egress is bridged (codex r9).
    readOnlyPaths.push(realpathSafe(nodePath));
    // The adapter's own executable: resolved on the HOST search path to a single
    // regular file, bound read-only, and invoked by that absolute path inside.
    // The operator's --adapter-command override is the EFFECTIVE command (codex r10):
    // an absolute path must be a regular file outside the worktree/repository; a
    // bare name is resolved on the host search list.
    const command = config.adapterCommand ?? adapter.command ?? 'claude';
    const executable = command.startsWith('/') ? resolveAbsoluteExecutable(command, io) : (io.resolveExecutable ?? resolveExecutable)(command, io.env.PATH);
    if (!executable) throw new SandboxPolicyError(`adapter executable not found${command.startsWith('/') ? '' : ' on PATH'}: ${command}`);
    if ([worktree, repo].filter(Boolean).some((root) => executable === realpathSafe(root) || executable.startsWith(`${realpathSafe(root)}/`))) throw new SandboxPolicyError(`adapter executable ${executable} lies under the worktree or repository`);
    if (!readOnlyPaths.includes(executable)) readOnlyPaths.push(executable);
    // The documented DIRECTORY bindings: the npm/corepack trees of the node that runs
    // the worker (derived from its realpath) and any read-only entry that is such a
    // tree — everything else that is a non-system directory stays a violation (codex r8).
    const allowedDirs = dedupeList([...nodeToolTrees(nodePath), ...readOnlyPaths.filter((p) => NODE_TOOL_TREE_RE.test(p))]);
    const inv = checkReadSetInvariant({
      readOnlyPaths, writableRoots: [worktree, ...writableRoots], home: home.home,
      homeBinds: home.homeBinds, homeScratchDirs: home.homeScratchDirs, isFile: io.isFile ?? null, allowedDirs,
    });
    if (!inv.ok) throw new SandboxPolicyError(inv.violations.join('; '));
    const sandbox = new BoundedModelSandbox({
      backend: sandboxSpec.backend, worktree, writableRoots, readOnlyPaths,
      home: home.home, homeBinds: home.homeBinds, homeWritableFiles: home.homeWritableFiles, homeScratchDirs: home.homeScratchDirs,
      unshareNet: egress !== null, isFile: io.isFile, commandMap: { [command]: executable },
      exec: async (argv, opts) => io.spawnWorker(argv[0], argv.slice(1), opts),
    });
    const description = { ...sandbox.describe(), egressAllowlist: egress?.allowlist ?? [], credentialSha256: home.credentialSha256, adapterExecutable: executable };
    return { sandbox, description, egress, stagingDir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export const NODE_TOOL_TREE_RE = /\/lib\/node_modules\/(npm|corepack)$/;
const dedupeList = (xs) => [...new Set(xs)];
/** `<prefix>/lib/node_modules/{npm,corepack}` next to a node realpath, when present. */
export function nodeToolTrees(nodePath) {
  let real; try { real = realpathSync(nodePath); } catch { return []; }
  const prefix = join(real, '..', '..');
  return ['npm', 'corepack'].map((t) => join(prefix, 'lib', 'node_modules', t)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** An absolute adapter command → its realpath when it is a regular file; null otherwise (injectable through io.resolveExecutable). */
export function resolveAbsoluteExecutable(command, io) {
  if (typeof io?.resolveExecutable === 'function') return io.resolveExecutable(command);
  try { const real = realpathSync(command); return statSync(real).isFile() ? real : null; } catch { return null; }
}

/** The first regular file named `command` on the host search list, as a realpath; null when absent. */
export function resolveExecutable(command, pathValue) {
  if (typeof command !== 'string' || command.includes('/')) return null;
  for (const dir of String(pathValue ?? '').split(':')) {
    if (!dir || !dir.startsWith('/')) continue;
    const candidate = join(dir, command);
    try { const real = realpathSync(candidate); if (statSync(real).isFile()) return real; } catch { /* next */ }
  }
  return null;
}

/** Wrap the worker argv in the in-sandbox bridge and add the proxy env (item 13). */
export function bridgeArgv({ egress, nodePath = process.execPath, argv }) {
  if (!egress) return argv;
  return [nodePath, BRIDGE_PATH, '--socket', egress.socketPath, '--port', String(egress.port), '--', ...argv];
}

/** Cut the worker's worktree from the MIRROR (item 12) and reset fleet's own branch in the caller repo. */
export function mirrorCreateWorktree({ repo, ticketId, integrationBranch, mirror, repoGit, gitAt }) {
  const id = String(ticketId).toLowerCase();
  const workerBranch = `fleet/${id}`;
  const path = join(repo, '.worktrees', `fleet-${id}`);
  const gatePath = join(repo, '.worktrees', `fleet-${id}-gate`);
  const startSha = repoGit('rev-parse', integrationBranch);
  const { baseBranch, branches } = assertBareMirror({ mirror, gitAt });
  // The worker gets the mirror read-write: OTHER tickets' `fleet/*` branches (already fetched back
  // into the caller repository) are dropped from it first, so the worker sees only the base branch
  // and its own branch (codex r19 #3).
  let dropped = 0;
  for (const b of branches) if (b.startsWith('fleet/') && b !== workerBranch) { try { gitAt(mirror)('update-ref', '-d', `refs/heads/${b}`); dropped++; } catch { /* already gone */ } }
  // Their OBJECTS are pruned too (codex r22 #1): a dropped ref still leaves the sibling's work
  // readable by hash otherwise. Host-safe overrides, on a mirror the pristine check just passed.
  if (dropped > 0) {
    try { gitAt(mirror)(...HOST_SAFE_GIT_FLAGS, 'reflog', 'expire', '--expire-unreachable=now', '--all'); } catch { /* no reflogs in a bare mirror */ }
    gitAt(mirror)(...HOST_SAFE_GIT_FLAGS, 'gc', '--prune=now', '--quiet');
  }
  // A later ticket cuts from the ADVANCED integration tip: bring it into the mirror first (codex r8).
  refreshMirrorTip({ mirror, repo, baseBranch, sourceRef: integrationBranch, tip: startSha, gitAt });
  // fleet's own worker branch in the caller repo: detach any gate worktree that
  // has it checked out, then point it at the cut tip (this run's baseline for
  // the compare-and-swap) — never a human's branch, always `fleet/<id>`.
  detachGateWorktree({ path: gatePath, gitAt });
  const existing = ensureWorkerBranchInRepo({ repo, workerBranch, cutTip: startSha, gitAt });
  if (!existing.created && existing.sha !== startSha) {
    // The gate worktree was detached above; ANY other worktree holding the branch (a human
    // recovery checkout, a stale one) must not have its pointer moved underneath it (codex r24 #3).
    const holders = worktreesHoldingBranch({ repo, branch: workerBranch, except: gatePath, gitAt });
    if (holders.length) throw new Error(`worker branch ${workerBranch} is checked out in ${holders.join(', ')}; refusing to move it — remove or detach that worktree first`);
    repoGit('update-ref', `refs/heads/${workerBranch}`, startSha, existing.sha);
  }
  cutMirrorWorktree({ mirror, workerBranch, path, cutTip: startSha, gitAt });
  return { path, branch: workerBranch, startSha, gatePath, mirror, cutTip: startSha };
}

/**
 * After the worker commits in the mirror: bring the branch back by CAS and
 * refresh the gate worktree. Returns { ok, sha } or { ok:false, reason, detail }.
 */
export function mirrorFetchBack({ repo, mirror, workerBranch, cutTip, gatePath, gitAt }) {
  // The worker had read-write access to the mirror: its config/hooks are re-checked BEFORE the
  // host runs any git against it (codex r14 #1). A poisoned mirror is a terminal fetch failure.
  try { assertMirrorConfigPristine({ mirror, gitAt }); }
  catch (e) { return { ok: false, reason: 'mirror-fetch-failed', step: 'mirror-pristine', detail: e.message }; }
  detachGateWorktree({ path: gatePath, gitAt });
  const fb = fetchBackWorkerBranch({ repo, mirror, workerBranch, cutTip, gitAt });
  if (!fb.ok) return fb;
  // The gate worktree must attach for the swap to stand (codex r13 #1): a failure here rolls
  // the branch ref back to `cutTip` (reverse compare-and-swap) so `ok:false ⇒ ref untouched`
  // holds and the next strike's CAS against the recorded cut tip still matches.
  try { ensureGateWorktree({ repo, path: gatePath, workerBranch, gitAt }); }
  catch (e) {
    let rollback = 'branch rolled back to the cut tip';
    try { gitAt(repo)('update-ref', `refs/heads/${workerBranch}`, cutTip, fb.sha); }
    catch (r) { rollback = `ROLLBACK FAILED (${r.message}); branch left at ${fb.sha}`; }
    return { ok: false, reason: 'mirror-fetch-failed', step: 'gate-worktree', detail: `gate-worktree: ${e.message}; ${rollback}` };
  }
  return fb;
}

export function mirrorCleanup({ repo, mirror, path, gatePath, repoGit, gitAt }) {
  // Never run git inside a poisoned mirror, even to clean up: drop the worktree directory only.
  let pristine = true;
  try { assertMirrorConfigPristine({ mirror, gitAt }); } catch { pristine = false; }
  if (pristine) removeMirrorWorktree({ mirror, path, gitAt });
  else if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  if (existsSync(gatePath)) worktrees.removeWorktree(repo, gatePath, repoGit);
  worktrees.pruneWorktrees(repo, repoGit);
}

/** The policy echo when nothing has been dispatched yet (config-derived). */
export function policyFromConfig(config) {
  return {
    readPolicy: config.modelPlaneRead ?? 'host',
    privateTmp: config.modelPlaneRead === 'bounded',
    gitSource: config.modelPlaneGit ?? 'shared',
    mirror: config.modelPlaneGitMirror ?? null,
    egress: config.modelPlaneEgress ?? 'open',
    egressAllowlist: [],
    homeBinds: [],
    writableRoots: [],
  };
}

export { dirname };
