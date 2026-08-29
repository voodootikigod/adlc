// Mirror-mode git lifecycle (spec §6.4, AC 84/106/108), driven against REAL git.
//
// The properties under test are git's — which objects a single-branch bare clone
// carries, where a worktree cut from a bare repository keeps its database, what a
// compare-and-swap `update-ref` refuses — so a stub could only restate our own
// assumptions. Every test builds a caller repository seeded with things that must
// NEVER reach the mirror (an extra branch, a dangling commit) and asserts the caller
// repository's refs changed in exactly the expected way and no other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FETCHED_REF_PREFIX, assertBareMirror, ensureWorkerBranchInRepo, cutMirrorWorktree, refreshMirrorTip,
  fetchBackWorkerBranch, ensureGateWorktree, detachGateWorktree, removeMirrorWorktree,
  mirrorRefs, gitCommonDir,
} from '../lib/git-mirror.mjs';

const ISSUE_BRANCH = 'adlc/autopilot/issue-7';
const WB = 'fleet/t1';
const TMP_REF = FETCHED_REF_PREFIX + WB;

// Hermetic git: fixed identity, no user/system config (a global hooksPath or gpgsign
// must not leak into the run), signing off.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fleet-test', GIT_AUTHOR_EMAIL: 'fleet@test.invalid',
  GIT_COMMITTER_NAME: 'fleet-test', GIT_COMMITTER_EMAIL: 'fleet@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const gitAt = (dir) => (...args) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

/** Records every argv and optionally injects a failure, delegating to real git otherwise. */
function recordingGitAt(log, failWhen = () => false) {
  return (dir) => (...args) => {
    log.push(args);
    if (failWhen(args, log)) throw new Error(`injected failure for: git ${args.join(' ')}`);
    return gitAt(dir)(...args);
  };
}

function commitFile(dir, name, content, message) {
  const g = gitAt(dir);
  writeFileSync(join(dir, name), content);
  g('add', '--', name);
  g('commit', '-q', '-m', message);
  return g('rev-parse', 'HEAD');
}

const refs = (dir) => gitAt(dir)('for-each-ref', '--format=%(refname) %(objectname)');
const objectsOf = (dir, ...revArgs) =>
  new Set(gitAt(dir)('rev-list', '--objects', ...revArgs).split('\n').filter(Boolean).map((l) => l.split(' ')[0]));
const hasObject = (dir, oid) => { try { gitAt(dir)('cat-file', '-e', oid); return true; } catch { return false; } };

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-git-mirror-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const g = gitAt(repo);
  g('init', '-q', '-b', 'main');
  const base = commitFile(repo, 'a.txt', 'base\n', 'base');
  g('checkout', '-q', '-b', 'other');
  const otherTip = commitFile(repo, 'o.txt', 'other\n', 'other');
  // A commit with no ref: reachable only through the reflog, which a clone never transfers.
  g('checkout', '-q', '-b', 'tmp', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'dangling');
  const dangling = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  g('branch', '-D', '-q', 'tmp');
  g('checkout', '-q', '-b', ISSUE_BRANCH, 'main');
  const issueTip = commitFile(repo, 'issue.txt', 'issue\n', 'issue');
  g('checkout', '-q', 'main');
  const mirror = join(root, 'mirror.git');
  gitAt(root)('clone', '-q', '--bare', '--no-local', '--single-branch', '--branch', ISSUE_BRANCH, repo, mirror);
  gitAt(mirror)('remote', 'remove', 'origin');
  const workerPath = join(root, 'worker-wt');
  const gatePath = join(repo, '.worktrees', 'gate');
  return { root, repo, mirror, base, otherTip, dangling, issueTip, workerPath, gatePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Cut + one worker commit: the state every fetch-back test starts from. */
function cutWithWorkerCommit(f) {
  ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: WB, cutTip: f.issueTip, gitAt });
  cutMirrorWorktree({ mirror: f.mirror, workerBranch: WB, path: f.workerPath, cutTip: f.issueTip, gitAt });
  return commitFile(f.workerPath, 'work.txt', 'work\n', 'worker build');
}

