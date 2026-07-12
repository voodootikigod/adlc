import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prosecute } from '../lib/prosecute.mjs';

const ctx = { worktree: '/wt', startSha: 'tip', ticket: { id: 'T1' } };

test('a clean review passes', async () => {
  const r = await prosecute(ctx, { runReview: () => ({ ok: true, findings: [] }) });
  assert.equal(r.verdict, 'pass');
});

test('a finding at/above the threshold BLOCKS (AC12 i / F3)', async () => {
  const r = await prosecute(ctx, { runReview: () => ({ ok: true, findings: [{ severity: 'high' }] }) });
  assert.equal(r.verdict, 'block');
  assert.equal(r.blocking.length, 1);
});

test('a below-threshold finding does not block', async () => {
  const r = await prosecute(ctx, { runReview: () => ({ ok: true, findings: [{ severity: 'low' }] }), failOn: 'medium' });
  assert.equal(r.verdict, 'pass');
});

test('an unreachable provider FAILS CLOSED (AC12 iii / F3)', async () => {
  const r = await prosecute(ctx, { runReview: () => ({ ok: false, reason: 'no provider' }) });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /provider/i);
});

test('no runner configured fails closed (never silently passes)', async () => {
  const r = await prosecute(ctx, {});
  assert.equal(r.verdict, 'unavailable');
});

test('a throwing runner fails closed', async () => {
  const r = await prosecute(ctx, { runReview: () => { throw new Error('spawn ENOENT'); } });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /threw/);
});

test('failOn severity is configurable', async () => {
  const findings = [{ severity: 'medium' }];
  assert.equal((await prosecute(ctx, { runReview: () => ({ ok: true, findings }), failOn: 'high' })).verdict, 'pass');
  assert.equal((await prosecute(ctx, { runReview: () => ({ ok: true, findings }), failOn: 'medium' })).verdict, 'block');
});
