import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus, renderComment, STATUS_COMMENT_MARKER } from '../lib/status-render.mjs';

const LABELS = { 'p5-pass': 'adlc:passed', 'p5-fail': 'adlc:failed', wip: 'adlc:in-progress' };

test('renderStatus picks the one label and removes the others (mutually exclusive)', () => {
  const r = renderStatus('p5-pass', { statusLabels: LABELS });
  assert.deepEqual(r.add, ['adlc:passed']);
  assert.deepEqual(r.remove.sort(), ['adlc:failed', 'adlc:in-progress']);
});

test('null status → no label added, all status labels removed', () => {
  const r = renderStatus(null, { statusLabels: LABELS });
  assert.deepEqual(r.add, []);
  assert.deepEqual(r.remove.sort(), ['adlc:failed', 'adlc:in-progress', 'adlc:passed']);
});

test('a status with no configured label adds nothing', () => {
  assert.deepEqual(renderStatus('wip', { statusLabels: { 'p5-pass': 'adlc:passed' } }).add, []);
});

test('comment is anchored by the marker and timestamp-free (idempotent)', () => {
  const a = renderComment('p5-pass');
  const b = renderComment('p5-pass');
  assert.equal(a, b, 'same status → byte-identical comment');
  assert.ok(a.startsWith(STATUS_COMMENT_MARKER));
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(a), 'no ISO timestamp in the comment');
});

test('null status renders a "no evidence" comment', () => {
  assert.match(renderComment(null), /no gate evidence/);
});
