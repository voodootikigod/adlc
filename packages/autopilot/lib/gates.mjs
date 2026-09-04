// The final local gates (spec §6.6; AC 20, 122, 135, 141, 149, 157).
//
// The SAME gate sequence `scripts/preflight.mjs` runs in CI order, invoked gate
// by gate by the orchestrator with the pinned script's `buildGates()` list as
// the normative ORDER (`preflight-order-drift` otherwise). Every gate runs
// inside fleet's repo-command-plane sandbox — network DENIED, reads bounded to
// the clone + the read-only dependency tree + pinned tool files + system roots,
// writes bounded to the clone and a private tmpfs, a synthetic empty HOME, an
// env without SSH_AUTH_SOCK / GH_TOKEN / GITHUB_TOKEN / ADLC_MANIFEST_KEY —
// with cwd = its OWN fresh clone of the gate mirror, snapshotted before and
// re-verified after (`gate-repo-moved` discards the verdict).
//
// Composition note: fleet's bounded `Sandbox.wrap` (a frozen rail) emits no
// `/dev` and can only bind a path at its own location. git cannot run without
// `/dev/null`, and the dependency tree must appear at `<clone>/node_modules`
// (workspace links are relative, so they resolve INSIDE the clone). Those
// three bwrap arguments are spliced into the wrapped argv here, before the
// `--` separator, after fleet's own binds (a later bind shadows an earlier one).

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Sandbox, NETWORK, READ_POLICY, SANDBOX_MODES, detectBackend } from '@adlc/fleet/lib/sandbox.mjs';
import { repoCommandEnv } from '@adlc/fleet/lib/env-scrub.mjs';
import { SYSTEM_ROOTS } from '@adlc/fleet/lib/bounded-model-plane.mjs';
import { validateIssueNumber, validateOid } from './input.mjs';
import { childEnv } from './keys.mjs';
import { pinnedRealpaths } from './tools.mjs';
import { DEADLINES } from './spawn.mjs';
import { cloneGateRepo } from './mirror.mjs';
import { snapshotGateRepo, compareSnapshots, cloneSanity, GateRepoError, gitMetadataUnchanged } from './gate-repo.mjs';
import { registerSeams, active } from './mutations.mjs';

export { ensureTrackingRef, releaseTrackingRef, trackingRef, ZERO_OID } from './gate-repo.mjs';

registerSeams([
  'gates.ignoreOrder',          // a preflight list that differs from EXPECTED_GATES passes
  'gates.spawnPreflightAlways', // scripts/preflight.mjs is spawned even without the R13 flags
  'gates.reuseClone',           // every gate runs in the FIRST gate's clone
  'gates.allowNetwork',         // the sandbox profile allows egress
  'gates.skipBracket',          // the remote-URL / base-object bracket is not checked
  'gates.skipDepsBind',         // the node_modules bind is omitted,
  'gates.gitBeforeMetadataCheck',
]);

export class GatesError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'GatesError'; this.code = code; this.exitCode = 2; }
}

export const BASE_TOKEN = 'origin/{base}';

/** The gate list this orchestrator knows how to run — the pinned preflight.mjs must equal it. */
export const EXPECTED_GATES = Object.freeze([
  { name: 'tests', argv: ['node', 'scripts/run-tests.mjs'] },
  { name: 'rail-freeze', argv: ['node', 'scripts/rails-guard-ci.mjs', BASE_TOKEN] },
  { name: 'mutation-gate', argv: ['node', 'scripts/mutation-gate.mjs', BASE_TOKEN, '--max', '12'] },
  { name: 'findings-ledger', argv: ['node', 'scripts/scan-findings-ledger.mjs'] },
  { name: 'findings-append-only', argv: ['node', 'scripts/guard-findings-ledger-append-only.mjs', BASE_TOKEN] },
  { name: 'reviewer-directed-comments', argv: ['node', 'scripts/check-reviewer-directed-comments.mjs', BASE_TOKEN] },
].map(Object.freeze));

