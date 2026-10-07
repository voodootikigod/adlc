// The pre-dispatch sanitizer (AC5): allowlist, type projection, normalization,
// credential redaction, size limits, and failing before dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// Credential-shaped samples, assembled at runtime so no literal secret sits in the source.
const SAMPLES = {
  openai: ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-'),
  github: `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`,
  aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.'),
  pem: ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', '-----END RSA PRIVATE KEY-----'].join('\n'),
  entropy: 'Zq8xW2pL9vR4tY7uK3mN6bH1cF5gJ0dS',
};

test('a valid input becomes canonical sanitized input with a hash of exactly that', () => {
  const { sanitizedInput, inputHash } = sanitize(raw(), PACK);
  assert.deepEqual(sanitizedInput, raw());
  assert.deepEqual(Object.keys(sanitizedInput), Object.keys(raw()).sort());
  assert.deepEqual(Object.keys(sanitizedInput.extensionCounts), ['md', 'mjs']);
  assert.equal(inputHash, canonicalHash(raw()));
});

test('an undeclared field is rejected before dispatch', () => {
  fails(raw({ diffHunks: '@@ -1 +1 @@' }), 'undeclared-field');
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

test('ordinary metadata is not redacted', () => {
  for (const value of ['feature', 'bugfix', 'mjs', 'none', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0123456789abcdef0123456789abcdef01234567']) {
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

test('a scanner failure stops the run; there is no raw fallback', () => {
  const scanner = () => { throw new Error('scanner exploded'); };
  fails(raw(), 'scanner-failure', PACK, { scanner });
});

test('a scanner that returns something other than text stops the run', () => {
  fails(raw(), 'scanner-failure', PACK, { scanner: () => ({ text: 42, redactions: 0 }) });
});

test('sanitize does not mutate its input', () => {
  const input = raw({ ticketCategory: `a ${SAMPLES.jwt}` });
  const before = structuredClone(input);
  sanitize(input, PACK);
  assert.deepEqual(input, before);
});
