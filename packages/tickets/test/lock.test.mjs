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

test('a failed owner write leaves no lock behind, and the next writer succeeds', () => {
  // Acquisition is two filesystem steps and the gap was not atomic: ENOSPC or a
  // quota on the owner write left `.adlc/tickets.lock` present with NO owner
  // file, and no lock object was returned for anyone to release — so every later
  // writer saw EEXIST and timed out. Injected because that gap is only reachable
  // through a real disk failure.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-partial-'));
  try {
    const boom = () => { const error = new Error('no space left on device'); error.code = 'ENOSPC'; throw error; };
    assert.throws(
      () => acquireTicketLock(root, { command: 'test', retries: 0, writeOwner: boom }),
      (error) => error.code === 'LOCK_FAILED' && /no space left/.test(error.message),
      'the original cause must survive, not be replaced by a cleanup error',
    );
    assert.ok(!existsSync(join(root, '.adlc', 'tickets.lock')), 'a half-made lock must be removed');

    // The real proof: the next writer is not blocked by the wreckage.
    const held = acquireTicketLock(root, { command: 'after' });
    assert.equal(readTicketLock(root)?.command, 'after');
    releaseTicketLock(held);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup never removes a lock this attempt did not create', () => {
  // The `created` flag matters: on EEXIST the directory is somebody else's, and
  // a blanket cleanup in the catch would delete a live lock out from under them.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-foreign-'));
  try {
    const held = acquireTicketLock(root, { command: 'owner' });
    assert.throws(
      () => acquireTicketLock(root, { command: 'contender', retries: 0 }),
      (error) => error.code === 'LOCK_TIMEOUT',
    );
    assert.ok(existsSync(held.path), "the incumbent's lock must survive a failed contender");
    assert.equal(readTicketLock(root)?.command, 'owner', 'and still be owned by the incumbent');
    releaseTicketLock(held);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cleanup that also fails is reported, with the path and both causes', () => {
  // Cleanup runs under exactly the conditions that broke the owner write, so it
  // can fail too. Swallowing that told the caller only "acquisition failed",
  // while a directory nobody holds a releasable handle to blocked every later
  // writer until a human found it. This is the one failure someone must act on,
  // so it names the path and both causes.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-stranded-'));
  try {
    const writeBoom = () => { const e = new Error('disk went away'); e.code = 'EIO'; throw e; };
    const removeBoom = () => { const e = new Error('directory busy'); e.code = 'EBUSY'; throw e; };

    let raised;
    assert.throws(() => acquireTicketLock(root, {
      command: 'test', retries: 0, writeOwner: writeBoom, removeLock: removeBoom,
    }), (error) => { raised = error; return error.code === 'LOCK_STRANDED'; });

    assert.match(raised.message, /disk went away/, 'the owner-write cause must survive');
    assert.match(raised.message, /directory busy/, 'and the cleanup cause too');
    assert.match(raised.message, /tickets\.lock/, 'and the path a human has to remove');
    assert.match(raised.message, /unblock later ticket writers/i, 'with what to do about it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cleanup that succeeds still reports the original failure, not a stranded lock', () => {
  // The distinction is the point: LOCK_FAILED means "nothing to clean up",
  // LOCK_STRANDED means "a directory is still there and it is yours to remove".
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-clean-'));
  try {
    const writeBoom = () => { const e = new Error('quota exceeded'); e.code = 'EDQUOT'; throw e; };
    assert.throws(
      () => acquireTicketLock(root, { command: 'test', retries: 0, writeOwner: writeBoom }),
      (error) => error.code === 'LOCK_FAILED' && /quota exceeded/.test(error.message),
    );
    assert.ok(!existsSync(join(root, '.adlc', 'tickets.lock')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release never throws, so it cannot mask a committed transaction', () => {
  // Release runs from `finally` blocks. An EBUSY on Windows (antivirus, a
  // transient handle) used to escape raw and replace the operation's outcome —
  // after a COMMITTED transaction that reports failure for work which durably
  // applied, and a retry cannot tell whether it landed. The failure is returned
  // instead: primary result intact, stranded lock still observable.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-release-io-'));
  try {
    const held = acquireTicketLock(root, { command: 'test' });
    const removeBoom = () => { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; };

    let outcome;
    assert.doesNotThrow(() => { outcome = releaseTicketLock(held, { removeLock: removeBoom }); });
    assert.equal(outcome.released, false);
    assert.equal(outcome.code, 'LOCK_STRANDED');
    assert.equal(outcome.path, held.path);
    assert.equal(outcome.cause.code, 'EBUSY', 'the real cause must be carried, not discarded');
    assert.ok(existsSync(held.path), 'and the lock really is still there');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release reports which non-release it performed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-outcomes-'));
  try {
    assert.deepEqual(releaseTicketLock(null), { released: false, reason: 'no-lock' });

    const held = acquireTicketLock(root, { command: 'test' });
    assert.deepEqual(releaseTicketLock(held), { released: true }, 'the ordinary path still releases');

    // An owner file we cannot verify is stranded, not silently ignored.
    const again = acquireTicketLock(root, { command: 'test' });
    writeFileSync(join(again.path, 'owner.json'), 'null');
    const outcome = releaseTicketLock(again);
    assert.equal(outcome.released, false);
    assert.equal(outcome.code, 'LOCK_STRANDED');
    rmSync(again.path, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a contended acquisition retries the documented number of times before giving up', () => {
  // The retry BOUND is the whole reason a second writer waits instead of failing
  // instantly, and nothing observed it: the contended path throws EEXIST out of
  // mkdir, so neither of the other two seams is reached and no test could count
  // attempts. The default could have drifted in either direction — halving the
  // window a concurrent `adlc ticket` write has to land in, or multiplying how
  // long a caller blocks on a lock nobody is going to release — and the suite
  // would have stayed green.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-retries-'));
  try {
    const held = acquireTicketLock(root, { command: 'incumbent' });
    let attempts = 0;
    assert.throws(() => acquireTicketLock(root, {
      command: 'contender',
      delayMs: 0, // the wait is not what is under test; the count is
      makeLockDirectory: (path) => { attempts += 1; return mkdirSync(path); },
    }), (error) => error.code === 'LOCK_TIMEOUT');
    // `retries` counts RETRIES, so the default is one initial attempt plus 50 more.
    assert.equal(attempts, 51, 'every attempt in the documented budget must actually be made');
    releaseTicketLock(held);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an already-removed lock is "no-lock", not a stranded one', () => {
  // LOCK_STRANDED means, per index.d.ts, "the directory is still on disk and a
  // human has to remove it". readLockMetadata collapses every read failure to
  // null — ENOENT included — so releasing a lock another process or a test had
  // already cleaned up raised that alarm at an operator with nothing to act on.
  const root = mkdtempSync(join(tmpdir(), 'adlc-lock-gone-'));
  try {
    const held = acquireTicketLock(root, { command: 'test' });
    rmSync(held.path, { recursive: true, force: true }); // someone else cleaned up

    const outcome = releaseTicketLock(held);
    assert.equal(outcome.released, false);
    assert.equal(outcome.reason, 'no-lock');
    assert.equal(outcome.code, undefined, 'nothing on disk is not a stranded lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
