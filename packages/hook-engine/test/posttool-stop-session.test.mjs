import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { evaluatePostTool } from '../lib/posttool.mjs';
import { hasManifestEvidence, evaluateStop } from '../lib/stop.mjs';
import { evaluateSessionStart } from '../lib/session-start.mjs';

const TEST_KEY = 'hook-engine-stop-test-key';

function makeRepo(prefix = 'adlc-he-stop-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [
        {
          id: 'T-HIGH',
          title: 'High risk ticket',
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

test('evaluatePostTool reports ok on clean lines and warns on repeated errors / scope violations', () => {
  const clean = evaluatePostTool({ lines: ['Writing src/a.mjs', 'All tests passed'], scopes: ['src/**'], maxBytes: 0 });
  assert.equal(clean.status, 'ok');
  assert.equal(clean.flailing, false);
  assert.equal(clean.advisory, null);

  const flail = evaluatePostTool({
    lines: [
      'Error: ENOENT missing foo',
      'Error: ENOENT missing foo',
      'Error: ENOENT missing foo',
      'Editing outside/bad.mjs',
    ],
    scopes: ['src/**'],
  });
  assert.equal(flail.status, 'warn');
  assert.equal(flail.flailing, true);
  assert.match(flail.advisory, /repeated-error/);
  assert.match(flail.advisory, /scope-violation/);
});

test('hasManifestEvidence and evaluateStop require HMAC-signed evidence and bound file reads', () => {
  const repo = makeRepo();
  try {
    // Missing key fails closed when evidence is required.
    const noKey = evaluateStop({ cwd: repo, requiredGate: 'prosecute', requireEvidence: true, key: '' });
    assert.equal(noKey.decision, 'block');
    assert.match(noKey.reason, /ADLC_MANIFEST_KEY/);

    // Initially no evidence: requireEvidence blocks.
    const blocked = evaluateStop({ cwd: repo, requiredGate: 'prosecute', requireEvidence: true, key: TEST_KEY });
    assert.equal(blocked.decision, 'block');
    assert.equal(blocked.hasEvidence, false);
    assert.equal(blocked.risk.tier, 'high');
    assert.match(blocked.reason, /missing signed gate "prosecute" evidence/);

    // Non-blocking mode allows while reporting risk tier.
    const allowedNoReq = evaluateStop({ cwd: repo, requiredGate: 'prosecute', requireEvidence: false, key: TEST_KEY });
    assert.equal(allowedNoReq.decision, 'allow');

    // Forged unsigned JSONL line in manifest.d/ is REJECTED.
    const segName = 'feat-test-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
    const segFile = join(repo, '.adlc', 'manifest.d', segName);
    writeFileSync(
      segFile,
      `${JSON.stringify({ seq: 1, gate: 'prosecute', ticket: 'T-HIGH', ts: '2026-01-01T00:00:00Z', files: {}, prev: null, data: {} })}\n`,
    );
    const forged = evaluateStop({ cwd: repo, requiredGate: 'prosecute', requireEvidence: true, key: TEST_KEY });
    assert.equal(forged.decision, 'block');
    assert.equal(forged.hasEvidence, false);

    // Properly HMAC-signed, chain-verified entry written by the real gate-manifest producer.
    rmSync(segFile, { force: true });
    record({
      gate: 'prosecute',
      ticket: 'T-HIGH',
      rawData: JSON.stringify({ revision: 'rev-abc123' }),
      dir: join(repo, '.adlc'),
      key: TEST_KEY,
    });

    const ev = hasManifestEvidence(repo, { gate: 'prosecute', ticketId: 'T-HIGH', revision: 'rev-abc123', key: TEST_KEY });
    assert.equal(ev.found, true, `expected verified evidence, got error=${ev.error}`);
    assert.equal(ev.matchingEntries.length, 1);

    // Wrong revision binding is rejected (prevents replay across revisions).
    const wrongRev = evaluateStop({ cwd: repo, requiredGate: 'prosecute', revision: 'rev-different', requireEvidence: true, key: TEST_KEY });
    assert.equal(wrongRev.decision, 'block');
    assert.equal(wrongRev.hasEvidence, false);

    const allowed = evaluateStop({ cwd: repo, requiredGate: 'prosecute', revision: 'rev-abc123', requireEvidence: true, key: TEST_KEY });
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.hasEvidence, true);

    // Malformed line appended to ledger fails closed (not silently skipped).
    writeFileSync(segFile, '{broken-json\n');
    const malformed = evaluateStop({ cwd: repo, requiredGate: 'prosecute', revision: 'rev-abc123', requireEvidence: true, key: TEST_KEY });
    assert.equal(malformed.decision, 'block');
    assert.match(malformed.reason, /malformed JSONL/);
    rmSync(segFile, { force: true });

    // Oversized manifest file fails closed under default 4 MiB bound.
    writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), Buffer.alloc(4 * 1024 * 1024 + 1, ' '));
    const oversized = hasManifestEvidence(repo, { gate: 'prosecute', ticketId: 'T-HIGH', key: TEST_KEY });
    assert.equal(oversized.found, false);
    assert.match(oversized.error, /exceeds .*manifest scan bound/);
    rmSync(join(repo, '.adlc', 'manifest.jsonl'), { force: true });

    // Too many manifest segments (>64) fails closed under default 64-segment bound.
    for (let i = 0; i < 65; i++) {
      const suffix = String(i).padStart(2, '0');
      writeFileSync(join(repo, '.adlc', 'manifest.d', `seg-${suffix}-01ARZ3NDEKTSV4RRFFQ69G5F${suffix}.jsonl`), '');
    }
    const tooMany = hasManifestEvidence(repo, { gate: 'prosecute', ticketId: 'T-HIGH', key: TEST_KEY });
    assert.equal(tooMany.found, false);
    assert.match(tooMany.error, /64-segment/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('evaluateSessionStart injects active ticket, risk tier, and frozen rails', () => {
  const repo = makeRepo('adlc-he-session-');
  const plain = mkdtempSync(join(tmpdir(), 'adlc-he-plain-'));
  try {
    const res = evaluateSessionStart({ cwd: repo });
    assert.ok(res.root);
    assert.equal(res.activeTicket.id, 'T-HIGH');
    assert.equal(res.risk.tier, 'high');
    assert.deepEqual(res.rails, ['test/frozen.test.mjs']);
    assert.match(res.additionalContext, /T-HIGH/);
    assert.match(res.additionalContext, /test\/frozen\.test\.mjs/);

    const empty = evaluateSessionStart({ cwd: plain });
    assert.equal(empty.root, null);
    assert.equal(empty.additionalContext, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});
