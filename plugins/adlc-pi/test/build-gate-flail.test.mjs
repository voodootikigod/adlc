// T22 tests: build-gate context-rot backstop (ctx.getContextUsage() + compaction
// signal, canonical @adlc/build-gate decision) and the flail advisory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFitnessTracker, checkBuildGate, DEFAULT_CONTEXT_PERCENT_THRESHOLD } from '../lib/build-gate.mjs';
import { createFlailTracker } from '../lib/flail.mjs';
import { createExtension } from '../lib/extension.mjs';

const HIGH_RISK_TICKET = {
  id: 'T1',
  title: 'High-risk work',
  body: 'Dangerous work',
  risk: 'high',
  scope: ['src/**'],
  rails: ['test/contracts/**'],
};
const NORMAL_TICKET = { ...HIGH_RISK_TICKET, id: 'T2', title: 'Normal work', risk: undefined };

function makeRepo({ tickets = [HIGH_RISK_TICKET, NORMAL_TICKET], current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-bg-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function fakePi() {
  const handlers = {};
  const steers = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand() {},
    async exec() { return { stdout: '', stderr: '', code: 0 }; },
    sendMessage(msg, opts) { steers.push({ msg, opts }); },
    handlers, steers,
  };
}

function fakeCtx(cwd, percent) {
  const notices = [];
  return {
    cwd,
    ui: { setStatus() {}, notify(m, l) { notices.push({ m, l }); } },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 2000, percent }),
    notices,
  };
}

async function boot(root, percent, env = {}) {
  const pi = fakePi();
  createExtension({ env })(pi);
  const ctx = fakeCtx(root, percent);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  return { pi, ctx };
}

const writeCall = (path, id = 'w1') => ({ type: 'tool_call', toolName: 'write', toolCallId: id, input: { path, content: 'x' } });

// =========================================================================
// AC1 — percent-threshold gating, risk-tier scoping
// =========================================================================

