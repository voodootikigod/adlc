import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponseHeaders, readBoundedBody, MAX_BODY_BYTES } from '../lib/capture.mjs';
import { diffJson, diffRoute } from '../lib/diff.mjs';

test('normalizeResponseHeaders lowercases, sorts, and omits volatile headers', () => {
  const headers = new Headers({
    'X-Custom': '  val  ',
    'Cache-Control': 'no-store',
    Date: 'Mon, 01 Jan 2026 00:00:00 GMT',
    ETag: '"abc"',
    'X-Request-Id': 'req-123',
    'Set-Cookie': 'session=secret; HttpOnly',
  });
  const norm = normalizeResponseHeaders(headers);
  assert.deepEqual(Object.keys(norm), ['cache-control', 'x-custom']);
  assert.equal(Object.hasOwn(norm, 'set-cookie'), false);
  assert.equal(norm['x-custom'], 'val');
  assert.equal(norm['cache-control'], 'no-store');
});

test('readBoundedBody caps huge bodies cleanly and marks truncated', async () => {
  const res = new Response('abcdefghij', { headers: { 'content-type': 'text/plain' } });
  const capped = await readBoundedBody(res, 4);
  assert.equal(capped.text, 'abcd');
  assert.equal(capped.truncated, true);
  assert.ok(capped.bytes >= 4);

  const smallRes = new Response('hi');
  const full = await readBoundedBody(smallRes);
  assert.equal(full.text, 'hi');
  assert.equal(full.truncated, false);
  assert.equal(full.bytes, 2);
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
  const overDefault = await readBoundedBody(new Response('a'.repeat(MAX_BODY_BYTES + 16)));
  assert.equal(overDefault.truncated, true);
  assert.equal(overDefault.text.length, MAX_BODY_BYTES);
});

test('diffJson compares full shared array prefix beyond first divergent index and diffRoute diffs headers', () => {
  const res = diffJson([1, 2, 3, 4], [1, 20, 3, 40]);
  assert.equal(res.total, 2);
  assert.deepEqual(res.changes.map((c) => c.path), ['[1]', '[3]']);

  const routeDiff = diffRoute(
    { method: 'GET', path: '/a', status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-cache' }, body: { ok: true } },
    { method: 'GET', path: '/a', status: 200, contentType: 'application/json', headers: { 'cache-control': 'public' }, body: { ok: true } },
  );
  assert.ok(routeDiff);
  assert.equal(routeDiff.diffs.length, 1);
  assert.equal(routeDiff.diffs[0].field, 'headers');

  // Legacy snapshot lacking headers on one side must not crash or report spurious header diffs
  const legacyNoDiff = diffRoute(
    { method: 'GET', path: '/a', status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-cache' }, body: { ok: true } },
    { method: 'GET', path: '/a', status: 200, contentType: 'application/json', body: { ok: true } },
  );
  assert.equal(legacyNoDiff, null);
});
