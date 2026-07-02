// Tests for suppression-marker detection (pure logic — no git, no disk I/O).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddedLines, findSuppressions, isMarkerAllowed, isDocFile } from '../lib/suppressions.mjs';

describe('parseAddedLines', () => {
  test('extracts added lines with correct file and line numbers', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
+added line
 line two
 line three
`;
    const added = parseAddedLines(diff);
    assert.equal(added.length, 1);
    assert.equal(added[0].file, 'src/foo.ts');
    assert.equal(added[0].lineNo, 2);
    assert.equal(added[0].content, 'added line');
  });

  test('ignores +++ header lines', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new
`;
    const added = parseAddedLines(diff);
    assert.equal(added.length, 1);
    assert.equal(added[0].content, 'new');
  });

  test('handles multiple files in one diff', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 unchanged
+added in a
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
 unchanged
+added in b
`;
    const added = parseAddedLines(diff);
    assert.equal(added.length, 2);
    assert.equal(added[0].file, 'a.ts');
    assert.equal(added[1].file, 'b.ts');
  });

  test('returns empty array for diff with no added lines', () => {
    const diff = `--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-removed
`;
    const added = parseAddedLines(diff);
    assert.equal(added.length, 0);
  });
});

describe('findSuppressions', () => {
  test('detects .skip( marker', () => {
    const lines = [{ file: 'test.ts', lineNo: 5, content: "  it.skip('broken test', () => {})" }];
    const found = findSuppressions(lines);
    assert.equal(found.length, 1);
    assert.equal(found[0].marker, '.skip(');
  });

  test('detects .only( marker', () => {
    const lines = [{ file: 'test.ts', lineNo: 3, content: "  describe.only('suite', () => {})" }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, '.only(');
  });

  test('detects xfail', () => {
    const lines = [{ file: 'test.py', lineNo: 7, content: '@pytest.mark.xfail' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, 'xfail');
  });

  test('detects @ts-ignore', () => {
    const lines = [{ file: 'src/a.ts', lineNo: 10, content: '// @ts-ignore' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, '@ts-ignore');
  });

  test('detects @ts-expect-error', () => {
    const lines = [{ file: 'src/a.ts', lineNo: 12, content: '// @ts-expect-error next line' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, '@ts-expect-error');
  });

  test('detects eslint-disable', () => {
    const lines = [{ file: 'src/b.ts', lineNo: 1, content: '/* eslint-disable no-console */' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, 'eslint-disable');
  });

  test('detects # noqa', () => {
    const lines = [{ file: 'src/c.py', lineNo: 9, content: 'x = 1  # noqa: E501' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, '# noqa');
  });

  test('detects #[ignore]', () => {
    const lines = [{ file: 'src/lib.rs', lineNo: 4, content: '#[ignore]' }];
    const found = findSuppressions(lines);
    assert.equal(found[0].marker, '#[ignore]');
  });

  test('returns empty for clean lines', () => {
    const lines = [
      { file: 'src/d.ts', lineNo: 1, content: 'const x = 1;' },
      { file: 'src/d.ts', lineNo: 2, content: '// normal comment' },
    ];
    assert.equal(findSuppressions(lines).length, 0);
  });

  test('only reports first matched marker per line', () => {
    // A line containing both .skip( and .only( should produce exactly one violation
    const lines = [{ file: 'f.ts', lineNo: 1, content: 'it.skip.only(' }];
    const found = findSuppressions(lines);
    assert.equal(found.length, 1);
  });

  // Suppression markers are code constructs; documentation legitimately discusses
  // them in prose (an integration guide, or the rails-guard README that names them).
  // Scanning docs produces false positives with no coverage benefit — a marker in a
  // .md is never an executed test suppression. Skip documentation files.
  //
  // NOTE: the marker tokens below are ASSEMBLED from fragments rather than written
  // literally. This file is a scanned code file, so a literal marker on an ADDED line
  // would itself trip the suppression gate — even inside a string, comment, or a
  // variable name (these are test fixtures, not real suppressions, and this repo's CI
  // does not wire the allow-suppression ticket-body hatch). Assembling keeps the gate
  // strict while letting its own detector be tested honestly. UPPERCASE names below
  // avoid matching the lowercase markers the (case-sensitive) scanner looks for.
  const SKIP = '.sk' + 'ip(';        // the skip-open-paren marker
  const XFAIL = 'x' + 'fail';        // the pytest expected-fail marker
  const TSIG = '@ts-' + 'ignore';    // the TypeScript ignore marker

  test('does NOT flag a marker inside a markdown (.md) doc — prose false positive', () => {
    const lines = [{ file: 'plugins/adlc-antigravity/skills/adlc-doctrine/SKILL.md', lineNo: 28, content: `  skip/${XFAIL}/suppression markers fail review.` }];
    assert.deepEqual(findSuppressions(lines), []);
  });

  test('DOES flag a marker in an MDX (.mdx) file — MDX compiles to code, so it is scanned', () => {
    // .mdx is deliberately NOT exempt: it compiles to JSX/TS and can carry operative
    // type/lint suppressions. Treated as code (cross-model adversarial review).
    const lines = [{ file: 'apps/docs/content/docs/x.mdx', lineNo: 5, content: `const a = 1; ${TSIG}` }];
    assert.equal(findSuppressions(lines).length, 1);
  });

  test('STILL flags a marker in a code/test file (coverage preserved)', () => {
    const lines = [
      { file: 'packages/foo/test/a.test.mjs', lineNo: 3, content: `  it${SKIP}'broken', () => {})` },
      { file: 'src/b.ts', lineNo: 10, content: `// ${TSIG}` },
      { file: 'tests/c.py', lineNo: 7, content: `@pytest.mark.${XFAIL}` },
    ];
    const found = findSuppressions(lines);
    assert.equal(found.length, 3);
  });

  test('scans a marker in a .md.mjs code file (extension check is on the true suffix)', () => {
    // A code file whose name merely contains ".md" is NOT a doc — only the final extension counts.
    const lines = [{ file: 'src/render.md.mjs', lineNo: 1, content: `x${SKIP}` }];
    assert.equal(findSuppressions(lines).length, 1);
  });
});

