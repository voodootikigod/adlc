// The two bare mirrors of a run and the per-gate clone (spec §6.4 (b) and the
// gate-mirror bullet, §6.6; AC 84, 94, 106, 161).
//
//   WORKER mirror  <run dir>/mirror.git — the model plane's ONLY git view: a
//                  bare single-branch clone holding exactly the objects
//                  reachable from BASE_OID and the issue branch, no remote,
//                  no non-core config, no hooks. rm -rf'd and recreated before
//                  every dispatch; never read by any gate.
//   GATE mirror    <run dir>/gate.git — created AFTER the last orchestrator
//                  commit by a LOCAL push of exactly two tips
//                  (attestedHead, BASE_OID); every GATE_REPO-<k> is a
//                  throwaway clone of it.
// Fetch-back (§6.4 "After the worker exits") is stated here as the explicit
// four-step sequence so its failure mode (`mirror-fetch-failed`, ref untouched,
// temp ref deleted) has one implementation.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { branchFor, validateIssueNumber, validateOid } from './input.mjs';
import { ensureTrackingRef } from './gate-repo.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'mirror.cloneTags',         // the worker mirror clone fetches the tags reachable from the branch (agy r3)
  'mirror.keepRemote',        // the clone's remote.* / non-core config is left in place
  'mirror.keepStale',         // an existing mirror is reused instead of recreated
  'mirror.skipVerify',        // the gate mirror is not verified (tips, ref set, object set)
  'mirror.skipAncestorCheck', // fetch-back skips `merge-base --is-ancestor`
]);

export class MirrorError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'MirrorError'; this.code = code; this.exitCode = 2; }
}

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

