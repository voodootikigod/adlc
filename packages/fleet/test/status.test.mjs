import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newStatus, loadStatus, saveStatus, withTicket, statusById, inFlightIds,
} from '../lib/status.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'fleet-status-'));
}

test('newStatus carries the resume anchors, not base (N2)', () => {
  const s = newStatus({
    runId: 'r1', base: 'main', baseSha: 'abc123', integrationBranch: 'fleet/run-r1',
    concurrency: 2, sandboxMode: 'sandbox', startedAt: '2026-07-12T00:00:00Z',
  });
  assert.equal(s.baseSha, 'abc123');
  assert.equal(s.integrationBranch, 'fleet/run-r1');
  assert.deepEqual(s.tickets, {});
});

test('saveStatus writes atomically and loadStatus round-trips', () => {
  const dir = tmp();
  const s = newStatus({ runId: 'r1', base: 'main', baseSha: 'abc', integrationBranch: 'fleet/run-r1', concurrency: 2 });
  saveStatus(dir, s);
  assert.equal(existsSync(join(dir, 'fleet-status.json')), true);
  const loaded = loadStatus(dir);
  assert.equal(loaded.runId, 'r1');
  assert.equal(loaded.integrationBranch, 'fleet/run-r1');
});

test('loadStatus returns null when no status exists', () => {
  assert.equal(loadStatus(tmp()), null);
});

test('withTicket is immutable and merges patches', () => {
  const s0 = newStatus({ runId: 'r1', base: 'main', concurrency: 2 });
  const s1 = withTicket(s0, 'T1', { state: 'building', strikes: 1, startSha: 'tip1' });
  assert.equal(s0.tickets.T1, undefined, 'original status is not mutated');
  assert.equal(s1.tickets.T1.state, 'building');
  assert.equal(s1.tickets.T1.startSha, 'tip1');
  const s2 = withTicket(s1, 'T1', { state: 'merged' });
  assert.equal(s2.tickets.T1.state, 'merged');
  assert.equal(s2.tickets.T1.strikes, 1, 'unpatched fields survive');
});

test('statusById and inFlightIds derive scheduler inputs', () => {
  let s = newStatus({ runId: 'r1', base: 'main', concurrency: 2 });
  s = withTicket(s, 'T1', { state: 'building' });
  s = withTicket(s, 'T2', { state: 'merged' });
  s = withTicket(s, 'T3', { state: 'pending' });
  assert.deepEqual(statusById(s), { T1: 'building', T2: 'merged', T3: 'pending' });
  assert.deepEqual(inFlightIds(s), ['T1']);
});