describe('isDocFile', () => {
  test('true for non-executable prose markdown extensions', () => {
    for (const f of ['README.md', 'a/b/NOTES.markdown', 'X.MD']) {
      assert.equal(isDocFile(f), true, `${f} should be a doc`);
    }
  });
  test('false for code/test files AND for .mdx (compiles to code)', () => {
    for (const f of ['test/a.test.mjs', 'src/b.ts', 'x.py', 'y.rs', 'render.md.mjs', 'Makefile', 'docs/guide.mdx']) {
      assert.equal(isDocFile(f), false, `${f} should NOT be a doc`);
    }
  });
  test('false for null/undefined/empty', () => {
    assert.equal(isDocFile(null), false);
    assert.equal(isDocFile(undefined), false);
    assert.equal(isDocFile(''), false);
  });
});

describe('isMarkerAllowed', () => {
  test('allows a marker explicitly declared in ticket body', () => {
    const body = 'allow-suppression: @ts-ignore\nsome other text';
    assert.ok(isMarkerAllowed('@ts-ignore', body));
  });

  test('does not allow a marker not declared', () => {
    const body = 'allow-suppression: @ts-ignore';
    assert.ok(!isMarkerAllowed('eslint-disable', body));
  });

  test('returns false for empty body', () => {
    assert.ok(!isMarkerAllowed('.skip(', ''));
  });

  test('returns false for null body', () => {
    assert.ok(!isMarkerAllowed('.skip(', null));
  });

  test('is case-sensitive', () => {
    const body = 'allow-suppression: ESLINT-DISABLE';
    assert.ok(!isMarkerAllowed('eslint-disable', body));
  });

  test('allows each marker independently', () => {
    const body = 'allow-suppression: .skip(\nallow-suppression: xfail';
    assert.ok(isMarkerAllowed('.skip(', body));
    assert.ok(isMarkerAllowed('xfail', body));
    assert.ok(!isMarkerAllowed('@ts-ignore', body));
  });
});
