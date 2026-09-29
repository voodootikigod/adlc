// Prose tool-log lines count toward the depth signal whether or not the log
// prefixes them with indentation or a timestamp. Under-counting is the
// fail-open direction (a deep session slips under the hard band), so these
// shapes are pinned; over-counting re-introduces false lockouts, so prose that
// merely MENTIONS a verb mid-sentence, or a JSONL record whose string content
// contains one, must still count 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countToolCalls, PROSE_TOOL_LINE } from '../lib/depth-signal.mjs';
import { PROSE_CASES } from './fixtures/prose-tool-lines.mjs';


for (const [label, text, expected] of PROSE_CASES) {
  test(`countToolCalls: ${label} → ${expected}`, () => {
    assert.equal(countToolCalls(text), expected);
  });
}

test('PROSE_TOOL_LINE is a global multiline matcher (one match per line)', () => {
  assert.ok(PROSE_TOOL_LINE.global && PROSE_TOOL_LINE.multiline);
});

test('JSONL tool_use records and prefixed prose lines add up', () => {
  const text = '{"type":"tool_use","name":"Write"}\n12:00:01 Writing src/a.mjs\n  Created src/b.mjs';
  assert.equal(countToolCalls(text), 3);
});
