// AC 32 (grammar half) — the locally re-implemented `adlc:begin` block codec:
// exactly one well-formed sentinel pair parses to its fields with the prose
// preserved; every ambiguity fails closed with line-named errors and NO block.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { parseBlock, serializeBlock, stripBlock, blockSkeleton, validateBlockFields, CATEGORIES, SUPPORTED_BLOCK_VERSION } from '../lib/block.mjs';
import { withMutation } from '../lib/mutations.mjs';

const FIELDS = { scope: ['packages/fleet/**'], rails: ['scripts/preflight.mjs'], edges: [{ to: 'T-1' }], duration: 2, category: 'feature' };
const body = (fields = FIELDS, attrs = 'v=1 key=abc') => `Intro prose.\n\n<!-- adlc:begin ${attrs} -->\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n<!-- adlc:end -->\n\n## Acceptance criteria\n\n- it works. VERIFY: test\n`;

export function ac32_blockGrammarParsesOneWellFormedPair() {
  const p = parseBlock(body());
  assert.equal(p.ok, true); assert.deepEqual(p.block, FIELDS); assert.equal(p.version, 1); assert.equal(p.key, 'abc');
  assert.equal(p.prefix, 'Intro prose.\n\n'); assert.match(p.suffix, /^\n\n## Acceptance criteria/);
  assert.equal(stripBlock(p), 'Intro prose.\n\n## Acceptance criteria\n\n- it works. VERIFY: test');
  // CRLF bodies (GitHub web edits) parse identically.
  assert.deepEqual(parseBlock(body().replace(/\n/g, '\r\n')).block, FIELDS);
  // A bare fence label and no fence at all are both accepted; no sentinels → ok with block:null.
  assert.deepEqual(parseBlock(`<!-- adlc:begin v=1 -->\n${JSON.stringify(FIELDS)}\n<!-- adlc:end -->`).block, FIELDS);
  assert.deepEqual(parseBlock('plain body'), { ok: true, block: null, fields: null, prefix: 'plain body', suffix: '', version: null, key: null, errors: [] });
  // serialize → parse round-trips, and the CLARIFY skeleton is itself a valid block.
  const round = parseBlock(serializeBlock({ prefix: 'a\n', suffix: '\nb' }, FIELDS, { key: 'k1' }));
  assert.deepEqual(round.block, FIELDS); assert.equal(round.key, 'k1'); assert.equal(round.prefix, 'a\n'); assert.equal(round.suffix, '\nb');
  const skel = parseBlock(blockSkeleton());
  assert.equal(skel.ok, true); assert.equal(skel.block.category, 'feature'); assert.ok(CATEGORIES.includes(skel.block.category));
  assert.equal(SUPPORTED_BLOCK_VERSION, 1);
  assert.deepEqual(validateBlockFields(FIELDS), []);
}

export async function ac32_blockGrammarFailsClosed() {
  ac32_blockGrammarParsesOneWellFormedPair();
  const cases = [
    ['duplicate begin', body().replace('<!-- adlc:end -->', '<!-- adlc:end -->\n<!-- adlc:begin v=1 -->\n{}\n<!-- adlc:end -->'), /exactly one 'adlc:begin'.*duplicate at line \d+/],
    ['missing end', body().replace('<!-- adlc:end -->', ''), /exactly one 'adlc:end' sentinel, found 0/],
    ['end before begin', `<!-- adlc:end -->\n<!-- adlc:begin v=1 -->\n{}\n`, /appears before/],
    ['no version', body(FIELDS, 'key=abc'), /missing the required v=<n>/],
    ['newer version', body(FIELDS, 'v=2'), /v=2 .*newer than supported/],
    ['garbled JSON', body().replace('"duration": 2', '"duration": 2,,'), /invalid JSON in the adlc block \(line \d+\)/],
    ['empty block', '<!-- adlc:begin v=1 -->\n\n<!-- adlc:end -->', /no JSON found/],
    ['array', '<!-- adlc:begin v=1 -->\n[1]\n<!-- adlc:end -->', /must be a JSON object/],
    ['bad category', body({ ...FIELDS, category: 'wish' }), /block field category: must be one of/],
    ['bad edges', body({ ...FIELDS, edges: [{ contract: 'x' }] }), /block field edges\[0\]\.to: required/],
    ['bad duration', body({ ...FIELDS, duration: 0 }), /block field duration: must be > 0/],
    ['scope not strings', body({ ...FIELDS, scope: [1] }), /block field scope: expected array of strings/],
  ];
  for (const [name, text, re] of cases) {
    const p = parseBlock(text);
    assert.equal(p.ok, false, name); assert.equal(p.block, null, `${name}: never a partial block`); assert.equal(p.fields, null, name);
    assert.ok(p.errors.some((e) => re.test(e)), `${name}: ${JSON.stringify(p.errors)}`);
  }
  // The seam the coverage gate applies: lenient grammar accepts the duplicate pair and the bad category.
  await withMutation('block.lenientGrammar', () => {
    assert.equal(parseBlock(cases[0][1]).ok, true, 'mutation fixture: duplicate sentinels accepted');
    assert.equal(parseBlock(cases[8][1]).ok, true, 'mutation fixture: bad category accepted');
  });
}
test('AC32: every ambiguity (duplicate/unbalanced sentinels, garbled JSON, unsupported version, invalid field) fails closed with line-named errors and no block', ac32_blockGrammarFailsClosed);
