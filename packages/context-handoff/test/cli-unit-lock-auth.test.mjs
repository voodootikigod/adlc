import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isPidAlive, unlockSession, writeLock } from '../lib/lock.mjs';
import {
  SCHEMA,
  buildResumeAuthDoc,
  verifyResumeAuthSig,
  writeResumeAuth,
  readResumeAuth,
} from '../lib/resume-auth.mjs';
import { commonFromValues } from '../lib/cli-helpers.mjs';
import { writeDenyRecord } from '../lib/deny-persist.mjs';
import { TMP_HEX_BYTES, writeJsonAtomic } from '../lib/atomic-json.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');

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

test('commonFromValues treats write as true only when exactly true', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-cfv-'));
  try {
    assert.equal(commonFromValues({ dir: '.adlc', write: true }, root).write, true);
    assert.equal(commonFromValues({ dir: '.adlc', write: false }, root).write, false);
    assert.equal(commonFromValues({ dir: '.adlc' }, root).write, false);
    assert.equal(commonFromValues({ dir: '.adlc', write: 1 }, root).write, false);
    assert.equal(commonFromValues({ dir: '.adlc', write: 'true' }, root).write, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeDenyRecord rejects null/non-object records', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-wdr-'));
  try {
    // Exact error distinguishes the early guard from later try/catch on
    // null.session_id (which would also return ok:false under a ||→&& swap).
    for (const bad of [null, undefined, 'nope', 42, true]) {
      const r = writeDenyRecord(root, bad);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'missing record');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TMP_HEX_BYTES is 8 and unique tmp uses that width', () => {
  assert.equal(TMP_HEX_BYTES, 8);
  const root = mkdtempSync(join(tmpdir(), 'handoff-tmp-'));
  try {
    const path = join(root, 'out.json');
    const temps = [];
    const fs = {
      mkdirSync() {},
      writeFileSync(tmp) {
        temps.push(tmp);
      },
      renameSync() {},
      unlinkSync() {},
      existsSync() {
        return false;
      },
    };
    writeJsonAtomic(path, { a: 1 }, { fs });
    assert.equal(temps.length, 1);
    const m = temps[0].match(/\.([0-9a-f]+)\.tmp$/);
    assert.ok(m, temps[0]);
    assert.equal(m[1].length, TMP_HEX_BYTES * 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help usage keeps angle-bracket placeholders', () => {
  const stdout = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(stdout, /^handoff <subcommand> \[options\]/m);
  assert.match(stdout, /--dir <path>/);
  assert.doesNotMatch(stdout, /handoff >=subcommand>/);
  assert.doesNotMatch(stdout, /--dir >=path>/);
});
