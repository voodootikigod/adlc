// generation-descriptor.test.mjs — the adoption record schema and generation-path
// resolver (T-01KYQMPBQT6Z2H507VGRCFANWM, spec .adlc/specs/manifest-key-hermeticity.md
// Layer 3, items 1 and 9).
//
// Presence of the adoption record IS required-mode — there is no separate boolean.
// A malformed record must never be silently treated the same as an absent one: callers
// (verifiers) fail closed on `valid: false`, distinct from `present: false`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLegacyGeneration,
  validateGenerationId,
  resolveGenerationDir,
  assertGenerationDirNotSymlinked,
  validateAdoptionRecord,
  readAdoptionRecord,
  resolveActiveGenerationPaths,
  CONFIG_FILENAME,
  MAX_CONFIG_JSON_BYTES,
} from '../lib/generation-descriptor.mjs';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

// A platform-native placeholder .adlc directory for path-resolution assertions that
// need no real filesystem — built via join() (not a hardcoded POSIX literal) so the
// expected values below use the SAME separator resolveGenerationDir's own join() calls
// produce, on every platform including Windows.
const DIR = join('repo', '.adlc');

function makeAdlcDir() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-generation-descriptor-'));
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// ── isLegacyGeneration ──────────────────────────────────────────────────────────────

test('isLegacyGeneration is true for absent, 0, and "0"', () => {
  assert.equal(isLegacyGeneration(undefined), true);
  assert.equal(isLegacyGeneration(0), true);
  assert.equal(isLegacyGeneration('0'), true);
});

test('isLegacyGeneration is FALSE for an explicit null — an absent field means legacy, but null is not a documented value and must not silently downgrade', () => {
  assert.equal(isLegacyGeneration(null), false);
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
  assert.equal(resolveGenerationDir(DIR, 0), DIR);
  assert.equal(resolveGenerationDir(DIR, undefined), DIR);
  assert.equal(resolveGenerationDir(DIR, '0'), DIR);
});

test('resolveGenerationDir resolves a real generation id under manifest-generations/', () => {
  assert.equal(resolveGenerationDir(DIR, 'a1b2c3'), join(DIR, 'manifest-generations', 'a1b2c3'));
});

test('resolveGenerationDir rejects an unsafe generation id', () => {
  assert.throws(() => resolveGenerationDir(DIR, '../../etc'));
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

test('a fingerprint containing the digit 0 is a valid hex character, not rejected', () => {
  const fp = `0${'a'.repeat(63)}`;
  const record = validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: fp });
  assert.equal(record.keyFingerprint, fp);
});

test('a malformed generation id throws through the same validation as validateGenerationId', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, generation: '../etc' }));
});

test('an EXPLICIT null generation is rejected as malformed, not silently downgraded to legacy', () => {
  assert.throws(
    () => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, generation: null }),
    /generation id/,
  );
});

test('priorFingerprints must be an array of valid fingerprints', () => {
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, priorFingerprints: 'not-an-array' }));
  assert.throws(() => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, priorFingerprints: ['bad'] }));
});

test('an ABSENT priorFingerprints field defaults to an empty array (no rotations yet)', () => {
  const record = validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A });
  assert.deepEqual(record.priorFingerprints, []);
});

test('an EXPLICIT null priorFingerprints is rejected, not silently normalized to an empty array', () => {
  assert.throws(
    () => validateAdoptionRecord({ schemaVersion: 1, keyFingerprint: FP_A, priorFingerprints: null }),
    /priorFingerprints/,
  );
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

test('config.json that is a SYMLINK is never followed — reported present-but-invalid, NOT absent (fail closed, not silently unadopted)', () => {
  const { root, dir } = makeAdlcDir();
  const outside = join(root, 'outside-config.json');
  writeFileSync(outside, JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A } }));
  symlinkSync(outside, join(dir, CONFIG_FILENAME));
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true, 'a symlinked config.json exists — it must never be conflated with "never adopted"');
  assert.equal(result.valid, false);
  assert.match(result.reason, /symlink|regular file/);
});

