import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResendSink } from '../lib/contact/resend-sink.mjs';

// AC3: ResendSink sends a notification email to CONTACT_NOTIFY_EMAIL with the
// lead fields. PM-E: send failure returns sink_failed (loud). AC8: key no leak.

const KEY = 'resend-secret-zyxw987654';
const LEAD = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  message: 'Rolling out agents org-wide.',
};

function fakeFetch(captured, { status = 200 } = {}) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return { id: 'email_1' }; },
      async text() { return 'ok'; },
    };
  };
}

test('POSTs to the Resend emails endpoint with the API key and configured from/to', async () => {
  const cap = {};
  const sink = createResendSink({
    apiKey: KEY,
    from: 'ADLC <noreply@agenticlifecycle.ai>',
    to: 'help@agenticlifecycle.ai',
    fetch: fakeFetch(cap),
  });
  const res = await sink.submit(LEAD);
  assert.equal(res.ok, true);
  assert.match(cap.url, /api\.resend\.com\/emails$/);
  assert.equal(cap.opts.method, 'POST');
  assert.equal(cap.opts.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(cap.opts.body);
  assert.equal(body.from, 'ADLC <noreply@agenticlifecycle.ai>');
  assert.deepEqual(body.to, ['help@agenticlifecycle.ai']);
});

test('includes the lead name, email, and message in the email body', async () => {
  const cap = {};
  const sink = createResendSink({
    apiKey: KEY,
    from: 'ADLC <noreply@agenticlifecycle.ai>',
    to: 'help@agenticlifecycle.ai',
    fetch: fakeFetch(cap),
  });
  await sink.submit(LEAD);
  const body = JSON.parse(cap.opts.body);
  const blob = `${body.subject || ''} ${body.html || ''} ${body.text || ''}`;
  assert.match(blob, /Ada Lovelace/);
  assert.match(blob, /ada@example\.com/);
  assert.match(blob, /Rolling out agents org-wide\./);
});

test('throws sink_failed on a non-2xx response, key never in the error', async () => {
  const cap = {};
  const sink = createResendSink({
    apiKey: KEY,
    from: 'ADLC <noreply@agenticlifecycle.ai>',
    to: 'help@agenticlifecycle.ai',
    fetch: fakeFetch(cap, { status: 403 }),
  });
  await assert.rejects(
    () => sink.submit(LEAD),
    (err) => {
      assert.equal(err.code, 'sink_failed');
      assert.ok(!String(err.message).includes(KEY));
      return true;
    },
  );
});
