// test/risk.test.mjs — risk-tier derivation from ticket fields (issue #48, item 1).
//
// Tier is 'high' if EITHER the ticket declares risk:'high' OR any derived signal
// fires. A declared risk:'normal' can NEVER downgrade a derived-high signal —
// that would be exactly the silent bypass the gate exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRiskSignals, computeRiskTier, TRUST_ROOT_PATHS, MANIFEST_PATH, HIGH_RISK_CATEGORIES } from '../lib/risk.mjs';

test('plain ticket with no risk markers → normal, no signals', () => {
  const t = { id: 'T1', title: 'x', category: 'feature' };
  const result = computeRiskTier(t);
  assert.equal(result.tier, 'normal');
  assert.deepEqual(result.signals, []);
});

test('declared risk: high → high tier', () => {
  const t = { id: 'T1', title: 'x', risk: 'high' };
  const result = computeRiskTier(t);
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('declared-risk-high'));
});

test('declared risk: normal with no other signal → normal tier', () => {
  const t = { id: 'T1', title: 'x', risk: 'normal' };
  const result = computeRiskTier(t);
  assert.equal(result.tier, 'normal');
});

test('declared risk: normal CANNOT downgrade a derived-high signal (no silent bypass)', () => {
  const t = { id: 'T1', title: 'x', risk: 'normal', category: 'contract' };
  const result = computeRiskTier(t);
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.some((s) => s.startsWith('high-risk-category')));
});

test('category "contract" → high (derived)', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', category: 'contract' });
  assert.equal(result.tier, 'high');
});

test('category "architecture" → high (derived)', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', category: 'architecture' });
  assert.equal(result.tier, 'high');
});

test('category "feature" → not high on its own', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', category: 'feature' });
  assert.equal(result.tier, 'normal');
});

test('ticket.external === true → high (writes back to/creates/deletes in an external system)', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', external: true });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('external-system-effect'));
});

test('ticket.mutatesIdentity === true → high', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', mutatesIdentity: true });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('mutates-identity'));
});

test('scope touching .adlc/manifest.jsonl → high (mutates-manifest)', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: ['.adlc/manifest.jsonl'] });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('mutates-manifest'));
});

test('rails glob touching .adlc/manifest.jsonl → high (mutates-manifest)', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', rails: ['.adlc/**'] });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('mutates-manifest'));
});

test('scope touching .adlc/tickets.json (trust root) → high', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: ['.adlc/tickets.json'] });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('touches-trust-root'));
});

test('scope touching .adlc/current-ticket.json (trust root) → high', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: ['.adlc/current-ticket.json'] });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('touches-trust-root'));
});

test('unrelated scope globs do not touch the trust root or manifest → normal', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: ['src/**', 'test/**'] });
  assert.equal(result.tier, 'normal');
});

test('multiple signals can fire simultaneously and are all reported', () => {
  const t = {
    id: 'T1',
    title: 'x',
    risk: 'high',
    category: 'architecture',
    external: true,
    mutatesIdentity: true,
    scope: ['.adlc/manifest.jsonl', '.adlc/tickets.json'],
  };
  const result = computeRiskTier(t);
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('declared-risk-high'));
  assert.ok(result.signals.includes('external-system-effect'));
  assert.ok(result.signals.includes('mutates-identity'));
  assert.ok(result.signals.includes('mutates-manifest'));
  assert.ok(result.signals.includes('touches-trust-root'));
  assert.ok(result.signals.some((s) => s.startsWith('high-risk-category')));
});

test('deriveRiskSignals is pure and returns [] for an empty ticket', () => {
  assert.deepEqual(deriveRiskSignals({}), []);
});

// ---- fail closed on malformed ticket data (not a crash, not a silent allow) ----

test('non-array scope (e.g. a number) does not throw and fails closed to high tier', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: 42 });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('malformed-scope'));
});

test('non-array rails (e.g. an object) does not throw and fails closed to high tier', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', rails: { foo: 'bar' } });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('malformed-rails'));
});

test('non-array scope (a single string glob, a plausible authoring mistake) fails closed', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: 'src/**' });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('malformed-scope'));
});

test('malformed scope alongside a valid rails array still evaluates the valid rails globs', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x', scope: 42, rails: ['.adlc/manifest.jsonl'] });
  assert.equal(result.tier, 'high');
  assert.ok(result.signals.includes('malformed-scope'));
  assert.ok(result.signals.includes('mutates-manifest'));
});

test('undefined scope/rails are not "malformed" — no false-positive signal', () => {
  const result = computeRiskTier({ id: 'T1', title: 'x' });
  assert.equal(result.tier, 'normal');
  assert.equal(result.signals.includes('malformed-scope'), false);
  assert.equal(result.signals.includes('malformed-rails'), false);
});

test('exported constants document the trust-root paths and high-risk categories', () => {
  assert.ok(TRUST_ROOT_PATHS.includes('.adlc/tickets.json'));
  assert.equal(MANIFEST_PATH, '.adlc/manifest.jsonl');
  assert.ok(HIGH_RISK_CATEGORIES.has('contract'));
  assert.ok(HIGH_RISK_CATEGORIES.has('architecture'));
});
