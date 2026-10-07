// The pre-dispatch sanitizer (AC5): allowlist, type projection, normalization,
// credential redaction, size limits, and failing before dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { SanitizationError, sanitize, scanText } from '../lib/sanitizer.mjs';
import { canonicalHash } from '../lib/canonical.mjs';

installNoNetwork();

const PACK = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));

const raw = (over = {}) => ({
  extensionCounts: { mjs: 3, md: 1 },
  linesAdded: 120,
  linesDeleted: 7,
  filesChanged: 4,
  ticketCategory: 'feature',
  declaredRailCount: 2,
  ...over,
});
const fails = (input, code, pack = PACK, options) =>
  assert.throws(() => sanitize(input, pack, options), (error) => error instanceof SanitizationError && error.code === code);

// Credential-shaped samples, assembled at runtime from fragments and hashed bytes
// so that no key-shaped literal sits in the source for a secret scanner to flag.
const bytes = (seed, length) => createHash('sha512').update(seed).digest().subarray(0, length);
const pemLine = (word) => ['-----', word, ' RSA ', 'PRIVATE', ' KEY', '-----'].join('');
const SAMPLES = {
  openai: ['sk', 'proj', bytes('openai-key', 18).toString('base64url')].join('-'),
  github: `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`,
  aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
  jwt: [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'decision-layer-test' })).toString('base64url'),
    bytes('jwt-signature', 32).toString('base64url'),
  ].join('.'),
  pem: [pemLine('BEGIN'), bytes('pem-body', 48).toString('base64'), pemLine('END')].join('\n'),
  entropy: bytes('entropy-token', 24).toString('base64url'),
};

test('a valid input becomes canonical sanitized input with a hash of exactly that', () => {
  const { sanitizedInput, inputHash } = sanitize(raw(), PACK);
  assert.deepEqual(sanitizedInput, raw());
  assert.deepEqual(Object.keys(sanitizedInput), Object.keys(raw()).sort());
  assert.deepEqual(Object.keys(sanitizedInput.extensionCounts), ['md', 'mjs']);
  assert.equal(inputHash, canonicalHash(raw()));
});

test('sends only the fields the pack declares (other collected fields are dropped)', () => {
  const { sanitizedInput } = sanitize(raw({ diffHunks: '@@ -1 +1 @@' }), PACK);
  assert.equal('diffHunks' in sanitizedInput, false);
  const subset = { ...PACK, inputs: { linesAdded: PACK.inputs.linesAdded, filesChanged: PACK.inputs.filesChanged } };
  const projected = sanitize(raw(), subset);
  assert.deepEqual(projected.sanitizedInput, { filesChanged: 4, linesAdded: 120 });
  assert.equal(projected.inputHash, canonicalHash({ filesChanged: 4, linesAdded: 120 }));
});

test('a declared field that is missing is rejected', () => {
  const input = raw();
  delete input.linesAdded;
  fails(input, 'missing-field');
});

test('values must have their declared type', () => {
  for (const over of [
    { linesAdded: -1 },
    { linesAdded: 1.5 },
    { linesAdded: '120' },
    { ticketCategory: 7 },
    { extensionCounts: { mjs: -2 } },
    { extensionCounts: { mjs: 'three' } },
    { extensionCounts: ['mjs'] },
    { extensionCounts: { mjs: { nested: 1 } } },
    { declaredRailCount: 'some' },
    { declaredRailCount: -1 },
  ]) {
    fails(raw(over), 'invalid-type');
  }
  assert.doesNotThrow(() => sanitize(raw({ declaredRailCount: 'none', ticketCategory: 'none' }), PACK));
});

test('control characters are removed, lone surrogates replaced, and strings NFC-normalized', () => {
  const { sanitizedInput } = sanitize(raw({ ticketCategory: 'fe\u0000a\u0007t\u009Fure\uD800 Café' }), PACK);
  assert.equal(sanitizedInput.ticketCategory, 'feature� Café');
});

test('object keys are normalized too', () => {
  const { sanitizedInput } = sanitize(raw({ extensionCounts: { 'm\u0001js': 2 } }), PACK);
  assert.deepEqual(sanitizedInput.extensionCounts, { mjs: 2 });
});

