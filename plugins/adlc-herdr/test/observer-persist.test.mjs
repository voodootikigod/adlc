// Persistence I/O for daemon-restart recovery. Kept in a lib (not bin glue) so the
// bounded-read guards and change-detected write are TESTED (real temp dirs), which
// also kills the mutation-gate survivors an untested bin guard would leave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadObserverState, saveObserverState, observerStatePath, OBSERVER_STATE_MAX_BYTES } from '../lib/observer-persist.mjs';

const mkRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-herdr-persist-'));
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  return repo;
};

test('loadObserverState reads a valid persisted object', () => {
  const repo = mkRepo();
  writeFileSync(observerStatePath(repo), JSON.stringify({ runId: 'r1', tabId: 'w4:t1', tailed: { 't-a': 'w4:pa' } }));
  assert.deepEqual(loadObserverState(repo), { runId: 'r1', tabId: 'w4:t1', tailed: { 't-a': 'w4:pa' } });
});

test('loadObserverState fails soft to null: missing, malformed, non-object, or past the size cap', () => {
  const repo = mkRepo();
  assert.equal(loadObserverState(repo), null, 'missing file → null');
  writeFileSync(observerStatePath(repo), '{ not json');
  assert.equal(loadObserverState(repo), null, 'malformed → null');
  writeFileSync(observerStatePath(repo), '[1,2,3]');
  assert.equal(loadObserverState(repo), null, 'a JSON array is not a state object → null');
  // A regular file past the cap must be rejected on SIZE before it is read/parsed —
  // pins both the `> MAX` comparison and the `||` in the bounded-read guard.
  writeFileSync(observerStatePath(repo), JSON.stringify({ runId: 'r1' }).padEnd(OBSERVER_STATE_MAX_BYTES + 10, ' '));
  assert.equal(loadObserverState(repo), null, 'an oversized (but otherwise parseable) file → null');
});

test('saveObserverState writes the snapshot; it round-trips through load', () => {
  const repo = mkRepo();
  const st = { prev: { runId: 'r1' }, runState: { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa']]) } };
  saveObserverState(repo, st);
  assert.deepEqual(loadObserverState(repo), { runId: 'r1', tabId: 'w4:t1', tailed: { 't-a': 'w4:pa' } });
});

test('saveObserverState SKIPS the write when the state is unchanged (no per-beat disk churn), and writes again on a change', () => {
  const repo = mkRepo();
  const st = { prev: { runId: 'r1' }, runState: { tabId: 'w4:t1', tailed: new Map() } };
  saveObserverState(repo, st);
  writeFileSync(observerStatePath(repo), 'SENTINEL'); // tamper, then re-save the SAME state
  saveObserverState(repo, st);
  assert.equal(readFileSync(observerStatePath(repo), 'utf8'), 'SENTINEL', 'an unchanged state is NOT rewritten');
  st.runState.tabId = 'w4:t2';
  saveObserverState(repo, st);
  assert.equal(loadObserverState(repo).tabId, 'w4:t2', 'a changed state IS written');
});
