// build-gate.test.mjs — tests for build-gate-inline.mjs, flail-inline.mjs, and persistent session depth tracking

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRiskTier,
  createDepthTracker,
  createPersistentTracker,
  decideBuildGate,
  checkBuildGate,
} from '../build-gate-inline.mjs';
import { createFlailTracker, detectEditChurn, flailMessage } from '../flail-inline.mjs';
import { runFromStdin } from '../hooks/adlc-rails-guard.mjs';

test('computeRiskTier: derives high risk for ticket declaring risk: high', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', risk: 'high' });
  assert.equal(tier, 'high');
  assert.ok(signals.includes('declared-risk-high'));
});

test('computeRiskTier: derives high risk for ticket touching trust root', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', scope: ['.adlc/tickets.json'] });
  assert.equal(tier, 'high');
  assert.ok(signals.includes('touches-trust-root'));
});

test('computeRiskTier: normal risk for standard ticket', () => {
  const { tier, signals } = computeRiskTier({ id: 'T1', title: 'test', scope: ['src/foo.mjs'] });
  assert.equal(tier, 'normal');
  assert.equal(signals.length, 0);
});

test('decideBuildGate: denies high risk ticket in degraded context', () => {
  const verdict = decideBuildGate({ riskTier: 'high', degraded: true, bypass: false });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /high-risk ticket build denied/);
});

test('decideBuildGate: allows high risk ticket in degraded context when bypass=true', () => {
  const verdict = decideBuildGate({ riskTier: 'high', degraded: true, bypass: true });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.overridden, true);
});

test('decideBuildGate: allows normal risk ticket even if degraded', () => {
  const verdict = decideBuildGate({ riskTier: 'normal', degraded: true, bypass: false });
  assert.equal(verdict.decision, 'allow');
});

test('createDepthTracker: tracks tool call count per session', () => {
  const tracker = createDepthTracker();
  assert.equal(tracker.depth('s1'), 0);
  tracker.recordToolCall('s1');
  tracker.recordToolCall('s1');
  assert.equal(tracker.depth('s1'), 2);
  assert.equal(tracker.isCompacted('s1'), false);
  tracker.markCompacted('s1');
  assert.equal(tracker.isCompacted('s1'), true);
});

test('createPersistentTracker: persists depth across calls to .adlc/sessions.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
  try {
    const t1 = createPersistentTracker(root);
    t1.recordToolCall('sess-100');
    t1.recordToolCall('sess-100');
    assert.equal(t1.depth('sess-100'), 2);

    // Re-create tracker from same root — verifies state persisted on disk
    const t2 = createPersistentTracker(root);
    assert.equal(t2.depth('sess-100'), 2);
    t2.markCompacted('sess-100');

    const t3 = createPersistentTracker(root);
    assert.equal(t3.isCompacted('sess-100'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFromStdin end-to-end: denies high-risk ticket edits once context depth threshold is crossed', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-gate-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const ticket = { id: 'T-HIGH', title: 'High risk contract', risk: 'high', scope: ['src/**'] };
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T-HIGH' }));

    const targetFile = join(root, 'src', 'app.mjs');
    const env = { ADLC_P4_ENFORCEMENT: '1', ADLC_BUILD_GATE_DEPTH_THRESHOLD: '3' };

    const payloadStr = (step) => JSON.stringify({
      conversationId: 'e2e-session-1',
      toolCall: { name: 'write_to_file', args: { TargetFile: targetFile, CodeContent: `// step ${step}` } }
    });

    // Calls 1 and 2 should pass
    let res = runFromStdin(payloadStr(1), env);
    assert.equal(res.allow_tool, true);
    res = runFromStdin(payloadStr(2), env);
    assert.equal(res.allow_tool, true);

    // Call 3 crosses depth threshold 3 on a high risk ticket → DENIED
    res = runFromStdin(payloadStr(3), env);
    assert.equal(res.allow_tool, false);
    assert.match(res.deny_reason, /build-gate/i);
    assert.match(res.deny_reason, /tool-call depth 3 >= 3/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flail-inline: detectEditChurn identifies churning file edits', () => {
  const logs = ['Editing src/a.js', 'Editing src/b.js', 'Editing src/a.js', 'Editing src/a.js'];
  const churning = detectEditChurn(logs, 3);
  assert.equal(churning.length, 1);
  assert.equal(churning[0].path, 'src/a.js');
  assert.equal(churning[0].count, 3);
});

test('createFlailTracker: records mutations and emits warning on threshold', () => {
  const tracker = createFlailTracker({ threshold: 3 });
  let res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 0);
  res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 0);
  res = tracker.record({ sessionID: 's1', tool: 'write_to_file', filePath: 'src/app.mjs' });
  assert.equal(res.churning.length, 1);
  assert.equal(res.churning[0].path, 'src/app.mjs');
});