/** Parse `buildGates()` from the pinned script TEXT → [{ name, argv }] with `origin/{base}` for the template. */
export function gateOrderFromPreflight(scriptText) {
  const text = String(scriptText ?? '');
  const fn = text.indexOf('function buildGates(');
  const start = fn === -1 ? -1 : text.indexOf('return [', fn);
  if (start === -1) throw new GatesError('preflight-unparseable', 'no buildGates() return list');
  let depth = 0; let end = -1;
  for (let i = start + 'return '.length; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new GatesError('preflight-unparseable', 'unbalanced gate list');
  const body = text.slice(start, end + 1);
  const gates = [];
  const entry = /name:\s*'([^']+)'[\s\S]*?argv:\s*\[\s*'([^']+)'\s*,\s*\[([\s\S]*?)\]\s*\]/g;
  for (const m of body.matchAll(entry)) {
    const args = [...m[3].matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((t) => (t[1] ?? t[2] ?? t[3]).replace(/\$\{base\}/g, '{base}'));
    gates.push({ name: m[1], argv: [m[2], ...args] });
  }
  if (gates.length === 0) throw new GatesError('preflight-unparseable', 'no gates parsed');
  return gates;
}

/** The parsed order must equal EXPECTED_GATES exactly (names and argv, in sequence). */
export function checkGateOrder(parsed, expected = EXPECTED_GATES) {
  if (active('gates.ignoreOrder')) return { ok: true, code: null, detail: null };
  const same = parsed.length === expected.length && parsed.every((g, i) => g.name === expected[i].name && JSON.stringify(g.argv) === JSON.stringify(expected[i].argv));
  return same ? { ok: true, code: null, detail: null } : { ok: false, code: 'preflight-order-drift', detail: `pinned: ${parsed.map((g) => g.name).join(' → ')}; expected: ${expected.map((g) => g.name).join(' → ')}` };
}

/** R13: the script can be the runner only once it carries BOTH flags. */
export const r13Present = (scriptText) => String(scriptText ?? '').includes('--no-fetch') && String(scriptText ?? '').includes('--sandboxed');

/** The concrete argv of one gate: pinned node, `origin/{base}` → `refs/remotes/origin/<oid>`. */
export function gateArgvFor(gate, { node, baseOid }) {
  validateOid(baseOid);
  const [cmd, ...args] = gate.argv;
  if (cmd !== 'node') throw new GatesError('preflight-order-drift', `gate ${gate.name} is not a node script`);
  return [node, ...args.map((a) => (a === BASE_TOKEN ? `refs/remotes/origin/${baseOid}` : a))];
}

/** READ_SET of a gate: the fixed system roots, /bin, each pinned executable's realpath (FILE binds) and the npm/corepack trees. */
export function gateReadOnlyPaths(ctx) {
  const node = ctx.pinned['node:realpath'] ?? ctx.pinned.node;
  const prefix = dirname(dirname(node));
  const candidates = [...SYSTEM_ROOTS, '/bin', ...pinnedRealpaths(ctx.pinned), join(prefix, 'lib', 'node_modules', 'npm'), join(prefix, 'lib', 'node_modules', 'corepack')];
  const out = [];
  for (const p of candidates) {
    if (!existsSync(p) || out.includes(p)) continue;
    if (SYSTEM_ROOTS.some((r) => r !== p && p.startsWith(r + '/'))) continue;
    out.push(p);
  }
  return out;
}

/** Splice the composition arguments (see the header) into fleet's wrapped argv, pinning bwrap. */
export function composeGateArgv({ wrapped, inner, bwrap, clone, nodeModules, bindDeps = true }) {
  const sep = wrapped.length - inner.length - 1;
  const chdir = wrapped.indexOf('--chdir');
  if (wrapped[sep] !== '--' || chdir === -1 || chdir + 1 >= sep) throw new GatesError('sandbox-unavailable', 'unexpected sandbox argv shape');
  // /dev and the private tmpfs go BEFORE fleet's binds: a later mount shadows an
  // earlier one, so a tmpfs mounted after the clone bind would hide a clone that
  // lives under /tmp. The dependency bind goes AFTER them, layered over the clone.
  const early = ['--dev', '/dev', '--tmpfs', '/tmp', '--setenv', 'TMPDIR', '/tmp'];
  const late = bindDeps && !active('gates.skipDepsBind') ? ['--ro-bind', nodeModules, join(clone, 'node_modules')] : [];
  return [bwrap, ...wrapped.slice(1, chdir + 2), ...early, ...wrapped.slice(chdir + 2, sep), ...late, ...wrapped.slice(sep)];
}

const FORBIDDEN_ENV = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'ADLC_MANIFEST_KEY'];

/** The gate's environment: fleet's repo-command scrub over the sanitized base, synthetic HOME, private TMPDIR. */
export function gateEnv(ctx, home) {
  const env = { ...repoCommandEnv(childEnv(ctx.env.base), { syntheticHome: home }), TMPDIR: '/tmp' };
  for (const k of FORBIDDEN_ENV) delete env[k];
  return env;
}

/** Spawn `inner` inside the repo-command-plane sandbox with cwd = clone. Exported for the probe tests of AC 149/157. */
export async function spawnInGateSandbox({ ctx, clone, inner, nodeModules, backend, home, label, deadlineMs = DEADLINES.preflightScript, bindDeps = true }) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const sandbox = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX, backend, worktree: clone, syntheticHome: home,
    readOnlyPaths: gateReadOnlyPaths(ctx), network: active('gates.allowNetwork') ? NETWORK.ALLOW : NETWORK.DENY, readPolicy: READ_POLICY.BOUNDED,
  });
  const argv = composeGateArgv({ wrapped: sandbox.wrap(inner), inner, bwrap: ctx.pinned.bwrap, clone, nodeModules, bindDeps });
  return ctx.spawn({ argv, cwd: clone, env: gateEnv(ctx, home), deadlineMs, label });
}