// Slice 5 moved the context-rot handoff deny in FRONT of the build gate, and
// its handoff band (60%) sits below this gate's own threshold (80%). Every
// percent that would trip the build gate therefore trips the handoff deny
// first, so the extension-level percent cases below assert that precedence,
// and the build gate's own percent decision is asserted where it is still
// reachable: on checkBuildGate directly, and through the compaction signal
// (AC2), which degrades a session without moving the percent.
test('AC1: high-risk ticket + degraded context denies a structured write', async () => {
  const root = makeRepo();
  try {
    const verdict = checkBuildGate({
      ticket: HIGH_RISK_TICKET,
      usage: { percent: DEFAULT_CONTEXT_PERCENT_THRESHOLD + 5 },
      compacted: false,
      env: {},
      root,
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /high/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: the context-handoff deny outranks the build gate above the handoff band', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, DEFAULT_CONTEXT_PERCENT_THRESHOLD + 5);
    const denied = await pi.handlers.tool_call(writeCall('src/a.ts'), ctx);
    assert.equal(denied.block, true);
    // The stronger deny wins: the build gate's bypass is an operator override,
    // the deny-set's exits are signed. Reporting the weaker one would tell the
    // agent to reach for an escape hatch that no longer applies.
    assert.match(denied.reason, /context-rot handoff deny/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: below both bands allows; normal-risk ticket is not build-gated', async () => {
  const root = makeRepo();
  try {
    const low = await boot(root, 30);
    assert.equal(await low.pi.handlers.tool_call(writeCall('src/a.ts'), low.ctx), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const root2 = makeRepo({ current: 'T2' });
  try {
    const { pi, ctx } = await boot(root2, 30);
    assert.equal(await pi.handlers.tool_call(writeCall('src/a.ts'), ctx), undefined, 'normal risk never build-gated');
  } finally { rmSync(root2, { recursive: true, force: true }); }

  // …but the deny-set is NOT risk-scoped: a normal-risk ticket past the
  // handoff band is still stopped. That is the deliberate difference between
  // a per-ticket blast-radius gate and a per-session trust decision.
  const root3 = makeRepo({ current: 'T2' });
  try {
    const { pi, ctx } = await boot(root3, 99);
    const denied = await pi.handlers.tool_call(writeCall('src/a.ts'), ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /context-rot handoff deny/);
  } finally { rmSync(root3, { recursive: true, force: true }); }
});

test('AC1: custom threshold via ADLC_BUILD_GATE_CONTEXT_PCT', () => {
  const root = makeRepo();
  try {
    const verdict = checkBuildGate({
      ticket: HIGH_RISK_TICKET,
      usage: { percent: 60 },
      compacted: false,
      env: { ADLC_BUILD_GATE_CONTEXT_PCT: '50' },
      root,
    });
    assert.equal(verdict.decision, 'deny');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC2 — compaction marks the session degraded
// =========================================================================

test('AC2: threshold/overflow compaction degrades even at low percent; manual does not', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, 10);
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'manual', willRetry: false }, ctx);
    assert.equal(await pi.handlers.tool_call(writeCall('src/a.ts', 'a'), ctx), undefined, 'manual compaction is not rot');

    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow', willRetry: true }, ctx);
    const denied = await pi.handlers.tool_call(writeCall('src/a.ts', 'b'), ctx);
    assert.equal(denied.block, true, 'post-compaction low percent must still deny — compaction IS the rot event');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC3 — audited override
// =========================================================================

// The override is exercised through the compaction signal rather than a high
// percent: past the handoff band the deny-set fires first, and no build-gate
// bypass clears it (see the AC1 precedence test). Compaction degrades the
// session at a low percent, which is exactly where the override still applies.
async function bootCompactedHighRisk(root, env) {
  const { pi, ctx } = await boot(root, 10, env);
  await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow', willRetry: true }, ctx);
  return { pi, ctx };
}

test('AC3: bypass allows only when the override is durably recorded', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await bootCompactedHighRisk(root, { ADLC_BUILD_GATE_BYPASS: '1' });
    assert.equal(await pi.handlers.tool_call(writeCall('src/a.ts'), ctx), undefined, 'audited bypass allows');
    const ledger = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(ledger, /build-gate-bypass/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: bypass with an unwritable ledger stays denied', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root, 10, { ADLC_BUILD_GATE_BYPASS: '1' });
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow', willRetry: true }, ctx);
    chmodSync(join(root, '.adlc'), 0o555);
    const denied = await pi.handlers.tool_call(writeCall('src/a.ts'), ctx);
    assert.equal(denied?.block, true, 'an unrecordable override must be refused');
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false);
  } finally {
    chmodSync(join(root, '.adlc'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

// =========================================================================
// AC4 — flail advisory: once per file, steer + notify, never blocks
// =========================================================================

test('AC4: third edit of the same file emits exactly one steer + one notify', async () => {
  const root = makeRepo({ current: 'T2' });
  try {
    const { pi, ctx } = await boot(root, 10);
    for (let i = 0; i < 3; i++) {
      assert.equal(await pi.handlers.tool_call(writeCall('src/hot.ts', `c${i}`), ctx), undefined, 'advisory never blocks');
    }
    const flailNotices = ctx.notices.filter((n) => /flail/.test(n.m));
    assert.equal(flailNotices.length, 1, 'warn once');
    assert.equal(pi.steers.length, 1, 'steer once');
    assert.match(pi.steers[0].msg.content, /src\/hot\.ts/);
    assert.equal(pi.steers[0].opts.deliverAs, 'steer');

    // a fourth edit of the SAME file stays quiet; one edit of another file emits nothing
    await pi.handlers.tool_call(writeCall('src/hot.ts', 'c4'), ctx);
    await pi.handlers.tool_call(writeCall('src/cold.ts', 'c5'), ctx);
    assert.equal(pi.steers.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC5 — state resets on session_start
// =========================================================================

test('AC5: session_start resets degraded flag and churn window', async () => {
  const root = makeRepo({ current: 'T2' });
  try {
    const { pi, ctx } = await boot(root, 10);
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow', willRetry: false }, ctx);
    for (let i = 0; i < 3; i++) await pi.handlers.tool_call(writeCall('src/hot.ts', `x${i}`), ctx);
    assert.equal(pi.steers.length, 1);

    // resume: everything resets
    await pi.handlers.session_start({ type: 'session_start', reason: 'resume' }, ctx);
    // switch to the high-risk ticket to check the degraded flag cleared
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);
    assert.equal(await pi.handlers.tool_call(writeCall('src/a.ts', 'y'), ctx), undefined, 'degraded flag cleared by session_start');

    for (let i = 0; i < 2; i++) await pi.handlers.tool_call(writeCall('src/hot.ts', `z${i}`), ctx);
    assert.equal(pi.steers.length, 1, 'churn window cleared — two edits after reset stay quiet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// Unit: trackers
// =========================================================================

test('F4 regression: a rails-denied edit never counts toward churn', async () => {
  const railTicket = { ...NORMAL_TICKET, id: 'T3', rails: ['test/contracts/**'] };
  const root = makeRepo({ tickets: [HIGH_RISK_TICKET, NORMAL_TICKET, railTicket], current: 'T3' });
  try {
    const { pi, ctx } = await boot(root, 10);
    for (let i = 0; i < 4; i++) {
      const denied = await pi.handlers.tool_call(writeCall('test/contracts/auth.test.ts', `d${i}`), ctx);
      assert.equal(denied.block, true);
    }
    // The sendMessage channel now also carries 'adlc-gate-notice' for denies
    // (T25); the flail claim is specifically that NO churn advisory fires.
    const flail = pi.steers.filter((s) => s.msg.customType === 'adlc-flail-advisory');
    assert.equal(flail.length, 0, 'denied edits are not churn — flail runs after the deny returns');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F4 regression: a throwing sendMessage never breaks the tool call', async () => {
  const root = makeRepo({ current: 'T2' });
  try {
    const pi = fakePi();
    pi.sendMessage = () => { throw new Error('steer channel down'); };
    createExtension({ env: {} })(pi);
    const ctx = fakeCtx(root, 10);
    await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
    for (let i = 0; i < 3; i++) {
      assert.equal(await pi.handlers.tool_call(writeCall('src/hot.ts', `s${i}`), ctx), undefined, 'advisory failure must not affect the call');
    }
    assert.ok(ctx.notices.some((n) => /flail/.test(n.m)), 'notify channel still warned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fitness tracker: only threshold/overflow compactions degrade', () => {
  const f = createFitnessTracker();
  f.markCompaction('manual');
  assert.equal(f.isCompacted(), false);
  f.markCompaction('threshold');
  assert.equal(f.isCompacted(), true);
  f.reset();
  assert.equal(f.isCompacted(), false);
});

test('flail tracker: threshold 3, once per file, bounded window', () => {
  const t = createFlailTracker({ window: 10 });
  assert.deepEqual(t.recordMutation('a.ts'), []);
  assert.deepEqual(t.recordMutation('a.ts'), []);
  const hit = t.recordMutation('a.ts');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].path, 'a.ts');
  assert.equal(hit[0].count, 3);
  assert.deepEqual(t.recordMutation('a.ts'), [], 'no repeat warning');
});
