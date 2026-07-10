import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHop, safeOrigin, handleContact, HONEYPOT_FIELD, bodyLengthAcceptable, MAX_BODY_BYTES } from '../lib/contact/handle.mjs';
import { createRateLimiter } from '../lib/contact/rate-limit.mjs';

// Kills hollow-test survivors: firstHop x-forwarded-for parsing (PM-B) and
// safeOrigin normalization, which the frozen route rail exercises only through
// an injected fake.

test('bodyLengthAcceptable requires a present Content-Length within the cap', () => {
  assert.equal(bodyLengthAcceptable(String(MAX_BODY_BYTES)), true);
  assert.equal(bodyLengthAcceptable('500'), true);
  assert.equal(bodyLengthAcceptable('0'), true);
  assert.equal(bodyLengthAcceptable(String(MAX_BODY_BYTES + 1)), false, 'oversized rejected');
  assert.equal(bodyLengthAcceptable(null), false, 'missing Content-Length rejected (blocks chunked)');
  assert.equal(bodyLengthAcceptable(''), false);
  assert.equal(bodyLengthAcceptable('not-a-number'), false);
  assert.equal(bodyLengthAcceptable('-1'), false);
});

test('firstHop returns the first hop of x-forwarded-for', () => {
  assert.equal(firstHop('203.0.113.7, 70.41.3.18, 150.172.238.178'), '203.0.113.7');
  assert.equal(firstHop('  198.51.100.9  '), '198.51.100.9');
});

test('firstHop returns empty string for missing header', () => {
  assert.equal(firstHop(''), '');
  assert.equal(firstHop(null), '');
  assert.equal(firstHop(undefined), '');
});

test('safeOrigin reduces a URL to its origin and rejects garbage', () => {
  assert.equal(safeOrigin('https://agenticlifecycle.ai/enterprise?x=1'), 'https://agenticlifecycle.ai');
  assert.equal(safeOrigin('https://agenticlifecycle.ai'), 'https://agenticlifecycle.ai');
  assert.equal(safeOrigin('not a url'), '');
  assert.equal(safeOrigin(''), '');
});

test('the real rate limiter keys distinct x-forwarded-for IPs independently', async () => {
  const rl = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
  const deps = {
    checkBot: async () => ({ isBot: false }),
    selectSink: () => ({ submit: async () => ({ ok: true }) }),
    rateLimit: (key) => rl.check(key),
    allowedOrigins: [],
  };
  const body = { name: 'Ada', email: 'a@b.com', message: 'hello there' };
  const first = await handleContact({ body, getHeader: (n) => (n.toLowerCase() === 'x-forwarded-for' ? '10.0.0.1, 9.9.9.9' : null), deps });
  const secondSameIp = await handleContact({ body, getHeader: (n) => (n.toLowerCase() === 'x-forwarded-for' ? '10.0.0.1, 1.2.3.4' : null), deps });
  const otherIp = await handleContact({ body, getHeader: (n) => (n.toLowerCase() === 'x-forwarded-for' ? '10.0.0.2' : null), deps });
  assert.equal(first.status, 200);
  assert.equal(secondSameIp.status, 429, 'same first-hop IP is rate-limited on the second call');
  assert.equal(otherIp.status, 200, 'a different first-hop IP is independent');
});

test('a filled honeypot short-circuits before any dep runs', async () => {
  let sinkCalls = 0;
  const deps = {
    checkBot: async () => { throw new Error('should not run'); },
    selectSink: () => ({ submit: async () => { sinkCalls++; return { ok: true }; } }),
    rateLimit: () => ({ allowed: true }),
    allowedOrigins: [],
  };
  const res = await handleContact({
    body: { name: 'Ada', email: 'a@b.com', message: 'hi', [HONEYPOT_FIELD]: 'x' },
    getHeader: () => null,
    deps,
  });
  assert.equal(res.status, 200);
  assert.equal(sinkCalls, 0);
});
