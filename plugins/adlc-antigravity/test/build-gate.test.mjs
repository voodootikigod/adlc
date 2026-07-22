// build-gate.test.mjs — tests for build-gate-inline.mjs and flail-inline.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRiskTier,
  createDepthTracker,
  decideBuildGate,
  checkBuildGate,
} from '../build-gate-inline.mjs';
import { createFlailTracker, detectEditChurn, flailMessage } from '../flail-inline.mjs';

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
