import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import {
  ADMIN_PUB_FILENAME,
  PRIVATE_KEY_ENV,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  KEY_ENV,
  getKey,
  signEntry,
  verifyEntrySig,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
} from '../lib/sign.mjs';
import { appendManifestEntry, buildEntry, record } from '../lib/record.mjs';
import { writePublicKeyFile } from '../lib/key-ceremony.mjs';
import { verify } from '../lib/verify.mjs';

const BIN = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;

function runCli(args, cwd, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function zeroSecretEnv(extra = {}) {
  const env = { ...process.env, ADLC_MANIFEST_KEY: '', ...extra };
  if (!Object.hasOwn(extra, 'ADLC_MANIFEST_PRIVATE_KEY')) {
    delete env.ADLC_MANIFEST_PRIVATE_KEY;
  }
  return env;
}

function initGitRepo(t, prefix) {
  const repoDir = tmp(t, prefix);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repoDir });
  return repoDir;
}

test('sign.mjs re-exports Ed25519 primitives and delegates getKey() to resolveKeyFromEnv()', () => {
  assert.equal(ADMIN_PUB_FILENAME, 'admin.pub');
  assert.equal(PRIVATE_KEY_ENV, 'ADLC_MANIFEST_PRIVATE_KEY');
  assert.equal(ED25519_PRIV_PREFIX, 'ed25519-priv:');
  assert.equal(SIG_ALG_ED25519, 'ed25519');
  assert.equal(KEY_ENV, 'ADLC_MANIFEST_KEY');

  const pair = generateEd25519KeyPair();
  assert.equal(isEd25519PrivateKey(pair.privateKey), true);
  assert.equal(isEd25519PrivateKey('hmac-secret'), false);
  assert.equal(derivePublicKeyPem(pair.privateKey), pair.publicKey);

  // Precedence and explicit-empty fail-closed semantics
  assert.equal(getKey({ ADLC_MANIFEST_PRIVATE_KEY: pair.privateKey, ADLC_MANIFEST_KEY: 'hmac' }), pair.privateKey);
  assert.equal(getKey({ ADLC_MANIFEST_PRIVATE_KEY: '', ADLC_MANIFEST_KEY: 'hmac' }), null);
  assert.equal(getKey({ ADLC_MANIFEST_KEY: 'hmac' }), 'hmac');
  assert.equal(getKey({}), null);

  // signEntry & verifyEntrySig round-trip for Ed25519 and HMAC
  const edEntry = {
    seq: 1,
    gate: 'p4-build',
    ts: '2026-11-27T00:00:00.000Z',
    files: {},
    prev: null,
    sigVersion: 2,
    sigAlg: SIG_ALG_ED25519,
  };
  const sig = signEntry(pair.privateKey, edEntry);
  assert.equal(sig, signEntryEd25519(pair.privateKey, edEntry));
  const signedEd = { ...edEntry, sig };
  assert.equal(verifyEntryEd25519(pair.publicKey, signedEd), true);
  assert.equal(verifyEntrySig(null, signedEd, { publicKey: pair.publicKey }), true);
  assert.equal(verifyEntrySig(pair.privateKey, signedEd), true);
  assert.equal(verifyEntrySig(null, signedEd), false);

  const hmacEntry = {
    seq: 1,
    gate: 'p4-build',
    ts: '2026-11-27T00:00:00.000Z',
    files: {},
    prev: null,
    sigVersion: 2,
  };
  const signedHmac = { ...hmacEntry, sig: signEntry('hmac-secret', hmacEntry) };
  assert.equal(verifyEntrySig('hmac-secret', signedHmac), true);
  assert.equal(verifyEntrySig(pair.privateKey, signedHmac), false);
});

test('monolithic manifest: dual-era unsigned -> HMAC -> Ed25519 verifies with zero secrets via admin.pub', (t) => {
  const dir = tmp(t, 'adlc-ed25519-mono-');
  const pair = generateEd25519KeyPair();
  writeFileSync(join(dir, ADMIN_PUB_FILENAME), pair.publicKey, 'utf8');
  assert.equal(readAdminPublicKey(dir).status, 'ok');

  // 1. Legacy unsigned entry
  const e1 = appendManifestEntry({ gate: 'legacy-unsigned' }, dir, { key: null });
  assert.equal(e1.sig, undefined);

  // 2. Legacy HMAC entry
  const e2 = appendManifestEntry({ gate: 'legacy-hmac' }, dir, { key: 'old-hmac-secret' });
  assert.equal(typeof e2.sig, 'string');
  assert.equal(e2.sigAlg, undefined);

  // 3. Ed25519 entry via record() (even though record() defaults to signatureVersion: 1)
  const e3 = record({ gate: 'ed25519-gate', dir, key: pair.privateKey });
  assert.equal(e3.sigVersion, 2);
  assert.equal(e3.sigAlg, SIG_ALG_ED25519);
  assert.match(e3.sig, /^[0-9a-f]{128}$/);

  // Verify via library with key: null (auto-reads <dir>/admin.pub)
  const res = verify(dir, { requireSignatures: true, key: null });
  assert.equal(res.valid, true, res.message);
  assert.equal(res.signed, true);
  assert.equal(res.count, 3);

  // Verify via CLI with zero secrets (ADLC_MANIFEST_KEY & ADLC_MANIFEST_PRIVATE_KEY unset/empty)
  const cliRes = runCli(['verify', '--dir', dir, '--json'], dir, zeroSecretEnv());
  assert.equal(cliRes.status, 0, cliRes.stderr);
  const parsed = JSON.parse(cliRes.stdout);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.signed, true);

  // Explicit publicKey: null disables admin.pub auto-read
  const noPubRes = verify(dir, { requireSignatures: false, key: null, publicKey: null });
  assert.equal(noPubRes.valid, true);
  assert.equal(noPubRes.signed, false);
});

