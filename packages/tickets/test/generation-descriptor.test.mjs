// generation-descriptor.test.mjs — the adoption record schema and generation-path
// resolver (T-01KYQMPBQT6Z2H507VGRCFANWM, spec .adlc/specs/manifest-key-hermeticity.md
// Layer 3, items 1 and 9).
//
// Presence of the adoption record IS required-mode — there is no separate boolean.
// A malformed record must never be silently treated the same as an absent one: callers
// (verifiers) fail closed on `valid: false`, distinct from `present: false`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLegacyGeneration,
  validateGenerationId,
  resolveGenerationDir,
  validateAdoptionRecord,
  readAdoptionRecord,
  resolveActiveGenerationPaths,
  CONFIG_FILENAME,
} from '../lib/generation-descriptor.mjs';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

function makeAdlcDir() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-generation-descriptor-'));
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// ── isLegacyGeneration ──────────────────────────────────────────────────────────────

test('isLegacyGeneration is true for absent, null, 0, and "0"', () => {
  assert.equal(isLegacyGeneration(undefined), true);
  assert.equal(isLegacyGeneration(null), true);
  assert.equal(isLegacyGeneration(0), true);
  assert.equal(isLegacyGeneration('0'), true);
});

test('isLegacyGeneration is false for a real generation id', () => {
  assert.equal(isLegacyGeneration('a1b2c3'), false);
  assert.equal(isLegacyGeneration(1), false);
});

// ── validateGenerationId ────────────────────────────────────────────────────────────

test('validateGenerationId accepts a lowercase alphanumeric id', () => {
  assert.equal(validateGenerationId('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
});

test('validateGenerationId rejects a path separator', () => {
  assert.throws(() => validateGenerationId('a/b'), /path component/);
  assert.throws(() => validateGenerationId('a\\b'), /path component/);
});

test('validateGenerationId rejects traversal', () => {
  assert.throws(() => validateGenerationId('..'), /path component/);
  assert.throws(() => validateGenerationId('a..b'), /path component/);
});

test('validateGenerationId rejects uppercase, empty, non-string, and over-length ids', () => {
  assert.throws(() => validateGenerationId('ABC123'));
  assert.throws(() => validateGenerationId(''));
  assert.throws(() => validateGenerationId(42));
  assert.throws(() => validateGenerationId(null));
  assert.throws(() => validateGenerationId('a'.repeat(65)));
});

// ── resolveGenerationDir ────────────────────────────────────────────────────────────

test('resolveGenerationDir returns dir unchanged for a legacy generation', () => {
  assert.equal(resolveGenerationDir('/repo/.adlc', 0), '/repo/.adlc');
  assert.equal(resolveGenerationDir('/repo/.adlc', undefined), '/repo/.adlc');
  assert.equal(resolveGenerationDir('/repo/.adlc', '0'), '/repo/.adlc');
});

test('resolveGenerationDir resolves a real generation id under manifest-generations/', () => {
  assert.equal(resolveGenerationDir('/repo/.adlc', 'a1b2c3'), '/repo/.adlc/manifest-generations/a1b2c3');
});

test('resolveGenerationDir rejects an unsafe generation id', () => {
  assert.throws(() => resolveGenerationDir('/repo/.adlc', '../../etc'));
});

// ── validateAdoptionRecord ──────────────────────────────────────────────────────────

test('a well-formed record round-trips', () => {
  const record = validateAdoptionRecord({
    schemaVersion: 1, keyFingerprint: FP_A, generation: 'g1', priorFingerprints: [FP_B],
  });
  assert.deepEqual(record, { schemaVersion: 1, keyFingerprint: FP_A, generation: 'g1', priorFingerprints: [FP_B] });
});

test('a legacy (generation 0) record defaults priorFingerprints to empty', () => {
  const record = validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, generation: 0 });
  assert.deepEqual(record.priorFingerprints, []);
});

test('a record that is not an object throws', () => {
  assert.throws(() => validateAdoptionRecord(null), /object/);
  assert.throws(() => validateAdoptionRecord('nope'), /object/);
  assert.throws(() => validateAdoptionRecord([1, 2]), /object/);
});

test('an unsupported schemaVersion throws', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 2, keyFingerprint: FP_A }), /schemaVersion/);
});

