import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { tmp } from '../lib/test-kit.mjs';
import { appendEntries, canonicalJson, ledgerPath, readEntries, withLedgerLock } from '../index.mjs';

test('withLedgerLock: never evicts a live same-host owner on age alone', (t) => {
  const dir = tmp(t, 'ledger-lock-live-');
  const target = join(dir, 'manifest.jsonl');
  const lockPath = `${target}.lock`;

  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      token: 'live-owner',
      pid: 7777,
      pidStartTime: 'start-7777',
      hostname: hostname(),
      startedAt: new Date(1_000).toISOString(),
    }),
  );

  assert.throws(
    () =>
      withLedgerLock(target, () => 'should-not-run', {
        retries: 1,
        delayMs: 1,
        staleMs: 500,
        now: () => 999_999,
        isPidAlive: (pid) => pid === 7777,
        procStartTime: () => 'start-7777',
      }),
    /could not acquire ledger lock/,
  );

  assert.equal(existsSync(lockPath), true);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'live-owner');
});

test('withLedgerLock: evicts dead same-host PID, reused same-host PID, and expired remote-host lock', (t) => {
  const dir = tmp(t, 'ledger-lock-stale-');
  const target = join(dir, 'manifest.jsonl');
  const lockPath = `${target}.lock`;

  // 1. Dead same-host PID
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      token: 'dead-owner',
      pid: 8888,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    withLedgerLock(target, () => 'acquired-dead', {
      retries: 2,
      delayMs: 1,
      staleMs: 60_000,
      isPidAlive: () => false,
    }),
    'acquired-dead',
  );

  // 2. Same-host PID reuse (pidStartTime mismatch)
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      token: 'reused-owner',
      pid: 7777,
      pidStartTime: 'old-start',
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  assert.equal(
    withLedgerLock(target, () => 'acquired-reused', {
      retries: 2,
      delayMs: 1,
      staleMs: 60_000,
      isPidAlive: () => true,
      procStartTime: () => 'new-start',
    }),
    'acquired-reused',
  );

  // 3. Remote-host lock: fresh is kept, expired is evicted
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      token: 'remote-owner',
      pid: process.pid,
      hostname: 'remote-host-other',
      startedAt: new Date(10_000).toISOString(),
    }),
  );
  assert.throws(
    () =>
      withLedgerLock(target, () => 'too-early', {
        retries: 1,
        delayMs: 1,
        staleMs: 5_000,
        now: () => 12_000,
      }),
    /could not acquire ledger lock/,
  );
  assert.equal(
    withLedgerLock(target, () => 'acquired-remote', {
      retries: 2,
      delayMs: 1,
      staleMs: 5_000,
      now: () => 20_000,
    }),
    'acquired-remote',
  );
});

test('appendEntries: array batch appends without reading/parsing existing ledger while factory still receives state', (t) => {
  const dir = tmp(t, 'ledger-fast-append-');
  const p = ledgerPath('events', dir);
  // Seed a pre-existing line; appendEntries with array batch must append O(batch)
  appendEntries('events', [{ seq: 1, kind: 'seed' }], dir);
  const appended = appendEntries('events', [{ seq: 2, kind: 'batch' }], dir);
  assert.deepEqual(appended, [{ seq: 2, kind: 'batch' }]);

  // Factory form still receives parsed state with existing entries and lastRawLine
  let seenState = null;
  appendEntries(
    'events',
    (state) => {
      seenState = state;
      return [{ seq: state.entries.length + 1, kind: 'factory' }];
    },
    dir,
  );
  assert.equal(seenState.entries.length, 2);
  assert.equal(seenState.lastRawLine, JSON.stringify({ seq: 2, kind: 'batch' }));

  const { entries, skipped } = readEntries('events', dir);
  assert.equal(skipped.length, 0);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 3);
});

test('canonicalJson: omits undefined, function, and symbol object keys consistently across nesting', () => {
  assert.equal(
    canonicalJson({ b: 2, a: 1, missing: undefined, fn: () => {}, sym: Symbol('x') }),
    canonicalJson({ a: 1, b: 2 }),
  );
  assert.equal(
    canonicalJson({ outer: { z: undefined, a: 1 }, list: [1, undefined, { y: undefined, x: 2 }] }),
    '{"list":[1,null,{"x":2}],"outer":{"a":1}}',
  );
});