async function bracket(ctx, baseOid) {
  if (active('gates.skipBracket')) return null;
  const obj = await ctx.git.local(ctx.repoRoot, ['cat-file', '-e', `${baseOid}^{commit}`]);
  return { url: await ctx.git.observe('remote.origin.url'), pushUrl: await ctx.git.observe('remote.origin.pushurl'), objectOk: obj.status === 0 };
}
function bracketDrift(before, after) {
  if (!before || !after) return null;
  if (before.url !== after.url || before.pushUrl !== after.pushUrl) return 'remote-url-changed';
  if (!before.objectOk || !after.objectOk) return 'base-object-missing';
  return null;
}
const tail = (ctx, text) => { const t = String(text ?? '').slice(-64 * 1024); const r = ctx.redactor?.redact(t); return r ? r.text : t; };

/**
 * Run the outer gate sequence against attestedHead. Never throws for a gate
 * verdict; returns { ok, code, gate?, reason?, gates: [...], head }.
 */
export async function runOuterGates({ ctx, issue, attestedHead, baseOid, gateDepsNodeModules, backend = detectBackend(), scriptText = null }) {
  const n = validateIssueNumber(issue); validateOid(attestedHead); validateOid(baseOid);
  const text = scriptText ?? await ctx.git.localOut(ctx.repoRoot, ['show', `${baseOid}:scripts/preflight.mjs`]);
  const order = checkGateOrder(gateOrderFromPreflight(text));
  if (!order.ok) return { ok: false, code: order.code, detail: order.detail, gates: [], head: attestedHead };
  if (!backend) return { ok: false, code: 'sandbox-unavailable', gates: [], head: attestedHead };
  const bindDeps = !active('gates.skipDepsBind');
  if (bindDeps && !(gateDepsNodeModules && existsSync(gateDepsNodeModules) && statSync(gateDepsNodeModules).isDirectory())) {
    return { ok: false, code: 'gate-deps-missing', gates: [], head: attestedHead };
  }
  const runDir = ctx.paths.runDir(n);
  const sequence = (r13Present(text) || active('gates.spawnPreflightAlways'))
    ? [{ name: 'preflight', argv: [ctx.pinned.node, 'scripts/preflight.mjs', '--no-fetch', '--sandboxed', '--base-oid', baseOid] }]
    : gateOrderFromPreflight(text).map((g) => ({ name: g.name, argv: gateArgvFor(g, { node: ctx.pinned.node, baseOid }) }));
  const before = await bracket(ctx, baseOid);
  const results = [];
  let reused = null;
  for (const [k, gate] of sequence.entries()) {
    const clone = reused ?? await cloneGateRepo({ ctx, issue: n, k, attestedHead, baseOid });
    if (active('gates.reuseClone')) reused = clone;
    const home = join(runDir, `gate-home-${k}`);
    try {
      const snapBefore = await snapshotGateRepo({ ctx, cwd: clone, baseOid });
      const sanity = cloneSanity(snapBefore, { attestedHead, baseOid });
      if (sanity) return { ok: false, code: 'gate-repo-stale', gate: gate.name, reason: sanity, gates: results, head: attestedHead };
      const r = await spawnInGateSandbox({ ctx, clone, inner: gate.argv, nodeModules: gateDepsNodeModules, backend, home, label: `gate:${gate.name}`, bindDeps });
      // File-level metadata check FIRST (no git process): a gate that touched .git/config or the hooks
      // is refused before the host runs any git inside that clone. Seam `gates.gitBeforeMetadataCheck`.
      const meta = active('gates.gitBeforeMetadataCheck') ? null : gitMetadataUnchanged(snapBefore, clone);
      if (meta) return { ok: false, code: 'gate-repo-moved', gate: gate.name, reason: meta, gates: results, head: attestedHead };
      const cmp = compareSnapshots(snapBefore, await snapshotGateRepo({ ctx, cwd: clone, baseOid }));
      if (!cmp.same) return { ok: false, code: 'gate-repo-moved', gate: gate.name, reason: cmp.reason, gates: results, head: attestedHead };
      results.push({ name: gate.name, clone, status: r.status, timedOut: r.timedOut, output: tail(ctx, `${r.stdout}\n${r.stderr}`) });
      if (r.status !== 0) return { ok: false, code: 'gate-failed', gate: gate.name, status: r.status, reason: r.reason, gates: results, head: attestedHead };
    } finally {
      if (!reused) rmSync(clone, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
  if (reused) rmSync(reused, { recursive: true, force: true });
  const drift = bracketDrift(before, await bracket(ctx, baseOid));
  if (drift) return { ok: false, code: drift, gates: results, head: attestedHead };
  return { ok: true, code: null, gates: results, head: attestedHead };
}

export { GateRepoError };
