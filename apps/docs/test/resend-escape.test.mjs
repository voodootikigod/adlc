import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResendSink } from '../lib/contact/resend-sink.mjs';

// Kills hollow-test survivors on escapeHtml: the email HTML body must escape
// angle brackets and ampersands so a hostile message cannot inject markup.

function captureBody() {
  const cap = {};
  const fetch = async (_url, opts) => {
    cap.body = JSON.parse(opts.body);
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  };
  return { cap, fetch };
}

test('escapes HTML metacharacters in the lead message', async () => {
  const { cap, fetch } = captureBody();
  const sink = createResendSink({ apiKey: 'k', from: 'a@b.com', to: 'c@d.com', fetch });
  await sink.submit({
    name: 'Ada',
    email: 'ada@example.com',
    company: '',
    message: '<script>alert(1)</script> & <b>bold</b>',
  });
  assert.ok(!/<script>/.test(cap.body.html), 'raw <script> must not appear in the html body');
  assert.match(cap.body.html, /&lt;script&gt;/, 'angle brackets escaped');
  assert.match(cap.body.html, /&amp;/, 'ampersand escaped');
});

test('escapes angle brackets in the name too', async () => {
  const { cap, fetch } = captureBody();
  const sink = createResendSink({ apiKey: 'k', from: 'a@b.com', to: 'c@d.com', fetch });
  await sink.submit({ name: '<img src=x>', email: 'a@b.com', company: '', message: 'hi' });
  assert.ok(!/<img src=x>/.test(cap.body.html));
  assert.match(cap.body.html, /&lt;img src=x&gt;/);
});
