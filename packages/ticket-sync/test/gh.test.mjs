import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghJson } from '../lib/gh.mjs';
import { assertReadProvider } from '../lib/provider.mjs';

// A fake runner — the seam that keeps every layer above gh.mjs offline.
const fakeRunner = (result) => async (args) => ({ args, ...result });

test('ghJson parses JSON stdout on success', async () => {
  const r = await ghJson(fakeRunner({ ok: true, code: 0, stdout: '[{"number":1}]', stderr: '', error: null }), ['issue', 'list']);
  assert.ok(r.ok);
  assert.equal(r.data[0].number, 1);
});

test('ghJson surfaces gh-not-found', async () => {
  const r = await ghJson(fakeRunner({ ok: false, code: 1, stdout: '', stderr: '', error: 'gh-not-found' }), ['x']);
  assert.ok(!r.ok);
  assert.equal(r.error, 'gh-not-found');
});

test('ghJson reports non-JSON output as an error (does not throw)', async () => {
  const r = await ghJson(fakeRunner({ ok: true, code: 0, stdout: 'not json', stderr: '', error: null }), ['x']);
  assert.ok(!r.ok);
  assert.match(r.error, /non-JSON/);
});

test('assertReadProvider requires listIssues', () => {
  assert.throws(() => assertReadProvider({}), /listIssues/);
  assert.doesNotThrow(() => assertReadProvider({ listIssues() {} }));
});
