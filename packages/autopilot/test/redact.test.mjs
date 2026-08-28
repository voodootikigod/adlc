// AC 88 / 91 / 96 / 99 / 105 — the single fail-closed redactor. Every
// SECRET_PATTERNS entry and every literal orchestrator secret is replaced with
// `[REDACTED:<pattern>]`; a redactor that throws, times out or leaves a
// residual match yields ONLY the withheld sentinel; structured records keep
// their schema. The outward WRITERS (comments, digest, dead-end file) are
// asserted in their own suites; this file owns the redactor's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, redactRecord, redactStream, SECRET_PATTERNS, WITHHELD_DEAD_END, WITHHELD_BODY, CHUNK_BYTES } from '../lib/redact.mjs';
import { withMutation } from '../lib/mutations.mjs';

/** One sample that matches each pattern, by name. */
export const SAMPLES = {
  'AWS access key ID': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'Private key (PEM)': '-----BEGIN RSA PRIVATE KEY-----',
  'OpenAI/Anthropic-style key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  'GitHub token': 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8S9t0',
  'Slack token': 'xoxb-1234567890-abcdefghij',
  'Google API key': 'AIza' + 'A'.repeat(35),
  JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  'Hardcoded credential assignment': 'api_key = "abcdefghijklmnopqrstuvwxyz"',
  'ADLC manifest key': 'ADLC_MANIFEST_KEY=0123456789abcdef0123456789abcdef',
  // Line-anchored by design (an .env-style assignment starts a line), so the sample carries its newline.
  'env secret assignment': '\nFOO_TOKEN=plainvalue123',
  'Bearer token': 'Bearer abcdefghijklmnopqrstuvwxyz0123',
};

export function ac88_everyPatternIsReplacedWithItsName() {
  const names = SECRET_PATTERNS.map((p) => p.name);
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...names].sort(), 'the sample table covers every pattern exactly');
  const { redact } = createRedactor({ secretValues: ['orchestrator-key-value-12345'] });
  for (const [name, sample] of Object.entries(SAMPLES)) {
    const r = redact(`log line before ${sample} after`);
    assert.equal(r.ok, true, name);
    assert.ok(!r.text.includes(sample), `${name}: the matched text is gone`);
    assert.ok(r.text.includes(`[REDACTED:${name}]`) || r.text.includes('[REDACTED:'), `${name}: replaced by [REDACTED:<pattern>]`);
  }
  const lit = redact('token: orchestrator-key-value-12345 trailing');
  assert.equal(lit.text, 'token: [REDACTED:orchestrator secret value] trailing', 'the literal key value is replaced by name');
}
test('AC88: each SECRET_PATTERNS entry and the literal orchestrator key value are replaced with [REDACTED:<pattern>]', ac88_everyPatternIsReplacedWithItsName);

export async function ac88_failClosedOnThrowOrResidual() {
  const throwing = createRedactor({ impl: () => { throw new Error('boom'); } });
  const r1 = throwing.redact('anything ' + SAMPLES['GitHub token']);
  assert.equal(r1.ok, false); assert.equal(r1.text, WITHHELD_DEAD_END); assert.match(r1.reason, /redactor-threw/);
  const leaky = createRedactor({ impl: (t) => t }); // returns input unchanged
  const r2 = leaky.redact('x ' + SAMPLES['GitHub token']);
  assert.equal(r2.ok, false); assert.equal(r2.text, WITHHELD_DEAD_END); assert.equal(r2.reason, 'residual-match');
  const custom = leaky.redact('x ' + SAMPLES.JWT, { withheld: WITHHELD_BODY });
  assert.equal(custom.text, WITHHELD_BODY, 'free-text writers get the body sentinel');
  let t = 0;
  const slow = createRedactor({ now: () => (t += 10_000), budgetMs: 5_000 });
  const r3 = slow.redact('clean text');
  assert.equal(r3.ok, false); assert.equal(r3.reason, 'redactor-timeout');
  // The seam the coverage gate applies: with `redactor.disable` the raw text goes out.
  await withMutation('redactor.disable', () => {
    const { redact } = createRedactor({});
    const r = redact('x ' + SAMPLES['GitHub token']);
    assert.equal(r.ok, true);
    assert.ok(r.text.includes(SAMPLES['GitHub token']), 'mutation fixture: the secret leaks (this is what the gate expects the real test to catch)');
  });
}
test('AC88: a redactor that throws, leaks (residual match) or exceeds its budget yields only the withheld sentinel', ac88_failClosedOnThrowOrResidual);

export function ac105_structuredRedactionKeepsSchema() {
  const { redact } = createRedactor({ secretValues: ['orchestrator-key-value-12345'] });
  const redactor = { redact };
  const record = { issue: 7, state: 'blocked', token: 'f'.repeat(64), lastError: 'failed with ' + SAMPLES['GitHub token'], baseOid: 'a'.repeat(40) };
  const out = redactRecord(record, ['lastError'], redactor);
  assert.equal(out.issue, 7); assert.equal(out.state, 'blocked'); assert.equal(out.token, 'f'.repeat(64)); assert.equal(out.baseOid, 'a'.repeat(40));
  assert.ok(!out.lastError.includes(SAMPLES['GitHub token']) && out.lastError.includes('[REDACTED:'));
  assert.equal(out.redactionFailed, undefined);
  // Identifier fields are NEVER handed to the redactor (spy).
  const seen = [];
  const spy = { redact: (t, o) => { seen.push(t); return redact(t, o); } };
  redactRecord(record, ['lastError'], spy);
  assert.deepEqual(seen, [record.lastError]);
  // A failing field → null + redactionFailed, and the document still parses/drives recovery.
  const failing = { redact: () => ({ ok: false, text: null }) };
  const bad = redactRecord(record, ['lastError'], failing);
  assert.equal(bad.lastError, null); assert.deepEqual(bad.redactionFailed, ['lastError']); assert.equal(bad.state, 'blocked');
  assert.equal(JSON.parse(JSON.stringify(bad)).token, record.token);
}
test('AC105: structured redaction touches only the free-text fields, nulls a failing one under redactionFailed, and keeps every identifier', ac105_structuredRedactionKeepsSchema);

export function ac99_chunkedRedactionCatchesStraddlingSecret() {
  const { redact } = createRedactor({});
  const token = SAMPLES['GitHub token'];
  // Place the token so it straddles a 64 KiB boundary (preceded by a space: the
  // pattern needs a word boundary, and a real log has one).
  const head = 'a'.repeat(CHUNK_BYTES - 11) + ' ';
  const whole = head + token + ' tail '.repeat(100);
  const chunks = [whole.slice(0, CHUNK_BYTES), whole.slice(CHUNK_BYTES)];
  const r = redactStream(chunks, { redact }, { keepChars: CHUNK_BYTES });
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes(token), 'a secret straddling the chunk boundary is still redacted');
  assert.ok(r.text.length <= CHUNK_BYTES, 'only the last 64 KiB is retained');
  const leaky = { redact: (t) => ({ ok: false, text: WITHHELD_DEAD_END }) };
  assert.equal(redactStream(['x'], leaky).text, WITHHELD_DEAD_END);
}
test('AC99: a secret straddling a 64 KiB chunk boundary is still redacted and only the last 64 KiB is kept', ac99_chunkedRedactionCatchesStraddlingSecret);
