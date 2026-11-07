// Rails for the scope index (spec: .adlc/specs/merge-forecast-scope-index.md).
//
// The index exists only to make merge-forecast faster, so its whole contract is
// "the same answers as before". Every test here compares it against the exact
// expression it replaces, built on core's globMatch, never against remembered
// outputs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch } from '@adlc/core';

import { compileGlob, createScopeIndex } from '../lib/scope-index.mjs';

// ─── The expressions the index replaces, verbatim from signals.mjs ──────────

function oldFiles(scope, repoFiles) {
  return repoFiles.filter((f) => (scope ?? []).some((g) => globMatch(g, f)));
}

function oldFilesNormalized(scope, repoFiles) {
  return repoFiles.filter((f) => {
    const fNorm = f.replace(/\\/g, '/');
    return (scope ?? []).some((g) => globMatch(g, fNorm));
  });
}

function oldMatches(scope, path) {
  return (scope ?? []).some((g) => globMatch(g, path));
}

// The outcome of a call, comparable across implementations: either the value
// or the error it threw, by constructor and message.
function outcome(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: `${err?.constructor?.name}: ${err?.message}` };
  }
}

/** Every concatenation of up to `maxLen` parts, plus the empty string. */
function build(parts, maxLen) {
  const out = [''];
  let level = [''];
  for (let n = 0; n < maxLen; n++) {
    level = level.flatMap((prefix) => parts.map((p) => prefix + p));
    out.push(...level);
  }
  return out;
}

// Deterministic PRNG (mulberry32), so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shapes real scopes use, next to the generated ones: literals, `dir/**`,
// and wildcards in the middle or at either end.
const REAL_PATTERNS = [
  'src/auth/**',
  'src/auth/login.mjs',
  'packages/*/lib/*.mjs',
  '**/*.test.mjs',
  '**/README.md',
  'app/votes/[pk]/**',
  'drizzle/0005_*',
  'docs/**/*.md',
  '.github/workflows/ci.yml',
  'src/**',
  '**',
  '*',
  'src/**/',
  'src/a**b/c',
  'a\\b/**',
];

const REAL_PATHS = [
  'src/auth/login.mjs',
  'src/auth/deep/x.mjs',
  'src/authz/x.mjs',
  'src',
  'src/',
  'packages/core/lib/glob.mjs',
  'packages/core/lib/sub/glob.mjs',
  'packages/core/test/glob.test.mjs',
  'README.md',
  'docs/README.md',
  'docs/guide/a.md',
  'app/votes/[pk]/page.tsx',
  'drizzle/0005_add.sql',
  'drizzle/0005_/x',
  '.github/workflows/ci.yml',
  'src/a/b/c',
  'src/ab/c',
  'a\\b/x',
  'a/b/x',
  '',
];

