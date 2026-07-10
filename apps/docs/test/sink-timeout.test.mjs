import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttioSink } from '../lib/contact/attio-sink.mjs';
import { createResendSink } from '../lib/contact/resend-sink.mjs';

// A hung upstream must not tie up the request: the bounded timeout aborts the
// fetch and surfaces as sink_failed (which the route maps to 502 + mailto).

const LEAD = { name: 'Ada', email: 'ada@example.com', company: '', message: 'hello there' };

// Fetch that never resolves until its AbortSignal fires. A ref'd keepalive timer
// stands in for the real network socket (AbortSignal.timeout's own timer is
// unref'd, so without this the test loop would drain before the deadline).
function hangingFetch(_url, opts) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 60_000);
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    }
  });
}

test('AttioSink times out a hung request and throws sink_failed', async () => {
  const sink = createAttioSink({ token: 'tok', object: 'enterprise_inquiries', timeoutMs: 25, fetch: hangingFetch });
  await assert.rejects(
    () => sink.submit(LEAD),
    (err) => err.code === 'sink_failed',
  );
});

test('ResendSink times out a hung request and throws sink_failed', async () => {
  const sink = createResendSink({ apiKey: 'k', from: 'a@b.com', to: 'c@d.com', timeoutMs: 25, fetch: hangingFetch });
  await assert.rejects(
    () => sink.submit(LEAD),
    (err) => err.code === 'sink_failed',
  );
});