test('config.json genuinely absent (no file at all) is the ONLY case reported as present:false', () => {
  const { dir } = makeAdlcDir();
  assert.deepEqual(readAdoptionRecord(dir), { present: false });
});

test('config.json that is a DIRECTORY is present-but-invalid, not absent', () => {
  const { dir } = makeAdlcDir();
  mkdirSync(join(dir, CONFIG_FILENAME));
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false);
});

test('.adlc ITSELF being a symlink is caught by readAdoptionRecord, even when the shadow target has a well-formed config.json', () => {
  const { root, dir } = makeAdlcDir();
  const shadow = join(root, 'shadow-adlc');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(join(shadow, CONFIG_FILENAME), JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A } }));
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(shadow, dir);
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true, 'a symlinked .adlc must never be conflated with "no .adlc at all"');
  assert.equal(result.valid, false);
  assert.match(result.reason, /symlink/);
});

test('.adlc genuinely absent entirely (no directory at all) is the only case reported present:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-generation-descriptor-'));
  const dir = join(root, '.adlc');
  assert.deepEqual(readAdoptionRecord(dir), { present: false });
});

for (const [label, value] of [['null', null], ['an array', []], ['a string', '"nope"'], ['a number', 42]]) {
  test(`config.json whose top-level value is ${label} is present-but-invalid, not conflated with "no signing key"`, () => {
    const { dir } = makeAdlcDir();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify(value));
    const result = readAdoptionRecord(dir);
    assert.equal(result.present, true, `a malformed top-level ${label} must not be reported as absent`);
    assert.equal(result.valid, false);
  });
}

test('config.json exceeding the byte cap is present but invalid, not silently truncated', () => {
  const { dir } = makeAdlcDir();
  const huge = JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A, filler: 'x'.repeat(100_000) } });
  writeFileSync(join(dir, CONFIG_FILENAME), huge);
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false);
  assert.match(result.reason, /exceeds/);
});

// The exported constant's value is pinned directly here as a HARDCODED literal (not
// derived from MAX_CONFIG_JSON_BYTES) so a mutation to the constant itself is caught —
// a boundary test built FROM the same (possibly mutated) constant it is meant to check
// can never observe the mutation, since both sides would move together.
const EXPECTED_MAX_CONFIG_JSON_BYTES = 65536;

test('MAX_CONFIG_JSON_BYTES is exactly 65536', () => {
  assert.equal(MAX_CONFIG_JSON_BYTES, EXPECTED_MAX_CONFIG_JSON_BYTES);
});

test('a config.json of EXACTLY the byte cap length is rejected (boundary precision, not off by one)', () => {
  const { dir } = makeAdlcDir();
  const template = (fillerLength) =>
    JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A, filler: 'x'.repeat(fillerLength) } });
  const shortfall = EXPECTED_MAX_CONFIG_JSON_BYTES - Buffer.byteLength(template(0));
  const content = template(shortfall);
  assert.equal(Buffer.byteLength(content), EXPECTED_MAX_CONFIG_JSON_BYTES, 'test setup: content must land exactly at the cap');
  writeFileSync(join(dir, CONFIG_FILENAME), content);
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, false, 'a file of exactly 65536 bytes must be rejected, not accepted');
});

test('a config.json ONE BYTE under the cap is read and parsed normally', () => {
  const { dir } = makeAdlcDir();
  const template = (fillerLength) =>
    JSON.stringify({ signing: { schemaVersion: 1, keyFingerprint: FP_A, filler: 'x'.repeat(fillerLength) } });
  const shortfall = EXPECTED_MAX_CONFIG_JSON_BYTES - 1 - Buffer.byteLength(template(0));
  const content = template(shortfall);
  assert.equal(Buffer.byteLength(content), EXPECTED_MAX_CONFIG_JSON_BYTES - 1, 'test setup: content must land one byte under the cap');
  writeFileSync(join(dir, CONFIG_FILENAME), content);
  const result = readAdoptionRecord(dir);
  assert.equal(result.present, true);
  assert.equal(result.valid, true);
});

