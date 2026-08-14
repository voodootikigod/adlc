// Concern: lib/revision.mjs resolveChangeSetRevision — the change-set identity must
// anchor to the MERGE-BASE of base and HEAD, never the base TIP
// (T-01M00BNADHBEP8N4VPG9J84V8W).
//
// With a base-tip anchor, every advance of the base branch moves the identity (the
// embedded base sha changes AND base-side churn enters the digest as reversed
// entries), invalidating a recorded cross-model attestation for a change that has
// not moved — the #362/#367 defect class reintroduced one level down.
//
// Properties pinned:
//   - AC3: the identity is UNCHANGED by a base advance that does not touch the
//     branch's changed files;
//   - AC4: when merge-base and base tip differ, the embedded base component is the
//     merge-base sha;
//   - linear-history equivalence: when the branch is current, the base component
//     equals the base tip (byte-identical to prior behavior);
//   - working-tree inclusivity is preserved: an uncommitted edit still moves the
//     identity (the FIX A property at the identity level);
//   - AC5: disjoint histories (no merge-base) fail closed to null.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveChangeSetRevision, changeSetBase, isChangeSetRevision } from '../lib/revision.mjs';

// Commit dates pinned so shas are deterministic run-to-run (mirrors the
// prosecute tier-check test fixture; nothing here asserts cross-repo equality).
const PINNED_GIT_DATE = '2026-01-01T00:00:00Z';

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rev-merge-base-'));
  const g = (...a) => execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_GIT_DATE, GIT_COMMITTER_DATE: PINNED_GIT_DATE },
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  writeFileSync(join(dir, 'feature.txt'), 'original\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  return { dir, g };
}

// Branch feat off main with one committed change, then advance main with a commit
// that does NOT touch the branch's changed file. Returns shas for assertions.
function branchThenAdvanceBase({ dir, g }) {
  const branchPoint = g('rev-parse', 'main').trim();
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'feature.txt'), 'changed on feat\n');
  g('add', '-A'); g('commit', '-qm', 'feat change');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'unrelated-on-main.txt'), 'base-side churn\n');
  g('add', '-A'); g('commit', '-qm', 'main advances');
  g('checkout', '-q', 'feat');
  return { branchPoint, baseTip: g('rev-parse', 'main').trim() };
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

describe('resolveChangeSetRevision anchors to the merge-base, not the base tip', () => {
  it('AC3: a base advance not touching the branch’s files leaves the identity IDENTICAL', () => {
    const repo = scratchRepo();
    try {
      const { dir, g } = repo;
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'feature.txt'), 'changed on feat\n');
      g('add', '-A'); g('commit', '-qm', 'feat change');
      const before = resolveChangeSetRevision({ cwd: dir, base: 'main' });
      assert.ok(isChangeSetRevision(before), 'precondition: an identity resolves before the base moves');

      g('checkout', '-q', 'main');
      writeFileSync(join(dir, 'unrelated-on-main.txt'), 'base-side churn\n');
      g('add', '-A'); g('commit', '-qm', 'main advances');
      g('checkout', '-q', 'feat');
      const after = resolveChangeSetRevision({ cwd: dir, base: 'main' });

      assert.equal(after, before,
        'the reviewed change did not move, so its identity must not move — a recorded attestation must still verify');
    } finally { cleanup(repo.dir); }
  });

  it('AC4: when merge-base and base tip differ, the embedded base component is the merge-base sha', () => {
    const repo = scratchRepo();
    try {
      const { branchPoint, baseTip } = branchThenAdvanceBase(repo);
      assert.notEqual(branchPoint, baseTip, 'precondition: the base actually advanced');
      const revision = resolveChangeSetRevision({ cwd: repo.dir, base: 'main' });
      assert.ok(isChangeSetRevision(revision));
      assert.equal(changeSetBase(revision), branchPoint, 'the identity anchors to the merge-base');
      assert.notEqual(changeSetBase(revision), baseTip, 'and never to the moved base tip');
    } finally { cleanup(repo.dir); }
  });

  it('linear-history equivalence: a current branch embeds the base tip (which IS the merge-base)', () => {
    const repo = scratchRepo();
    try {
      const { dir, g } = repo;
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'feature.txt'), 'changed on feat\n');
      g('add', '-A'); g('commit', '-qm', 'feat change');
      const revision = resolveChangeSetRevision({ cwd: dir, base: 'main' });
      assert.equal(changeSetBase(revision), g('rev-parse', 'main').trim(),
        'when the branch is current the two anchors coincide — prior behavior is byte-identical');
    } finally { cleanup(repo.dir); }
  });

  it('working-tree inclusivity survives: an uncommitted edit still moves the identity', () => {
    const repo = scratchRepo();
    try {
      const { dir } = repo;
      branchThenAdvanceBase(repo);
      const committed = resolveChangeSetRevision({ cwd: dir, base: 'main' });
      writeFileSync(join(dir, 'feature.txt'), 'edited again, uncommitted\n');
      const dirty = resolveChangeSetRevision({ cwd: dir, base: 'main' });
      assert.ok(isChangeSetRevision(dirty));
      assert.notEqual(dirty, committed,
        'the identity must describe the working tree the gate actually prosecutes, not just commits');
    } finally { cleanup(repo.dir); }
  });

  it('criss-cross histories (multiple best common ancestors) fail closed to null', () => {
    // main: A → Y, then merges feat@X; feat: A → X, then merges main@Y. Both X and Y
    // are best common ancestors, so `git merge-base --all` prints two — an identity
    // anchored to an arbitrarily-picked one would be an identity nobody chose.
    const repo = scratchRepo();
    try {
      const { dir, g } = repo;
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'feature.txt'), 'changed on feat\n');
      g('add', '-A'); g('commit', '-qm', 'X');
      const shaX = g('rev-parse', 'HEAD').trim();
      g('checkout', '-q', 'main');
      writeFileSync(join(dir, 'main-side.txt'), 'Y\n');
      g('add', '-A'); g('commit', '-qm', 'Y');
      g('checkout', '-q', 'feat');
      g('merge', '-q', '--no-edit', 'main');
      g('checkout', '-q', 'main');
      g('merge', '-q', '--no-edit', shaX);
      g('checkout', '-q', 'feat');
      const all = g('merge-base', '--all', 'main', 'HEAD').trim().split('\n');
      assert.equal(all.length, 2, 'precondition: the topology really has two best ancestors');
      assert.equal(resolveChangeSetRevision({ cwd: dir, base: 'main' }), null,
        'an ambiguous merge-base must refuse the identity, never guess an anchor');
    } finally { cleanup(repo.dir); }
  });

  it('AC5: disjoint histories (no merge-base) fail closed to null', () => {
    const repo = scratchRepo();
    try {
      const { dir, g } = repo;
      g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(dir, 'feature.txt'), 'changed on feat\n');
      g('add', '-A'); g('commit', '-qm', 'feat change');
      // An orphan branch shares no history with feat: rev-parse resolves it, but no
      // merge-base exists — the identity must refuse, never fall back to the tip.
      g('checkout', '-q', '--orphan', 'isolated');
      writeFileSync(join(dir, 'island.txt'), 'no shared history\n');
      g('add', '-A'); g('commit', '-qm', 'orphan');
      g('checkout', '-q', 'feat');
      const revision = resolveChangeSetRevision({ cwd: dir, base: 'isolated' });
      assert.equal(revision, null, 'no merge-base ⇒ no identity ⇒ the gate finds no attestation and refuses');
    } finally { cleanup(repo.dir); }
  });
});
