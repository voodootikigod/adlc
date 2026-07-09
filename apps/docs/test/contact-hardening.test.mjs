import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSink, SinkError } from '../lib/contact/sinks.mjs';
import { handleContact } from '../lib/contact/handle.mjs';

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