describe('compileGlob answers exactly what globMatch answers', () => {
  test('differential over a generated pattern × path corpus', () => {
    const patterns = [
      ...build(['a', 'b', '/', '*', '**', '**/', '.', '?', '[', '\\', '\n'], 3),
      ...REAL_PATTERNS,
    ];
    const paths = [...build(['a', 'b', '/', '.', 'ab', '?', '[', '\\', '\n'], 3), ...REAL_PATHS];
    let compared = 0;
    let matched = 0;
    for (const pattern of patterns) {
      const matcher = compileGlob(pattern);
      for (const path of paths) {
        const expected = globMatch(pattern, path);
        if (matcher(path) !== expected) {
          assert.fail(
            `compileGlob(${JSON.stringify(pattern)})(${JSON.stringify(path)}) !== ` +
              `globMatch → ${expected}`,
          );
        }
        compared += 1;
        if (expected) matched += 1;
      }
    }
    // A differential that never matches anything would pass while proving little.
    assert.ok(compared > 100000, `only ${compared} pairs compared`);
    assert.ok(matched > 1000, `only ${matched} matching pairs among ${compared}`);
  });

  test('each shape the matcher special-cases is covered, matching and not', () => {
    const cases = [
      // literal
      ['a/b.mjs', 'a/b.mjs', true],
      ['a/b.mjs', 'a/b.mjsx', false],
      ['a/b.mjs', 'xa/b.mjs', false],
      ['', '', true],
      ['', 'a', false],
      // literal followed by **
      ['src/**', 'src/', true],
      ['src/**', 'src/a/b', true],
      ['src/**', 'src', false],
      ['src/**', 'srcx/a', false],
      ['**', '', true],
      ['**', 'a/b', true],
      ['ab**', 'ab', true],
      // general: leading literal, trailing literal, minimum length
      ['src/*.mjs', 'src/a.mjs', true],
      ['src/*.mjs', 'lib/a.mjs', false],
      ['src/*.mjs', 'src/a.js', false],
      ['src/*.mjs', 'src/.mjs', true],
      ['src/*.mjs', 'src.mjs', false],
      ['ab**b', 'ab', false],
      ['ab**b', 'abb', true],
      ['ab*ba', 'aba', false],
      ['ab*ba', 'abba', true],
      ['**/x', 'x', true],
      ['**/x', 'a/x', true],
      ['**/x', 'ax', false],
      ['*', 'a/b', false],
      ['src/**/', 'src/', true],
      ['src/**/', 'src/a/', true],
      ['src/**/', 'src/a', false],
    ];
    for (const [pattern, path, expected] of cases) {
      assert.equal(globMatch(pattern, path), expected, `reference changed for ${pattern} / ${path}`);
      assert.equal(compileGlob(pattern)(path), expected, `compileGlob(${pattern})(${path})`);
    }
  });

  test('a non-string pattern compiles, then throws exactly as globMatch does', () => {
    for (const pattern of [undefined, null, 42, {}, ['a']]) {
      const matcher = outcome(() => compileGlob(pattern));
      assert.ok(!('error' in matcher), `compileGlob(${String(pattern)}) threw at compile time`);
      assert.deepEqual(
        outcome(() => matcher.value('a')),
        outcome(() => globMatch(pattern, 'a')),
        `matcher for ${String(pattern)}`,
      );
    }
  });
});

// A file list with the awkward cases in it: backslashes (which only the
// normalized view rewrites), duplicates, route brackets and migration prefixes.
const SEGMENTS = ['a', 'b', 'a.b', '[x]', '0005_y.sql', 'src'];
const FILES = [
  ...build(SEGMENTS.map((s) => `${s}/`), 2).flatMap((dir) => SEGMENTS.map((s) => dir + s)),
  'a\\b',
  'a\\b/c',
  'a\\b\\c',
  'src\\a.b',
  'a/a',
  'a/a',
  'a,b',
  '',
];

const SCOPE_PATTERNS = [
  ...REAL_PATTERNS,
  'a/**',
  'a/*',
  'a/b',
  'a/b/**',
  '**/a.b',
  '*/[x]/*',
  'src/**/*.sql',
  'b**',
  'a\\b',
  'a/b/c',
  'nothing/**',
  'a,b',
  'a,*',
];

function generatedScopes(count, seed) {
  const next = rng(seed);
  const scopes = [[]];
  for (let i = 0; i < count; i++) {
    const size = 1 + Math.floor(next() * 5);
    const scope = [];
    for (let j = 0; j < size; j++) scope.push(SCOPE_PATTERNS[Math.floor(next() * SCOPE_PATTERNS.length)]);
    scopes.push(scope);
  }
  return scopes;
}

describe('createScopeIndex returns exactly the old file sets', () => {
  test('files() equals the old filter: same elements, same order, duplicates kept', () => {
    const index = createScopeIndex(FILES);
    let nonEmpty = 0;
    for (const scope of generatedScopes(400, 1)) {
      const expected = oldFiles(scope, FILES);
      assert.deepEqual(index.files(scope), expected, `scope ${JSON.stringify(scope)}`);
      if (expected.length > 0) nonEmpty += 1;
    }
    assert.ok(nonEmpty > 100, `only ${nonEmpty} scopes matched anything`);
  });

  test('filesNormalized() equals the old import-radius filter, keeping the original strings', () => {
    const index = createScopeIndex(FILES);
    let differs = 0;
    for (const scope of generatedScopes(400, 2)) {
      const expected = oldFilesNormalized(scope, FILES);
      assert.deepEqual(index.filesNormalized(scope), expected, `scope ${JSON.stringify(scope)}`);
      if (JSON.stringify(expected) !== JSON.stringify(oldFiles(scope, FILES))) differs += 1;
    }
    // The two views must actually disagree somewhere, or this proves nothing
    // about which one the index serves.
    assert.ok(differs > 0, 'no scope told the normalized view from the raw one');
  });

  test('matches() equals the old some(), for paths inside and outside the file list', () => {
    const index = createScopeIndex(FILES);
    const paths = [...FILES, ...REAL_PATHS, 'src/imp-b/util.mjs', 'a/b/index.mjs'];
    for (const scope of generatedScopes(200, 3)) {
      for (const path of paths) {
        assert.equal(index.matches(scope, path), oldMatches(scope, path), `${JSON.stringify(scope)} / ${path}`);
      }
    }
  });

  test('an index over no files returns no files', () => {
    const index = createScopeIndex([]);
    assert.deepEqual(index.files(['**']), []);
    assert.deepEqual(index.filesNormalized(['**']), []);
  });
});

