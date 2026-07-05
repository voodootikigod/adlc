// Tests for suppression-marker detection (pure logic — no git, no disk I/O).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddedLines, findSuppressions, isMarkerAllowed, isDocFile, computeFencedLines } from '../lib/suppressions.mjs';

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

  // --- MDX prose code-contexts: markers inside Markdown inline-code spans and fenced
  //     code blocks render as literal text and can never be an operative suppression.
  //     They are exempt for .mdx; a marker in the MDX ESM/JSX layer stays scanned.
  test('does NOT flag a marker inside an .mdx inline-code span (prose false positive)', () => {
    const lines = [{ file: 'apps/docs/x.mdx', lineNo: 24, content: `markers (\`${TSIG}\`, \`${SKIP}\`, …) are reverted` }];
    assert.deepEqual(findSuppressions(lines), []);
  });

  test('DOES flag a real marker OUTSIDE the inline-code span on the same .mdx line', () => {
    // First occurrence is prose in a span; a second, bare occurrence is operative ESM.
    const lines = [{ file: 'apps/docs/x.mdx', lineNo: 5, content: `see \`${TSIG}\` — then const a = 1; ${TSIG}` }];
    assert.equal(findSuppressions(lines).length, 1);
  });

  test('DOES flag a call-marker hidden in a template-literal interpolation (HIT 3)', () => {
    // A test-focus call inside a ${...} interpolation is operative JS, not an inert
    // Markdown span, so it must not be stripped. (Marker assembled to avoid self-trip.)
    const only = '.on' + 'ly(';
    const lines = [{ file: 'apps/docs/x.mdx', lineNo: 9, content: '<X>{`${describe' + only + 't)}`}</X>' }];
    assert.equal(findSuppressions(lines).length, 1);
  });

  test('does NOT flag a marker on an .mdx line the isFenced predicate marks as fenced', () => {
    const lines = [{ file: 'apps/docs/rails-guard.mdx', lineNo: 55, content: `  [suppression] src/foo.ts:12  marker: ${TSIG}` }];
    const isFenced = (file, lineNo) => file === 'apps/docs/rails-guard.mdx' && lineNo === 55;
    assert.deepEqual(findSuppressions(lines, { isFenced }), []);
  });

  test('DOES flag a real .mdx marker on a line the isFenced predicate marks NOT fenced', () => {
    const lines = [{ file: 'apps/docs/x.mdx', lineNo: 80, content: `export const meta = {}; // ${TSIG}` }];
    const isFenced = () => false; // outside any fence
    assert.equal(findSuppressions(lines, { isFenced }).length, 1);
  });

  test('isFenced predicate does NOT apply to code files (only .mdx is prose)', () => {
    // Even if a predicate lied about a .ts line, findSuppressions never consults it for code.
    const lines = [{ file: 'src/a.ts', lineNo: 10, content: `// ${TSIG}` }];
    const isFenced = () => true;
    assert.equal(findSuppressions(lines, { isFenced }).length, 1);
  });

  test('fails CLOSED: a fenced .mdx marker is scanned when no isFenced predicate is supplied', () => {
    const lines = [{ file: 'apps/docs/x.mdx', lineNo: 5, content: `bare operative ${TSIG}` }];
    assert.equal(findSuppressions(lines).length, 1);
  });
});

