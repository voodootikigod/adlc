// Contract tests for the shared CommonMark fenced-code helper (used by rails-guard
// and spec-lint). The exhaustive adversarial cases live in rails-guard's
// suppressions test; these pin the core-owned contract directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeFencedLines } from '../lib/markdown.mjs';

describe('computeFencedLines', () => {
  test('marks interior lines only, not the fence delimiters', () => {
    const content = ['prose', '```sh', 'interior', '```', 'after'].join('\n');
    assert.deepEqual([...computeFencedLines(content)], [3]);
  });

  test('a shorter run does not close a longer fence (nested fences do not desync)', () => {
    const content = ['````mdx', '```', 'still inside', '````', 'operative'].join('\n');
    const fenced = computeFencedLines(content);
    assert.deepEqual([...fenced].sort((a, b) => a - b), [2, 3]);
    assert.equal(fenced.has(5), false, 'line after the real 4-backtick closer is not fenced');
  });

  test('a CRLF closer still closes (line endings normalized before matching)', () => {
    const content = '```sh\ninterior\n```\r\nafter\n';
    const fenced = computeFencedLines(content);
    assert.equal(fenced.has(2), true);
    assert.equal(fenced.has(4), false);
  });

  test('supports tilde fences and returns empty for non-string/empty input', () => {
    assert.deepEqual([...computeFencedLines(['x', '~~~', 'in', '~~~'].join('\n'))], [3]);
    assert.equal(computeFencedLines('').size, 0);
    assert.equal(computeFencedLines(null).size, 0);
  });

  test('a backtick run whose info string contains a backtick is NOT a fence opener', () => {
    // Guards inline code like ` ```code` ` from being read as a block-fence opener.
    // Were this rule dropped, the following line would be treated as fenced interior.
    const content = ['prose', '```not`valid', 'operative marker line', 'more'].join('\n');
    assert.equal(computeFencedLines(content).size, 0, 'no valid fence opened → nothing fenced');
  });

  test('unclosedToEof controls the fail direction for an unclosed fence', () => {
    const content = ['before', '```', 'a', 'b'].join('\n'); // opener, no closer
    // Default (true): interior extends to EOF (MDX-inert semantics).
    assert.deepEqual([...computeFencedLines(content)].sort((a, b) => a - b), [3, 4]);
    // false: an unclosed fence marks nothing (caller will scan those lines).
    assert.equal(computeFencedLines(content, { unclosedToEof: false }).size, 0);
    // A CLOSED fence is unaffected by the flag.
    const closed = ['before', '```', 'a', '```', 'after'].join('\n');
    assert.deepEqual([...computeFencedLines(closed, { unclosedToEof: false })], [3]);
  });
});