test('the mirror holds exactly the issue branch and only the objects reachable from BASE + issue tip; a non-bare path is refused', () => {
  const f = makeFixture();
  try {
    assert.deepEqual(assertBareMirror({ mirror: f.mirror, gitAt }), { branches: [ISSUE_BRANCH], baseBranch: ISSUE_BRANCH });
    assert.deepEqual(mirrorRefs({ mirror: f.mirror, gitAt }), [`refs/heads/${ISSUE_BRANCH}`]);
    assert.deepEqual(objectsOf(f.mirror, '--all'), objectsOf(f.repo, f.base, f.issueTip), 'no object beyond BASE + issue history crossed');
    assert.equal(hasObject(f.mirror, f.otherTip), false, 'the `other` branch tip is absent');
    assert.equal(hasObject(f.mirror, f.dangling), false, 'the dangling commit is absent');
    assert.doesNotMatch(gitAt(f.mirror)('config', '--list', '--local'), /^remote\./m, 'no remote config survives');

    assert.throws(() => assertBareMirror({ mirror: f.repo, gitAt }), /not a bare repository/);
    assert.throws(() => assertBareMirror({ mirror: f.root, gitAt }), /not a git repository/);
    assert.throws(() => assertBareMirror({ gitAt }), TypeError);
  } finally { f.cleanup(); }
});

test('ensureWorkerBranchInRepo creates the worker branch at the cut tip once and is a no-op thereafter', () => {
  const f = makeFixture();
  try {
    const before = refs(f.repo);
    assert.deepEqual(ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: WB, cutTip: f.issueTip, gitAt }), { created: true, sha: f.issueTip });
    assert.equal(refs(f.repo), `${before}\nrefs/heads/${WB} ${f.issueTip}`.split('\n').sort().join('\n'), 'exactly one ref was added');
    assert.deepEqual(ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: WB, cutTip: f.issueTip, gitAt }), { created: false, sha: f.issueTip });
    // An existing ref is reported, never rewritten — even when the caller's cutTip differs.
    assert.deepEqual(ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: WB, cutTip: f.base, gitAt }), { created: false, sha: f.issueTip });
    // A ref name as the CAS old value would resolve to the current value and always pass:
    // refused at the boundary before any git call.
    const log = [];
    assert.throws(() => ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: 'fleet/t2', cutTip: ISSUE_BRANCH, gitAt: recordingGitAt(log) }), TypeError);
    assert.deepEqual(log, []);

    // The creation is a zero-OID compare-and-swap: a ref that appears between the existence
    // check and the write (a concurrent run) makes the create FAIL LOUDLY instead of being
    // silently overwritten. Simulated by planting the ref just before the write runs.
    const raced = (dir) => (...args) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/heads/fleet/t2') gitAt(dir)('update-ref', 'refs/heads/fleet/t2', f.otherTip);
      return gitAt(dir)(...args);
    };
    assert.throws(() => ensureWorkerBranchInRepo({ repo: f.repo, workerBranch: 'fleet/t2', cutTip: f.issueTip, gitAt: raced }), /update-ref/);
    assert.equal(gitAt(f.repo)('rev-parse', 'refs/heads/fleet/t2'), f.otherTip, 'the concurrently created ref keeps its value');
  } finally { f.cleanup(); }
});

test('cutMirrorWorktree cuts a worktree whose git database IS the mirror, at the cut tip, seeing no caller-only ref', () => {
  const f = makeFixture();
  try {
    const repoBefore = refs(f.repo);
    const r = cutMirrorWorktree({ mirror: f.mirror, workerBranch: WB, path: f.workerPath, cutTip: f.issueTip, gitAt });
    assert.deepEqual(r, { path: f.workerPath, branch: WB, startSha: f.issueTip });
    assert.equal(gitCommonDir(f.workerPath, gitAt), gitCommonDir(f.mirror, gitAt), 'the worktree resolves INTO the mirror, not the caller repo');
    assert.equal(gitAt(f.workerPath)('rev-parse', 'HEAD'), f.issueTip);
    assert.equal(gitAt(f.workerPath)('symbolic-ref', '--short', 'HEAD'), WB);
    assert.deepEqual(gitAt(f.workerPath)('for-each-ref', '--format=%(refname)').split('\n').sort(),
      [`refs/heads/${ISSUE_BRANCH}`, `refs/heads/${WB}`], 'only the issue branch and the worker branch are visible');
    assert.equal(refs(f.repo), repoBefore, 'the caller repository is untouched');

    // A stale worktree/branch from a previous strike is replaced, not an error.
    commitFile(f.workerPath, 'stale.txt', 'stale\n', 'stale strike');
    cutMirrorWorktree({ mirror: f.mirror, workerBranch: WB, path: f.workerPath, cutTip: f.issueTip, gitAt });
    assert.equal(gitAt(f.workerPath)('rev-parse', 'HEAD'), f.issueTip, 'recut lands back on the cut tip');

    // A cut tip the mirror does not hold is a caller bug, named by OID.
    assert.throws(() => cutMirrorWorktree({ mirror: f.mirror, workerBranch: 'fleet/t2', path: join(f.root, 'wt2'), cutTip: f.otherTip, gitAt }),
      new RegExp(`cut tip ${f.otherTip} is not a commit the mirror`));
    assert.throws(() => cutMirrorWorktree({ mirror: f.mirror, workerBranch: 'fleet/t2', path: 'relative/wt', cutTip: f.issueTip, gitAt }), /absolute path/);
  } finally { f.cleanup(); }
});

