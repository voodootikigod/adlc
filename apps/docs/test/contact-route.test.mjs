import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleContact, HONEYPOT_FIELD } from '../lib/contact/handle.mjs';
import { SinkError } from '../lib/contact/sinks.mjs';

// AC5-AC8, AC13-AC15: the ordered gates of the contact route, exercised through
// the pure handleContact core with injected fakes.

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  message: 'Rolling out agents org-wide.',
};

function spySink({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    submit: async (lead) => {
      calls.push(lead);
      if (fail) throw fail;
      return { ok: true };
    },
  };
}

function baseDeps(over = {}) {
  const sink = over.sink || spySink();
  return {
    sink,
    deps: {
      checkBot: over.checkBot || (async () => ({ isBot: false })),
      selectSink: over.selectSink || (() => sink),
      rateLimit: over.rateLimit || (() => ({ allowed: true })),
      allowedOrigins: over.allowedOrigins || ['https://agenticlifecycle.ai'],
      now: () => 1_000_000,
    },
  };
}

function getHeader(map) {
  return (name) => map[name.toLowerCase()] ?? null;
}

const OK_HEADERS = { origin: 'https://agenticlifecycle.ai', 'x-forwarded-for': '203.0.113.7' };

test('AC5: a filled honeypot returns 200 success and never calls the sink', async () => {
  const { sink, deps } = baseDeps();
  const res = await handleContact({
    body: { ...VALID, [HONEYPOT_FIELD]: 'http://spam.example' },
    getHeader: getHeader(OK_HEADERS),
    deps,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sink.calls.length, 0);
});

test('AC6: invalid input returns 400 with field errors and no sink call', async () => {
  const { sink, deps } = baseDeps();
  const res = await handleContact({
    body: { name: '', email: 'bad', message: '' },
    getHeader: getHeader(OK_HEADERS),
    deps,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.fields && Object.keys(res.body.fields).length > 0);
  assert.equal(sink.calls.length, 0);
});

test('AC6: exceeding the rate limit returns 429 and no sink call', async () => {
  const { sink, deps } = baseDeps({ rateLimit: () => ({ allowed: false }) });
  const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
  assert.equal(res.status, 429);
  assert.equal(res.body.ok, false);
  assert.equal(sink.calls.length, 0);
});

test('AC6: an unconfigured sink returns 503 sink_unconfigured', async () => {
  const { deps } = baseDeps({
    selectSink: () => { throw new SinkError('sink_unconfigured', 'no secret'); },
  });
  const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'sink_unconfigured');
});

test('AC6: a valid human submission reaches the sink and returns 200', async () => {
  const { sink, deps } = baseDeps();
  const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0].email, 'ada@example.com');
});

test('AC7: a bot verdict returns 403 and never calls the sink', async () => {
  const { sink, deps } = baseDeps({ checkBot: async () => ({ isBot: true }) });
  const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  assert.equal(sink.calls.length, 0);
});

test('AC13: a BotID infra error fails open — the request still reaches the sink', async () => {
  const SECRET = 'infra-token-should-not-leak-4242';
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const { sink, deps } = baseDeps({
      checkBot: async () => { throw new Error(`botid exploded ${SECRET}`); },
    });
    const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(sink.calls.length, 1);
    assert.ok(!JSON.stringify(res.body).includes(SECRET), 'error text must not surface in the body');
    assert.ok(!errs.join(' ').includes(SECRET), 'error text must not be logged');
  } finally {
    console.error = origError;
  }
});

test('AC14: a cross-origin POST returns 403 and never calls the sink', async () => {
  const { sink, deps } = baseDeps();
  const res = await handleContact({
    body: VALID,
    getHeader: getHeader({ origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.7' }),
    deps,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  assert.equal(sink.calls.length, 0);
});

test('AC15: a sink send failure returns 502 and never a success envelope', async () => {
  const failing = spySink({ fail: new SinkError('sink_failed', 'resend 403') });
  const { deps } = baseDeps({ sink: failing, selectSink: () => failing });
  const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'sink_failed');
  assert.notEqual(res.body.ok, true);
});

test('AC8: a secret embedded in a sink error never reaches the response or the logs', async () => {
  const SECRET = 'attio-secret-leak-9999';
  const errs = [];
  const origError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const failing = spySink({ fail: new Error(`upstream said ${SECRET}`) });
    const { deps } = baseDeps({ sink: failing, selectSink: () => failing });
    const res = await handleContact({ body: VALID, getHeader: getHeader(OK_HEADERS), deps });
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(res.body).includes(SECRET), 'secret must not be in the body');
    assert.ok(!errs.join(' ').includes(SECRET), 'secret must not be logged');
  } finally {
    console.error = origError;
  }
});
