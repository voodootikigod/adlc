import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttioSink } from '../lib/contact/attio-sink.mjs';

// AC2: AttioSink POSTs an assert-by-email person payload to Attio with the
// bearer token and maps company/message to configured attribute slugs.
// PM-A: grounded in the Attio v2 records shape. PM-D/AC8: token never leaks.

const TOKEN = 'attio-secret-abcdef123456';
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
      async json() { return { data: { id: { record_id: 'rec_1' } } }; },
      async text() { return 'ok'; },
    };
  };
}

test('PUTs to the people records assert-by-email endpoint with the bearer token', async () => {
  const cap = {};
  const sink = createAttioSink({
    token: TOKEN,
    companyAttr: 'company_name',
    messageAttr: 'inquiry',
    fetch: fakeFetch(cap),
  });
  const res = await sink.submit(LEAD);
  assert.equal(res.ok, true);
  assert.match(cap.url, /\/v2\/objects\/people\/records\?matching_attribute=email_addresses$/);
  assert.equal(cap.opts.method, 'PUT');
  assert.equal(cap.opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(cap.opts.headers['Content-Type'] || '', /application\/json/);
});

test('maps name/email/company/message into the Attio values shape', async () => {
  const cap = {};
  const sink = createAttioSink({
    token: TOKEN,
    companyAttr: 'company_name',
    messageAttr: 'inquiry',
    fetch: fakeFetch(cap),
  });
  await sink.submit(LEAD);
  const values = JSON.parse(cap.opts.body).data.values;
  assert.equal(values.email_addresses[0].email_address, 'ada@example.com');
  assert.equal(values.name[0].full_name, 'Ada Lovelace');
  assert.equal(values.name[0].first_name, 'Ada');
  assert.equal(values.name[0].last_name, 'Lovelace');
  assert.equal(values.company_name, 'Analytical Engines');
  assert.equal(values.inquiry, 'Rolling out agents org-wide.');
});

test('throws sink_failed on a non-2xx response, and the token never appears in the error', async () => {
  const cap = {};
  const sink = createAttioSink({
    token: TOKEN,
    companyAttr: 'company_name',
    messageAttr: 'inquiry',
    fetch: fakeFetch(cap, { status: 400 }),
  });
  await assert.rejects(
    () => sink.submit(LEAD),
    (err) => {
      assert.equal(err.code, 'sink_failed');
      assert.ok(!String(err.message).includes(TOKEN), 'token must not appear in error message');
      assert.ok(!String(err.stack || '').includes(TOKEN), 'token must not appear in stack');
      return true;
    },
  );
});