test('fetchBackWorkerBranch advances the caller branch to the worker commit via fetch → ancestry → CAS → delete and leaves no temp ref', () => {
  const f = makeFixture();
  try {
    const workerTip = cutWithWorkerCommit(f);
    const before = refs(f.repo);
    const log = [];
    const r = fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt: recordingGitAt(log) });
    assert.deepEqual(r, { ok: true, sha: workerTip });
    assert.equal(gitAt(f.repo)('rev-parse', `refs/heads/${WB}`), workerTip);
    assert.equal(hasObject(f.repo, workerTip), true, 'the worker commit now lives in the caller repository');
    assert.equal(refs(f.repo), before.replace(`refs/heads/${WB} ${f.issueTip}`, `refs/heads/${WB} ${workerTip}`), 'only the worker branch moved; no temp ref remains');
    // AC 106: the recorded argv shows the temp-ref fetch, the ancestry check and the CAS with the cut tip as old value.
    const mutating = log.filter((a) => a[0] !== 'rev-parse');
    assert.deepEqual(mutating, [
      ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', f.mirror, `+refs/heads/${WB}:${TMP_REF}`],
      ['merge-base', '--is-ancestor', f.issueTip, TMP_REF],
      ['update-ref', `refs/heads/${WB}`, TMP_REF, f.issueTip],
      ['update-ref', '-d', TMP_REF],
    ]);
    assert.equal(hasObject(f.mirror, workerTip), true, 'the mirror still holds the branch for forensics');
  } finally { f.cleanup(); }
});

test('a mirror tip that does not descend from the cut tip is refused: ok:false, caller branch untouched, temp ref gone', () => {
  const f = makeFixture();
  try {
    cutWithWorkerCommit(f);
    // Rewrite the worker branch in the mirror to an orphan (no parent, so BASE is not its ancestor).
    const mg = gitAt(f.mirror);
    writeFileSync(join(f.root, 'empty'), '');
    const orphan = mg('commit-tree', mg('hash-object', '-w', '-t', 'tree', join(f.root, 'empty')), '-m', 'orphan');
    mg('update-ref', `refs/heads/${WB}`, orphan);
    const before = refs(f.repo);
    const r = fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mirror-fetch-failed');
    assert.equal(r.step, 'ancestry');
    assert.equal(refs(f.repo), before, 'no ref changed and the temp ref was removed');
    assert.equal(hasObject(f.repo, orphan), true, 'the fetch itself succeeded — only the ancestry check refused it');

    const gone = fetchBackWorkerBranch({ repo: f.repo, mirror: join(f.root, 'nope.git'), workerBranch: WB, cutTip: f.issueTip, gitAt });
    assert.equal(gone.ok, false);
    assert.equal(gone.step, 'fetch');
    assert.match(gone.detail, /nope\.git/);
    assert.equal(refs(f.repo), before);
  } finally { f.cleanup(); }
});

test('a caller branch that moved after the cut fails the compare-and-swap and stays where it moved to', () => {
  const f = makeFixture();
  try {
    const workerTip = cutWithWorkerCommit(f);
    gitAt(f.repo)('update-ref', `refs/heads/${WB}`, f.otherTip);
    const before = refs(f.repo);
    const r = fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'cas');
    assert.equal(refs(f.repo), before, 'the moved ref is not clobbered; temp ref gone');
    assert.equal(hasObject(f.repo, workerTip), true);

    // A ref name for cutTip would make the swap compare against the CURRENT value (always
    // true) — refused before any git runs. Missing args likewise throw rather than report.
    const log = [];
    assert.throws(() => fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: ISSUE_BRANCH, gitAt: recordingGitAt(log) }), TypeError);
    assert.throws(() => fetchBackWorkerBranch({ repo: f.repo, workerBranch: WB, cutTip: f.issueTip, gitAt: recordingGitAt(log) }), TypeError);
    assert.deepEqual(log, []);
  } finally { f.cleanup(); }
});

test('a failure deleting the temp ref after the swap rolls the branch back so ok:false always means "ref untouched"', () => {
  const f = makeFixture();
  try {
    cutWithWorkerCommit(f);
    const before = refs(f.repo);
    const log = [];
    let deletes = 0;
    const failFirstDelete = (a) => a[0] === 'update-ref' && a[1] === '-d' && ++deletes === 1;
    const r = fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt: recordingGitAt(log, failFirstDelete) });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'cleanup');
    assert.match(r.detail, /rolled back/);
    assert.equal(refs(f.repo), before, 'the branch is back at the cut tip and the temp ref is gone');
  } finally { f.cleanup(); }
});

