import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTicketLock, readTicketLock, releaseTicketLock } from '../index.mjs';

test('one worktree lock records ownership and serializes writers without stealing stale locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-lock-'));
  try {
    const first = acquireTicketLock(root, { retries: 0, transactionId: 'one', command: 'test' });
    const metadata = readTicketLock(root);
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.transactionId, 'one');
    assert.throws(() => acquireTicketLock(root, { retries: 0 }), (error) => error.code === 'LOCK_TIMEOUT');
    assert.deepEqual(readTicketLock(root), metadata, 'a contender must not remove or rewrite the owner');
    releaseTicketLock(first);
    const second = acquireTicketLock(root, { retries: 0 });
    releaseTicketLock(second);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readTicketLock validates the shape it is declared to return', () => {
  // index.d.ts publishes TicketLockMetadata with a numeric pid and version, but
  // this only JSON-parsed whatever was on disk. `owner.json` holding the valid
  // JSON string "stale" therefore satisfied the compiler and crashed the caller
  // on `.pid` — and in an untrusted workspace that file is attacker-controlled.
  // An unrecognized shape now reads as NO lock rather than a lying object.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-shape-'));
  try {
    mkdirSync(join(root, '.adlc', 'tickets.lock'), { recursive: true });
    const ownerPath = join(root, '.adlc', 'tickets.lock', 'owner.json');
    const valid = {
      version: 1, pid: 1234, hostname: 'host', startedAt: '2026-07-26T00:00:00.000Z',
      command: 'adlc ticket update', transactionId: null,
    };

    writeFileSync(ownerPath, JSON.stringify(valid));
    assert.deepEqual(readTicketLock(root), valid, 'a well-formed lock still reads back');

    for (const [label, body] of [
      ['a bare string', '"stale"'],
      ['a number', '7'],
      ['null', 'null'],
      ['an array', '[]'],
      ['an empty object', '{}'],
      ['a missing pid', JSON.stringify({ ...valid, pid: undefined })],
      ['a string pid', JSON.stringify({ ...valid, pid: '1234' })],
      ['an unknown version', JSON.stringify({ ...valid, version: 2 })],
      ['a non-string command', JSON.stringify({ ...valid, command: 5 })],
      ['a numeric transactionId', JSON.stringify({ ...valid, transactionId: 5 })],
    ]) {
      writeFileSync(ownerPath, body);
      assert.equal(readTicketLock(root), null, `${label} must read as no lock`);
    }

    // A real transaction id is a string, and that must still be accepted.
    writeFileSync(ownerPath, JSON.stringify({ ...valid, transactionId: 'tx-1' }));
    assert.equal(readTicketLock(root)?.transactionId, 'tx-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseTicketLock survives a malformed owner file and leaves the lock alone', () => {
  // Hardening readTicketLock alone left THIS path parsing the same
  // attacker-controlled file and dereferencing it unvalidated: `owner.json`
  // becoming the valid JSON `null` made `.pid` throw. Release runs from
  // `finally` blocks across the transaction, migration, archive, fleet and sync
  // paths, so that TypeError would replace the operation's real result AND
  // strand the lock directory, timing out every later writer.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-release-'));
  try {
    for (const body of ['null', '7', '"stale"', '[]', '{}', '{"pid":"x"}', 'not json at all']) {
      const held = acquireTicketLock(root, { command: 'test' });
      writeFileSync(join(held.path, 'owner.json'), body);
      // Must not throw, and must not remove a lock it can no longer prove is ours.
      assert.doesNotThrow(() => releaseTicketLock(held), `body ${body} must not throw`);
      assert.ok(existsSync(held.path), `body ${body}: an unverifiable lock must be left in place`);
      rmSync(held.path, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseTicketLock still removes a lock it does own', () => {
  // The guard must not become "never release", or every writer strands its lock.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-release-ok-'));
  try {
    const held = acquireTicketLock(root, { command: 'test' });
    assert.ok(existsSync(held.path));
    releaseTicketLock(held);
    assert.ok(!existsSync(held.path), 'a validated, matching owner must be released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquire rejects options whose lock could not be released, leaving nothing behind', () => {
  // Making release strict without validating acquisition produced a lock this
  // module could create and then refuse to remove: acquireTicketLock(root,
  // { command: null }) returned a lock whose owner file failed its own release
  // check, so the directory was stranded and every later writer timed out.
  // One shared definition of a well-formed owner, asserted before any mkdir.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-opts-'));
  try {
    for (const options of [{ command: null }, { command: 7 }, { transactionId: 7 }, { transactionId: {} }]) {
      assert.throws(
        () => acquireTicketLock(root, options),
        (error) => error.code === 'INVALID_LOCK_OPTIONS',
        `${JSON.stringify(options)} must be refused`,
      );
      assert.ok(!existsSync(join(root, '.adlc', 'tickets.lock')), `${JSON.stringify(options)} must leave no lock behind`);
    }

    // And the valid shapes still acquire and release cleanly.
    for (const options of [{ command: 'ok' }, { command: 'ok', transactionId: null }, { command: 'ok', transactionId: 'tx-1' }]) {
      const held = acquireTicketLock(root, options);
      releaseTicketLock(held);
      assert.ok(!existsSync(held.path), `${JSON.stringify(options)} must round-trip acquire -> release`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