test('monolithic manifest: refuses reserved sigAlg field, mismatched private key, corrupt admin.pub, and post-Ed25519 downgrade', (t) => {
  const dir = tmp(t, 'adlc-ed25519-refuse-');
  const pairA = generateEd25519KeyPair();
  const pairB = generateEd25519KeyPair();
  writeFileSync(join(dir, ADMIN_PUB_FILENAME), pairA.publicKey, 'utf8');

  // Reserved chain field `sigAlg` rejected
  assert.throws(
    () => appendManifestEntry({ gate: 'x', sigAlg: 'ed25519' }, dir, { key: null }),
    /reserved chain field: sigAlg/,
  );

  // Mismatched private key rejected before writing
  assert.throws(
    () => record({ gate: 'x', dir, key: pairB.privateKey }),
    /does not match admin\.pub/,
  );
  assert.equal(existsSync(join(dir, 'manifest.jsonl')), false);

  // Valid Ed25519 entry
  record({ gate: 'ed-ok', dir, key: pairA.privateKey });

  // Post-Ed25519 downgrade (appending an unsigned or HMAC entry after an Ed25519 entry) fails verify with exit 2
  const manifestPath = join(dir, 'manifest.jsonl');
  const raw = readFileSync(manifestPath, 'utf8').trim();
  const downgradeEntry = {
    seq: 2,
    gate: 'downgrade-hmac',
    ts: '2026-11-27T00:00:01.000Z',
    files: {},
    prev: null,
  };
  // Append via library with HMAC key: record.mjs verifies chain first, which succeeds, then appends HMAC;
  // subsequent verify MUST detect downgrade after ed25519 era!
  appendManifestEntry({ gate: 'downgrade-hmac' }, dir, { key: 'hmac-secret' });
  const verifyDowngrade = runCli(['verify', '--dir', dir, '--json'], dir, zeroSecretEnv());
  assert.equal(verifyDowngrade.status, 2, 'downgrade after ed25519 must exit 2');
  const downgradeJson = JSON.parse(verifyDowngrade.stdout);
  assert.equal(downgradeJson.valid, false);
  assert.match(downgradeJson.message, /ed25519/i);

  // Restore valid single-entry manifest and verify tampering fails with exit 2
  writeFileSync(manifestPath, `${raw.replace('ed-ok', 'ed-tampered')}\n`, 'utf8');
  const verifyTampered = runCli(['verify', '--dir', dir, '--json'], dir, zeroSecretEnv());
  assert.equal(verifyTampered.status, 2, 'tampered ed25519 entry must exit 2');

  // Corrupt admin.pub fails closed on record()
  const corruptDir = tmp(t, 'adlc-ed25519-corrupt-');
  writeFileSync(join(corruptDir, ADMIN_PUB_FILENAME), 'not-a-valid-pem\n', 'utf8');
  assert.throws(
    () => record({ gate: 'x', dir: corruptDir, key: pairA.privateKey }),
    /admin\.pub/,
  );
  // Prevent unused var lint
  assert.equal(downgradeEntry.seq, 2);
});