async function must(ctx, cwd, args, code) {
  const r = await ctx.git.local(cwd, args);
  if (r.status !== 0) throw new MirrorError(code, `git ${args.filter((a) => !a.startsWith('-c') && a !== 'core.hooksPath=/dev/null')[0]}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Every configured key outside `core.*` is removed (remote URL, credential helper, branch tracking, ...). */
export async function unsetNonCoreConfig({ ctx, dir }) {
  const list = await ctx.git.local(dir, ['config', '--list', '--local', '--name-only']);
  const keys = [...new Set(list.stdout.split('\n').map((l) => l.trim()).filter((k) => k && !k.startsWith('core.')))];
  for (const key of keys) await must(ctx, dir, ['config', '--unset-all', key], 'mirror-config');
  return keys;
}

/** A clone/init copies the template's executable `*.sample` hooks; a mirror has none. */
export function emptyHooks(gitDir) {
  const hooks = join(gitDir, 'hooks');
  rmSync(hooks, { recursive: true, force: true });
  mkdirSync(hooks, { recursive: true });
}

/** The sorted set of object ids reachable from `revs` (commits, trees, blobs). */
export async function objectSet({ ctx, cwd, revs }) {
  const out = await must(ctx, cwd, ['rev-list', '--objects', ...revs], 'mirror-rev-list');
  return [...new Set(out.split('\n').filter(Boolean).map((l) => l.split(' ')[0]))].sort();
}

async function verifyObjectSet({ ctx, mirror, tips, code }) {
  const inMirror = await objectSet({ ctx, cwd: mirror, revs: ['--all'] });
  const expected = await objectSet({ ctx, cwd: ctx.repoRoot, revs: tips });
  if (JSON.stringify(inMirror) !== JSON.stringify(expected)) throw new MirrorError(code, `mirror holds ${inMirror.length} objects, expected ${expected.length}`);
}

async function refNames({ ctx, cwd }) {
  return (await must(ctx, cwd, ['for-each-ref', '--format=%(refname)'], 'mirror-refs')).split('\n').filter(Boolean).sort();
}

/** §6.4 (b): the worker mirror, recreated under the lock before every dispatch. */
export async function createWorkerMirror({ ctx, issue }) {
  const n = validateIssueNumber(issue);
  const baseOid = validateOid(ctx.baseOid);
  const branch = branchFor(n);
  const mirror = ctx.paths.mirror(n);
  if (existsSync(mirror)) {
    if (active('mirror.keepStale')) return mirror;
    rmSync(mirror, { recursive: true, force: true });
  }
  mkdirSync(ctx.paths.runDir(n), { recursive: true });
  // `--no-tags`: a single-branch clone still fetches every tag reachable from the branch, and this
  // repository carries release tags on main — the exact-ref check below would refuse every mirror
  // (agy r3 c5). Mutation seam `mirror.cloneTags`: tags come along.
  await must(ctx, ctx.repoRoot, [...NO_HOOKS, 'clone', '-q', '--bare', '--no-local', '--single-branch', ...(active('mirror.cloneTags') ? [] : ['--no-tags']), '--branch', branch, ctx.repoRoot, mirror], 'mirror-clone-failed');
  if (!active('mirror.keepRemote')) {
    await must(ctx, mirror, ['remote', 'remove', 'origin'], 'mirror-config');
    await unsetNonCoreConfig({ ctx, dir: mirror });
  }
  emptyHooks(mirror);
  const refs = await refNames({ ctx, cwd: mirror });
  if (JSON.stringify(refs) !== JSON.stringify([`refs/heads/${branch}`])) throw new MirrorError('mirror-invalid', `refs: ${refs.join(', ')}`);
  await verifyObjectSet({ ctx, mirror, tips: [baseOid, `refs/heads/${branch}`], code: 'mirror-stale' });
  return mirror;
}

/** The gate mirror must hold exactly attestedHead and BASE_OID and nothing else (`gate-mirror-stale`). */
export async function verifyGateMirror({ ctx, issue, attestedHead, baseOid }) {
  const n = validateIssueNumber(issue); validateOid(attestedHead); validateOid(baseOid);
  const gate = ctx.paths.gateMirror(n);
  const branchRef = `refs/heads/${branchFor(n)}`; const baseRef = `refs/remotes/origin/${baseOid}`;
  if (!existsSync(gate)) throw new MirrorError('gate-mirror-stale', 'gate mirror missing');
  if (active('mirror.skipVerify')) return gate;
  const tip = await ctx.git.local(gate, ['rev-parse', '--verify', '--quiet', branchRef]);
  if (tip.status !== 0 || tip.stdout.trim() !== attestedHead) throw new MirrorError('gate-mirror-stale', `${branchRef} is ${tip.stdout.trim() || 'absent'}, not ${attestedHead}`);
  const base = await ctx.git.local(gate, ['rev-parse', '--verify', '--quiet', baseRef]);
  if (base.status !== 0 || base.stdout.trim() !== baseOid) throw new MirrorError('gate-mirror-stale', `${baseRef} is ${base.stdout.trim() || 'absent'}`);
  const refs = await refNames({ ctx, cwd: gate });
  if (JSON.stringify(refs) !== JSON.stringify([branchRef, baseRef].sort())) throw new MirrorError('gate-mirror-stale', `refs: ${refs.join(', ')}`);
  await verifyObjectSet({ ctx, mirror: gate, tips: [attestedHead, baseOid], code: 'gate-mirror-stale' });
  return gate;
}

/** §6.4 gate-mirror bullet: empty bare repository + a LOCAL push of exactly the two tips. */
export async function createGateMirror({ ctx, issue, attestedHead, baseOid }) {
  const n = validateIssueNumber(issue); validateOid(attestedHead); validateOid(baseOid);
  const gate = ctx.paths.gateMirror(n);
  rmSync(gate, { recursive: true, force: true });
  mkdirSync(ctx.paths.runDir(n), { recursive: true });
  await must(ctx, ctx.paths.runDir(n), ['init', '-q', '--bare', gate], 'gate-mirror-init');
  emptyHooks(gate);
  await must(ctx, ctx.repoRoot, [...NO_HOOKS, 'push', '-q', gate, `${attestedHead}:refs/heads/${branchFor(n)}`, `${baseOid}:refs/remotes/origin/${baseOid}`], 'gate-mirror-push');
  await verifyGateMirror({ ctx, issue: n, attestedHead, baseOid });
  return gate;
}

/** §6.6: GATE_REPO-<k>, a throwaway single-branch clone of the gate mirror at attestedHead with the tracking ref inside. */
export async function cloneGateRepo({ ctx, issue, k, attestedHead, baseOid }) {
  const n = validateIssueNumber(issue);
  if (!Number.isInteger(k) || k < 0) throw new TypeError('k must be a non-negative integer');
  const gate = await verifyGateMirror({ ctx, issue: n, attestedHead, baseOid });
  const runDir = ctx.paths.runDir(n);
  const path = join(runDir, `gate-repo-${k}`);
  rmSync(path, { recursive: true, force: true });
  await must(ctx, runDir, [...NO_HOOKS, 'clone', '-q', '--no-hardlinks', '--single-branch', '--no-tags', '--branch', branchFor(n), gate, path], 'gate-repo-clone');
  await must(ctx, path, ['remote', 'remove', 'origin'], 'gate-repo-config');
  await unsetNonCoreConfig({ ctx, dir: path });
  emptyHooks(join(path, '.git'));
  await ensureTrackingRef({ ctx, cwd: path, baseOid });
  const head = (await must(ctx, path, ['rev-parse', 'HEAD'], 'gate-repo-stale')).trim();
  if (head !== attestedHead) throw new MirrorError('gate-repo-stale', `HEAD is ${head}`);
  return path;
}

const WORKER_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/**
 * §6.4 "After the worker exits": temp-ref fetch → `merge-base --is-ancestor
 * <cutTip>` → compare-and-swap `update-ref` on the old value → temp ref deleted.
 * Any step failing → `mirror-fetch-failed`, the worker branch untouched.
 */
export async function fetchBackWorkerBranch({ ctx, issueWt, mirror, workerBranch, cutTip }) {
  if (!WORKER_BRANCH_RE.test(workerBranch) || workerBranch.includes('..')) throw new MirrorError('mirror-fetch-failed', 'bad worker branch name');
  validateOid(cutTip);
  const tmp = `refs/autopilot/fetched/${workerBranch}`;
  const target = `refs/heads/${workerBranch}`;
  const cleanup = () => ctx.git.local(issueWt, ['update-ref', '-d', tmp]);
  const step = async (args) => { const r = await ctx.git.local(issueWt, args); if (r.status !== 0) { await cleanup(); throw new MirrorError('mirror-fetch-failed', `git ${args[0]}: ${r.stderr.trim()}`); } return r; };
  await step(['fetch', '-q', '--no-tags', mirror, `+refs/heads/${workerBranch}:${tmp}`]);
  if (!active('mirror.skipAncestorCheck')) await step(['merge-base', '--is-ancestor', cutTip, tmp]);
  const fetched = (await step(['rev-parse', '--verify', tmp])).stdout.trim();
  await step(['update-ref', target, tmp, cutTip]);
  await cleanup();
  return { head: fetched, tmpRef: tmp };
}
