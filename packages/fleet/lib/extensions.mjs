// Assembly of the autopilot extensions (issue-autopilot-local §6.4, §14; fleet
// ticket items 11–15) on top of the isolated modules: the bounded model-plane
// profile with its synthetic HOME (bounded-model-plane.mjs, synthetic-home.mjs),
// the egress allowlist (egress-proxy.mjs + egress-bridge.mjs) and the git mirror
// (git-mirror.mjs). live-deps.mjs calls these at its seams; every host
// primitive arrives through `io` so the composition is unit-testable.

import { join, dirname } from 'node:path';
import { realpathSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BoundedModelSandbox, checkReadSetInvariant } from './bounded-model-plane.mjs';
import { prepareSyntheticHome } from './synthetic-home.mjs';
import { startEgressProxy, egressEnv, DEFAULT_BRIDGE_PORT } from './egress-proxy.mjs';
import {
  assertBareMirror, ensureWorkerBranchInRepo, cutMirrorWorktree, fetchBackWorkerBranch, ensureGateWorktree,
  detachGateWorktree, removeMirrorWorktree,
} from './git-mirror.mjs';
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
export async function buildBoundedModelSandbox({ config, io, sandboxSpec, worktree, adapter, ticketId, statusDir, extraWritable = [], nodePath = process.execPath }) {
  const hostHome = io.env.HOME;
  if (!hostHome) throw new SandboxPolicyError('HOME is unset; the synthetic home cannot be staged');
  const stagingDir = join(statusDir, 'fleet-home', String(ticketId).toLowerCase());
  const home = prepareSyntheticHome({ hostHome, stagingDir, adapter, fs: io.homeFs, uid: io.uid });

  const readOnlyPaths = [...(config.modelPlaneReadOnly ?? [])];
  const writableRoots = [...extraWritable, ...(config.modelPlaneWritable ?? [])];
  let egress = null;
  if (config.modelPlaneEgress === 'allowlist') {
    const allowlist = [...(adapter.egressHosts ?? [])];
    if (allowlist.length === 0) throw new SandboxPolicyError(`adapter ${adapter.name} declares no egressHosts; allowlist mode has nothing to permit`);
    const socketDir = join(statusDir, 'fleet-egress', String(ticketId).toLowerCase());
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const socketPath = join(socketDir, 'proxy.sock');
    const start = io.startEgressProxy ?? startEgressProxy;
    const proxy = await start({ socketPath, allowlist, log: (m) => io.log?.(`egress: ${typeof m === 'string' ? m : JSON.stringify(m)}`) });
    const port = config.egressBridgePort ?? DEFAULT_BRIDGE_PORT;
    egress = { proxy, port, socketPath, env: egressEnv(port), allowlist: [...proxy.allowlist] };
    writableRoots.push(socketDir);
    // The bridge and the node that runs it must be visible inside: single-file binds.
    readOnlyPaths.push(realpathSafe(nodePath), realpathSafe(BRIDGE_PATH));
  }
  const inv = checkReadSetInvariant({
    readOnlyPaths, writableRoots: [worktree, ...writableRoots], home: home.home,
    homeBinds: home.homeBinds, homeScratchDirs: home.homeScratchDirs, isFile: io.isFile ?? null,
  });
  if (!inv.ok) throw new SandboxPolicyError(inv.violations.join('; '));
  const sandbox = new BoundedModelSandbox({
    backend: sandboxSpec.backend, worktree, writableRoots, readOnlyPaths,
    home: home.home, homeBinds: home.homeBinds, homeWritableFiles: home.homeWritableFiles, homeScratchDirs: home.homeScratchDirs,
    unshareNet: egress !== null, isFile: io.isFile,
    exec: async (argv, opts) => io.spawnWorker(argv[0], argv.slice(1), opts),
  });
  const description = { ...sandbox.describe(), egressAllowlist: egress?.allowlist ?? [], credentialSha256: home.credentialSha256 };
  return { sandbox, description, egress };
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
  assertBareMirror({ mirror, gitAt });
  // fleet's own worker branch in the caller repo: detach any gate worktree that
  // has it checked out, then point it at the cut tip (this run's baseline for
  // the compare-and-swap) — never a human's branch, always `fleet/<id>`.
  detachGateWorktree({ path: gatePath, gitAt });
  const existing = ensureWorkerBranchInRepo({ repo, workerBranch, cutTip: startSha, gitAt });
  if (!existing.created && existing.sha !== startSha) repoGit('update-ref', `refs/heads/${workerBranch}`, startSha, existing.sha);
  cutMirrorWorktree({ mirror, workerBranch, path, cutTip: startSha, gitAt });
  return { path, branch: workerBranch, startSha, gatePath, mirror, cutTip: startSha };
}

/**
 * After the worker commits in the mirror: bring the branch back by CAS and
 * refresh the gate worktree. Returns { ok, sha } or { ok:false, reason, detail }.
 */
export function mirrorFetchBack({ repo, mirror, workerBranch, cutTip, gatePath, gitAt }) {
  detachGateWorktree({ path: gatePath, gitAt });
  const fb = fetchBackWorkerBranch({ repo, mirror, workerBranch, cutTip, gitAt });
  if (!fb.ok) return fb;
  ensureGateWorktree({ repo, path: gatePath, workerBranch, gitAt });
  return fb;
}

export function mirrorCleanup({ repo, mirror, path, gatePath, repoGit, gitAt }) {
  removeMirrorWorktree({ mirror, path, gitAt });
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
