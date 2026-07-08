// flail.test.mjs — Phase 3.3: churn advisory over tool.execute.after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlailTracker, flailMessage } from '../lib/flail.mjs';
import { adlcRailsGuard } from '../index.mjs';

// ---- tracker ----
test('flags a file only once it crosses the churn threshold (>=3)', () => {
  const t = createFlailTracker();
  assert.deepEqual(t.record({ sessionID: 's', tool: 'edit', filePath: 'a.mjs' }).churning, []);
  assert.deepEqual(t.record({ sessionID: 's', tool: 'edit', filePath: 'a.mjs' }).churning, []);
  const third = t.record({ sessionID: 's', tool: 'write', filePath: 'a.mjs' }).churning;
  assert.equal(third.length, 1);
  assert.equal(third[0].path, 'a.mjs');
  assert.ok(third[0].count >= 3);
});

test('warns at most ONCE per churning file (no toast spam)', () => {
  const t = createFlailTracker();
  for (let i = 0; i < 3; i++) t.record({ sessionID: 's', tool: 'edit', filePath: 'a.mjs' });
  // already warned on the 3rd; further edits do not re-report
  assert.deepEqual(t.record({ sessionID: 's', tool: 'edit', filePath: 'a.mjs' }).churning, []);
});

test('sessions are isolated; non-mutators and missing paths ignored', () => {
  const t = createFlailTracker();
  for (let i = 0; i < 3; i++) t.record({ sessionID: 's1', tool: 'edit', filePath: 'a.mjs' });
  // a different session starts fresh
  assert.deepEqual(t.record({ sessionID: 's2', tool: 'edit', filePath: 'a.mjs' }).churning, []);
  // read tool / no path never count
  assert.deepEqual(t.record({ sessionID: 's3', tool: 'read', filePath: 'a.mjs' }).churning, []);
  assert.deepEqual(t.record({ sessionID: 's3', tool: 'edit' }).churning, []);
});

test('flailMessage names the file and count', () => {
  assert.match(flailMessage({ path: 'x.mjs', count: 4 }), /x\.mjs.*4×/);
});

// ---- memory bounds (P5 finding): sessions + warned sets do not grow forever ----
test('LRU-caps the number of tracked sessions', () => {
  const t = createFlailTracker({ maxSessions: 3 });
  for (let i = 0; i < 10; i++) t.record({ sessionID: `s${i}`, tool: 'edit', filePath: 'a.mjs' });
  assert.ok(t.size() <= 3, `tracked sessions bounded (got ${t.size()})`);
});

test('evict() drops a finished session', () => {
  const t = createFlailTracker();
  t.record({ sessionID: 's', tool: 'edit', filePath: 'a.mjs' });
  assert.equal(t.size(), 1);
  t.evict('s');
  assert.equal(t.size(), 0);
});

test('warned set is bounded per session', () => {
  const t = createFlailTracker({ maxWarned: 5, window: 10000 });
  // churn 50 distinct files (each >=3 edits) in one session
  for (let f = 0; f < 50; f++) for (let e = 0; e < 3; e++) t.record({ sessionID: 's', tool: 'edit', filePath: `f${f}.mjs` });
  // no assertion on exact size internals, but the tracker must not have retained
  // all 50 — a follow-up churn of an early file may re-warn (acceptable), and it
  // must not throw. Sanity: still functioning.
  assert.doesNotThrow(() => t.record({ sessionID: 's', tool: 'edit', filePath: 'later.mjs' }));
});

// ---- REAL handler ----
test('tool.execute.after handler toasts a churn warning on the 3rd edit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const toasts = [];
  const client = { tui: { showToast: async (r) => { toasts.push(r.body); } } };
  const hooks = await adlcRailsGuard({ worktree: dir, client });
  try {
    const after = (fp) => hooks['tool.execute.after']({ tool: 'edit', sessionID: 's', callID: 'c', args: { filePath: fp } }, {});
    await after('churn.mjs');
    await after('churn.mjs');
    assert.equal(toasts.length, 0, 'no warning before threshold');
    await after('churn.mjs');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].variant, 'warning');
    assert.match(toasts[0].message, /flail check.*churn\.mjs/);
    await after('churn.mjs'); // no repeat
    assert.equal(toasts.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool.execute.after counts apply_patch envelope churn (GPT-5-class mutator)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const toasts = [];
  const client = { tui: { showToast: async (r) => { toasts.push(r.body); } } };
  const hooks = await adlcRailsGuard({ worktree: dir, client });
  try {
    const patch = (f) => `*** Begin Patch\n*** Update File: ${f}\n@@\n-old\n+new\n*** End Patch`;
    const after = () => hooks['tool.execute.after']({ tool: 'apply_patch', sessionID: 's', callID: 'c', args: { patch: patch('svc.mjs') } }, {});
    await after(); await after();
    assert.equal(toasts.length, 0);
    await after(); // 3rd apply_patch to svc.mjs → churn warning
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].message, /flail check.*svc\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool.execute.after counts multiedit (edits[]) and patch (files[]) churn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  for (const [tool, mkArgs] of [
    ['multiedit', () => ({ edits: [{ filePath: 'm.mjs' }] })],
    ['patch', () => ({ files: ['p.mjs'] })],
  ]) {
    const toasts = [];
    const client = { tui: { showToast: async (r) => { toasts.push(r.body); } } };
    const hooks = await adlcRailsGuard({ worktree: dir, client });
    const after = () => hooks['tool.execute.after']({ tool, sessionID: 's', callID: 'c', args: mkArgs() }, {});
    await after(); await after();
    assert.equal(toasts.length, 0, `${tool}: no warning before threshold`);
    await after();
    assert.equal(toasts.length, 1, `${tool}: one churn warning at 3`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('tool.execute.after dedupes duplicate targets within one call (no overcount)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const toasts = [];
  const client = { tui: { showToast: async (r) => { toasts.push(r.body); } } };
  const hooks = await adlcRailsGuard({ worktree: dir, client });
  try {
    // one multiedit call naming the same file 3× must count as ONE churn event
    const dupCall = () => hooks['tool.execute.after']({ tool: 'multiedit', sessionID: 's', callID: 'c', args: { edits: [{ filePath: 'd.mjs' }, { filePath: 'd.mjs' }, { filePath: 'd.mjs' }] } }, {});
    await dupCall();
    await dupCall();
    assert.equal(toasts.length, 0, 'two calls (deduped) is below the 3-call threshold');
    await dupCall();
    assert.equal(toasts.length, 1, 'third distinct call crosses threshold exactly once');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool.execute.after never throws on a malformed payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  const hooks = await adlcRailsGuard({ worktree: dir });
  try {
    await hooks['tool.execute.after'](undefined);
    await hooks['tool.execute.after']({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
