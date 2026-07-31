// key-ceremony.test.mjs — key generation, custody handoff, and the custody checkpoint
// (T-01KYQMPBQT6Z2H507VGRCFANWM, T3 slice B, spec .adlc/specs/manifest-key-hermeticity.md
// Layer 3, "the key is GENERATED, never accepted").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEY_BYTE_LENGTH,
  KEY_HEX_LENGTH,
  generateManifestKey,
  computeKeyFingerprint,
  assertHandoffPathOutsideRepo,
  writeKeyHandoffFile,
  readSecretLine,
  confirmCustody,
  resolveCeremonyKey,
} from '../lib/key-ceremony.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-'));
}

// ── generateManifestKey ─────────────────────────────────────────────────────────────

test('generates a 64-character lowercase hex string from real CSPRNG entropy', () => {
  const key = generateManifestKey();
  assert.equal(key.length, KEY_HEX_LENGTH);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('is deterministic given injected entropy — mirrors the ULID injectable-entropy convention', () => {
  const entropy = Buffer.alloc(KEY_BYTE_LENGTH, 0x11);
  const key = generateManifestKey(entropy);
  assert.equal(key, '11'.repeat(KEY_BYTE_LENGTH));
});

test('two real-entropy calls never collide (sanity, not a proof)', () => {
  assert.notEqual(generateManifestKey(), generateManifestKey());
});

test('rejects entropy that is not a Buffer', () => {
  assert.throws(() => generateManifestKey('not-a-buffer'), TypeError);
  assert.throws(() => generateManifestKey(null), TypeError);
});

test('rejects entropy of the wrong length', () => {
  assert.throws(() => generateManifestKey(Buffer.alloc(16)), TypeError);
  assert.throws(() => generateManifestKey(Buffer.alloc(64)), TypeError);
});

// ── computeKeyFingerprint ───────────────────────────────────────────────────────────

test('fingerprint is sha256 of the exact UTF-8 bytes of the key', () => {
  const key = generateManifestKey();
  const expected = createHash('sha256').update(key, 'utf8').digest('hex');
  assert.equal(computeKeyFingerprint(key), expected);
});

test('fingerprint is deterministic for the same key and differs for a different key', () => {
  const a = generateManifestKey();
  const b = generateManifestKey();
  assert.equal(computeKeyFingerprint(a), computeKeyFingerprint(a));
  assert.notEqual(computeKeyFingerprint(a), computeKeyFingerprint(b));
});

test('refuses an empty or non-string key', () => {
  assert.throws(() => computeKeyFingerprint(''), TypeError);
  assert.throws(() => computeKeyFingerprint(null), TypeError);
  assert.throws(() => computeKeyFingerprint(undefined), TypeError);
});

// ── assertHandoffPathOutsideRepo ────────────────────────────────────────────────────

test('accepts a path genuinely outside the repo root', () => {
  const root = tmpRoot();
  const outside = join(tmpdir(), 'somewhere-else-entirely', 'key.txt');
  assert.doesNotThrow(() => assertHandoffPathOutsideRepo(outside, { root }));
});

test('rejects a path inside the repo root', () => {
  const root = tmpRoot();
  const inside = join(root, 'key.txt');
  assert.throws(() => assertHandoffPathOutsideRepo(inside, { root }), /outside the repository/i);
});

test('rejects the repo root itself', () => {
  const root = tmpRoot();
  assert.throws(() => assertHandoffPathOutsideRepo(root, { root }), /outside the repository/i);
});

test('rejects a nested inside-repo path even several directories deep', () => {
  const root = tmpRoot();
  const inside = join(root, 'a', 'b', 'c', 'key.txt');
  assert.throws(() => assertHandoffPathOutsideRepo(inside, { root }), /outside the repository/i);
});

test('a sibling directory whose name merely starts with the repo root name is NOT inside it', () => {
  const root = tmpRoot();
  const sibling = `${root}-sibling`;
  const outsidePath = join(sibling, 'key.txt');
  assert.doesNotThrow(() => assertHandoffPathOutsideRepo(outsidePath, { root }));
});

// ── writeKeyHandoffFile ──────────────────────────────────────────────────────────────

test('writes the key to the handoff path with mode 0600', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const key = generateManifestKey();
  const handoffPath = join(outsideDir, 'key.txt');
  writeKeyHandoffFile(handoffPath, key, { root });
  assert.equal(readFileSync(handoffPath, 'utf8'), key);
  const mode = statSync(handoffPath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('refuses to overwrite an existing file at the handoff path', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  writeFileSync(handoffPath, 'pre-existing content');
  assert.throws(
    () => writeKeyHandoffFile(handoffPath, generateManifestKey(), { root }),
    /refusing to overwrite/,
  );
  assert.equal(readFileSync(handoffPath, 'utf8'), 'pre-existing content', 'the pre-existing file must be untouched');
});

test('refuses a handoff path inside the repository, before writing anything', () => {
  const root = tmpRoot();
  const insidePath = join(root, 'key.txt');
  assert.throws(() => writeKeyHandoffFile(insidePath, generateManifestKey(), { root }), /outside the repository/i);
});

// ── readSecretLine / confirmCustody: fake TTY-like streams (no real pty needed) ────

function makeFakeTty({ isTTY = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; };
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  let written = '';
  const output = { isTTY, write: (s) => { written += s; } };
  return { input, output, writtenOutput: () => written };
}

function typeAndEnter(input, text) {
  for (const ch of text) input.emit('data', ch);
  input.emit('data', '\r');
}

test('readSecretLine refuses when input is not a TTY', async () => {
  const { input, output } = makeFakeTty({ isTTY: false });
  await assert.rejects(() => readSecretLine({ input, output }), /interactive terminal/);
});

test('readSecretLine refuses when output is not a TTY', async () => {
  const { input } = makeFakeTty();
  const output = { isTTY: false, write: () => {} };
  await assert.rejects(() => readSecretLine({ input, output }), /interactive terminal/);
});

test('readSecretLine resolves with the typed value, echo disabled', async () => {
  const { input, output, writtenOutput } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'the-typed-secret');
  const result = await resultPromise;
  assert.equal(result, 'the-typed-secret');
  assert.ok(!writtenOutput().includes('the-typed-secret'), 'the typed value must never be echoed back to output');
});

test('readSecretLine enables raw mode while reading and restores the PRIOR raw state after', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  assert.equal(input.isRaw, true, 'raw mode must be enabled for the duration of the read');
  typeAndEnter(input, 'x');
  await resultPromise;
  assert.equal(input.isRaw, false, 'raw mode must be restored to what it was before the read');
});

test('readSecretLine handles backspace by removing the last character', async () => {
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  for (const ch of 'abcX') input.emit('data', ch);
  input.emit('data', '\u007f'); // backspace removes the 'X'
  input.emit('data', '\r');
  assert.equal(await resultPromise, 'abc');
});

test('readSecretLine backspace on an empty buffer does not underflow', async () => {
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  input.emit('data', '\u007f');
  input.emit('data', 'y');
  input.emit('data', '\r');
  assert.equal(await resultPromise, 'y');
});

test('readSecretLine rejects on Ctrl-C and restores raw mode', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  input.emit('data', '\u0003');
  await assert.rejects(() => resultPromise, /Ctrl-C/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine does not leak a "data" listener on input after resolving', async () => {
  const { input, output } = makeFakeTty();
  const before = input.listenerCount('data');
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'z');
  await resultPromise;
  assert.equal(input.listenerCount('data'), before);
});

