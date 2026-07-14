// Concern: @adlc/core resolveRevision() must honor an ignore path even when it is
// expressed via a SYMLINK ALIAS of cwd. Regression guard for PR #182.
//
// This test lives in @adlc/prosecute rather than @adlc/core because packages/core
// is rail-frozen (tickets T42-T44); it exercises the exported resolveRevision
// directly. Bug it guards: on macOS process.cwd() reports the realpath
// (/private/var/...) while evidence paths recorded in a P5 passes.json are stored
// in the /var/... symlink form. Before the fix, relative(cwd, path) produced a
// '../'-escaping path, the evidence file silently dropped out of the ignore set,
// and the worktree revision hashed evidence that itself embeds the revision —
// making the git-worktree: hash non-deterministic across cwd forms. The test forces
// the same condition portably with an explicit symlink (no /var dependency).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRevision } from '@adlc/core';

describe('@adlc/core resolveRevision — symlinked ignore paths', () => {
  it('honors an ignore path given via a symlink alias of cwd (revision stays stable)', () => {
    // realpathSync so `real` is canonical — the same form process.cwd() would report.
    const real = realpathSync.native(mkdtempSync(join(tmpdir(), 'rev-real-')));
    const g = (...a) => execFileSync('git', a, { cwd: real, stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.co');
    g('config', 'user.name', 'tester');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(real, 'tracked.txt'), 'baseline\n');
    g('add', '-A');
    g('commit', '-qm', 'baseline');

    // An untracked evidence-like file we want excluded from the revision hash.
    const evidence = join(real, 'evidence.txt');
    writeFileSync(evidence, 'v1\n');

    // Reference that SAME file through a symlink alias of the repo root — the alias
    // form that broke ignore-matching before the fix.
    const aliasParent = realpathSync.native(mkdtempSync(join(tmpdir(), 'rev-alias-')));
    const alias = join(aliasParent, 'link');
    symlinkSync(real, alias);
    const aliasEvidence = join(alias, 'evidence.txt');

    const rev1 = resolveRevision({ cwd: real, ignorePaths: [aliasEvidence] });
    writeFileSync(evidence, 'v2-changed-content\n'); // mutate the file that must be ignored
    const rev2 = resolveRevision({ cwd: real, ignorePaths: [aliasEvidence] });

    assert.equal(rev1, rev2,
      'a symlink-alias ignore path must be honored — otherwise the ignored file leaks into the hash and the revision is unstable');
    // Sanity: the alias-form ignore genuinely excluded the file (not a no-op match on
    // an empty set) — a NON-ignored mutation must change the revision.
    const revNoIgnore = resolveRevision({ cwd: real, ignorePaths: [] });
    assert.notEqual(rev1, revNoIgnore, 'guard is meaningful: without the ignore, evidence.txt changes the revision');
  });
});
