import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlock, serializeBlock, blocksEqual, SUPPORTED_BLOCK_VERSION } from '../lib/block.mjs';

const FIELDS = { scope: ['src/**'], rails: ['test/**'], edges: [{ to: 'gh:a/b#1' }], duration: 2, category: 'feature' };

function body(prose, fields, opts) {
  return serializeBlock(prose, fields, opts);
}

test('round-trip preserves prefix, suffix, and fields verbatim', () => {
  const prose = { prefix: 'Human intro.\n\n', suffix: '\n\nHuman outro.\n' };
  const parsed = parseBlock(body(prose, FIELDS, { key: 'abc' }));
  assert.ok(parsed.ok);
  assert.equal(parsed.prefix, prose.prefix);
  assert.equal(parsed.suffix, prose.suffix);
  assert.equal(parsed.version, SUPPORTED_BLOCK_VERSION);
  assert.equal(parsed.key, 'abc');
  assert.deepEqual(parsed.fields, FIELDS);
});

test('no sentinels at all → no block, not an error (prefix = whole body)', () => {
  const parsed = parseBlock('Just a plain human description.\n');
  assert.ok(parsed.ok);
  assert.equal(parsed.block, null);
  assert.equal(parsed.prefix, 'Just a plain human description.\n');
});

test('a ```json fence in PROSE (outside the sentinels) is ignored', () => {
  const prose = { prefix: 'Example:\n```json\n{"not":"adlc"}\n```\n', suffix: '\ntrailing\n' };
  const parsed = parseBlock(body(prose, FIELDS));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.fields, FIELDS);
  assert.equal(parsed.prefix, prose.prefix); // the prose fence survives untouched
});

test('missing end sentinel → fail closed, error names the line', () => {
  const text = 'pre\n<!-- adlc:begin v=1 -->\n```json\n{}\n```\n';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('adlc:end')));
  assert.equal(parsed.block, null);
});

test('duplicate begin sentinels (two full pairs) → fail closed with a line number', () => {
  const text = '<!-- adlc:begin v=1 -->\n```json\n{}\n```\n<!-- adlc:end -->\n<!-- adlc:begin v=1 -->\n```json\n{}\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('adlc:begin') && /line \d+/.test(e)));
});

test('two begins + ONE end → fail closed (begin-count guard is independent of end-count)', () => {
  const text = '<!-- adlc:begin v=1 -->\n```json\n{}\n```\n<!-- adlc:begin v=1 -->\n```json\n{}\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok, 'two begins + one end must not be accepted (ambiguous)');
  assert.equal(parsed.block, null);
  assert.ok(parsed.errors.some((e) => e.includes('adlc:begin') && e.includes('found 2')));
});

test('raw JSON between the sentinels (no ```json fence) is tolerated for hand authoring', () => {
  // Pins the FENCE_RE `: inner` fallback so it stays load-bearing (and cannot
  // regress into an uncaught crash on a fenceless body).
  const parsed = parseBlock('<!-- adlc:begin v=1 -->\n{"duration":2}\n<!-- adlc:end -->');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.fields, { duration: 2 });
});

test('end before begin → fail closed', () => {
  const text = '<!-- adlc:end -->\nstuff\n<!-- adlc:begin v=1 -->\n```json\n{}\n```';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('before')));
});

test('missing version on the begin sentinel → fail closed', () => {
  const text = '<!-- adlc:begin key=x -->\n```json\n{}\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('version')));
});

test('version newer than supported → fail closed (do not guess)', () => {
  const text = `<!-- adlc:begin v=${SUPPORTED_BLOCK_VERSION + 1} -->\n\`\`\`json\n{}\n\`\`\`\n<!-- adlc:end -->`;
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('newer than supported')));
});

test('garbled JSON → fail closed', () => {
  const text = '<!-- adlc:begin v=1 -->\n```json\n{ not: json,, }\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('invalid JSON')));
});

test('present-but-invalid block (bad rails type) → fail closed, NOT degraded to no-rails', () => {
  const text = '<!-- adlc:begin v=1 -->\n```json\n{"rails":"test/**"}\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok, 'a malformed rails block must fail closed');
  assert.ok(parsed.errors.some((e) => e.includes('rails')));
  assert.equal(parsed.block, null);
});

test('a JSON array between the sentinels is rejected (must be an object)', () => {
  const text = '<!-- adlc:begin v=1 -->\n```json\n[]\n```\n<!-- adlc:end -->';
  const parsed = parseBlock(text);
  assert.ok(!parsed.ok);
  assert.ok(parsed.errors.some((e) => e.includes('object')));
});

test('$schema is preserved but excluded from block equality', () => {
  const a = { ...FIELDS, $schema: 'https://adlc.dev/schema/v1/adlc-block.schema.json' };
  const b = { ...FIELDS };
  assert.ok(blocksEqual(a, b), '$schema presence must not register as a change');
  const parsed = parseBlock(serializeBlock({ prefix: '', suffix: '' }, a));
  assert.equal(parsed.fields.$schema, a.$schema, '$schema is preserved on round-trip');
});

test('CRLF body parses identically to LF, prefix/suffix included (normalizeNewlines is load-bearing)', () => {
  const lf = serializeBlock({ prefix: 'p\n\n', suffix: '\n\ns' }, FIELDS);
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = parseBlock(lf);
  const b = parseBlock(crlf);
  assert.ok(a.ok && b.ok);
  assert.equal(b.prefix, a.prefix); // kills a normalizeNewlines-drop mutant
  assert.equal(b.suffix, a.suffix);
  assert.deepEqual(b.fields, a.fields);
});
