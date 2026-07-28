// Concern: resolveChangeSetRevision (#365) — attestation identity bound to the REVIEWED CHANGE
// rather than the whole worktree.
//
// The defect it replaces: resolveRevision hashes every tracked and untracked file, so any advance
// of `main` invalidates an attestation for a change that has not moved (#362 lost one to a
// docs-only merge; #367 to a terminal-rendering merge).
//
// The premortem findings this pins (see ticket t-gate-revision-binding):
//   F2 — identity must be TREE-derived, not `git diff` TEXT. Rename detection is a similarity
//        heuristic and diff.algorithm / core.autocrlf / git version all change diff bytes, so a
//        text hash reintroduces the local-vs-CI divergence #362 and #367 were spent on.
//   F3 — mode is part of the identity. Normalizing it away makes `chmod +x` on a hook invisible
//        after review.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveChangeSetRevision, changeSetDigest } from '../lib/revision.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-changeset-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  return { dir, g };
}
const clean = (d) => rmSync(d, { recursive: true, force: true });

// A branch carrying one reviewed change.
function withChange({ dir, g }, mutate = (d) => writeFileSync(join(d, 'src', 'app.mjs'), 'export const x = 1;\n')) {
  g('checkout', '-q', '-b', 'feat');
  mutate(dir);
  g('add', '-A'); g('commit', '-qm', 'the reviewed change');
}

