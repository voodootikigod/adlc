// build-gate.test.mjs — Phase 2.3: the context-rot backstop for OpenCode.
// Exercises the OpenCode-specific glue (depth tracker + signal wiring) and the
// REAL exported hook handler; the decision logic itself is @adlc/build-gate's
// and has its own package tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDepthTracker, checkBuildGate } from '../lib/build-gate.mjs';
import { adlcRailsGuard } from '../index.mjs';

function repo({ tickets } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-bg-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  if (tickets !== undefined) writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify(tickets));
  return dir;
}
const HIGH = { tickets: [{ id: 'T1', risk: 'high', rails: ['frozen/**'] }] };
const NORMAL = { tickets: [{ id: 'T1', rails: ['frozen/**'] }] };
const ON = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

// ---- tracker ----
test('tracker: counts per session, isolates sessions, marks compaction', () => {
  const t = createDepthTracker();
  t.recordToolCall('a'); t.recordToolCall('a'); t.recordToolCall('b');
  assert.equal(t.depth('a'), 2);
  assert.equal(t.depth('b'), 1);
  assert.equal(t.depth('c'), 0);
  t.markCompacted('a');
  assert.equal(t.isCompacted('a'), true);
  assert.equal(t.isCompacted('b'), false);
});

// ---- decision glue ----
test('high-risk + shallow session → allow', () => {
  const dir = repo({ tickets: HIGH });
  try {
    const t = createDepthTracker();
    t.recordToolCall('s');
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ...ON } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('high-risk + depth past threshold → deny (with signal in reason)', () => {
  const dir = repo({ tickets: HIGH });
  try {
    const t = createDepthTracker();
    for (let i = 0; i < 41; i++) t.recordToolCall('s');
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ...ON } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /depth 41 > 40/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('high-risk + compacted session → deny even at depth 1', () => {
  const dir = repo({ tickets: HIGH });
  try {
    const t = createDepthTracker();
    t.recordToolCall('s');
    t.markCompacted('s');
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ...ON } });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /compacted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('NORMAL-risk ticket → allow regardless of depth/compaction', () => {
  const dir = repo({ tickets: NORMAL });
  try {
    const t = createDepthTracker();
    for (let i = 0; i < 100; i++) t.recordToolCall('s');
    t.markCompacted('s');
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ...ON } });
    assert.equal(r.decision, 'allow');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derived high risk (trust-root rails) cannot be downgraded by declared normal', () => {
  const dir = repo({ tickets: { tickets: [{ id: 'T1', risk: 'normal', rails: ['.adlc/tickets.json'] }] } });
  try {
    const t = createDepthTracker();
    t.markCompacted('s');
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ...ON } });
    assert.equal(r.decision, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bypass honored ONLY when durably recorded (writes build-gate-bypass to manifest)', () => {
  const dir = repo({ tickets: HIGH });
  try {
    const t = createDepthTracker();
    t.markCompacted('s');
    const env = { ...ON, ADLC_BUILD_GATE_BYPASS: '1' };
    const r = checkBuildGate({ sessionID: 's', tracker: t, root: dir, env });
    assert.equal(r.decision, 'allow');
    assert.equal(r.overridden, true);
    const manifest = join(dir, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(manifest), 'override durably recorded');
    assert.match(readFileSync(manifest, 'utf8'), /build-gate-bypass/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enforcement off / uninitialized / no ticket → allow (rails gate owns those)', () => {
  const bare = mkdtempSync(join(tmpdir(), 'oc-bg-'));
  const dir = repo({ tickets: HIGH });
  try {
    const t = createDepthTracker();
    t.markCompacted('s');
    assert.equal(checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ADLC_TICKET: 'T1' } }).decision, 'allow');
    assert.equal(checkBuildGate({ sessionID: 's', tracker: t, root: bare, env: { ...ON } }).decision, 'allow');
    assert.equal(checkBuildGate({ sessionID: 's', tracker: t, root: dir, env: { ADLC_P4_ENFORCEMENT: '1' } }).decision, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---- the REAL handler: build-gate denies an off-rail structured edit ----
test('handler: high-risk + compaction event → edit to a NON-rail path throws', async () => {
  const dir = repo({ tickets: HIGH });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
    delete process.env.ADLC_BUILD_GATE_BYPASS;
    const hooks = await adlcRailsGuard({ worktree: dir });
    // Off-rail edit passes rails; passes build-gate while fresh…
    await hooks['tool.execute.before']({ tool: 'edit', sessionID: 's1', callID: 'c' }, { args: { filePath: 'src/ok.mjs' } });
    // …the session compacts…
    await hooks.event({ event: { type: 'session.compacted', properties: { sessionID: 's1' } } });
    // …now the same off-rail edit is denied by the build gate.
    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'edit', sessionID: 's1', callID: 'c' }, { args: { filePath: 'src/ok.mjs' } }),
      /ADLC build-gate/,
    );
    // A different (fresh) session is unaffected.
    await hooks['tool.execute.before']({ tool: 'edit', sessionID: 's2', callID: 'c' }, { args: { filePath: 'src/ok.mjs' } });
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});

test('handler: read-only tools never hit the build gate', async () => {
  const dir = repo({ tickets: HIGH });
  const saved = { ...process.env };
  try {
    process.env.ADLC_P4_ENFORCEMENT = '1';
    process.env.ADLC_TICKET = 'T1';
    const hooks = await adlcRailsGuard({ worktree: dir });
    await hooks.event({ event: { type: 'session.compacted', properties: { sessionID: 's1' } } });
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 's1', callID: 'c' }, { args: { filePath: 'src/ok.mjs' } }); // no throw
  } finally { Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }); }
});