test('ensureGateWorktree checks the fetched-back branch out in a caller worktree and refreshes it after the branch advances; detach leaves HEAD at the same commit', () => {
  const f = makeFixture();
  try {
    const tip1 = cutWithWorkerCommit(f);
    assert.equal(fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt }).ok, true);
    assert.deepEqual(ensureGateWorktree({ repo: f.repo, path: f.gatePath, workerBranch: WB, gitAt }), { path: f.gatePath });
    const wg = gitAt(f.gatePath);
    assert.equal(wg('symbolic-ref', '--short', 'HEAD'), WB);
    assert.equal(wg('rev-parse', 'HEAD'), tip1);
    assert.equal(gitAt(f.repo)('symbolic-ref', '--short', 'HEAD'), 'main', 'the shared checkout never switches');

    // Detach so the next fetch-back never advances a checked-out branch.
    assert.deepEqual(detachGateWorktree({ path: f.gatePath, gitAt }), { path: f.gatePath, detached: true });
    assert.throws(() => wg('symbolic-ref', '--short', 'HEAD'), /not a symbolic ref/);
    assert.equal(wg('rev-parse', 'HEAD'), tip1);
    assert.deepEqual(detachGateWorktree({ path: join(f.root, 'missing'), gitAt }), { path: join(f.root, 'missing'), detached: false });

    // The branch advances (second strike) and the gate worktree — left dirty and on ANOTHER
    // branch meanwhile — is refreshed without moving that other branch.
    const tip2 = commitFile(f.workerPath, 'more.txt', 'more\n', 'second commit');
    assert.equal(fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: tip1, gitAt }).ok, true);
    wg('checkout', '-q', 'other');
    writeFileSync(join(f.gatePath, 'o.txt'), 'dirty\n');
    const otherBefore = gitAt(f.repo)('rev-parse', 'refs/heads/other');
    ensureGateWorktree({ repo: f.repo, path: f.gatePath, workerBranch: WB, gitAt });
    assert.equal(wg('symbolic-ref', '--short', 'HEAD'), WB);
    assert.equal(wg('rev-parse', 'HEAD'), tip2);
    assert.equal(wg('status', '--porcelain'), '', 'the tree is clean at the new tip');
    assert.equal(gitAt(f.repo)('rev-parse', 'refs/heads/other'), otherBefore, 'the branch the worktree was on is not reset');
    assert.equal(gitAt(f.repo)('rev-parse', `refs/heads/${WB}`), tip2);
  } finally { f.cleanup(); }
});

test('removeMirrorWorktree deregisters the worker worktree from the mirror and tolerates repetition', () => {
  const f = makeFixture();
  try {
    cutWithWorkerCommit(f);
    assert.match(gitAt(f.mirror)('worktree', 'list', '--porcelain'), new RegExp(`worktree ${f.workerPath}`));
    assert.deepEqual(removeMirrorWorktree({ mirror: f.mirror, path: f.workerPath, gitAt }), { path: f.workerPath, removed: true });
    assert.equal(existsSync(f.workerPath), false);
    assert.doesNotMatch(gitAt(f.mirror)('worktree', 'list', '--porcelain'), new RegExp(`worktree ${f.workerPath}`));
    assert.deepEqual(removeMirrorWorktree({ mirror: f.mirror, path: f.workerPath, gitAt }), { path: f.workerPath, removed: true });
    assert.deepEqual(mirrorRefs({ mirror: f.mirror, gitAt }).sort(), [`refs/heads/${ISSUE_BRANCH}`, `refs/heads/${WB}`], 'the branch stays in the mirror for forensics');
  } finally { f.cleanup(); }
});

import { zeroOidFor } from '../lib/git-mirror.mjs';

