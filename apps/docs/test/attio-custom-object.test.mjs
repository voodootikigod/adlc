import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttioSink } from '../lib/contact/attio-sink.mjs';
import { selectSink } from '../lib/contact/sinks.mjs';

// The AttioSink writing to a custom object (enterprise_inquiries) with flat text
// attributes, and selectSink defaulting the deployed path to that object.

const LEAD = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  message: 'Rolling out agents org-wide.',
};

function capture({ status = 200 } = {}) {
  const cap = {};
  const fetch = async (url, opts) => {
    cap.url = url;
    cap.opts = opts;
    return { ok: status >= 200 && status < 300, status, async json() { return {}; }, async text() { return ''; } };
  };
  return { cap, fetch };
}

test('custom object: PUTs flat text values matched on the email attribute', async () => {
  const { cap, fetch } = capture();
  const sink = createAttioSink({ token: 'tok', object: 'enterprise_inquiries', fetch });
  const res = await sink.submit(LEAD);
  assert.equal(res.ok, true);
  assert.match(cap.url, /\/v2\/objects\/enterprise_inquiries\/records\?matching_attribute=email$/);
  assert.equal(cap.opts.method, 'PUT');
  const values = JSON.parse(cap.opts.body).data.values;
  // Flat string values — not the structured People shape.
  assert.equal(values.name, 'Ada Lovelace');
  assert.equal(values.email, 'ada@example.com');
  assert.equal(values.company, 'Analytical Engines');
  assert.equal(values.message, 'Rolling out agents org-wide.');
  assert.equal(values.source, 'Enterprise contact form');
  assert.equal(values.email_addresses, undefined, 'must not use the People email shape');
});

test('custom object: omits company when the lead has none', async () => {
  const { cap, fetch } = capture();
  const sink = createAttioSink({ token: 'tok', object: 'enterprise_inquiries', fetch });
  await sink.submit({ ...LEAD, company: '' });
  const values = JSON.parse(cap.opts.body).data.values;
  assert.equal('company' in values, false);
});

test('custom object: honors overridden attribute slugs and match attribute', async () => {
  const { cap, fetch } = capture();
  const sink = createAttioSink({
    token: 'tok',
    object: 'leads',
    matchAttr: 'work_email',
    emailAttr: 'work_email',
    messageAttr: 'notes',
    fetch,
  });
  await sink.submit(LEAD);
  assert.match(cap.url, /\/v2\/objects\/leads\/records\?matching_attribute=work_email$/);
  const values = JSON.parse(cap.opts.body).data.values;
  assert.equal(values.work_email, 'ada@example.com');
  assert.equal(values.notes, 'Rolling out agents org-wide.');
});

test('People mode is preserved (structured values, email_addresses match)', async () => {
  const { cap, fetch } = capture();
  const sink = createAttioSink({ token: 'tok', object: 'people', fetch });
  await sink.submit(LEAD);
  assert.match(cap.url, /\/v2\/objects\/people\/records\?matching_attribute=email_addresses$/);
  const values = JSON.parse(cap.opts.body).data.values;
  assert.equal(values.name[0].full_name, 'Ada Lovelace');
  assert.equal(values.email_addresses[0].email_address, 'ada@example.com');
});

test('selectSink defaults the deployed Attio path to the custom object', async () => {
  const { cap, fetch } = capture();
  const sink = selectSink({ CONTACT_SINK: 'attio', ATTIO_API_TOKEN: 'tok' }, { fetch });
  await sink.submit(LEAD);
  assert.match(cap.url, /\/v2\/objects\/enterprise_inquiries\/records\?matching_attribute=email$/);
});

test('selectSink honors ATTIO_OBJECT=people override', async () => {
  const { cap, fetch } = capture();
  const sink = selectSink({ CONTACT_SINK: 'attio', ATTIO_API_TOKEN: 'tok', ATTIO_OBJECT: 'people' }, { fetch });
  await sink.submit(LEAD);
  assert.match(cap.url, /\/v2\/objects\/people\/records/);
});
