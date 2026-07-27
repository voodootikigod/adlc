// The migration-evidence hash chain (#363 round 4).
//
// `prev` is defined by @adlc/gate-manifest as sha256 of the PREVIOUS RAW LINE
// (record.mjs writes `sha256(state.lastRawLine)`; verify.mjs states the same rule). The
// gate validated the SECOND appended entry against `JSON.stringify(parsedEntry)` instead —
// a re-serialization that only coincides with the raw line when the writer's exact byte
// form happens to be reproduced. It is not: leading whitespace, key order, and spacing all
// diverge, so a manifest whose real chain is broken was accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateMigrationEvidence } from '../lib/ci/manifest.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const STORE_HASH = 'store-hash';
const ARCHIVE_HASH = 'archive-hash';
const TRANSACTION = 'txn-1';

const applyEntry = (prev) => ({
  gate: 'ticket-migrate',
  seq: 1,
  prev,
  data: {
    operation: 'migrate',
    action: 'apply',
    bindingScope: 'store',
    storeHash: STORE_HASH,
    archiveHash: ARCHIVE_HASH,
    transactionId: TRANSACTION,
  },
});

const recoverEntry = (prev) => ({
  gate: 'ticket-migrate',
  seq: 2,
  prev,
  data: {
    operation: 'migrate',
    action: 'recover-complete',
    bindingScope: 'store',
    storeHash: STORE_HASH,
    archiveHash: ARCHIVE_HASH,
    transactionId: TRANSACTION,
  },
});

const validate = (headText) => validateMigrationEvidence('', headText, STORE_HASH, ARCHIVE_HASH);

test('a two-entry migration chained over the real raw lines is accepted', () => {
  const applyLine = JSON.stringify(applyEntry(null));
  const headText = `${applyLine}\n${JSON.stringify(recoverEntry(sha256(applyLine)))}\n`;
  assert.doesNotThrow(() => validate(headText));
});

// The exploit: the apply line as WRITTEN carries leading whitespace, so its raw sha differs
// from the sha of its re-serialized form. Linking recover-complete to the re-serialization
// used to pass while the file's actual chain was broken.
test('recover-complete linked to a RE-SERIALIZED apply line is denied', () => {
  const parsed = applyEntry(null);
  const rawApplyLine = `  ${JSON.stringify(parsed)}`; // leading whitespace: raw !== stringify
  const forged = recoverEntry(sha256(JSON.stringify(parsed)));
  assert.notEqual(sha256(rawApplyLine), sha256(JSON.stringify(parsed)), 'the two forms must differ for this to test anything');

  assert.throws(
    () => validate(`${rawApplyLine}\n${JSON.stringify(forged)}\n`),
    /does not extend the manifest hash chain/
  );
});

test('recover-complete linked to the true raw apply line is accepted even when it is not canonical', () => {
  const rawApplyLine = `  ${JSON.stringify(applyEntry(null))}`;
  const honest = recoverEntry(sha256(rawApplyLine));
  assert.doesNotThrow(() => validate(`${rawApplyLine}\n${JSON.stringify(honest)}\n`));
});

test('a wrong prev on the FIRST appended entry is still denied', () => {
  assert.throws(
    () => validate(`${JSON.stringify(applyEntry(sha256('not the base')))}\n`),
    /does not extend the manifest hash chain/
  );
});

test('a sequence gap is denied', () => {
  const applyLine = JSON.stringify(applyEntry(null));
  const gapped = { ...recoverEntry(sha256(applyLine)), seq: 3 };
  assert.throws(() => validate(`${applyLine}\n${JSON.stringify(gapped)}\n`), /sequence does not extend/);
});
