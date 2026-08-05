import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  removeResumeAuth,
} from '../lib/resume-auth.mjs';
import { lockPath, resolveHandoffDirs, resumeAuthPath } from '../lib/paths.mjs';
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

test('isPidAlive treats EPERM as alive and ESRCH as dead', () => {
  const throwing = (code) => () => {
    const err = new Error(code);
    err.code = code;
    throw err;
  };
  // EPERM: the process exists, we just may not signal it — reclaiming its lock
  // would evict a live session.
  assert.equal(isPidAlive(4242, { kill: throwing('EPERM') }), true);
  assert.equal(isPidAlive(4242, { kill: throwing('ESRCH') }), false);
  assert.equal(isPidAlive(4242, { kill: throwing('EINVAL') }), false);
  assert.equal(
    isPidAlive(4242, {
      kill: () => {
        throw new Error('no code at all');
      },
    }),
    false,
  );
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

test('readResumeAuth refuses a document minted for another consumer session', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ra-x-'));
  try {
    const key = 'cross-session-key';
    const wrote = writeResumeAuth(
      root,
      'consumer-a',
      { ticketId: 'T155', contentHash: 'hash-1', denySessionId: 'denier' },
      { key },
    );
    assert.equal(wrote.ok, true);
    assert.equal(readResumeAuth(root, 'consumer-a', { key })?.verified, true);

    // Copy the signed document verbatim to another session's path: the signature
    // still verifies, so only the consumer_session_id bind can refuse it.
    const copied = writeJsonAtomic(resumeAuthPath(root, 'consumer-b'), wrote.doc);
    assert.equal(copied.ok, true);
    assert.equal(verifyResumeAuthSig(key, wrote.doc), true);
    assert.equal(readResumeAuth(root, 'consumer-b', { key }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removeResumeAuth deletes the cache and is safe when already absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ra-rm-'));
  try {
    const key = 'rollback-key';
    writeResumeAuth(
      root,
      'consumer-r',
      { ticketId: 'T155', contentHash: 'hash-1', denySessionId: 'denier' },
      { key },
    );
    assert.equal(existsSync(resumeAuthPath(root, 'consumer-r')), true);
    assert.equal(removeResumeAuth(root, 'consumer-r'), true);
    assert.equal(existsSync(resumeAuthPath(root, 'consumer-r')), false);
    assert.equal(removeResumeAuth(root, 'consumer-r'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveHandoffDirs refuses a --dir whose last segment is not .adlc', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-dirs-'));
  try {
    const ok = resolveHandoffDirs('.adlc', cwd);
    assert.equal(ok.ok, true);
    assert.equal(ok.adlcDir, join(cwd, '.adlc'));
    assert.equal(ok.root, cwd);

    const nested = resolveHandoffDirs(join('sub', '.adlc'), cwd);
    assert.equal(nested.ok, true);
    assert.equal(nested.root, join(cwd, 'sub'));

    // Artifacts join `.adlc` onto root themselves, so any other basename would
    // silently write artifacts and evidence into different trees.
    for (const bad of ['ledger', '.adlc-alt', '.', join('sub', 'adlc')]) {
      const got = resolveHandoffDirs(bad, cwd);
      assert.equal(got.ok, false, `expected refusal for --dir ${bad}`);
      assert.match(got.error, /must end in "\.adlc"/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('commonFromValues propagates the --dir refusal instead of resolving dirs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-cfv-bad-'));
  try {
    const bad = commonFromValues({ dir: 'ledger', write: true }, cwd);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /must end in "\.adlc"/);
    assert.equal(bad.root, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unlockSession refuses a lock whose host is not the local host', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ul-host-'));
  try {
    const lock = {
      pid: 4242,
      started_at: '2026-01-01T00:00:00.000Z',
      host: 'other-host',
      nonce: 'n',
    };
    writeLock(root, 's-host', lock);
    const args = {
      sessionId: 's-host',
      pid: 4242,
      startedAt: lock.started_at,
      host: lock.host,
      nonce: lock.nonce,
      write: true,
    };
    const foreign = unlockSession(root, args, { alive: () => false, localHost: 'this-host' });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.exitCode, 2);
    assert.match(foreign.error, /not this host/);
    assert.equal(existsSync(lockPath(root, 's-host')), true, 'foreign lock must survive');

    const owned = unlockSession(root, args, { alive: () => false, localHost: 'other-host' });
    assert.equal(owned.ok, true);
    assert.equal(existsSync(lockPath(root, 's-host')), false);
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