describe('resolveChangeSetRevision (#365) — identity bound to the reviewed change', () => {
  it('is stable when the BASE gains unrelated commits (the whole point)', () => {
    const r = repo();
    try {
      withChange(r);
      const before = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });

      // main advances with a file the change never touches — the #362 / #367 scenario.
      r.g('checkout', '-q', 'main');
      writeFileSync(join(r.dir, 'UNRELATED.md'), 'a docs merge\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'unrelated docs');
      r.g('checkout', '-q', 'feat');
      r.g('rebase', '-q', 'main');

      const after = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.equal(changeSetOf(after), changeSetOf(before),
        'the change-set component must survive an unrelated advance of the base');
    } finally { clean(r.dir); }
  });

  it('changes when a reviewed byte changes', () => {
    const r = repo();
    try {
      withChange(r);
      const before = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 2;\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'altered');
      const after = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.notEqual(changeSetOf(after), changeSetOf(before));
    } finally { clean(r.dir); }
  });

  // F2 — the identity must not depend on git configuration.
  it('F2: identity is independent of diff.algorithm, diff.renames and core.autocrlf', () => {
    const r = repo();
    try {
      withChange(r);
      const baseline = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      for (const [k, v] of [
        ['diff.algorithm', 'patience'],
        ['diff.algorithm', 'histogram'],
        ['diff.renames', 'false'],
        ['diff.renames', 'copies'],
        ['core.autocrlf', 'true'],
      ]) {
        r.g('config', k, v);
        assert.equal(resolveChangeSetRevision({ cwd: r.dir, base: 'main' }), baseline,
          `identity moved after setting ${k}=${v} — the implementation is hashing diff TEXT, not the tree`);
      }
    } finally { clean(r.dir); }
  });

  // F2 continued — a rename must not be collapsed by similarity detection.
  it('F2: a rename is recorded as delete+add, not resolved by a similarity heuristic', () => {
    const r = repo();
    try {
      r.g('checkout', '-q', '-b', 'feat');
      execFileSync('git', ['mv', 'src/app.mjs', 'src/renamed.mjs'], { cwd: r.dir, stdio: 'ignore' });
      r.g('add', '-A'); r.g('commit', '-qm', 'rename');
      const withRenames = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      r.g('config', 'diff.renames', 'true');
      const stillSame = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.equal(stillSame, withRenames, 'rename detection must not influence the identity');
    } finally { clean(r.dir); }
  });

  // F3 — mode is part of what was reviewed.
  it('F3: a mode-only change (chmod +x) yields a DIFFERENT identity', () => {
    const r = repo();
    try {
      r.g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(r.dir, 'hook.sh'), '#!/bin/sh\necho hi\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'add hook');
      const before = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });

      chmodSync(join(r.dir, 'hook.sh'), 0o755);
      r.g('add', '-A'); r.g('commit', '-qm', 'chmod +x');
      const after = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.notEqual(after, before,
        'chmod +x must be visible in the identity — otherwise it is invisible after review');
    } finally { clean(r.dir); }
  });

  it('excludes ignorePaths, so recording an attestation does not change the identity', () => {
    const r = repo();
    try {
      r.g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 1;\n');
      mkdirSync(join(r.dir, '.adlc'), { recursive: true });
      writeFileSync(join(r.dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'change + ledger');
      const before = resolveChangeSetRevision({ cwd: r.dir, base: 'main', ignorePaths: [join(r.dir, '.adlc', 'manifest.jsonl')] });
      writeFileSync(join(r.dir, '.adlc', 'manifest.jsonl'), '{"seq":1}\n{"seq":2}\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'append attestation');
      const after = resolveChangeSetRevision({ cwd: r.dir, base: 'main', ignorePaths: [join(r.dir, '.adlc', 'manifest.jsonl')] });
      assert.equal(changeSetOf(after), changeSetOf(before));
    } finally { clean(r.dir); }
  });

  it('untracked scratch files do not affect the identity (removes the local-vs-CI divergence)', () => {
    const r = repo();
    try {
      withChange(r);
      const before = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      writeFileSync(join(r.dir, '.scratch-review.out'), 'local noise\n');
      assert.equal(resolveChangeSetRevision({ cwd: r.dir, base: 'main' }), before,
        'an untracked file must not move the identity — that trap cost two PRs');
    } finally { clean(r.dir); }
  });

  // ── AC13/AC14: the basis is base → WORKING TREE, not base..HEAD ──────────────────
  // An earlier build compared base to HEAD and was reverted: prosecution here is
  // working-tree-inclusive on purpose (FIX A in prosecute-cross-model-cli.test.mjs), so a
  // committed-only identity would describe something the gate does not prosecute.
  it('AC13: an UNCOMMITTED edit to a tracked file changes the identity, and reverting restores it', () => {
    const r = repo();
    try {
      withChange(r);
      const committed = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });

      // Prove the premise: a committed three-dot diff cannot see this edit.
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 99; // uncommitted\n');
      const threeDot = r.g('diff', '--name-only', 'main...HEAD');
      assert.doesNotMatch(threeDot, /uncommitted/, 'fixture sanity: the edit is not committed');

      const dirty = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.notEqual(dirty, committed,
        'an uncommitted tracked edit MUST move the identity — otherwise the gate attests code it never saw');

      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 1;\n'); // revert
      assert.equal(resolveChangeSetRevision({ cwd: r.dir, base: 'main' }), committed,
        'restoring the working tree must restore the identity — the identity is content, not history');
    } finally { clean(r.dir); }
  });

  // The collision the CURRENT side exists to avoid. Comparing a commit to the working tree,
  // `git diff --raw` reports `dstsha` as 40 zeros for an unstaged modification regardless of
  // CONTENT. An implementation that reads that field collapses every distinct edit onto one
  // identity — a reviewed change and an arbitrary replacement would attest alike.
  it('AC13: two different UNCOMMITTED contents yield different identities (dstsha is zeros for both)', () => {
    const r = repo();
    try {
      withChange(r);
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 111;\n');
      const first = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 222;\n');
      const second = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });

      // Fixture sanity: git really does report zeros for BOTH, so this is the live hazard.
      const raw = r.g('diff', '--raw', '--abbrev=40', 'main');
      assert.match(raw, /0{40}/, 'fixture sanity: dstsha is zeros for an unstaged modification');

      assert.notEqual(first, second,
        'the current side must be COMPUTED from the working tree, never read from git diff --raw');
    } finally { clean(r.dir); }
  });

  // A STAGED modification reports a real dstsha — but it is the INDEX blob, which goes stale the
  // moment the file is edited again. Trusting it attests the staged content, not the real tree.
  it('AC13: an edit made AFTER staging moves the identity (the index sha is not the working tree)', () => {
    const r = repo();
    try {
      withChange(r);
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 7;\n');
      r.g('add', 'src/app.mjs');
      const staged = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      writeFileSync(join(r.dir, 'src', 'app.mjs'), 'export const x = 8;\n'); // edit after staging
      assert.notEqual(resolveChangeSetRevision({ cwd: r.dir, base: 'main' }), staged,
        'the identity must follow the working tree, not the index');
    } finally { clean(r.dir); }
  });

  // AC17 / review finding R2 — a deleted path is still LISTED by --raw but is gone from disk, so
  // hash-object and stat must never be reached for it. The outer try/catch would otherwise turn
  // the crash into a silent null: no identity, no attestation, and no explanation.
  it('AC17: a DELETED tracked path resolves via the sentinel instead of crashing', () => {
    const r = repo();
    try {
      withChange(r);
      const present = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      rmSync(join(r.dir, 'README.md'));
      const deleted = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.ok(deleted, 'a deletion must still produce an identity, not null from a swallowed crash');
      assert.match(deleted, /^git-change:/);
      assert.notEqual(deleted, present, 'a deletion is part of the reviewed change');
    } finally { clean(r.dir); }
  });

  // AC17 continued — the sentinel's SPECIFIC bytes are part of the documented contract ("000000
  // mode / 40 zeros"), not an arbitrary placeholder: `git diff --raw` itself reports a MISSING
  // side as 40 zeros (e.g. an added file's srcSha), so a deleted path's current-side sentinel is
  // chosen to match that existing git convention. A test that only checks "some stable value
  // differing from present" (the block above) would not notice the sentinel silently becoming a
  // different 40-hex-char constant. This reconstructs the expected digest independently — from
  // git's own base-tree lookup plus the DOCUMENTED sentinel — and pins the exact value, so a
  // production change to the sentinel bytes fails this test rather than surviving unnoticed.
  it('AC17: the deleted-path sentinel is EXACTLY 40 zeros, not merely "some" stable constant', () => {
    const r = repo();
    try {
      // A single, isolated deletion: nothing else in the change set, so the entries array has
      // exactly one element and the expected digest is reproducible by hand.
      const lsTree = r.g('ls-tree', 'main', '--', 'README.md').trim();
      const match = lsTree.match(/^(\d+) blob ([0-9a-f]+)\t/);
      assert.ok(match, 'fixture setup: README.md must be a tracked blob on main');
      const [, srcMode, srcSha] = match;

      r.g('checkout', '-q', '-b', 'feat');
      rmSync(join(r.dir, 'README.md'));
      r.g('add', '-A'); r.g('commit', '-qm', 'delete README.md');

      const revision = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      const digest = changeSetDigest(revision);

      const DOCUMENTED_NULL_OBJECT = '0'.repeat(40);
      const DOCUMENTED_DELETED_MODE = '000000';
      const entry = ['README.md', srcMode, srcSha, DOCUMENTED_DELETED_MODE, DOCUMENTED_NULL_OBJECT].join(' ');
      const expectedHash = createHash('sha256');
      expectedHash.update(Buffer.from(entry));
      expectedHash.update('\0');

      assert.equal(digest, expectedHash.digest('hex'),
        'the deleted-path identity must match a hash built from the DOCUMENTED all-zero sentinel — ' +
        'any other 40-hex-char constant would fail this exact comparison');
    } finally { clean(r.dir); }
  });

  // A symlink's blob is its TARGET STRING. `hash-object <path>` opens and FOLLOWS the link, which
  // fails outright for a symlink to a directory ("fatal: Unable to hash") — and this repo tracks
  // exactly that (plugins/adlc-cursor/commands). Not covered by the six review findings.
  it('handles a retargeted SYMLINK, including one pointing at a directory', () => {
    const r = repo();
    try {
      mkdirSync(join(r.dir, 'realdir'), { recursive: true });
      mkdirSync(join(r.dir, 'otherdir'), { recursive: true });
      writeFileSync(join(r.dir, 'realdir', 'a.txt'), 'hi\n');
      writeFileSync(join(r.dir, 'otherdir', 'b.txt'), 'yo\n');
      symlinkSync('realdir', join(r.dir, 'linkdir'));
      r.g('add', '-A'); r.g('commit', '-qm', 'add a symlink to a directory');
      r.g('checkout', '-q', '-b', 'feat');

      // The DIRECTORY symlink must itself be in the change set — that is the case hash-object
      // cannot survive. Retarget it in the WORKING TREE, so --raw reports dstsha as zeros too.
      rmSync(join(r.dir, 'linkdir'));
      symlinkSync('otherdir', join(r.dir, 'linkdir'));

      // Fixture sanity: this is exactly what would kill a hash-object-based implementation.
      assert.throws(
        () => execFileSync('git', ['hash-object', 'linkdir'], { cwd: r.dir, stdio: ['ignore', 'pipe', 'ignore'] }),
        'fixture sanity: hash-object really does fail on a symlink to a directory');

      const retargeted = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.ok(retargeted, 'a directory symlink in the change set must not crash the resolver');
      assert.match(retargeted, /^git-change:/);

      // A DANGLING symlink is the second case hash-object cannot open.
      symlinkSync('nowhere-at-all', join(r.dir, 'dangling'));
      r.g('add', '-A');
      const withDangling = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      assert.ok(withDangling, 'a dangling symlink must not crash the resolver either');
      assert.notEqual(withDangling, retargeted, 'adding a symlink is part of the reviewed change');

      // The identity tracks the TARGET STRING, which is what git stores for a symlink blob.
      rmSync(join(r.dir, 'linkdir'));
      symlinkSync('realdir', join(r.dir, 'linkdir')); // back to the original target
      assert.notEqual(resolveChangeSetRevision({ cwd: r.dir, base: 'main' }), withDangling,
        'retargeting a symlink changes what was reviewed');
    } finally { clean(r.dir); }
  });

  // AC16 / review finding R3. The finding prescribed `git hash-object --path=<path>`; measured,
  // that is a no-op for a file already at its working-tree path (git applies that path's own
  // attributes either way) and it would force one process per file, since --path is singular.
  // What actually decides CRLF-vs-LF is the ATTRIBUTE, which outranks core.autocrlf — so that is
  // what this pins. Without a text attribute the identity DOES follow core.autocrlf; the repo's
  // own `* text=auto eol=lf` is the control, and this test goes red if it is ever removed.
  it('AC16: with a text attribute, CRLF content hashes identically under any core.autocrlf', () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, '.gitattributes'), '* text=auto eol=lf\n');
      r.g('add', '-A'); r.g('commit', '-qm', 'pin eol');
      r.g('checkout', '-q', '-b', 'feat');
      writeFileSync(join(r.dir, 'crlf.txt'), 'alpha\r\nbeta\r\n'); // real CR bytes
      r.g('add', '-A'); r.g('commit', '-qm', 'add crlf file');

      let baseline;
      for (const value of ['false', 'true', 'input']) {
        r.g('config', 'core.autocrlf', value);
        const rev = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
        if (baseline === undefined) baseline = rev;
        assert.equal(rev, baseline,
          `identity moved under core.autocrlf=${value} — a Windows checkout would disagree with Linux CI`);
      }
    } finally { clean(r.dir); }
  });

  it('carries the gate-derived base sha in the identity, and is prefixed distinctly from the old form', () => {
    const r = repo();
    try {
      withChange(r);
      const rev = resolveChangeSetRevision({ cwd: r.dir, base: 'main' });
      const baseSha = execFileSync('git', ['rev-parse', 'main'], { cwd: r.dir, encoding: 'utf8' }).trim();
      assert.match(rev, /^git-change:/, 'must not collide with the git-worktree: form (F4)');
      assert.ok(rev.includes(baseSha), 'the base the change was reviewed against must be visible in the identity');
    } finally { clean(r.dir); }
  });
});

// The change-set component of `git-change:<base_sha>:<hash>`.
function changeSetOf(revision) {
  const parts = String(revision).split(':');
  return parts[parts.length - 1];
}