test('a malformed keyFingerprint throws (wrong length, non-hex, or missing)', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: 'abc' }), /keyFingerprint/);
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: 'g'.repeat(64) }), /keyFingerprint/);
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1 }), /keyFingerprint/);
});

test('a malformed generation id throws through the same validation as validateGenerationId', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, generation: '../etc' }));
});

test('priorFingerprints must be an array of valid fingerprints', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, priorFingerprints: 'not-an-array' }));
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, priorFingerprints: ['bad'] }));
});

// ── readAdoptionRecord ──────────────────────────────────────────────────────────────

test('no config.json at all is reported as absent, not malformed', () => {
  const { dir } = makeAdlcDir();
  assert.deepEqual(readAdoptionRecord(dir), { present: false });
});

test('config.json without a "signing" key is reported as absent', () => {
  const { dir } = makeAdlcDir();
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ securityMode: 'signed' }));
  assert.deepEqual(readAdoptionRecord(dir), { present: false });
});

test('config.json with a well-formed "signing" key is present and valid', () => {
  const { dir } = makeAdlcDir();
  const signing = { schemaVersion: 1, keyFingerprint: FP_A, generation: 'g1', priorFingerprints: [] };
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ securityMode: 'signed', signing }));
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.record, signing);
});

test('config.json with a malformed "signing" key is present but invalid, distinct from absent', () => {
  const { dir } = makeAdlcDir();
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: 'bad' } }));
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false);
  assert.match(result.reason, /keyFingerprint/);
});

test('config.json that is not valid JSON is present but invalid', () => {
  const { dir } = makeAdlcDir();
  writeFileSync(join(dir, CONFIG_FILENAME), '{ not json');
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false);
});

test('config.json that is a SYMLINK is never followed, even to a well-formed record', () => {
  const { root, dir } = makeAdlcDir();
  const outside = join(root, 'outside-config.json');
  writeFileSync(outside, JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A } }));
  symlinkSync(outside, join(dir, CONFIG_FILENAME));
  assert.deepEqual(readAdoptionRecord(dir), { present: false });
});

test('config.json exceeding the byte cap is present but invalid, not silently truncated', () => {
  const { dir } = makeAdlcDir();
  const huge = JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A, filler: 'x'.repeat(100_000) } });
  writeFileSync(join(dir, CONFIG_FILENAME), huge);
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false);
  assert.match(result.reason, /exceeds/);
});

// ── resolveActiveGenerationPaths ────────────────────────────────────────────────────

test('an absent adoption record resolves to the legacy in-place layout', () => {
  const paths = resolveActiveGenerationPaths('/repo/.adlc', { present: false });
  assert.equal(paths.generationDir, '/repo/.adlc');
  assert.equal(paths.manifestPath, '/repo/.adlc/manifest.jsonl');
  assert.equal(paths.segmentDirPath, '/repo/.adlc/manifest.d');
});

test('a valid record with a real generation resolves under manifest-generations/', () => {
  const adoption = { present: true, valid: true, record: { schemaVersion: 1, keyFingerprint: FP_A, generation: 'g1', priorFingerprints: [] } };
  const paths = resolveActiveGenerationPaths('/repo/.adlc', adoption);
  assert.equal(paths.generationDir, '/repo/.adlc/manifest-generations/g1');
  assert.equal(paths.manifestPath, '/repo/.adlc/manifest-generations/g1/manifest.jsonl');
  assert.equal(paths.segmentDirPath, '/repo/.adlc/manifest-generations/g1/manifest.d');
});

test('a valid record with generation 0 resolves to the legacy layout too (adopted but not yet rotated)', () => {
  const adoption = { present: true, valid: true, record: { schemaVersion: 1, keyFingerprint: FP_A, generation: 0, priorFingerprints: [] } };
  const paths = resolveActiveGenerationPaths('/repo/.adlc', adoption);
  assert.equal(paths.generationDir, '/repo/.adlc');
});

test('resolveActiveGenerationPaths refuses a malformed adoption record rather than guessing a generation', () => {
  const adoption = { present: true, valid: false, reason: 'signing.keyFingerprint must be a 64-character lowercase hex sha256 digest' };
  assert.throws(() => resolveActiveGenerationPaths('/repo/.adlc', adoption), /keyFingerprint/);
});
