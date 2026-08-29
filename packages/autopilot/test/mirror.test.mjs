// AC 84 / 94 / 106 / 161 — the worker mirror, its placement and replacement,
// the explicit fetch-back sequence, and the gate mirror + per-gate clone, all
// over REAL temporary git repositories.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkerMirror, createGateMirror, cloneGateRepo, fetchBackWorkerBranch, objectSet } from '../lib/mirror.mjs';
import { EXCLUDE_ENTRIES } from '../lib/paths.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { makeCtx, gitSpawns } from './helpers/gates-ctx.mjs';
import { makeRepo, addIssueWorktree, writeFiles, commitAll, git, scratch } from './helpers/gates-fixture.mjs';

const ISSUE = 7;
const BRANCH = `adlc/autopilot/issue-${ISSUE}`;

function fixture() {
  const { root, baseOid } = makeRepo({ files: { 'README.md': 'base\n', 'packages/foo/lib/x.mjs': 'export const x = 1;\n' } });
  const ctx = makeCtx({ repoRoot: root, baseOid });
  writeFiles(root, { '.git/info/exclude': EXCLUDE_ENTRIES.join('\n') + '\n' }); // what preflight guarantees (§9.1c)
  const wt = addIssueWorktree(root, ctx.paths.issueWorktree(ISSUE), ISSUE, baseOid);
  const commitIn = (dir, files, msg) => { writeFiles(dir, files); return commitAll(dir, msg); };
  // Noise the mirrors must never carry: another local branch and a dangling commit.
  git(root, ['branch', 'other', baseOid]);
  const tree = git(root, ['rev-parse', `${baseOid}^{tree}`]);
  const dangling = git(root, ['commit-tree', tree, '-m', 'dangling']);
  git(root, ['checkout', '-q', 'other']); const otherTip = commitIn(root, { 'other.txt': 'x\n' }, 'other'); git(root, ['checkout', '-q', 'main']);
  const has = (repo, oid) => { try { git(repo, ['cat-file', '-e', `${oid}^{commit}`]); return true; } catch { return false; } };
  return { root, baseOid, ctx, wt, commitIn, dangling, otherTip, has, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const configKeys = (repo) => git(repo, ['config', '--list', '--local', '--name-only']).split('\n').filter(Boolean);
const refs = (repo) => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean);

export async function ac84_workerMirror() {
  const f = fixture();
  try {
    const tip = f.commitIn(f.wt, { 'packages/foo/lib/x.mjs': 'export const x = 2;\n' }, 'worker-shaped');
    const mirror = await createWorkerMirror({ ctx: f.ctx, issue: ISSUE });
    assert.equal(mirror, f.ctx.paths.mirror(ISSUE));
    assert.deepEqual(refs(mirror), [`refs/heads/${BRANCH} ${tip}`], 'exactly one branch');
    const keys = configKeys(mirror);
    assert.ok(keys.length > 0 && keys.every((k) => k.startsWith('core.')), `only core.* config, got ${keys.join(',')}`);
    assert.ok(!keys.some((k) => /^remote\.|^credential\.|hookspath/i.test(k)), 'no remote.*, credential.* or hooksPath');
    assert.deepEqual(readdirSync(join(mirror, 'hooks')), [], 'no hooks');
    assert.deepEqual(await objectSet({ ctx: f.ctx, cwd: mirror, revs: ['--all'] }), await objectSet({ ctx: f.ctx, cwd: f.root, revs: [f.baseOid, tip] }), 'rev-list --all equals the objects reachable from BASE_OID + the issue branch');
    assert.equal(f.has(mirror, f.otherTip), false, "the other branch's commit is absent"); assert.equal(f.has(mirror, f.dangling), false, 'the dangling commit is absent');
    assert.equal(f.has(f.root, f.dangling), true, 'control: the dangling commit exists in REPO_ROOT');
    const clone = gitSpawns(f.ctx).find((a) => a.includes('clone'));
    assert.deepEqual(clone.filter((a) => a.startsWith('--')), ['--bare', '--no-local', '--single-branch', '--branch']);
  } finally { f.cleanup(); }
}
test('AC84: the worker mirror has exactly the issue branch, only core.* config, no hooks, and exactly the objects reachable from BASE_OID + the branch (a planted extra branch and dangling commit are absent)', ac84_workerMirror);

export async function ac94_mirrorOutsideWorktree() {
  const f = fixture();
  try {
    const first = f.commitIn(f.wt, { 'a.txt': '1\n' }, 'one');
    const mirror = await createWorkerMirror({ ctx: f.ctx, issue: ISSUE });
    assert.equal(mirror, join(f.root, '.adlc', 'autopilot-runs', String(ISSUE), 'mirror.git'));
    assert.ok(!mirror.startsWith(f.wt + '/'), 'outside ISSUE_WT');
    assert.ok(EXCLUDE_ENTRIES.includes('.adlc/autopilot-runs/'), 'the run directory is excluded from the primary tree');
    assert.equal(git(f.wt, ['status', '--porcelain']), '', 'ISSUE_WT stays clean');
    assert.equal(git(f.root, ['status', '--porcelain']), '', 'REPO_ROOT stays clean (the run dir is under .adlc/autopilot-runs, excluded)');
    assert.equal(git(mirror, ['rev-parse', `refs/heads/${BRANCH}`]), first);
    const second = f.commitIn(f.wt, { 'a.txt': '2\n' }, 'two');
    const again = await createWorkerMirror({ ctx: f.ctx, issue: ISSUE });
    assert.equal(again, mirror); assert.equal(git(mirror, ['rev-parse', `refs/heads/${BRANCH}`]), second, 'a stale mirror is replaced before dispatch');
    rmSync(f.ctx.paths.runDir(ISSUE), { recursive: true, force: true });
    assert.equal(existsSync(mirror), false, 'removing the run directory removes the mirror');
  } finally { f.cleanup(); }
}
test('AC94: the mirror lives at <REPO_ROOT>/.adlc/autopilot-runs/<issue>/mirror.git, ISSUE_WT stays clean, a stale mirror is replaced, and the run directory removal takes it away', ac94_mirrorOutsideWorktree);

export async function ac106_fetchBack() {
  const f = fixture();
  try {
    const cutTip = f.commitIn(f.wt, { 'a.txt': '1\n' }, 'issue');
    const mirror = await createWorkerMirror({ ctx: f.ctx, issue: ISSUE });
    const worker = 'fleet/run-1/worker';
    git(f.root, ['branch', worker, cutTip]); // fleet cut the worker branch in the caller repository
    // The worker commits INTO the mirror (its only git view): a clone, a commit, a push to refs/heads/<worker>.
    const wclone = scratch('ap-worker-'); git(wclone, ['clone', '-q', mirror, '.']);
    const workerCommit = f.commitIn(wclone, { 'packages/foo/lib/y.mjs': 'export const y = 1;\n' }, 'worker work');
    git(wclone, ['push', '-q', mirror, `HEAD:refs/heads/${worker}`]); rmSync(wclone, { recursive: true, force: true });
    f.ctx.recorder.length = 0;
    const r = await fetchBackWorkerBranch({ ctx: f.ctx, issueWt: f.wt, mirror, workerBranch: worker, cutTip });
    assert.equal(r.head, workerCommit);
    const argv = gitSpawns(f.ctx);
    const tmp = `refs/autopilot/fetched/${worker}`;
    assert.deepEqual(argv[0].filter((a) => a !== '-q'), ['fetch', '--no-tags', mirror, `+refs/heads/${worker}:${tmp}`], 'temp-ref fetch');
    assert.deepEqual(argv[1], ['merge-base', '--is-ancestor', cutTip, tmp]);
    assert.deepEqual(argv[3], ['update-ref', `refs/heads/${worker}`, tmp, cutTip], 'CAS update-ref with the cut tip as the old value');
    assert.deepEqual(argv[4], ['update-ref', '-d', tmp]);
    assert.equal(git(f.root, ['rev-parse', `refs/heads/${worker}`]), workerCommit, "the worker branch in ISSUE_WT's repository points at the worker's commit");
    assert.equal(refs(f.root).some((l) => l.startsWith(tmp)), false, 'temp ref deleted');
    // A mirror tip that does not descend from the cut tip: a commit on BASE_OID, not on cutTip.
    const rogue = scratch('ap-rogue-'); git(rogue, ['clone', '-q', mirror, '.']); git(rogue, ['checkout', '-q', f.baseOid]);
    f.commitIn(rogue, { 'rogue.txt': 'x\n' }, 'rogue'); git(rogue, ['push', '-q', '-f', mirror, `HEAD:refs/heads/${worker}`]); rmSync(rogue, { recursive: true, force: true });
    await assert.rejects(() => fetchBackWorkerBranch({ ctx: f.ctx, issueWt: f.wt, mirror, workerBranch: worker, cutTip: workerCommit }), (e) => e.code === 'mirror-fetch-failed');
    assert.equal(git(f.root, ['rev-parse', `refs/heads/${worker}`]), workerCommit, 'branch ref untouched'); assert.equal(refs(f.root).some((l) => l.startsWith(tmp)), false, 'temp ref deleted on failure');
  } finally { f.cleanup(); }
}
test('AC106: fetch-back = temp-ref fetch, merge-base --is-ancestor, CAS update-ref with the cut tip, temp ref deleted; a non-descending mirror tip → mirror-fetch-failed with the ref untouched', ac106_fetchBack);

export async function ac161_gateMirror() {
  const f = fixture();
  try {
    f.commitIn(f.wt, { 'packages/foo/lib/x.mjs': 'export const x = 2;\n' }, 'worker');
    const completion = f.commitIn(f.wt, { '.adlc/tickets/t-x--0.json': '{"completed":true}\n' }, 'chore(ticket): complete');
    const attestedHead = f.commitIn(f.wt, { '.adlc/manifest.d/seg.jsonl': '{"seq":1}\n' }, 'chore(manifest): attest');
    const gate = await createGateMirror({ ctx: f.ctx, issue: ISSUE, attestedHead, baseOid: f.baseOid });
    assert.equal(gate, f.ctx.paths.gateMirror(ISSUE));
    assert.deepEqual(refs(gate).sort(), [`refs/heads/${BRANCH} ${attestedHead}`, `refs/remotes/origin/${f.baseOid} ${f.baseOid}`].sort(), 'exactly two refs at the two tips');
    assert.deepEqual(await objectSet({ ctx: f.ctx, cwd: gate, revs: ['--all'] }), await objectSet({ ctx: f.ctx, cwd: f.root, revs: [attestedHead, f.baseOid] }));
    assert.equal(f.has(gate, f.otherTip), false); assert.equal(f.has(gate, f.dangling), false);
    const clone = await cloneGateRepo({ ctx: f.ctx, issue: ISSUE, k: 0, attestedHead, baseOid: f.baseOid });
    assert.equal(clone, join(f.ctx.paths.runDir(ISSUE), 'gate-repo-0'));
    assert.equal(git(clone, ['rev-parse', 'HEAD']), attestedHead); assert.equal(git(clone, ['rev-parse', `refs/remotes/origin/${f.baseOid}`]), f.baseOid);
    const log = git(clone, ['log', '--format=%H', 'HEAD']).split('\n');
    assert.ok(log.includes(completion) && log.includes(attestedHead), 'completion and attestation commits present');
    assert.ok(configKeys(clone).every((k) => k.startsWith('core.')), 'no config beyond core.*'); assert.deepEqual(readdirSync(join(clone, '.git', 'hooks')), []);
    rmSync(clone, { recursive: true, force: true });
    // A gate mirror created BEFORE the attestation commit.
    await createGateMirror({ ctx: f.ctx, issue: ISSUE, attestedHead: completion, baseOid: f.baseOid });
    const later = f.commitIn(f.wt, { '.adlc/manifest.d/seg.jsonl': '{"seq":1}\n{"seq":2}\n' }, 'chore(manifest): re-attest');
    await assert.rejects(() => cloneGateRepo({ ctx: f.ctx, issue: ISSUE, k: 1, attestedHead: later, baseOid: f.baseOid }), (e) => e.code === 'gate-mirror-stale');
    assert.equal(existsSync(join(f.ctx.paths.runDir(ISSUE), 'gate-repo-1')), false, 'no clone is cut from a stale mirror');
  } finally { f.cleanup(); }
}
test('AC161: the gate mirror holds exactly attestedHead + BASE_OID and their objects; GATE_REPO checks out attestedHead with the completion and attestation commits; a mirror created before attestation → gate-mirror-stale, no clone', ac161_gateMirror);

test('seam check: the mirror tests fail under their registered seams', async () => {
  for (const [seam, fn] of [['mirror.keepRemote', ac84_workerMirror], ['mirror.keepStale', ac94_mirrorOutsideWorktree], ['mirror.skipAncestorCheck', ac106_fetchBack], ['mirror.skipVerify', ac161_gateMirror]]) {
    await assert.rejects(() => withMutation(seam, fn), `${fn.name} must fail under ${seam}`);
  }
});
