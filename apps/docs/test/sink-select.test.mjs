import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSink, SinkError } from '../lib/contact/sinks.mjs';

// AC4: selectSink returns the sink named by CONTACT_SINK and throws a typed
// sink_unconfigured error when the required secret is missing.

const noopFetch = async () => ({ ok: true, status: 200, async json() { return {}; }, async text() { return ''; } });

test('CONTACT_SINK=attio with a token returns a submitting sink', () => {
  const sink = selectSink(
    { CONTACT_SINK: 'attio', ATTIO_API_TOKEN: 'tok' },
    { fetch: noopFetch },
  );
  assert.equal(typeof sink.submit, 'function');
});

test('CONTACT_SINK=attio without a token throws sink_unconfigured', () => {
  assert.throws(
    () => selectSink({ CONTACT_SINK: 'attio' }, { fetch: noopFetch }),
    (err) => {
      assert.ok(err instanceof SinkError);
      assert.equal(err.code, 'sink_unconfigured');
      return true;
    },
  );
});

test('CONTACT_SINK=resend with a key returns a submitting sink', () => {
  const sink = selectSink(
    { CONTACT_SINK: 'resend', RESEND_API_KEY: 'key', CONTACT_FROM_EMAIL: 'a@b.com', CONTACT_NOTIFY_EMAIL: 'c@d.com' },
    { fetch: noopFetch },
  );
  assert.equal(typeof sink.submit, 'function');
});

test('CONTACT_SINK=resend without a key throws sink_unconfigured', () => {
  assert.throws(
    () => selectSink({ CONTACT_SINK: 'resend' }, { fetch: noopFetch }),
    (err) => {
      assert.equal(err.code, 'sink_unconfigured');
      return true;
    },
  );
});

test('an unset CONTACT_SINK throws sink_unconfigured', () => {
  assert.throws(
    () => selectSink({}, { fetch: noopFetch }),
    (err) => {
      assert.equal(err.code, 'sink_unconfigured');
      return true;
    },
  );
});