for (const [name, secret] of Object.entries(SAMPLES)) {
  test(`a ${name} credential is redacted and the run continues`, () => {
    const { sanitizedInput, redactions } = sanitize(raw({ ticketCategory: `feature ${secret} end` }), PACK);
    assert.ok(!sanitizedInput.ticketCategory.includes(secret.split('\n')[0].slice(-12)), sanitizedInput.ticketCategory);
    assert.match(sanitizedInput.ticketCategory, /^feature <redacted:[a-z-]+> end$/);
    assert.ok(redactions > 0);
  });
}

test('a credential used as a count-map key is redacted, and colliding keys merge', () => {
  const { sanitizedInput } = sanitize(raw({ extensionCounts: { [SAMPLES.github]: 2, [SAMPLES.aws]: 3, mjs: 1 } }), PACK);
  assert.deepEqual(sanitizedInput.extensionCounts, { '<redacted:credential>': 5, mjs: 1 });
});

test('the JWT and API-key patterns start at their minimum lengths', () => {
  const seg = (n) => 'abcdefghijklmnop'.slice(0, n);
  assert.equal(scanText(`eyJ${seg(8)}.${seg(8)}.x`).text, '<redacted:jwt>');
  assert.equal(scanText(`eyJ${seg(7)}.${seg(8)}.x`).text, `eyJ${seg(7)}.${seg(8)}.x`);
  assert.equal(scanText(`eyJ${seg(8)}.${seg(7)}.x`).text, `eyJ${seg(8)}.${seg(7)}.x`);
  const key = (n) => `sk-${'Ab1'.repeat(7).slice(0, n)}`;
  assert.equal(scanText(key(20)).text, '<redacted:credential>');
  assert.equal(scanText(key(19)).text, key(19));
});

// One sample per credential pattern, at that pattern's minimum length and with a
// digit in the body, built from low-entropy text so only the pattern itself, never
// the high-entropy fallback, can redact it.
const body = (n) => '0Ab1'.repeat(n).slice(0, n);
const CREDENTIAL_SAMPLES = [
  ['sk-', `sk-${body(20)}`],
  ['sk-ant-', `sk-ant-${body(20)}`],
  ['ghp_', `ghp_${body(20)}`],
  ['ghs_', `ghs_${body(20)}`],
  ['github_pat_', `github_pat_${body(20)}`],
  ['glpat-', `glpat-${body(20)}`],
  ['AKIA', `AKIA${body(16).toUpperCase()}`],
  ['ASIA', `ASIA${body(16).toUpperCase()}`],
  ['xoxb-', `xoxb-${body(10)}`],
  ['xoxp-', `xoxp-${body(10)}`],
  ['AIza', `AIza${body(35)}`],
  ['npm_', `npm_${body(36)}`],
];

for (const [prefix, sample] of CREDENTIAL_SAMPLES) {
  test(`the ${prefix} pattern redacts a minimum-length key to <redacted:credential>`, () => {
    assert.equal(scanText(`key ${sample} end`).text, 'key <redacted:credential> end');
  });
}

test('the samples are too low in entropy for the fallback to catch on its own', () => {
  for (const [, sample] of CREDENTIAL_SAMPLES) {
    assert.ok(!/<redacted:high-entropy>/.test(scanText(sample.replace(/^[A-Za-z]+[-_]+/, '')).text), sample);
  }
});

test('a 40-character hex string is redacted: v1 inputs never carry a commit SHA, so long hex is treated as a secret', () => {
  const sha = '0123456789abcdef'.repeat(3).slice(0, 40);
  assert.equal(scanText(sha).text, '<redacted:credential>');
});

test('random hex of 32 or more characters is redacted, though the general entropy check cannot reach it', () => {
  const hex32 = createHash('sha256').update('decision-layer-hex-32').digest('hex').slice(0, 32);
  const hex64 = createHash('sha256').update('decision-layer-hex-64').digest('hex');
  for (const hex of [hex32, hex64, hex64.toUpperCase()]) {
    assert.equal(scanText(`key ${hex} end`).text, 'key <redacted:credential> end', hex);
  }
});

