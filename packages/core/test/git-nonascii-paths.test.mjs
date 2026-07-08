// Regression: git C-quotes non-ASCII paths in `diff --name-only` / patch headers
// unless -z (name lists) or core.quotepath=false (patch text) is used. The quoted
// string is a DISPLAY form, not the authoritative path — a scanner fed that string
// (e.g. rails-guard's checkRailEdits) fails to match a real rail path, so editing a
// rail-frozen file with a non-ASCII name silently evades the freeze gate.
// See docs/review-lenses/text-scanning-gates.md (authoritative-source check).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, changedFiles, gitDiff } from '../lib/git.mjs';

const NON_ASCII = 'café.js'; // U+00E9 — git quotes this as "caf\303\251.js" by default

function repoWithRenamedFile() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-git-nonascii-'));
  const g = (args) => git(args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  const base = g(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, NON_ASCII), 'const frozen = true;\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'add non-ascii file']);
  return { dir, base };
}

describe('git helpers return authoritative (unquoted) paths', () => {
  test('changedFiles yields the real non-ASCII path, not git\'s C-quoted display form', () => {
    const { dir, base } = repoWithRenamedFile();
    try {
      const files = changedFiles(base, dir);
      assert.ok(files.includes(NON_ASCII), `expected raw "${NON_ASCII}", got ${JSON.stringify(files)}`);
      // The quoted display form must NOT be what a downstream matcher receives.
      assert.ok(!files.some((f) => f.includes('\\303')), 'must not contain a C-quoted octal escape');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changedFiles handles a space in the path (the -z name-list path is fully raw)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-git-space-'));
    const g = (args) => git(args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      g(['init', '-q']);
      g(['config', 'user.email', 't@t']);
      g(['config', 'user.name', 't']);
      g(['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(dir, 'README.md'), 'base\n');
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'base']);
      const base = g(['rev-parse', 'HEAD']).trim();
      writeFileSync(join(dir, 'spaced name.js'), 'const x = 1;\n');
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'add spaced']);
      const files = changedFiles(base, dir);
      assert.ok(files.includes('spaced name.js'), `expected raw spaced path, got ${JSON.stringify(files)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('gitDiff patch headers carry the real non-ASCII path (quotepath disabled)', () => {
    const { dir, base } = repoWithRenamedFile();
    try {
      const diff = gitDiff(base, dir);
      assert.ok(diff.includes(NON_ASCII), 'diff header should contain the raw path');
      assert.ok(!diff.includes('caf\\303\\251'), 'diff header must not contain the C-quoted form');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