// ── resolveActiveGenerationPaths ────────────────────────────────────────────────────

test('an absent adoption record resolves to the legacy in-place layout', () => {
  const paths = resolveActiveGenerationPaths(DIR, { present: false });
  assert.equal(paths.generationDir, DIR);
  assert.equal(paths.manifestPath, join(DIR, 'manifest.jsonl'));
  assert.equal(paths.segmentDirPath, join(DIR, 'manifest.d'));
});

test('a valid record with a real generation resolves under manifest-generations/', () => {
  const adoption = { present: true, valid: true, record: { schemaVersion: 1, keyFingerprint: FP_A, generation: 'g1', priorFingerprints: [] } };
  const paths = resolveActiveGenerationPaths(DIR, adoption);
  assert.equal(paths.generationDir, join(DIR, 'manifest-generations', 'g1'));
  assert.equal(paths.manifestPath, join(DIR, 'manifest-generations', 'g1', 'manifest.jsonl'));
  assert.equal(paths.segmentDirPath, join(DIR, 'manifest-generations', 'g1', 'manifest.d'));
});

test('a valid record with generation 0 resolves to the legacy layout too (adopted but not yet rotated)', () => {
  const adoption = { present: true, valid: true, record: { schemaVersion: 1, keyFingerprint: FP_A, generation: 0, priorFingerprints: [] } };
  const paths = resolveActiveGenerationPaths(DIR, adoption);
  assert.equal(paths.generationDir, DIR);
});

test('resolveActiveGenerationPaths refuses a malformed adoption record rather than guessing a generation', () => {
  const adoption = { present: true, valid: false, reason: 'signing.keyFingerprint must be a 64-character lowercase hex sha256 digest' };
  assert.throws(() => resolveActiveGenerationPaths(DIR, adoption), /keyFingerprint/);
});

// ── assertGenerationDirNotSymlinked ─────────────────────────────────────────────────

test('the legacy layout (generationDir === dir) still requires dir itself to be safe — mustExist:false tolerates a not-yet-created dir', () => {
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(DIR, DIR, { mustExist: false }));
});

test('the legacy layout with the DEFAULT (mustExist:true) rejects a dir that does not exist at all', () => {
  assert.throws(() => assertGenerationDirNotSymlinked(DIR, DIR));
});

test('.adlc ITSELF being a symlink is rejected, even for the legacy (generationDir === dir) case', () => {
  const { root, dir } = makeAdlcDir();
  const outside = join(root, 'outside-adlc');
  mkdirSync(outside, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(outside, dir);
  assert.throws(() => assertGenerationDirNotSymlinked(dir, dir), /symlink/);
});

test('a genuinely real, fully-created generation directory passes', () => {
  const { dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  mkdirSync(generationDir, { recursive: true });
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, generationDir));
});

test('a SYMLINKED manifest-generations/ directory is rejected — the exact committed-symlink attack', () => {
  const { root, dir } = makeAdlcDir();
  const outside = join(root, 'outside-generations');
  mkdirSync(join(outside, 'g1'), { recursive: true });
  symlinkSync(outside, join(dir, 'manifest-generations'));
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, generationDir), /symlink/);
});

test('a SYMLINKED generation id directory itself (manifest-generations/ real, g1 symlinked) is rejected', () => {
  const { root, dir } = makeAdlcDir();
  mkdirSync(join(dir, 'manifest-generations'), { recursive: true });
  const outside = join(root, 'outside-g1');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(dir, 'manifest-generations', 'g1'));
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, generationDir), /symlink/);
});

test('a NOT-YET-CREATED generation directory is rejected by DEFAULT (mustExist:true) — the common "verify an active generation" case must fail closed', () => {
  const { dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, generationDir));
});