describe('createScopeIndex caches by scope content', () => {
  test('an equal scope in a different array returns the identical result', () => {
    const index = createScopeIndex(FILES);
    const first = index.files(['a/**', 'b']);
    assert.ok(first.length > 0);
    assert.equal(index.files(['a/**', 'b']), first, 'files() recomputed an equal scope');
    const firstNorm = index.filesNormalized(['a/**', 'b']);
    assert.equal(index.filesNormalized(['a/**', 'b']), firstNorm, 'filesNormalized() recomputed an equal scope');
  });

  test('different content is a different entry', () => {
    const index = createScopeIndex(FILES);
    const ab = index.files(['a/**']);
    const ba = index.files(['b/**']);
    assert.notEqual(ab, ba);
    assert.deepEqual(ab, oldFiles(['a/**'], FILES));
    assert.deepEqual(ba, oldFiles(['b/**'], FILES));
    // Order and multiplicity are part of a scope's content.
    assert.deepEqual(index.files(['b', 'a']), oldFiles(['b', 'a'], FILES));
    assert.deepEqual(index.files(['a', 'a']), oldFiles(['a', 'a'], FILES));
  });

  test('the raw and normalized views of one scope never answer for each other', () => {
    // Same index, same scope, both views, in both orders: a cache that served
    // one view's result for the other would only show up here, because the
    // raw and normalized answers differ only when a path holds a backslash.
    const scopes = [['a/**'], ['a/b'], ['src/a.b'], ['a/*'], ['**/c']];
    for (const order of ['raw-first', 'normalized-first']) {
      const index = createScopeIndex(FILES);
      for (const scope of scopes) {
        if (order === 'raw-first') index.files(scope);
        else index.filesNormalized(scope);
        assert.deepEqual(index.files(scope), oldFiles(scope, FILES), `${order} files(${scope})`);
        assert.deepEqual(
          index.filesNormalized(scope),
          oldFilesNormalized(scope, FILES),
          `${order} filesNormalized(${scope})`,
        );
      }
    }
    assert.notDeepEqual(oldFiles(['a/**'], FILES), oldFilesNormalized(['a/**'], FILES));
  });

  test('scopes whose globs join to the same text are different entries', () => {
    // A key built by joining the globs with any separator, or none, would
    // merge each of these pairs into one entry. Both orders, on one index.
    const differ = (first, second, files) => {
      const index = createScopeIndex(files);
      assert.deepEqual(index.files(first), oldFiles(first, files), JSON.stringify(first));
      assert.deepEqual(index.files(second), oldFiles(second, files), `${JSON.stringify(second)} after ${JSON.stringify(first)}`);
      assert.notDeepEqual(oldFiles(first, files), oldFiles(second, files), 'the pair must differ to prove anything');
    };
    const bothOrders = (one, two, files) => {
      differ(one, two, files);
      differ(two, one, files);
    };
    // Every single UTF-16 code unit as the separator, lone surrogates included,
    // each on its own three-file index, plus no separator at all.
    for (let code = 0; code <= 0xffff; code++) {
      const joined = `a${String.fromCharCode(code)}b`;
      bothOrders(['a', 'b'], [joined], ['a', 'b', joined]);
    }
    bothOrders(['a', 'b'], ['ab'], ['a', 'b', 'ab']);
    // Multi-character separators, including ones that mimic JSON's own.
    for (const sep of ['","', '", "', ', ', '/ ', '\u0000\u0000', '\r\n']) {
      const joined = `a${sep}b`;
      bothOrders(['a', 'b'], [joined], ['a', 'b', joined]);
    }
    // The shapes real scopes take.
    const files = ['src/', 'src/a.mjs', 'src/**', 'packages/core/x.mjs', 'packages/core/lib/a.mjs', 'lib/b.mjs'];
    bothOrders(['src/', '**'], ['src/**'], files);
    bothOrders(['src', '**'], ['src/**'], files);
    bothOrders(['packages/core', 'lib/**'], ['packages/core/lib/**'], files);
  });

  test('a sparse scope skips its holes, as some() does', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ['a/a', , 'a/b'];
    for (const files of [FILES, []]) {
      const index = createScopeIndex(files);
      assert.deepEqual(outcome(() => index.files(sparse)), outcome(() => oldFiles(sparse, files)));
      assert.deepEqual(
        outcome(() => index.filesNormalized(sparse)),
        outcome(() => oldFilesNormalized(sparse, files)),
      );
      assert.deepEqual(outcome(() => index.matcher(sparse)('a/b')), outcome(() => oldMatches(sparse, 'a/b')));
    }
    // Not vacuous: both globs after and before the hole do match.
    assert.deepEqual(new Set(createScopeIndex(FILES).files(sparse)), new Set(['a/a', 'a/b']));
  });

  test('matcher() answers as matches() does, and is built once per scope content', () => {
    const index = createScopeIndex(FILES);
    const paths = [...FILES, ...REAL_PATHS, 'a/b/index.mjs'];
    for (const scope of generatedScopes(100, 4)) {
      const match = index.matcher(scope);
      for (const path of paths) {
        assert.equal(match(path), oldMatches(scope, path), `${JSON.stringify(scope)} / ${path}`);
      }
    }
    assert.equal(index.matcher(['a/**', 'b']), index.matcher(['a/**', 'b']));
    assert.notEqual(index.matcher(['a/**']), index.matcher(['b/**']));
  });

  test('a returned array is not shared with the next index', () => {
    const one = createScopeIndex(FILES).files(['a/**']);
    const two = createScopeIndex(FILES).files(['a/**']);
    assert.notEqual(one, two);
    assert.deepEqual(one, two);
  });
});

