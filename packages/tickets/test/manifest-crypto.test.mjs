import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADMIN_PUB_FILENAME,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
  entrySigValid,
  verifyEntrySig,
  verifyChain,
  verifyManifestForest,
  resolveOpenSegment,
  MARKER_FORMAT,
  MARKER_VERSION,
  markerPath,
  segmentDirPath,
  segmentPath,
  lineagePath,
} from '@adlc/tickets/lib/manifest-primitives.mjs';
import {
  PRIVATE_KEY_ENV,
  validateKeyParam,
  resolveKeyFromEnv,
} from '@adlc/tickets/lib/key-contract.mjs';
import {
  forestChainsIntact,
  readOwnChains,
} from '../lib/manifest-segments.mjs';
import { recordTicketEvidence } from '../lib/evidence.mjs';
import { sha256 } from '../lib/canonical.mjs';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-ed25519-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function initGitRepo(root, branch = 'feature/ed25519-test') {
  const env = {
    ...process.env,
    ADLC_MANIFEST_KEY: '',
    ADLC_MANIFEST_PRIVATE_KEY: '',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execFileSync('git', ['init', '-b', branch], { cwd: root, env, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), 'test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, env, stdio: 'ignore' });
}

function makeHmacEntry(seq, prevRawLine, hmacKey, extra = {}) {
  const entry = {
    seq,
    gate: 'test-gate',
    ts: '2026-01-01T00:00:00.000Z',
    files: {},
    prev: prevRawLine ? sha256(prevRawLine) : null,
    ...extra,
  };
  entry.sig = createHmac('sha256', hmacKey).update(canonicalEntryBytes(entry)).digest('hex');
  return entry;
}

function makeEd25519Entry(seq, prevRawLine, privateKey, extra = {}) {
  const entry = {
    seq,
    gate: 'test-gate',
    ts: '2026-01-01T00:00:00.000Z',
    files: {},
    prev: prevRawLine ? sha256(prevRawLine) : null,
    sigVersion: 2,
    sigAlg: SIG_ALG_ED25519,
    ...extra,
  };
  entry.sig = signEntryEd25519(privateKey, entry);
  return entry;
}

function makeUnsignedEntry(seq, prevRawLine, extra = {}) {
  return {
    seq,
    gate: 'test-gate',
    ts: '2026-01-01T00:00:00.000Z',
    files: {},
    prev: prevRawLine ? sha256(prevRawLine) : null,
    ...extra,
  };
}

function writeJsonl(filePath, entries) {
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  return lines;
}

test('subpath exports expose all Ed25519 primitives and key-contract helpers', () => {
  assert.equal(ADMIN_PUB_FILENAME, 'admin.pub');
  assert.equal(PRIVATE_KEY_ENV, 'ADLC_MANIFEST_PRIVATE_KEY');
  assert.equal(ED25519_PRIV_PREFIX, 'ed25519-priv:');
  assert.equal(SIG_ALG_ED25519, 'ed25519');
  assert.equal(typeof generateEd25519KeyPair, 'function');
  assert.equal(typeof isEd25519PrivateKey, 'function');
  assert.equal(typeof derivePublicKeyPem, 'function');
  assert.equal(typeof signEntryEd25519, 'function');
  assert.equal(typeof verifyEntryEd25519, 'function');
  assert.equal(typeof readAdminPublicKey, 'function');
  assert.equal(verifyEntrySig, entrySigValid);
});

test('generateEd25519KeyPair produces single-line private key, canonical SPKI PEM, and sha256 DER fingerprint', () => {
  const kp = generateEd25519KeyPair();
  assert.equal(isEd25519PrivateKey(kp.privateKey), true);
  assert.equal(kp.privateKey.includes('\n'), false);
  assert.equal(validateKeyParam(kp.privateKey), kp.privateKey);
  assert.match(kp.publicKey, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(kp.publicKey, /-----END PUBLIC KEY-----\n?$/);
  assert.match(kp.keyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(derivePublicKeyPem(kp.privateKey), kp.publicKey);

  // Verify fingerprint matches sha256 of SPKI DER bytes
  const spkiB64 = kp.publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const expectedFp = createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex');
  assert.equal(kp.keyFingerprint, expectedFp);
});

test('isEd25519PrivateKey and derivePublicKeyPem reject invalid inputs', () => {
  assert.equal(isEd25519PrivateKey('hmac-secret'), false);
  assert.equal(isEd25519PrivateKey(null), false);
  assert.equal(isEd25519PrivateKey(undefined), false);
  assert.equal(isEd25519PrivateKey(123), false);
  assert.equal(isEd25519PrivateKey(`${ED25519_PRIV_PREFIX}abc`), true);

  assert.throws(() => derivePublicKeyPem('not-prefixed'), /ed25519-priv:/);
  assert.throws(() => derivePublicKeyPem(ED25519_PRIV_PREFIX), /invalid Ed25519 private key/);
  assert.throws(() => derivePublicKeyPem(`${ED25519_PRIV_PREFIX}abc\ndef`), /invalid Ed25519 private key/);
  assert.throws(() => derivePublicKeyPem(`${ED25519_PRIV_PREFIX}AAAA`));

  // Non-Ed25519 PKCS8 DER (EC P-256) must be rejected
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecDer = ec.privateKey.export({ type: 'pkcs8', format: 'der' });
  assert.throws(
    () => derivePublicKeyPem(`${ED25519_PRIV_PREFIX}${ecDer.toString('base64')}`),
    /not an Ed25519/,
  );
});

test('signEntryEd25519 and verifyEntryEd25519 sign, verify, and reject tampering', () => {
  const kp1 = generateEd25519KeyPair();
  const kp2 = generateEd25519KeyPair();
  const entry = makeEd25519Entry(1, null, kp1.privateKey, { data: { ok: true } });

  assert.match(entry.sig, /^[0-9a-f]{128}$/);
  assert.equal(verifyEntryEd25519(kp1.publicKey, entry), true);
  assert.equal(verifyEntryEd25519(kp1.privateKey, entry), true);
  assert.equal(verifyEntryEd25519(kp2.publicKey, entry), false);
  assert.equal(verifyEntryEd25519(kp2.privateKey, entry), false);

  // Tampered payload
  assert.equal(verifyEntryEd25519(kp1.publicKey, { ...entry, gate: 'tampered' }), false);
  // Uppercase hex or short hex rejected
  assert.equal(verifyEntryEd25519(kp1.publicKey, { ...entry, sig: entry.sig.toUpperCase() }), false);
  assert.equal(verifyEntryEd25519(kp1.publicKey, { ...entry, sig: entry.sig.slice(0, 64) }), false);
  assert.equal(verifyEntryEd25519(kp1.publicKey, { ...entry, sig: '' }), false);
  // Bad key types rejected
  assert.equal(verifyEntryEd25519(null, entry), false);
  assert.equal(verifyEntryEd25519('', entry), false);
  assert.equal(verifyEntryEd25519('not-a-pem', entry), false);
  // Segment metadata excluded in sigVersion 2
  assert.equal(verifyEntryEd25519(kp1.publicKey, { ...entry, segment: 'main-01.jsonl' }), true);
});

test('resolveKeyFromEnv prefers ADLC_MANIFEST_PRIVATE_KEY by presence and fails closed on empty string', () => {
  const kp = generateEd25519KeyPair();
  assert.equal(
    resolveKeyFromEnv({ ADLC_MANIFEST_PRIVATE_KEY: kp.privateKey, ADLC_MANIFEST_KEY: 'hmac-secret' }),
    kp.privateKey,
  );
  // Empty ADLC_MANIFEST_PRIVATE_KEY must NOT fall back to ADLC_MANIFEST_KEY
  assert.equal(
    resolveKeyFromEnv({ ADLC_MANIFEST_PRIVATE_KEY: '', ADLC_MANIFEST_KEY: 'hmac-secret' }),
    null,
  );
  // Absent ADLC_MANIFEST_PRIVATE_KEY falls back to ADLC_MANIFEST_KEY
  assert.equal(
    resolveKeyFromEnv({ ADLC_MANIFEST_KEY: 'hmac-secret' }),
    'hmac-secret',
  );
  assert.equal(resolveKeyFromEnv({ ADLC_MANIFEST_KEY: '' }), null);
  assert.equal(resolveKeyFromEnv({}), null);
});

test('readAdminPublicKey handles absent, ok, boundary 4096 bytes, oversized, symlink, directory, and invalid keys', () => {
  const kp = generateEd25519KeyPair();
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPubPem = ec.publicKey.export({ type: 'spki', format: 'pem' });

  withTmpDir((dir) => {
    // Absent
    assert.deepEqual(readAdminPublicKey(dir), { status: 'absent', publicKey: null });

    // Valid
    const pubPath = join(dir, ADMIN_PUB_FILENAME);
    writeFileSync(pubPath, kp.publicKey);
    assert.deepEqual(readAdminPublicKey(dir), { status: 'ok', publicKey: kp.publicKey });

    // Exactly 4096 bytes (padded with trailing newlines) is accepted
    const padded = kp.publicKey + '\n'.repeat(4096 - Buffer.byteLength(kp.publicKey, 'utf8'));
    assert.equal(Buffer.byteLength(padded, 'utf8'), 4096);
    writeFileSync(pubPath, padded);
    assert.deepEqual(readAdminPublicKey(dir), { status: 'ok', publicKey: kp.publicKey });

    // 4097 bytes is rejected
    writeFileSync(pubPath, `${padded}\n`);
    const over = readAdminPublicKey(dir);
    assert.equal(over.status, 'error');
    assert.match(over.reason, /exceeds 4096/);

    // Invalid PEM content
    writeFileSync(pubPath, 'not a public key\n');
    const bad = readAdminPublicKey(dir);
    assert.equal(bad.status, 'error');
    assert.match(bad.reason, /not a valid Ed25519 SPKI/);

    // Non-Ed25519 SPKI PEM (EC) rejected
    writeFileSync(pubPath, ecPubPem);
    const nonEd = readAdminPublicKey(dir);
    assert.equal(nonEd.status, 'error');
    assert.match(nonEd.reason, /not a valid Ed25519 SPKI/);

    // Symlink rejected
    unlinkSync(pubPath);
    const target = join(dir, 'real.pub');
    writeFileSync(target, kp.publicKey);
    symlinkSync(target, pubPath);
    const sym = readAdminPublicKey(dir);
    assert.equal(sym.status, 'error');
    assert.match(sym.reason, /symlink/);

    // Directory rejected
    unlinkSync(pubPath);
    mkdirSync(pubPath);
    const dirRes = readAdminPublicKey(dir);
    assert.equal(dirRes.status, 'error');
    assert.match(dirRes.reason, /not a regular file/);
  });
});

test('entrySigValid routes Ed25519, HMAC, and rejects unknown sigAlg or mismatched keys', () => {
  const kp = generateEd25519KeyPair();
  const hmacKey = 'test-hmac-secret';
  const edEntry = makeEd25519Entry(1, null, kp.privateKey);
  const hmacEntry = makeHmacEntry(1, null, hmacKey);

  // Ed25519 with explicit publicKey and key: null
  assert.equal(entrySigValid(null, edEntry, { publicKey: kp.publicKey }), true);
  // Ed25519 with privateKey and publicKey: null (derives pubkey)
  assert.equal(entrySigValid(kp.privateKey, edEntry), true);
  // Ed25519 with no publicKey and HMAC key fails closed
  assert.equal(entrySigValid(hmacKey, edEntry), false);
  // Ed25519 with no publicKey and key: null fails closed
  assert.equal(entrySigValid(null, edEntry), false);
  // Ed25519 with malformed private key fails closed
  assert.equal(entrySigValid(`${ED25519_PRIV_PREFIX}bad`, edEntry), false);

  // HMAC with HMAC key
  assert.equal(entrySigValid(hmacKey, hmacEntry), true);
  // HMAC with Ed25519 private key fails closed (must not use private key string as HMAC secret)
  assert.equal(entrySigValid(kp.privateKey, hmacEntry), false);
  // HMAC with key: null fails closed even if publicKey is provided
  assert.equal(entrySigValid(null, hmacEntry, { publicKey: kp.publicKey }), false);

  // Unknown sigAlg always rejected
  for (const alg of ['rsa', 'hmac', '', null, 123]) {
    assert.equal(entrySigValid(hmacKey, { ...hmacEntry, sigAlg: alg }, { publicKey: kp.publicKey }), false);
  }
});

test('verifyChain and verifyManifestForest enforce dual-era verification and monotone Ed25519 era', () => {
  const kp = generateEd25519KeyPair();
  const hmacKey = 'legacy-hmac-key';

  withTmpDir((dir) => {
    writeFileSync(join(dir, ADMIN_PUB_FILENAME), kp.publicKey);

    // Dual-era root: unsigned -> HMAC -> Ed25519
    const e1 = makeUnsignedEntry(1, null);
    const l1 = JSON.stringify(e1);
    const e2 = makeHmacEntry(2, l1, hmacKey);
    const l2 = JSON.stringify(e2);
    const e3 = makeEd25519Entry(3, l2, kp.privateKey);
    writeJsonl(join(dir, 'manifest.jsonl'), [e1, e2, e3]);

    // Zero-secret verification via admin.pub succeeds with requireSignatures: true
    const ok = verifyManifestForest(dir, { key: null, requireSignatures: true });
    assert.equal(ok.valid, true, ok.message);
    assert.equal(ok.signed, true);
    assert.equal(ok.count, 3);

    // Explicit publicKey: null disables admin.pub lookup (keyless structural check only)
    const noPub = verifyManifestForest(dir, { key: null, publicKey: null, requireSignatures: true });
    assert.equal(noPub.valid, true);
    assert.equal(noPub.signed, false);

    // Downgrade: Ed25519 -> HMAC in same chain must fail closed
    const l3 = JSON.stringify(e3);
    const e4Hmac = makeHmacEntry(4, l3, hmacKey);
    writeJsonl(join(dir, 'manifest.jsonl'), [e1, e2, e3, e4Hmac]);
    const downgradeHmac = verifyManifestForest(dir, { key: null, requireSignatures: false });
    assert.equal(downgradeHmac.valid, false);
    assert.equal(downgradeHmac.break.reason, 'downgrade after ed25519 entry');

    // Downgrade: Ed25519 -> unsigned in same chain must fail closed
    const e4Unsigned = makeUnsignedEntry(4, l3);
    writeJsonl(join(dir, 'manifest.jsonl'), [e1, e2, e3, e4Unsigned]);
    const downgradeUnsigned = verifyManifestForest(dir, { key: null, requireSignatures: false });
    assert.equal(downgradeUnsigned.valid, false);
    assert.equal(downgradeUnsigned.break.reason, 'downgrade after ed25519 entry');

    // Pre-Ed25519-only chain fails when requireSignatures: true and admin.pub is present with key: null
    writeJsonl(join(dir, 'manifest.jsonl'), [e1, e2]);
    const noEd = verifyManifestForest(dir, { key: null, requireSignatures: true });
    assert.equal(noEd.valid, false);
    assert.match(noEd.break.reason, /no valid ed25519/);

    // Same pre-Ed25519-only chain passes structural check when requireSignatures: false
    const noEdLenient = verifyManifestForest(dir, { key: null, requireSignatures: false });
    assert.equal(noEdLenient.valid, true);
    assert.equal(noEdLenient.signed, false);

    // Corrupt admin.pub fails closed
    writeFileSync(join(dir, ADMIN_PUB_FILENAME), 'corrupt');
    const corrupt = verifyManifestForest(dir, { key: null, requireSignatures: false });
    assert.equal(corrupt.valid, false);
    assert.equal(corrupt.break.segment, ADMIN_PUB_FILENAME);
    assert.equal(forestChainsIntact(dir, { key: null }), false);
  });
});

test('verifyManifestForest enforces cross-segment monotone Ed25519 era and zero-secret verification', () => {
  const kp = generateEd25519KeyPair();
  const hmacKey = 'legacy-hmac-key';

  withTmpDir((dir) => {
    mkdirSync(segmentDirPath(dir), { recursive: true });
    writeFileSync(markerPath(dir), JSON.stringify({ format: MARKER_FORMAT, version: MARKER_VERSION, auth: 'keyed' }));
    writeFileSync(join(dir, ADMIN_PUB_FILENAME), kp.publicKey);

    // Pre-Ed25519 root (HMAC) + Ed25519 segment anchored to root
    const r1 = makeHmacEntry(1, null, hmacKey, { gate: 'manifest-cutover' });
    const [r1Line] = writeJsonl(join(dir, 'manifest.jsonl'), [r1]);

    const segA = 'main-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
    const sA1 = makeEd25519Entry(1, null, kp.privateKey, {
      anchor: { segment: 'root', seq: 1, lineHash: sha256(r1Line) },
      branch: 'main',
    });
    const [sA1Line] = writeJsonl(segmentPath(dir, segA), [sA1]);

    // Zero-secret verification succeeds across pre-Ed25519 root + Ed25519 segment
    const ok = verifyManifestForest(dir, { key: null, requireSignatures: true });
    assert.equal(ok.valid, true, ok.message);
    assert.equal(ok.signed, true);
    assert.equal(ok.count, 2);

    // Segment B anchored to Ed25519 segment A with an HMAC entry must fail (cross-segment downgrade)
    const segB = 'feat-01ARZ3NDEKTSV4RRFFQ69G5FAW.jsonl';
    const sB1 = makeHmacEntry(1, null, hmacKey, {
      sigVersion: 2,
      anchor: { segment: segA, seq: 1, lineHash: sha256(sA1Line) },
      branch: 'feat',
    });
    writeJsonl(segmentPath(dir, segB), [sB1]);

    const crossDowngrade = verifyManifestForest(dir, { key: null, requireSignatures: false });
    assert.equal(crossDowngrade.valid, false);
    assert.equal(crossDowngrade.break.segment, segB);
    assert.equal(crossDowngrade.break.reason, 'downgrade after ed25519 entry');
  });
});

test('recordTicketEvidence, resolveOpenSegment, and readOwnChains work end-to-end with Ed25519 (root & segmented)', () => {
  const kp1 = generateEd25519KeyPair();
  const kp2 = generateEd25519KeyPair();

  // Root mode
  withTmpDir((root) => {
    const adlcDir = join(root, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), kp1.publicKey);

    // Mismatched private key fails closed before writing
    assert.throws(
      () => recordTicketEvidence(root, {
        key: kp2.privateKey,
        transactionId: 'tx-mismatch',
        operation: 'create',
        storeHash: 'a'.repeat(64),
      }),
      /does not match admin\.pub/,
    );
    assert.equal(existsSync(join(adlcDir, 'manifest.jsonl')), false);

    // Matching private key records v2 Ed25519 entry
    const entry = recordTicketEvidence(root, {
      key: kp1.privateKey,
      transactionId: 'tx-root-1',
      operation: 'create',
      storeHash: 'a'.repeat(64),
    });
    assert.equal(entry.sigVersion, 2);
    assert.equal(entry.sigAlg, SIG_ALG_ED25519);
    assert.equal(verifyEntryEd25519(kp1.publicKey, entry), true);

    // Idempotent retry returns the same entry
    const retry = recordTicketEvidence(root, {
      key: kp1.privateKey,
      transactionId: 'tx-root-1',
      operation: 'create',
      storeHash: 'a'.repeat(64),
    });
    assert.equal(retry.seq, entry.seq);

    // Zero-secret verification via admin.pub passes
    const verified = verifyManifestForest(adlcDir, { key: null, requireSignatures: true });
    assert.equal(verified.valid, true, verified.message);
    assert.equal(verified.signed, true);

    // readOwnChains verifies with key: null via admin.pub
    const [rootChain] = readOwnChains(adlcDir, { key: null });
    assert.equal(rootChain.length, 1);
    assert.equal(rootChain[0].sigAlg, SIG_ALG_ED25519);
  });

  // Segmented mode with git repo (resolveOpenSegment recovery + readOwnChains recovery)
  withTmpDir((root) => {
    initGitRepo(root, 'feature/ed25519-seg');
    const adlcDir = join(root, '.adlc');
    mkdirSync(segmentDirPath(adlcDir), { recursive: true });
    writeFileSync(
      markerPath(adlcDir),
      JSON.stringify({ format: MARKER_FORMAT, version: MARKER_VERSION, auth: 'keyed' }),
    );
    writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), kp1.publicKey);

    const entry1 = recordTicketEvidence(root, {
      key: kp1.privateKey,
      transactionId: 'tx-seg-1',
      operation: 'create',
      storeHash: 'b'.repeat(64),
    });
    assert.equal(entry1.sigVersion, 2);
    assert.equal(entry1.sigAlg, SIG_ALG_ED25519);
    assert.equal(forestChainsIntact(adlcDir, { key: null }), true);

    // Delete .lineage token to force segment recovery
    unlinkSync(lineagePath(adlcDir));

    // resolveOpenSegment authenticates and recovers Ed25519 segment with private key
    const recovered = resolveOpenSegment(adlcDir, { cwd: root, key: kp1.privateKey });
    assert.equal(recovered.isNew, false);

    // readOwnChains recovers and verifies Ed25519 segment with ZERO secrets (key: null + admin.pub)
    const [rootEntries, segEntries] = readOwnChains(adlcDir, { cwd: root, allowRecovery: true, key: null });
    assert.equal(rootEntries.length, 0);
    assert.equal(segEntries.length, 1);
    assert.equal(segEntries[0].data.transactionId, 'tx-seg-1');

    // Mismatched private key fails closed in segmented mode
    assert.throws(
      () => recordTicketEvidence(root, {
        key: kp2.privateKey,
        transactionId: 'tx-seg-2',
        operation: 'update',
        storeHash: 'c'.repeat(64),
      }),
      /does not match admin\.pub/,
    );

    // Corrupt admin.pub fails closed in readOwnChains and resolveOpenSegment
    writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), 'bad-pem');
    assert.throws(() => readOwnChains(adlcDir, { cwd: root, allowRecovery: true, key: null }), /admin\.pub/);
    assert.throws(() => resolveOpenSegment(adlcDir, { cwd: root, key: kp1.privateKey }), /admin\.pub/);
  });
});

test('verifyChain rejects unsupported sigAlg and unsigned sigAlg:ed25519 entries', () => {
  const kp = generateEd25519KeyPair();

  const badAlg = makeUnsignedEntry(1, null, { sigAlg: 'ed448', sig: 'aa'.repeat(64) });
  const r1 = verifyChain([{ line: JSON.stringify(badAlg), lineNo: 1 }], {
    key: null,
    publicKey: kp.publicKey,
    requireSignatures: true,
    anchorOnFirst: false,
  });
  assert.equal(r1.valid, false);
  assert.equal(r1.break.reason, 'signature invalid');

  const missingSig = makeUnsignedEntry(1, null, { sigAlg: SIG_ALG_ED25519 });
  const r2 = verifyChain([{ line: JSON.stringify(missingSig), lineNo: 1 }], {
    key: null,
    publicKey: kp.publicKey,
    requireSignatures: false,
    anchorOnFirst: false,
  });
  assert.equal(r2.valid, false);
  assert.equal(r2.break.reason, 'unsigned entry');
});