test('short hex, and long hex too regular to be a secret, are kept', () => {
  const hex31 = createHash('sha256').update('decision-layer-hex-31').digest('hex').slice(0, 31);
  for (const value of ['3e424d6', 'deadbeef', 'cafe', hex31, '0123'.repeat(10), 'a'.repeat(40), 'ab'.repeat(20)]) {
    assert.equal(scanText(value).text, value, value);
  }
});

test('ordinary metadata is not redacted', () => {
  for (const value of ['feature', 'bugfix', 'mjs', 'none', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.equal(scanText(value).text, value);
  }
});

test('two inputs that differ only in a redacted secret hash the same', () => {
  const a = sanitize(raw({ ticketCategory: `x ${SAMPLES.github}` }), PACK).inputHash;
  const b = sanitize(raw({ ticketCategory: `x ghp_${'Z9y8X7w6V5u4T3s2R1q0'.repeat(2)}` }), PACK).inputHash;
  assert.equal(a, b);
});

test('a field over its declared maxBytes is rejected', () => {
  fails(raw({ ticketCategory: 'x'.repeat(70) }), 'field-too-large');
});

test('a pack may lower the per-field and total limits', () => {
  fails(raw(), 'field-too-large', { ...PACK, limits: { fieldBytes: 8, totalBytes: 32768 } });
  fails(raw(), 'total-too-large', { ...PACK, limits: { fieldBytes: 4096, totalBytes: 64 } });
});

test('the hard 4 KiB field limit holds even when a field declares more', () => {
  const pack = structuredClone(PACK);
  pack.inputs.ticketCategory.maxBytes = 4096;
  assert.doesNotThrow(() => sanitize(raw({ ticketCategory: 'x'.repeat(4000) }), pack));
  fails(raw({ ticketCategory: 'x'.repeat(4095) }), 'field-too-large', pack);
});

test('the sanitizer applies the 4 KiB and 32 KiB caps itself, whatever an unvalidated pack declares', () => {
  const huge = { ...PACK, limits: { fieldBytes: 1_000_000, totalBytes: 10_000_000 } };
  huge.inputs = { ...PACK.inputs, ticketCategory: { ...PACK.inputs.ticketCategory, maxBytes: 1_000_000 } };
  assert.doesNotThrow(() => sanitize(raw({ ticketCategory: 'x'.repeat(4094) }), huge));
  fails(raw({ ticketCategory: 'x'.repeat(4095) }), 'field-too-large', huge);
  const wide = { ...huge, inputs: {} };
  const input = {};
  for (let i = 0; i < 9; i += 1) {
    wide.inputs[`f${i}`] = { source: 'ticket-store', type: 'string', classification: 'metadata', maxBytes: 1_000_000 };
    input[`f${i}`] = 'y'.repeat(3800);
  }
  assert.doesNotThrow(() => sanitize(Object.fromEntries(Object.entries(input).slice(0, 8)), { ...wide, inputs: Object.fromEntries(Object.entries(wide.inputs).slice(0, 8)) }));
  fails(input, 'total-too-large', wide);
});

test('count-map keys that name Object.prototype members are ordinary keys', () => {
  const extensionCounts = JSON.parse('{"constructor":2,"__proto__":3,"tostring":1}');
  const { sanitizedInput } = sanitize(raw({ extensionCounts }), PACK);
  assert.deepEqual(Object.entries(sanitizedInput.extensionCounts).sort(), [['__proto__', 3], ['constructor', 2], ['tostring', 1]]);
});

test('a scanner failure stops the run; there is no raw fallback', () => {
  const scanner = () => { throw new Error('scanner exploded'); };
  fails(raw(), 'scanner-failure', PACK, { scanner });
});

test('a scanner that returns something other than text stops the run', () => {
  fails(raw(), 'scanner-failure', PACK, { scanner: () => ({ text: 42, redactions: 0 }) });
  fails(raw(), 'scanner-failure', PACK, { scanner: (text) => ({ text, redactions: '1' }) });
});

test('sanitize does not mutate its input', () => {
  const input = raw({ ticketCategory: `a ${SAMPLES.jwt}` });
  const before = structuredClone(input);
  sanitize(input, PACK);
  assert.deepEqual(input, before);
});