describe('computeFencedLines', () => {
  const fence = '```';
  const TSIG = '@ts-' + 'ignore';

  test('marks interior lines of a fenced block, not the delimiters', () => {
    const content = [
      'intro prose',       // 1
      `${fence}sh`,        // 2  opener
      `marker ${TSIG}`,    // 3  interior — fenced
      'more output',       // 4  interior — fenced
      `${fence}`,          // 5  closer
      'trailing prose',    // 6
    ].join('\n');
    const fenced = computeFencedLines(content);
    assert.deepEqual([...fenced].sort((a, b) => a - b), [3, 4]);
  });

  test('an unclosed fence extends to end of file (fails closed by marking everything inside)', () => {
    const content = ['before', `${fence}`, 'a', 'b'].join('\n');
    assert.deepEqual([...computeFencedLines(content)].sort((a, b) => a - b), [3, 4]);
  });

  test('returns an empty set for empty or non-string input', () => {
    assert.equal(computeFencedLines('').size, 0);
    assert.equal(computeFencedLines(null).size, 0);
    assert.equal(computeFencedLines(undefined).size, 0);
  });

  test('supports tilde fences and indented delimiters', () => {
    const content = ['x', '  ~~~', '  fenced', '  ~~~', 'y'].join('\n');
    assert.deepEqual([...computeFencedLines(content)], [3]);
  });

  test('a shorter run does NOT close a longer fence — nested fences do not desync (HIT 1)', () => {
    const bt4 = '````', bt3 = '```';
    const content = [
      'intro',        // 1
      `${bt4}mdx`,    // 2  opener (4 backticks)
      bt3,            // 3  interior 3-backtick — too short to close
      'sample',       // 4  interior
      bt4,            // 5  real closer (4 backticks)
      'operative',    // 6  OUTSIDE the fence — must NOT be marked
    ].join('\n');
    const fenced = computeFencedLines(content);
    assert.deepEqual([...fenced].sort((a, b) => a - b), [3, 4]);
    assert.equal(fenced.has(6), false, 'line after the real closer must be operative, not fenced');
  });

  test('a tilde run does NOT close a backtick fence (fence character must match)', () => {
    const content = ['```', 'interior', '~~~', 'still interior'].join('\n');
    // The ~~~ does not close the ``` fence; both interior lines stay fenced (unclosed → EOF).
    assert.deepEqual([...computeFencedLines(content)].sort((a, b) => a - b), [2, 3, 4]);
  });

  test('a fewer-than-three backtick/tilde line does NOT open a fence (HIT 2)', () => {
    for (const delim of ['`', '``', '~', '~~']) {
      const content = ['before', delim, 'neighbor', delim, 'after'].join('\n');
      assert.equal(computeFencedLines(content).size, 0, `"${delim}" must not open a fence`);
    }
  });

  test('a closer with trailing content does NOT close the fence (CommonMark)', () => {
    const content = ['```', 'interior', '``` trailing text', 'still interior'].join('\n');
    // "``` trailing text" is not a valid closer → fence stays open to EOF.
    assert.deepEqual([...computeFencedLines(content)].sort((a, b) => a - b), [2, 3, 4]);
  });

  test('a CRLF fence closer still closes the fence — no line-ending desync (CRLF HIT)', () => {
    const bt = '```';
    // LF opener, CRLF closer, LF operative line after. The `\r` must not defeat the closer.
    const content = `${bt}sh\ninterior\n${bt}\r\noperative after closer\n`;
    const fenced = computeFencedLines(content);
    assert.deepEqual([...fenced].sort((a, b) => a - b), [2]);
    assert.equal(fenced.has(4), false, 'operative line after a CRLF closer must be scanned, not fenced');
  });

  test('a CRLF-throughout fenced block is detected (Windows-authored docs, no false positives)', () => {
    const bt = '```';
    const content = `${bt}sh\r\ninterior1\r\ninterior2\r\n${bt}\r\nafter\r\n`;
    assert.deepEqual([...computeFencedLines(content)].sort((a, b) => a - b), [2, 3]);
  });

  test('an embedded bare CR fails CLOSED — the line is not treated as inert', () => {
    const bt = '```';
    // Fence opens, then a line carrying a bare mid-line CR — must not stay fenced.
    const content = `${bt}\ninterior\nmarker\rmore\nplain\n`;
    const fenced = computeFencedLines(content);
    assert.equal(fenced.has(3), false, 'a line with an embedded CR must be scanned, not fenced');
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
