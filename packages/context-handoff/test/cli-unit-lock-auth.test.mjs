import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPidAlive, unlockSession, writeLock } from '../lib/lock.mjs';
import {
  SCHEMA,
  buildResumeAuthDoc,
  verifyResumeAuthSig,
  writeResumeAuth,
  readResumeAuth,
} from '../lib/resume-auth.mjs';

test('isPidAlive rejects non-integer and non-positive pids', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5), false);
  assert.equal(isPidAlive(NaN), false);
  assert.equal(isPidAlive('12'), false);
});

test('isPidAlive reports the current process as alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('resume-auth schema is exactly 1 and binds the signature', () => {
  assert.equal(SCHEMA, 1);
  const key = 'test-manifest-key-for-schema';
  const doc = buildResumeAuthDoc({
    ticketId: 'T155',
    contentHash: 'abc',
    denySessionId: 'denier',
    consumerSessionId: 'consumer',
    key,
  });
  assert.equal(doc.schema, 1);
  assert.equal(verifyResumeAuthSig(key, doc), true);
  // Tampering the signature bytes must fail closed.
  assert.equal(verifyResumeAuthSig(key, { ...doc, sig: '0'.repeat(doc.sig.length) }), false);
});

test('writeResumeAuth round-trips verified bind fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ra-'));
  try {
    const key = 'roundtrip-key';
    const wrote = writeResumeAuth(
      root,
      'consumer',
      {
        ticketId: 'T155',
        contentHash: 'hash-1',
        denySessionId: 'denier',
      },
      { key },
    );
    assert.equal(wrote.ok, true);
    const read = readResumeAuth(root, 'consumer', { key });
    assert.equal(read?.verified, true);
    assert.equal(read?.ticket_id, 'T155');
    assert.equal(read?.content_hash, 'hash-1');
    assert.equal(read?.deny_session_id, 'denier');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unlockSession refuses when alive callback says pid is alive', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ul-'));
  try {
    writeLock(root, 's1', {
      pid: 4242,
      started_at: '2026-01-01T00:00:00.000Z',
      host: 'h',
      nonce: 'n',
    });
    const r = unlockSession(
      root,
      {
        sessionId: 's1',
        pid: 4242,
        startedAt: '2026-01-01T00:00:00.000Z',
        host: 'h',
        nonce: 'n',
        write: true,
      },
      { alive: () => true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
