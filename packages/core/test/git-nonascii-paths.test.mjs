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

import { git, changedFiles, gitDiff, splitNulPaths, GIT_MAX_BUFFER } from '../lib/git.mjs';

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

  test('git() caps output at 64 MiB', () => {
    assert.strictEqual(GIT_MAX_BUFFER, 64 * 1024 * 1024);
  });
});

// #249 — the byte level below C-quoting. `-z` avoids quoting, but the OUTPUT was
// then decoded as UTF-8 before splitting, and UTF-8 decoding is not injective:
// every invalid byte becomes U+FFFD, so two distinct paths on disk collapse to
// one string and a gate keyed on that string answers for the wrong file. The
// split must happen on the BUFFER, and a path that cannot round-trip must fail
// closed rather than alias another.
describe('splitNulPaths — buffer-level split, fail closed on lossy decode (#249)', () => {
  const enc = (s) => Buffer.from(s, 'utf8');

  test('splits valid NUL-delimited paths', () => {
    const buf = Buffer.concat([enc('a/x.json'), Buffer.from([0]), enc('b/y.json'), Buffer.from([0])]);
    assert.deepEqual(splitNulPaths(buf), ['a/x.json', 'b/y.json']);
  });

  test('preserves valid non-ASCII paths exactly (no normalisation)', () => {
    const buf = Buffer.concat([enc('café/π.json'), Buffer.from([0])]);
    assert.deepEqual(splitNulPaths(buf), ['café/π.json']);
  });

  test('a trailing NUL does not yield an empty entry', () => {
    assert.deepEqual(splitNulPaths(Buffer.concat([enc('only.json'), Buffer.from([0])])), ['only.json']);
  });

  test('a leading NUL does not yield an empty entry, and does not leak into the next path', () => {
    const buf = Buffer.concat([Buffer.from([0]), enc('only.json'), Buffer.from([0])]);
    assert.deepEqual(splitNulPaths(buf), ['only.json']);
  });

  test('two paths differing only in INVALID bytes do not collapse — they throw', () => {
    // This is the whole point: bad-\x80/p.json and bad-\xEF\xBF\xBD/p.json both
    // decode to bad-�/p.json. A tolerant splitter would return ONE entry for two
    // files. splitNulPaths refuses the invalid one instead.
    const invalid = Buffer.concat([enc('bad-'), Buffer.from([0x80]), enc('/p.json'), Buffer.from([0])]);
    assert.throws(() => splitNulPaths(invalid), /not valid UTF-8|#249/);
  });

  test('the fail-closed error names UTF-8 specifically, not just #249', () => {
    // The `|#249` alternation above also matches if this wording drifts (e.g. a
    // typo'd encoding name), so pin the encoding name on its own here.
    const invalid = Buffer.concat([enc('bad-'), Buffer.from([0x80]), enc('/p.json'), Buffer.from([0])]);
    assert.throws(() => splitNulPaths(invalid), /not valid UTF-8/);
  });

  test('a lone surrogate byte sequence fails closed', () => {
    const loneSurrogate = Buffer.concat([enc('x-'), Buffer.from([0xED, 0xA0, 0x80]), enc('.json'), Buffer.from([0])]);
    assert.throws(() => splitNulPaths(loneSurrogate), /not valid UTF-8|#249/);
  });

  test('one bad path fails the whole batch — no silent partial result', () => {
    // A gate must not act on a partial changed-file set it believes is complete.
    const buf = Buffer.concat([
      enc('good.json'), Buffer.from([0]),
      enc('bad-'), Buffer.from([0xC0]), enc('.json'), Buffer.from([0]),
    ]);
    assert.throws(() => splitNulPaths(buf), /not valid UTF-8|#249/);
  });

  test('empty input yields no paths', () => {
    assert.deepEqual(splitNulPaths(Buffer.alloc(0)), []);
    assert.deepEqual(splitNulPaths(enc('')), []);
  });

  test('accepts a string for already-decoded callers (documented weaker guarantee)', () => {
    assert.deepEqual(splitNulPaths('a\0b\0'), ['a', 'b']);
  });
});
