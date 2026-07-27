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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveChangeSetRevision } from '../lib/revision.mjs';

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