test('segmented manifest: Ed25519 record + zero-secret verify + mismatched key refusal', (t) => {
  const repoDir = initGitRepo(t, 'adlc-ed25519-seg-');
  const adlcDir = join(repoDir, '.adlc');
  mkdirSync(join(adlcDir, 'manifest.d'), { recursive: true });
  writeFileSync(
    join(repoDir, '.gitignore'),
    '.adlc/manifest.d/.lineage\n.adlc/manifest.d/*.lock\n.adlc/manifest.d/*.tmp-*\n',
    'utf8',
  );
  writeFileSync(
    join(adlcDir, 'manifest.d', '.store.json'),
    JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }),
    'utf8',
  );

  const pairA = generateEd25519KeyPair();
  const pairB = generateEd25519KeyPair();
  writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), pairA.publicKey, 'utf8');

  // Mismatched private key rejected on segmented write
  assert.throws(
    () => appendManifestEntry({ gate: 'seg-bad' }, adlcDir, { cwd: repoDir, key: pairB.privateKey }),
    /does not match admin\.pub/,
  );

  // Record via CLI with ADLC_MANIFEST_PRIVATE_KEY
  const rec1 = runCli(
    ['record', 'seg-ed-1', '--dir', adlcDir, '--json'],
    repoDir,
    zeroSecretEnv({ ADLC_MANIFEST_PRIVATE_KEY: pairA.privateKey }),
  );
  assert.equal(rec1.status, 0, rec1.stderr);
  const entry1 = JSON.parse(rec1.stdout);
  assert.equal(entry1.sigVersion, 2);
  assert.equal(entry1.sigAlg, SIG_ALG_ED25519);

  // Append a second entry on the same segment
  const rec2 = runCli(
    ['record', 'seg-ed-2', '--dir', adlcDir, '--json'],
    repoDir,
    zeroSecretEnv({ ADLC_MANIFEST_PRIVATE_KEY: pairA.privateKey }),
  );
  assert.equal(rec2.status, 0, rec2.stderr);
  const entry2 = JSON.parse(rec2.stdout);
  assert.equal(entry2.seq, 2);
  assert.equal(entry2.sigAlg, SIG_ALG_ED25519);

  // Verify via CLI with zero secrets (ADLC_MANIFEST_KEY & ADLC_MANIFEST_PRIVATE_KEY both unset/empty)
  const ver = runCli(['verify', '--dir', adlcDir, '--json'], repoDir, zeroSecretEnv());
  assert.equal(ver.status, 0, ver.stderr);
  const verJson = JSON.parse(ver.stdout);
  assert.equal(verJson.valid, true);
  assert.equal(verJson.signed, true);
  assert.equal(verJson.segments, 1);
  assert.equal(verJson.count, 2);
});

test('CLI: generate-key --ed25519 writes 0600 private key outside repo, optional --public-output, never leaks private key', (t) => {
  const repoDir = initGitRepo(t, 'adlc-ed25519-ceremony-repo-');
  const outsideDir = tmp(t, 'adlc-ed25519-ceremony-out-');
  const privPath = join(outsideDir, 'ed25519.key');
  const pubPath = join(repoDir, '.adlc', ADMIN_PUB_FILENAME);

  const res = runCli(
    ['generate-key', '--ed25519', '--output', privPath, '--public-output', pubPath, '--json'],
    repoDir,
    zeroSecretEnv(),
  );
  assert.equal(res.status, 0, res.stderr);

  const rawPriv = readFileSync(privPath, 'utf8');
  assert.ok(rawPriv.endsWith('\n'), 'handoff file must be newline-terminated');
  const privKey = rawPriv.trimEnd();
  assert.ok(privKey.startsWith(ED25519_PRIV_PREFIX), 'private key must carry ed25519-priv: prefix');
  assert.equal(statSync(privPath).mode & 0o777, 0o600, 'private key handoff file must be mode 0600');

  // Zero private key bytes on stdout or stderr
  assert.ok(!res.stdout.includes(privKey), 'private key must never appear on stdout');
  assert.ok(!res.stderr.includes(privKey), 'private key must never appear on stderr');
  const rawB64 = privKey.slice(ED25519_PRIV_PREFIX.length);
  assert.ok(!res.stdout.includes(rawB64), 'raw base64 private key must never appear on stdout');
  assert.ok(!res.stderr.includes(rawB64), 'raw base64 private key must never appear on stderr');

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.algorithm, 'ed25519');
  assert.equal(parsed.output, privPath);
  assert.equal(parsed.publicOutput, pubPath);
  assert.match(parsed.keyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(parsed.publicKey, derivePublicKeyPem(privKey));
  assert.equal(readFileSync(pubPath, 'utf8'), parsed.publicKey);

  // Refuses writing private key inside the repository
  const insidePath = join(repoDir, 'leaked.key');
  const insideRes = runCli(
    ['generate-key', '--ed25519', '--output', insidePath, '--json'],
    repoDir,
    zeroSecretEnv(),
  );
  assert.notEqual(insideRes.status, 0);
  assert.equal(existsSync(insidePath), false);

  // Refuses symlink for --public-output
  const linkTarget = join(outsideDir, 'target.pub');
  writeFileSync(linkTarget, 'dummy', 'utf8');
  const symlinkPub = join(repoDir, 'link.pub');
  symlinkSync(linkTarget, symlinkPub);
  const symPrivPath = join(outsideDir, 'ed25519-2.key');
  const symRes = runCli(
    ['generate-key', '--ed25519', '--output', symPrivPath, '--public-output', symlinkPub, '--json'],
    repoDir,
    zeroSecretEnv(),
  );
  assert.notEqual(symRes.status, 0);
  assert.match(symRes.stderr, /symlink/i);

  // writePublicKeyFile rejects invalid PEM; buildEntry stamps sigVersion:2 + sigAlg:ed25519
  assert.throws(() => writePublicKeyFile(join(outsideDir, 'bad.pub'), 'not-a-pem'), TypeError);
  const kp = generateEd25519KeyPair();
  const built = buildEntry({ gate: 'test', ticket: 'T-1', filePaths: [], prevRawLine: null, prevSeq: 0, ts: new Date().toISOString(), key: kp.privateKey });
  assert.equal(built.sigVersion, 2);
  assert.equal(built.sigAlg, SIG_ALG_ED25519);
  assert.equal(verifyEntrySig(null, built, { publicKey: kp.publicKey }), true);
});