test('the CAS null object id is as wide as the repository object format: a SHA-256 caller repository gets its worker branch created (codex r2)', () => {
  assert.equal(zeroOidFor('a'.repeat(40)), '0'.repeat(40));
  assert.equal(zeroOidFor('b'.repeat(64)), '0'.repeat(64));
  let supported = true;
  const dir = mkdtempSync(join(tmpdir(), 'fleet-sha256-'));
  try {
    try { execFileSync('git', ['init', '-q', '--object-format=sha256', '-b', 'main', dir], { env, stdio: 'pipe' }); }
    catch { supported = false; }
    if (!supported) { assert.ok(true, 'git without sha256 support: width rule asserted above'); return; }
    writeFileSync(join(dir, 'f'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', 'f'], { env, stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { env, stdio: 'pipe' });
    const tip = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
    assert.equal(tip.length, 64, 'a SHA-256 tip');
    const r = ensureWorkerBranchInRepo({ repo: dir, workerBranch: WB, cutTip: tip });
    assert.deepEqual(r, { created: true, sha: tip });
    assert.equal(execFileSync('git', ['-C', dir, 'rev-parse', `refs/heads/${WB}`], { env, encoding: 'utf8' }).trim(), tip);
    assert.deepEqual(ensureWorkerBranchInRepo({ repo: dir, workerBranch: WB, cutTip: tip }), { created: false, sha: tip });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the disposable-mirror contract is ENFORCED: a second base branch, a remote or a live hook is refused; fleet/* worker branches are allowed (codex r8)', () => {
  const f = makeFixture();
  try {
    const g = gitAt(f.mirror);
    g('branch', 'fleet/t9', ISSUE_BRANCH);
    assert.equal(assertBareMirror({ mirror: f.mirror, gitAt }).baseBranch, ISSUE_BRANCH, 'worker branches do not break the contract');
    g('branch', 'stray', ISSUE_BRANCH);
    assert.throws(() => assertBareMirror({ mirror: f.mirror, gitAt }), /exactly one base branch/);
    g('branch', '-D', 'stray');
    g('remote', 'add', 'origin', f.repo);
    assert.throws(() => assertBareMirror({ mirror: f.mirror, gitAt }), /carries remotes|poisoned: config carries remote\./, 'a remote is refused — by the config vet that now runs first (remote.* keys) or by the remote probe');
    g('remote', 'remove', 'origin');
    writeFileSync(join(f.mirror, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.throws(() => assertBareMirror({ mirror: f.mirror, gitAt }), /carries hooks|poisoned: live hooks/, 'a live hook is refused — by the vet that now runs first, or by the hooks probe');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a later ticket cuts from the ADVANCED integration tip: the mirror is refreshed from the caller repository, fast-forward, still single-branch (codex r8)', () => {
  const f = makeFixture();
  try {
    // the caller's integration branch moves past what the mirror holds
    const g = gitAt(f.repo);
    g('branch', 'fleet/run-x', ISSUE_BRANCH);
    g('checkout', '-q', 'fleet/run-x');
    const advanced = commitFile(f.repo, 'merged.txt', 'merged\n', 'merge of ticket 1');
    g('checkout', '-q', ISSUE_BRANCH);
    assert.throws(() => gitAt(f.mirror)('cat-file', '-e', `${advanced}^{commit}`), 'the mirror does not hold the advanced tip yet');
    const r = refreshMirrorTip({ mirror: f.mirror, repo: f.repo, baseBranch: ISSUE_BRANCH, sourceRef: 'fleet/run-x', tip: advanced, gitAt });
    assert.equal(r.refreshed, true);
    assert.equal(gitAt(f.mirror)('rev-parse', ISSUE_BRANCH), advanced, 'the base branch fast-forwarded to the tip');
    assert.deepEqual(mirrorRefs({ mirror: f.mirror, gitAt }), [`refs/heads/${ISSUE_BRANCH}`], 'still exactly one base branch');
    assert.equal(refreshMirrorTip({ mirror: f.mirror, repo: f.repo, baseBranch: ISSUE_BRANCH, sourceRef: 'fleet/run-x', tip: advanced, gitAt }).refreshed, false, 'idempotent once held');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('when the rollback after a failed temp-ref delete ALSO fails, the result says so and names the sha the branch was left at (the degraded path is explicit, never silent)', () => {
  const f = makeFixture();
  try {
    cutWithWorkerCommit(f);
    const log = [];
    let deletes = 0;
    const failing = (a) => (a[0] === 'update-ref' && a[1] === '-d' && ++deletes === 1) || (a[0] === 'update-ref' && a.length === 4 && a[2] === f.issueTip);
    const r = fetchBackWorkerBranch({ repo: f.repo, mirror: f.mirror, workerBranch: WB, cutTip: f.issueTip, gitAt: recordingGitAt(log, failing) });
    assert.equal(r.ok, false); assert.equal(r.step, 'cleanup');
    assert.match(r.detail, /ROLLBACK FAILED/);
    assert.match(r.detail, /branch left at [0-9a-f]{40}/);
    assert.notEqual(refs(f.repo).includes(f.issueTip), false, 'the fixture refs still list the cut tip for the base branch');
  } finally { f.cleanup(); }
});
