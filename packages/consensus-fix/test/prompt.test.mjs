/**
 * Tests for prompt building and tail utility.
 * Pure — no I/O.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tail, buildPrompt } from '../lib/prompt.mjs';

test('tail returns the string unchanged when within limit', () => {
  assert.equal(tail('hello', 100), 'hello');
});

test('tail truncates to last maxChars characters', () => {
  const long = 'a'.repeat(5000);
  const result = tail(long, 4000);
  assert.equal(result.length, 4000);
  assert.equal(result, 'a'.repeat(4000));
});

test('tail with default 4000 chars', () => {
  const long = 'x'.repeat(6000);
  const result = tail(long);
  assert.equal(result.length, 4000);
});

test('buildPrompt includes test command', () => {
  const prompt = buildPrompt({
    testCmd: 'node --test test/foo.test.mjs',
    testOutput: 'Error: assertion failed',
    snapshot: { 'src/foo.mjs': 'export const x = 1;' },
  });
  assert.ok(prompt.includes('node --test test/foo.test.mjs'));
});

test('buildPrompt includes test output', () => {
  const output = 'Error: assertion failed at line 42';
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: output,
    snapshot: { 'a.mjs': 'code' },
  });
  assert.ok(prompt.includes(output));
});

test('buildPrompt includes file name and content', () => {
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: 'fail',
    snapshot: {
      'src/util.mjs': 'export function add(a, b) { return a - b; }',
    },
  });
  assert.ok(prompt.includes('src/util.mjs'));
  assert.ok(prompt.includes('export function add(a, b) { return a - b; }'));
});

test('buildPrompt includes JSON output format instruction', () => {
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: 'fail',
    snapshot: { 'a.mjs': 'code' },
  });
  assert.ok(prompt.includes('"changes"'));
  assert.ok(prompt.includes('JSON'));
});

test('buildPrompt tails long test output to 4000 chars', () => {
  const longOutput = 'line\n'.repeat(2000); // ~10000 chars
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: longOutput,
    snapshot: { 'a.mjs': 'code' },
  });
  // The output in the prompt should be no more than 4000 chars of test output.
  // We find the section between the output code fences and verify.
  const match = prompt.match(/Test output[\s\S]*?```\n([\s\S]*?)```/);
  assert.ok(match, 'should have test output section');
  assert.ok(match[1].length <= 4001, 'output section should be at most 4000 chars + newline');
});

test('buildPrompt requests hunks, not full file content, in its output-schema instructions (issue #279)', () => {
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: 'fail',
    snapshot: { 'a.mjs': 'code' },
  });
  assert.ok(prompt.includes('"hunks"'));
  assert.ok(prompt.includes('startLine'));
  assert.ok(prompt.includes('endLine'));
  assert.ok(prompt.includes('replacement'));
  assert.ok(!prompt.includes('"content"'), 'must not still ask for full-file "content" — that is the old schema');
});

test('buildPrompt tells the model which line numbers are the FILE\'s real numbering, not excerpt-relative', () => {
  const bigContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const testOutput = 'Error at big.mjs:100';
  const prompt = buildPrompt({ testCmd: 'npm test', testOutput, snapshot: { 'big.mjs': bigContent } });
  assert.match(prompt, /excerpt/i);
  assert.match(prompt, /200 lines total/);
});

// ── AC: >=70% prompt-size reduction for a 600-line file / 5-line bug (issue #279) ──

/**
 * Reconstruct the OLD (pre-#279) prompt shape — the whole file embedded
 * verbatim, full-file-content output schema — so the size comparison is
 * against what this package actually used to send, not an arbitrary
 * hand-picked number.
 */
function oldStyleBuildPrompt({ testCmd, testOutput, snapshot }) {
  const tailedOutput = testOutput.length <= 4000 ? testOutput : testOutput.slice(testOutput.length - 4000);
  const fileBlocks = Object.entries(snapshot)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');
  return [
    `This test command fails:`, '```', testCmd, '```', '',
    `Test output (last 4000 chars):`, '```', tailedOutput, '```', '',
    `Source files:`, '', fileBlocks, '',
    `Produce a MINIMAL fix. Output JSON with this exact shape:`,
    `{"changes": [{"file": "<path>", "content": "<full new content of changed file>"}]}`, '',
    `Rules:`,
    `- Only include files that actually need changes.`,
    `- Use only the file paths listed above.`,
    `- "content" must be the complete new file content, not a diff.`,
    `- Output ONLY valid JSON. No prose before or after.`,
  ].join('\n');
}

test('AC: for a 600-line file with a 5-line bug, the prompt shrinks by at least 70% vs. the old full-file-embed baseline', () => {
  // A realistic-shaped 600-line source file with a small bug region.
  const lines = Array.from({ length: 600 }, (_, i) => `function helper${i}() { return computeValue(${i}); }`);
  const content = lines.join('\n');

  // The "5-line bug": a stack trace pointing at one small region of the file.
  const testOutput = [
    'AssertionError [ERR_ASSERTION]: expected 300 to equal 301',
    '    at TestContext.<anonymous> (/repo/src/big.mjs:300:15)',
    '    at Test.runInAsyncScope (node:async_hooks:214:14)',
  ].join('\n');

  const snapshot = { 'src/big.mjs': content };

  const baseline = oldStyleBuildPrompt({ testCmd: 'node --test', testOutput, snapshot });
  const updated = buildPrompt({ testCmd: 'node --test', testOutput, snapshot });

  const reduction = 1 - updated.length / baseline.length;
  assert.ok(
    reduction >= 0.70,
    `expected >=70% prompt-size reduction, got ${(reduction * 100).toFixed(1)}% (baseline=${baseline.length} chars, updated=${updated.length} chars)`
  );
});

test('a small file (at or under the windowing threshold) is NOT artificially shrunk below what the old design would have sent', () => {
  // Windowing exists to cut a 600-line file down, not to shrink something
  // already small — a tiny file should still appear whole either way.
  const content = 'export function add(a, b) { return a + b; }';
  const snapshot = { 'small.mjs': content };
  const testOutput = 'fail';

  const baseline = oldStyleBuildPrompt({ testCmd: 'npm test', testOutput, snapshot });
  const updated = buildPrompt({ testCmd: 'npm test', testOutput, snapshot });

  assert.ok(updated.includes(content), 'the small file must still be shown in full');
  // Sizes should be close (the schema-instruction text differs, but no file
  // content was cut) — not a >=70% reduction, since there was nothing to cut.
  assert.ok(updated.length > baseline.length * 0.5, 'a small file must not be over-aggressively trimmed');
});
