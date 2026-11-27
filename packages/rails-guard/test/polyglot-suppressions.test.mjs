// Tests for polyglot, Biome, todo, and V8/c8/Istanbul suppression markers in rails-guard.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPRESSION_MARKERS,
  findSuppressions,
  isMarkerAllowed,
  parseAddedLines,
} from '../lib/suppressions.mjs';

// Marker literals are assembled from fragments so this scanned test file never
// carries a literal suppression token on an added diff line.
const PYTEST_SKIP = 'pytest.mark.' + 'skip';
const UNITTEST_SKIP = '@unittest.' + 'skip';
const TYPE_IGNORE = '# type: ' + 'ignore';
const PRAGMA_NO_COVER = '# pragma: ' + 'no cover';
const GO_T_SKIP = 't.' + 'Skip(';
const GO_NOLINT = '//' + 'nolint';
const RUST_ALLOW = '#[' + 'allow(';
const BIOME_IGNORE = 'biome-' + 'ignore';
const C8_IGNORE = 'c8 ' + 'ignore';
const V8_IGNORE = 'v8 ' + 'ignore';
const ISTANBUL_IGNORE = 'istanbul ' + 'ignore';
const DOT_TODO = '.to' + 'do(';

const POLYGLOT_CASES = [
  { file: 'tests/test_auth.py', marker: PYTEST_SKIP, line: `@${PYTEST_SKIP}(reason="flaky")` },
  { file: 'tests/test_legacy.py', marker: UNITTEST_SKIP, line: `${UNITTEST_SKIP}("deferred")` },
  { file: 'src/service.py', marker: TYPE_IGNORE, line: `val: int = raw  ${TYPE_IGNORE}[assignment]` },
  { file: 'src/branch.py', marker: PRAGMA_NO_COVER, line: `if unreachable:  ${PRAGMA_NO_COVER}` },
  { file: 'pkg/auth_test.go', marker: GO_T_SKIP, line: `\t${GO_T_SKIP}"temporarily disabled")` },
  { file: 'pkg/auth.go', marker: GO_NOLINT, line: `x := run() ${GO_NOLINT}:errcheck` },
  { file: 'src/lib.rs', marker: RUST_ALLOW, line: `${RUST_ALLOW}dead_code)]` },
  { file: 'src/check.ts', marker: BIOME_IGNORE, line: `// ${BIOME_IGNORE} lint/suspicious/noExplicitAny: legacy` },
  { file: 'src/cov-a.mjs', marker: C8_IGNORE, line: `/* ${C8_IGNORE} next */` },
  { file: 'src/cov-b.mjs', marker: V8_IGNORE, line: `/* ${V8_IGNORE} start */` },
  { file: 'src/cov-c.js', marker: ISTANBUL_IGNORE, line: `/* ${ISTANBUL_IGNORE} next */` },
  { file: 'test/suite.test.mjs', marker: DOT_TODO, line: `test${DOT_TODO}'write real assertion');` },
];

describe('polyglot and coverage SUPPRESSION_MARKERS', () => {
  test('includes every required polyglot, linter, coverage, and todo marker', () => {
    for (const { marker } of POLYGLOT_CASES) {
      assert.ok(SUPPRESSION_MARKERS.includes(marker), `missing marker: ${marker}`);
    }
  });

  test('detects each new suppression marker across Python, Go, Rust, and JS/TS diffs', () => {
    for (const { file, marker, line } of POLYGLOT_CASES) {
      const diff = [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        '@@ -1 +1,2 @@',
        ' unchanged',
        `+${line}`,
        '',
      ].join('\n');
      const found = findSuppressions(parseAddedLines(diff));
      assert.equal(found.length, 1, `expected violation in ${file}`);
      assert.equal(found[0].file, file);
      assert.equal(found[0].marker, marker);
      assert.equal(found[0].lineNo, 2);
    }
  });

  test('preserves .md/.markdown/.diff/.patch doc exemptions and .mdx inline/fenced prose exemptions', () => {
    const docLines = POLYGLOT_CASES.flatMap(({ line }, idx) => [
      { file: 'docs/guide.md', lineNo: idx + 1, content: line },
      { file: 'docs/notes.markdown', lineNo: idx + 1, content: line },
      { file: 'fixtures/sample.diff', lineNo: idx + 1, content: `+${line}` },
      { file: 'fixtures/sample.patch', lineNo: idx + 1, content: `+${line}` },
    ]);
    assert.deepEqual(findSuppressions(docLines), []);

    const mdxInline = POLYGLOT_CASES.map(({ marker }, idx) => ({
      file: 'apps/docs/page.mdx',
      lineNo: idx + 1,
      content: `Documenting \`${marker}\` in prose.`,
    }));
    assert.deepEqual(findSuppressions(mdxInline), []);

    const mdxFenced = [{ file: 'apps/docs/page.mdx', lineNo: 12, content: `// ${BIOME_IGNORE} lint` }];
    assert.deepEqual(findSuppressions(mdxFenced, { isFenced: () => true }), []);
    assert.equal(findSuppressions(mdxFenced, { isFenced: () => false }).length, 1);
  });

  test('honors exact allow-suppression declarations per polyglot marker', () => {
    for (const { marker } of POLYGLOT_CASES) {
      assert.equal(isMarkerAllowed(marker, `allow-suppression: ${marker}`), true);
      assert.equal(isMarkerAllowed(marker, 'allow-suppression: other'), false);
    }
  });
});
