import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import {
  ADMIN_PUB_FILENAME,
  SIG_ALG_ED25519,
  generateEd25519KeyPair,
  signEntryEd25519,
  generateSegmentUlid,
} from '@adlc/tickets/lib/manifest-primitives.mjs';
import {
  MAX_MANIFEST_SEGMENTS,
  MAX_MANIFEST_TOTAL_BYTES,
  MAX_MANIFEST_LINES,
  hasManifestEvidence,
  evaluateStop,
} from '../lib/stop.mjs';

function makeRepo(t, prefix = 'adlc-he-stop-ed25519-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-ED25519',
          title: 'Ed25519 zero-secret verification ticket',
          completed: false,
          risk: 'high',
          scope: ['packages/core/**'],
          rails: ['test/frozen.test.mjs'],
        },
      ],
    }, null, 2),
  );
  return dir;
}

test('stop.mjs exports raised manifest bounds (10_000 segments, 64 MiB total, 250_000 lines)', () => {
  assert.equal(MAX_MANIFEST_SEGMENTS, 10_000);
  assert.equal(MAX_MANIFEST_TOTAL_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_MANIFEST_LINES, 250_000);
});

test('hasManifestEvidence and evaluateStop succeed on 200 segments and verify Ed25519 with zero secrets via .adlc/admin.pub', (t) => {
  const repo = makeRepo(t);
  const adlcDir = join(repo, '.adlc');
  const { privateKey, publicKey } = generateEd25519KeyPair();
  writeFileSync(join(adlcDir, ADMIN_PUB_FILENAME), publicKey);

  // Record a root Ed25519-signed entry so segments can anchor to root seq 1.
  const rootEntry = record({
    gate: 'prosecute',
    ticket: 'T-ED25519',
    rawData: JSON.stringify({ revision: 'rev-ed25519-200' }),
    dir: adlcDir,
    key: privateKey,
  });
  const rootLine = JSON.stringify(rootEntry);
  const anchor = { segment: 'root', seq: 1, lineHash: sha256(rootLine) };

  // Create 200 valid Ed25519-signed anchored segments under .adlc/manifest.d/.
  const baseTs = 1_700_000_000_000;
  for (let i = 0; i < 200; i += 1) {
    const ulid = generateSegmentUlid(baseTs + i);
    const segName = `lane-${String(i).padStart(3, '0')}-${ulid}.jsonl`;
    const entry = {
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      gate: 'build-gate',
      ticket: 'T-ED25519',
      prev: null,
      anchor,
      data: { idx: i },
      sigVersion: 2,
      sigAlg: SIG_ALG_ED25519,
    };
    entry.sig = signEntryEd25519(privateKey, entry);
    writeFileSync(join(adlcDir, 'manifest.d', segName), `${JSON.stringify(entry)}\n`);
  }

  // Zero secrets: key: null and empty env — verified purely from .adlc/admin.pub.
  const ev = hasManifestEvidence(repo, {
    gate: 'prosecute',
    ticketId: 'T-ED25519',
    revision: 'rev-ed25519-200',
    key: null,
    env: {},
  });
  assert.equal(ev.error, null);
  assert.equal(ev.found, true);
  assert.equal(ev.manifestSegments.length, 200);
  assert.equal(ev.matchingEntries.length, 1);

  const stopRes = evaluateStop({
    cwd: repo,
    requiredGate: 'prosecute',
    revision: 'rev-ed25519-200',
    requireEvidence: true,
    key: null,
    env: {},
  });
  assert.equal(stopRes.decision, 'allow');
  assert.equal(stopRes.hasEvidence, true);
  assert.equal(stopRes.manifestSegments.length, 200);

  // Explicit maxTotalBytes bound fails closed when total bytes across segments exceed cap.
  const overBytes = hasManifestEvidence(repo, {
    gate: 'prosecute',
    ticketId: 'T-ED25519',
    key: null,
    env: {},
    maxTotalBytes: 1024,
  });
  assert.equal(overBytes.found, false);
  assert.match(overBytes.error, /exceeds .*manifest scan bound/);
});

test('hasManifestEvidence and evaluateStop fail closed on absent verifier, corrupt admin.pub, or symlinked admin.pub', (t) => {
  const repo = makeRepo(t, 'adlc-he-stop-failclosed-');
  const adlcDir = join(repo, '.adlc');
  const pubPath = join(adlcDir, ADMIN_PUB_FILENAME);

  // Neither key nor admin.pub -> fail closed.
  const noVerifier = evaluateStop({
    cwd: repo,
    requiredGate: 'prosecute',
    requireEvidence: true,
    key: null,
    env: {},
  });
  assert.equal(noVerifier.decision, 'block');
  assert.match(noVerifier.reason, /ADLC_MANIFEST_KEY/);

  // Corrupt admin.pub -> fail closed even if an HMAC key is provided.
  writeFileSync(pubPath, 'not-a-valid-pem-key\n');
  const corrupt = evaluateStop({
    cwd: repo,
    requiredGate: 'prosecute',
    requireEvidence: true,
    key: 'some-hmac-key',
    env: {},
  });
  assert.equal(corrupt.decision, 'block');
  assert.match(corrupt.reason, /admin\.pub/);
  rmSync(pubPath, { force: true });

  // Symlinked admin.pub -> fail closed.
  const outside = mkdtempSync(join(tmpdir(), 'adlc-he-stop-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const { publicKey } = generateEd25519KeyPair();
  const externalPub = join(outside, 'admin.pub');
  writeFileSync(externalPub, publicKey);
  symlinkSync(externalPub, pubPath);

  const symlinked = hasManifestEvidence(repo, {
    gate: 'prosecute',
    ticketId: 'T-ED25519',
    key: null,
    env: {},
  });
  assert.equal(symlinked.found, false);
  assert.match(symlinked.error, /admin\.pub/);
});
