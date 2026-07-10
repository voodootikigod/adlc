import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSink, SinkError } from '../lib/contact/sinks.mjs';
import { handleContact } from '../lib/contact/handle.mjs';
import { createRateLimiter } from '../lib/contact/rate-limit.mjs';

// Adversarial-review fixes:
// HIGH  — unset CONTACT_SINK must still select Attio when a token is present.
// MEDIUM — same-origin must fail closed via the Host-derived origin when no
//          explicit allowlist is configured.

const noopFetch = async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } });
const VALID = { name: 'Ada', email: 'ada@example.com', message: 'Rolling out agents.' };

test('HIGH: unset CONTACT_SINK with a token selects the Attio sink (default)', () => {
  const sink = selectSink({ ATTIO_API_TOKEN: 'tok' }, { fetch: noopFetch });
  assert.equal(typeof sink.submit, 'function');
});

test('HIGH: unset CONTACT_SINK with NO token still fails closed (sink_unconfigured)', () => {
  assert.throws(
    () => selectSink({}, { fetch: noopFetch }),
    (err) => err instanceof SinkError && err.code === 'sink_unconfigured',
  );
});

test('an explicit unknown CONTACT_SINK fails closed', () => {
  assert.throws(
    () => selectSink({ CONTACT_SINK: 'ftp' }, { fetch: noopFetch }),
    (err) => err.code === 'sink_unconfigured',
  );
});

function deps(over = {}) {
  const sink = { calls: 0, submit: async () => { sink.calls++; return { ok: true }; } };
  return {
    sink,
    deps: {
      checkBot: async () => ({ isBot: false }),
      selectSink: () => sink,
      rateLimit: () => ({ allowed: true }),
      allowedOrigins: over.allowedOrigins ?? [], // empty => Host-derived default
    },
  };
}

function headers(map) {
  return (name) => map[name.toLowerCase()] ?? null;
}

test('MEDIUM: with no allowlist, a same-origin POST (Origin === Host) is allowed', async () => {
  const { sink, deps: d } = deps();
  const res = await handleContact({
    body: VALID,
    getHeader: headers({ host: 'agenticlifecycle.ai', origin: 'https://agenticlifecycle.ai', 'x-forwarded-for': '203.0.113.7' }),
    deps: d,
  });
  assert.equal(res.status, 200);
  assert.equal(sink.calls, 1);
});

test('MEDIUM: with no allowlist, a cross-origin POST (Origin !== Host) is rejected 403', async () => {
  const { sink, deps: d } = deps();
  const res = await handleContact({
    body: VALID,
    getHeader: headers({ host: 'agenticlifecycle.ai', origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.7' }),
    deps: d,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden_origin');
  assert.equal(sink.calls, 0);
});

test('MEDIUM: x-forwarded-proto is honored when deriving the expected origin', async () => {
  const { sink, deps: d } = deps();
  const res = await handleContact({
    body: VALID,
    getHeader: headers({ host: 'localhost:4321', origin: 'http://localhost:4321', 'x-forwarded-proto': 'http' }),
    deps: d,
  });
  assert.equal(res.status, 200);
  assert.equal(sink.calls, 1);
});

test('a Host with an explicit default port still matches a port-less Origin', async () => {
  const { sink, deps: d } = deps();
  const res = await handleContact({
    body: VALID,
    getHeader: headers({ host: 'agenticlifecycle.ai:443', origin: 'https://agenticlifecycle.ai', 'x-forwarded-proto': 'https' }),
    deps: d,
  });
  assert.equal(res.status, 200, 'host:443 must be treated same-origin as the port-less https origin');
  assert.equal(sink.calls, 1);
});

test('malformed requests do not burn the rate-limit quota for a later valid lead', async () => {
  // Real limiter, max 3. Six invalid POSTs from one IP must not exhaust it;
  // a subsequent valid submission from the same IP still succeeds.
  const rl = createRateLimiter({ max: 3, windowMs: 10_000, now: () => 0 });
  const sink = { calls: 0, submit: async () => { sink.calls++; return { ok: true }; } };
  const d = {
    checkBot: async () => ({ isBot: false }),
    selectSink: () => sink,
    rateLimit: (key) => rl.check(key),
    allowedOrigins: [],
  };
  const hdr = headers({ host: 'agenticlifecycle.ai', origin: 'https://agenticlifecycle.ai', 'x-forwarded-for': '10.0.0.5' });
  for (let i = 0; i < 6; i++) {
    const bad = await handleContact({ body: { name: '', email: 'x', message: '' }, getHeader: hdr, deps: d });
    assert.equal(bad.status, 400);
  }
  const good = await handleContact({ body: VALID, getHeader: hdr, deps: d });
  assert.equal(good.status, 200, 'valid lead still accepted after malformed spam');
  assert.equal(sink.calls, 1);
});