test('mustExist:false explicitly tolerates a not-yet-created generation directory — the off-path transition-builder case', () => {
  const { dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, generationDir, { mustExist: false }));
});

test('a FILE occupying the manifest-generations/ position (not a directory) is rejected', () => {
  const { dir } = makeAdlcDir();
  writeFileSync(join(dir, 'manifest-generations'), 'not a directory');
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, generationDir), /not a directory/);
});

test('a SYMLINKED manifest.jsonl LEAF FILE is rejected even when every directory above it is genuinely real', () => {
  // The gap this closes: confining only the DIRECTORY tree up through generationDir
  // would pass here (every directory component really is a directory), while the leaf
  // file itself — the thing a verifier actually opens — is a symlink to a decoy or an
  // unbounded device. The check must be called on the EXACT path being used
  // (manifestPath), not only on its parent directory.
  const { root, dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  mkdirSync(generationDir, { recursive: true });
  const decoy = join(root, 'decoy-manifest.jsonl');
  writeFileSync(decoy, '{"seq":1}\n');
  const manifestPath = join(generationDir, 'manifest.jsonl');
  symlinkSync(decoy, manifestPath);
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, generationDir), 'the directory tree above the leaf is genuinely real');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, manifestPath), /symlink/, 'checking the EXACT leaf path must catch what checking only the directory misses');
});

test('a genuinely real manifest.jsonl leaf file (regular file, no symlink anywhere in its path) passes', () => {
  const { dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  mkdirSync(generationDir, { recursive: true });
  const manifestPath = join(generationDir, 'manifest.jsonl');
  writeFileSync(manifestPath, '{"seq":1}\n');
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, manifestPath));
});

// ── containment: targetPath must actually be INSIDE dir ─────────────────────────────

test('a SIBLING path (outside dir entirely) is rejected, not walked and certified safe', () => {
  const { root, dir } = makeAdlcDir();
  const sibling = join(root, 'CONTRIBUTING.md');
  writeFileSync(sibling, 'not part of .adlc');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, sibling), /not inside/);
});

test('an ANCESTOR path (dir\'s own parent) is rejected', () => {
  const { root, dir } = makeAdlcDir();
  assert.throws(() => assertGenerationDirNotSymlinked(dir, root), /not inside/);
});

test('a path escaping via .. components (e.g. .adlc/../../etc) is rejected even if every real component exists', () => {
  const { root, dir } = makeAdlcDir();
  const outside = join(root, 'outside-file.txt');
  writeFileSync(outside, 'data');
  const escaping = join(dir, '..', 'outside-file.txt');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, escaping), /not inside/);
});

test('a genuine descendant path is unaffected by the containment check', () => {
  const { dir } = makeAdlcDir();
  const generationDir = join(dir, 'manifest-generations', 'g1');
  mkdirSync(generationDir, { recursive: true });
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, generationDir, { mustExist: false }));
});

test('containment is still enforced when dir itself does NOT YET EXIST and mustExist:false — the exact gap this closes', () => {
  // Before this fix: checkComponent(dir, ...) hit ENOENT, returned false with
  // mustExist:false, and the whole function returned BEFORE the containment check ever
  // ran — so an out-of-tree target was silently "approved" whenever dir hadn't been
  // created yet (the normal state before initial adoption).
  const root = mkdtempSync(join(tmpdir(), 'adlc-generation-descriptor-'));
  const dir = join(root, '.adlc'); // deliberately never created
  const outsideSibling = join(root, 'CONTRIBUTING.md');
  assert.throws(() => assertGenerationDirNotSymlinked(dir, outsideSibling, { mustExist: false }), /not inside/);
});

test('a genuine descendant is still tolerated when dir does not yet exist and mustExist:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-generation-descriptor-'));
  const dir = join(root, '.adlc');
  const generationDir = join(dir, 'manifest-generations', 'g1');
  assert.doesNotThrow(() => assertGenerationDirNotSymlinked(dir, generationDir, { mustExist: false }));
});
