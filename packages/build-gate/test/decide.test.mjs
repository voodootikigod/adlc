// test/decide.test.mjs — build-gate deny/allow decision given a mocked depth
// signal (issue #48, item 3). Pure decision function: no filesystem, no
// process I/O — the override side effect is injected so both the "recorded"
// and "recording failed" (unaudited bypass refused) paths are exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBuildGate } from '../lib/decide.mjs';

test('normal-risk ticket → allow, regardless of degraded signal', () => {
  const r = decideBuildGate({ riskTier: 'normal', degraded: true, bypass: false });
  assert.equal(r.decision, 'allow');
  assert.match(r.reason, /normal/);
});

test('high-risk ticket, NOT degraded → allow', () => {
  const r = decideBuildGate({ riskTier: 'high', degraded: false, bypass: false });
  assert.equal(r.decision, 'allow');
  assert.match(r.reason, /below threshold|not degraded/i);
});

test('high-risk ticket, degraded, no bypass → DENY (exit 2 territory)', () => {
  const r = decideBuildGate({ riskTier: 'high', degraded: true, bypass: false });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /high-risk/i);
});

test('high-risk ticket, degraded, bypass requested AND recorded → allow, overridden:true', () => {
  let recordCalled = false;
  const r = decideBuildGate({
    riskTier: 'high',
    degraded: true,
    bypass: true,
    recordBypass: () => {
      recordCalled = true;
      return true;
    },
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.overridden, true);
  assert.equal(recordCalled, true);
});

test('high-risk ticket, degraded, bypass requested but recording FAILS → DENY (unaudited override refused)', () => {
  const r = decideBuildGate({
    riskTier: 'high',
    degraded: true,
    bypass: true,
    recordBypass: () => false,
  });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /unaudited|could not be (recorded|audited)/i);
});

test('bypass flag is IGNORED when not degraded (no override needed, no record call)', () => {
  let recordCalled = false;
  const r = decideBuildGate({
    riskTier: 'high',
    degraded: false,
    bypass: true,
    recordBypass: () => {
      recordCalled = true;
      return true;
    },
  });
  assert.equal(r.decision, 'allow');
  assert.equal(recordCalled, false);
});

test('bypass flag is IGNORED for a normal-risk ticket (no record call)', () => {
  let recordCalled = false;
  const r = decideBuildGate({
    riskTier: 'normal',
    degraded: true,
    bypass: true,
    recordBypass: () => {
      recordCalled = true;
      return true;
    },
  });
  assert.equal(r.decision, 'allow');
  assert.equal(recordCalled, false);
});

test('bypass requested but no recordBypass function supplied at all → DENY (never silently allow)', () => {
  const r = decideBuildGate({ riskTier: 'high', degraded: true, bypass: true });
  assert.equal(r.decision, 'deny');
});