describe('odd scopes keep the old failure behavior', () => {
  const ODD = [
    undefined,
    null,
    'a/**',
    42,
    { length: 1, 0: 'a' },
    ['a', 42],
    [42, 'a'],
    ['**', 42],
    [null],
    [undefined, '**'],
    // Matches `a\\b` only once its backslash is normalized, then hits the
    // non-string: the two views must stop, or not stop, where the old ones did.
    ['a/b', 42],
    // Falsy but not nullish: `scope ?? []` keeps them, so they throw.
    '',
    0,
    false,
    NaN,
  ];

  for (const files of [FILES, ['a'], ['a\\b'], []]) {
    test(`files(), filesNormalized() and matches() over ${files.length} file(s)`, () => {
      const index = createScopeIndex(files);
      for (const scope of ODD) {
        assert.deepEqual(
          outcome(() => index.files(scope)),
          outcome(() => oldFiles(scope, files)),
          `files(${JSON.stringify(scope)})`,
        );
        assert.deepEqual(
          outcome(() => index.filesNormalized(scope)),
          outcome(() => oldFilesNormalized(scope, files)),
          `filesNormalized(${JSON.stringify(scope)})`,
        );
        // Like the old `const bScope = b.scope ?? []`, building the matcher
        // never throws; any error comes when it is called.
        const built = outcome(() => index.matcher(scope));
        assert.ok(!('error' in built), `matcher(${JSON.stringify(scope)}) threw when built`);
        for (const path of ['a', 'b', '']) {
          assert.deepEqual(
            outcome(() => index.matches(scope, path)),
            outcome(() => oldMatches(scope, path)),
            `matches(${JSON.stringify(scope)}, ${path})`,
          );
          assert.deepEqual(
            outcome(() => built.value(path)),
            outcome(() => oldMatches(scope, path)),
            `matcher(${JSON.stringify(scope)})(${path})`,
          );
        }
      }
    });
  }
});
