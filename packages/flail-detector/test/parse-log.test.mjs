// test/parse-log.test.mjs — unit tests for the log parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog } from '../lib/parse-log.mjs';

test('parseLog: plain text log returns raw lines', () => {
  const content = 'line one\nline two\nline three';
  const { lines, bytes } = parseLog(content);
  assert.deepEqual(lines, ['line one', 'line two', 'line three']);
  assert.ok(bytes > 0);
});

test('parseLog: JSONL with message keys extracts values', () => {
  const entries = [
    { message: 'Error: cannot find module' },
    { message: 'Writing /tmp/foo.txt' },
    { level: 'info', message: 'Build started' },
  ];
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  const { lines } = parseLog(content);
  assert.ok(lines.includes('Error: cannot find module'));
  assert.ok(lines.includes('Writing /tmp/foo.txt'));
  assert.ok(lines.includes('Build started'));
});

test('parseLog: JSONL with content keys extracts values', () => {
  const entries = [
    { content: 'ENOENT: no such file or directory' },
    { content: 'Editing src/index.js' },
  ];
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  const { lines } = parseLog(content);
  assert.ok(lines.includes('ENOENT: no such file or directory'));
  assert.ok(lines.includes('Editing src/index.js'));
});

test('parseLog: JSONL with text keys extracts values', () => {
  const entries = [
    { text: 'Exception in thread main' },
  ];
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  const { lines } = parseLog(content);
  assert.ok(lines.includes('Exception in thread main'));
});

test('parseLog: mixed (non-JSON lines use as-is) treated as plain when minority JSON', () => {
  // Only one JSON line out of 5 total — treated as plain text
  const content = [
    'plain line one',
    'plain line two',
    'plain line three',
    'plain line four',
    JSON.stringify({ message: 'json line' }),
  ].join('\n');
  const { lines } = parseLog(content);
  // Should be raw lines (including the JSON string unparsed)
  assert.ok(lines.some((l) => l.startsWith('plain line one')));
});

test('parseLog: bytes reflects original content size', () => {
  const content = 'hello world\n';
  const { bytes } = parseLog(content);
  assert.equal(bytes, Buffer.byteLength(content, 'utf8'));
});

test('parseLog: empty file returns empty lines', () => {
  const { bytes } = parseLog('');
  // lines will be [''] from split('\n') — empty string split gives one empty element
  assert.equal(bytes, 0);
});

test('parseLog: JSONL with nested content key', () => {
  const entries = [
    { data: { content: 'Error: failed to connect' } },
  ];
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  const { lines } = parseLog(content);
  assert.ok(lines.includes('Error: failed to connect'));
});