test('readSecretLine does not leak a process SIGINT listener after resolving', async () => {
  const before = process.listenerCount('SIGINT');
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'z');
  await resultPromise;
  assert.equal(process.listenerCount('SIGINT'), before);
});

// ── confirmCustody ───────────────────────────────────────────────────────────────────

test('confirmCustody succeeds when the re-entered value matches the key', async () => {
  const key = generateManifestKey();
  const result = await confirmCustody(key, { readSecret: async () => key });
  assert.equal(result, true);
});

test('confirmCustody throws when the re-entered value does not match', async () => {
  const key = generateManifestKey();
  await assert.rejects(
    () => confirmCustody(key, { readSecret: async () => 'a-completely-different-value' }),
    /does not match/,
  );
});

test('confirmCustody throws on a value that differs only in length (no partial-match acceptance)', async () => {
  const key = generateManifestKey();
  await assert.rejects(() => confirmCustody(key, { readSecret: async () => key.slice(0, -1) }), /does not match/);
});

test('confirmCustody end-to-end with a fake TTY (no real pty)', async () => {
  const key = generateManifestKey();
  const { input, output } = makeFakeTty();
  const resultPromise = confirmCustody(key, { input, output });
  typeAndEnter(input, key);
  assert.equal(await resultPromise, true);
});

// ── resolveCeremonyKey ───────────────────────────────────────────────────────────────

test('with no importKey, generates a fresh key', () => {
  const resolved = resolveCeremonyKey();
  assert.equal(resolved.imported, false);
  assert.match(resolved.key, /^[0-9a-f]{64}$/);
});

test('refuses a caller-supplied key without the exception flag', () => {
  assert.throws(
    () => resolveCeremonyKey({ importKey: 'some-legacy-key' }),
    /never accepts one/,
  );
});

test('accepts a caller-supplied key WITH the exception flag, and reports it as imported', () => {
  const resolved = resolveCeremonyKey({ importKey: 'some-legacy-key', allowKeyImport: true });
  assert.deepEqual(resolved, { key: 'some-legacy-key', imported: true });
});

test('refuses an empty imported key even with the exception flag', () => {
  assert.throws(() => resolveCeremonyKey({ importKey: '', allowKeyImport: true }), TypeError);
});

test('passes injected entropy through to generation on the normal (non-import) path', () => {
  const entropy = Buffer.alloc(KEY_BYTE_LENGTH, 0x22);
  const resolved = resolveCeremonyKey({ entropy });
  assert.equal(resolved.key, '22'.repeat(KEY_BYTE_LENGTH));
});
