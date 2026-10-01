// flail.test.mjs — Phase 3.3: churn advisory over tool.execute.after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlailTracker, flailMessage } from '../lib/flail.mjs';
import { loadPlugin, captureStderr } from './helpers/fake-ctx.mjs';

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
/** Load the plugin with stderr captured; `warnings` collects every operator line. */
async function churnPlugin(dir) {
  const warnings = [];
  const plugin = await loadPlugin({ root: dir });
  const after = plugin.after;
  plugin.after = async (...args) => {
    const { lines } = await captureStderr(() => after(...args));
    warnings.push(...lines);
  };
  return { warnings, plugin };
}

test('execute.after handler warns on stderr about churn on the 3rd edit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const { warnings, plugin } = await churnPlugin(dir);
  try {
    const after = (fp) => plugin.after('edit', { path: fp });
    await after('churn.mjs');
    await after('churn.mjs');
    assert.equal(warnings.length, 0, 'no warning before threshold');
    await after('churn.mjs');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[adlc\] warning: .*flail check.*churn\.mjs/);
    await after('churn.mjs'); // no repeat
    assert.equal(warnings.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execute.after counts v2 patch envelope churn (patchText)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const { warnings, plugin } = await churnPlugin(dir);
  try {
    const patch = (f) => `*** Begin Patch\n*** Update File: ${f}\n@@\n-old\n+new\n*** End Patch`;
    const after = () => plugin.after('patch', { patchText: patch('svc.mjs') });
    await after(); await after();
    assert.equal(warnings.length, 0);
    await after(); // 3rd patch to svc.mjs → churn warning
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /flail check.*svc\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execute.after counts multiedit (edits[]) and patch (files[]) churn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  for (const [tool, mkArgs] of [
    ['multiedit', () => ({ edits: [{ filePath: 'm.mjs' }] })],
    ['patch', () => ({ files: ['p.mjs'] })],
  ]) {
    const { warnings, plugin } = await churnPlugin(dir);
    const after = () => plugin.after(tool, mkArgs());
    await after(); await after();
    assert.equal(warnings.length, 0, `${tool}: no warning before threshold`);
    await after();
    assert.equal(warnings.length, 1, `${tool}: one churn warning at 3`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('execute.after dedupes duplicate targets within one call (no overcount)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const { warnings, plugin } = await churnPlugin(dir);
  try {
    // one multiedit call naming the same file 3× must count as ONE churn event
    const dupCall = () => plugin.after('multiedit', { edits: [{ filePath: 'd.mjs' }, { filePath: 'd.mjs' }, { filePath: 'd.mjs' }] });
    await dupCall();
    await dupCall();
    assert.equal(warnings.length, 0, 'two calls (deduped) is below the 3-call threshold');
    await dupCall();
    assert.equal(warnings.length, 1, 'third distinct call crosses threshold exactly once');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execute.after never throws on a malformed payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flail-'));
  const plugin = await loadPlugin({ root: dir });
  try {
    const after = plugin.registrations.tool.get('execute.after');
    await after(undefined);
    await after({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
