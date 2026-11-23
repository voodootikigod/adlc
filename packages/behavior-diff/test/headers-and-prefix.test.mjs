import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponseHeaders, readBoundedBody } from '../lib/capture.mjs';
import { diffJson, diffRoute } from '../lib/diff.mjs';

test('normalizeResponseHeaders lowercases, sorts, and omits volatile headers', () => {
  const headers = new Headers({
    'X-Custom': '  val  ',
    'Cache-Control': 'no-store',
    Date: 'Mon, 01 Jan 2026 00:00:00 GMT',
    ETag: '"abc"',
    'X-Request-Id': 'req-123',
  });
  const norm = normalizeResponseHeaders(headers);
  assert.deepEqual(Object.keys(norm), ['cache-control', 'x-custom']);
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
  const full = await readBoundedBody(smallRes, 100);
  assert.equal(full.text, 'hi');
  assert.equal(full.truncated, false);
  assert.equal(full.bytes, 2);
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
});
