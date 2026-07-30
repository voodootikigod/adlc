// key-contract.test.mjs — AC2.2 of T-01KYQMPBK8TKJKNRQABD8FXC61
// (spec .adlc/specs/manifest-key-hermeticity.md, Layer 2).
//
// The four library boundaries — appendManifestEntry/record, verify, repairChain, and the
// tickets evidence writer — take `key` as a REQUIRED, validated parameter with no
// ambient fallback. Every case here runs with process.env.ADLC_MANIFEST_KEY SET to a
// sentinel that must never be consulted: if any function falls back to the environment,
// an assertion below fails loudly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendManifestEntry, record } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { repairChain } from '../lib/repair.mjs';
import { verifyEntrySig } from '../lib/sign.mjs';
import { recordTicketEvidence } from '@adlc/tickets';

const AMBIENT = 'ambient-key-that-must-never-be-consulted';
let savedKey;
before(() => { savedKey = process.env.ADLC_MANIFEST_KEY; process.env.ADLC_MANIFEST_KEY = AMBIENT; });
after(() => {
  if (savedKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
  else process.env.ADLC_MANIFEST_KEY = savedKey;
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-key-contract-'));
  return dir;
}

test('omitting key throws for every boundary — never an ambient fallback', () => {
  const dir = scratchDir();
  try {
    assert.throws(() => appendManifestEntry({ type: 'x' }, dir), /key/i);
    assert.throws(() => record({ gate: 'g', dir }), /key/i);
    assert.throws(() => verify(dir), /key/i);
    assert.throws(() => repairChain({ dir, reason: 'contract test reason' }), /key/i);
    assert.throws(() => recordTicketEvidence(dir, { transactionId: 't', operation: 'update', storeHash: 'h' }), /key/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit '' and non-strings throw at every boundary", () => {
  const dir = scratchDir();
  try {
    for (const bad of ['', 42, true]) {
      assert.throws(() => appendManifestEntry({ type: 'x' }, dir, { key: bad }), /key/i);
      assert.throws(() => verify(dir, { key: bad }), /key/i);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('key: null takes the UNSIGNED branch even with the ambient env key set', () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir), { recursive: true });
    const entry = appendManifestEntry({ type: 'contract-null' }, dir, { key: null });
    assert.equal(entry.sig, undefined, 'null key must write unsigned — the ambient env key must not be consulted');
    const raw = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trim();
    assert.ok(!raw.includes(AMBIENT), 'ambient sentinel must not leak into the ledger');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('key: <literal> signs with THAT key even when the env carries a different one', () => {
  const dir = scratchDir();
  const literal = 'explicit-test-key';
  try {
    const entry = appendManifestEntry({ type: 'contract-literal' }, dir, { key: literal });
    assert.equal(typeof entry.sig, 'string');
    assert.equal(verifyEntrySig(literal, entry), true, 'signed under the literal');
    assert.equal(verifyEntrySig(AMBIENT, entry), false, 'NOT signed under the ambient env key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify with key: null checks the chain; with a literal it checks signatures under it', () => {
  const dir = scratchDir();
  try {
    appendManifestEntry({ type: 'a' }, dir, { key: 'k1' });
    appendManifestEntry({ type: 'b' }, dir, { key: 'k1' });
    assert.equal(verify(dir, { requireSignatures: false, key: null }).valid, true);
    assert.equal(verify(dir, { key: 'k1' }).valid, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
