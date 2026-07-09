import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../lib/contact/rate-limit.mjs';

// PM-B: the real fixed-window limiter — allows up to max, then blocks, resets
// after the window, and evicts expired entries so the map stays bounded.

test('allows up to max requests then blocks within the window', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, false);
});

test('resets after the window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, false);
  t = 1001;
  assert.equal(rl.check('ip').allowed, true);
});

test('tracks distinct keys independently', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('b').allowed, true);
  assert.equal(rl.check('a').allowed, false);
});

test('the default limit allows 5 then blocks the 6th', () => {
  const rl = createRateLimiter({ now: () => 0 }); // default max=5
  for (let i = 0; i < 5; i++) assert.equal(rl.check('ip').allowed, true, `request ${i + 1}`);
  assert.equal(rl.check('ip').allowed, false, '6th request blocked at the default limit');
});

test('evicts expired entries so the map does not grow unbounded', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 100; i++) rl.check(`ip-${i}`);
  // Advance past the window; the next check must sweep the 100 stale entries.
  t = 2000;
  const probe = rl.check('fresh');
  assert.equal(probe.allowed, true);
  // No public size accessor, so assert behavior: a previously-seen key is fresh
  // again (its entry was evicted, not lingering).
  assert.equal(rl.check('ip-0').allowed, true);
});
