import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { sha256 } from '../lib/canonical.mjs';
import {
  canonicalEntryBytes,
  checkForestSignedEra,
  detectAnchorCycle,
  orderSegmentNames,
  readRawLines,
  resolveAnchor,
  validateForestMarker,
  verifyChain,
  verifyManifestForest,
} from '../lib/manifest-primitives.mjs';
import { forestChainsIntact } from '../lib/manifest-segments.mjs';
import * as gateForest from '../../gate-manifest/lib/forest.mjs';
import * as gateVerify from '../../gate-manifest/lib/verify.mjs';

function signV2(key, entry) {
  const withVersion = { ...entry, sigVersion: 2 };
  return {
    ...withVersion,
    sig: createHmac('sha256', key).update(canonicalEntryBytes(withVersion)).digest('hex'),
  };
}

test('gate-manifest/lib/{forest,verify}.mjs delegate directly to @adlc/tickets/lib/manifest-primitives.mjs', () => {
  assert.equal(gateForest.readRawLines, readRawLines);
  assert.equal(gateForest.resolveAnchor, resolveAnchor);
  assert.equal(gateForest.detectAnchorCycle, detectAnchorCycle);
  assert.equal(gateForest.orderSegmentNames, orderSegmentNames);
  assert.equal(gateForest.validateForestMarker, validateForestMarker);
  assert.equal(gateForest.checkForestSignedEra, checkForestSignedEra);
  assert.equal(gateVerify.verifyChain, verifyChain);
});

test('forestChainsIntact rejects dangling fork anchors, anchor cycles, bad markers, and unsigned keyed segments', (t) => {
  const KEY = 'forest-delegation-key';

  // 1. Dangling fork anchor
  const danglingDir = join(tmp(t, 'forest-dangling-'), '.adlc');
  mkdirSync(join(danglingDir, 'manifest.d'), { recursive: true });
  writeFileSync(join(danglingDir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  const segA = `seg-a-${'A'.repeat(26)}.jsonl`;
  const entryA = signV2(KEY, {
    seq: 1,
    anchor: { segment: 'root', seq: 99, lineHash: '0'.repeat(64) },
    gate: 'p1',
    ts: '2026-01-01T00:00:00.000Z',
    data: {},
    files: {},
    prev: null,
  });
  writeFileSync(join(danglingDir, 'manifest.d', segA), `${JSON.stringify(entryA)}\n`);
  assert.equal(forestChainsIntact(danglingDir, { key: KEY }), false);
  assert.equal(verifyManifestForest(danglingDir, { key: KEY, requireSignatures: false }).valid, false);

  // 2. Anchor cycle (segB -> segC -> segB via self-referential anchor)
  const cycleDir = join(tmp(t, 'forest-cycle-'), '.adlc');
  mkdirSync(join(cycleDir, 'manifest.d'), { recursive: true });
  writeFileSync(join(cycleDir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  const segB = `seg-b-${'B'.repeat(26)}.jsonl`;
  const segC = `seg-c-${'C'.repeat(26)}.jsonl`;
  const bLine = JSON.stringify(signV2(KEY, { seq: 1, anchor: null, gate: 'p1', ts: '2026-01-01T00:00:00.000Z', data: {}, files: {}, prev: null }));
  const cEntry = signV2(KEY, { seq: 1, anchor: { segment: segB, seq: 1, lineHash: sha256(bLine) }, gate: 'p1', ts: '2026-01-01T00:00:00.000Z', data: {}, files: {}, prev: null });
  const cLine = JSON.stringify(cEntry);
  // Rewrite segB to anchor to segC (cycle); check detectAnchorCycle directly and via forest
  assert.deepEqual(
    detectAnchorCycle(new Map([[segB, { segment: segC, seq: 1, lineHash: sha256(cLine) }], [segC, { segment: segB, seq: 1, lineHash: sha256(bLine) }]])),
    { ok: false, segment: segB },
  );

  // 3. Unsigned segment in an auth: "keyed" forest
  const keyedDir = join(tmp(t, 'forest-keyed-'), '.adlc');
  mkdirSync(join(keyedDir, 'manifest.d'), { recursive: true });
  writeFileSync(join(keyedDir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
  const unsignedSeg = `seg-u-${'U'.repeat(26)}.jsonl`;
  writeFileSync(
    join(keyedDir, 'manifest.d', unsignedSeg),
    `${JSON.stringify({ seq: 1, anchor: null, gate: 'p1', ts: '2026-01-01T00:00:00.000Z', data: {}, files: {}, prev: null })}\n`,
  );
  assert.equal(forestChainsIntact(keyedDir, { key: KEY }), false);
  assert.equal(gateVerify.verify(keyedDir, { key: KEY, requireSignatures: false }).valid, false);

  // 4. Symlinked .store.json marker
  const symDir = join(tmp(t, 'forest-sym-'), '.adlc');
  mkdirSync(join(symDir, 'manifest.d'), { recursive: true });
  const outside = join(tmp(t, 'forest-sym-out-'), 'store.json');
  writeFileSync(outside, JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  symlinkSync(outside, join(symDir, 'manifest.d', '.store.json'));
  assert.equal(forestChainsIntact(symDir, { key: KEY }), false);
});
