// ceremony-drift.test.mjs — the drift reporter's decision logic.
//
// This job runs on a schedule and after every merge to main. Its whole value is
// being a signal someone still trusts months from now, so the decision logic is
// tested directly: it must be IDEMPOTENT (a re-run with unchanged drift must not
// touch the issue) and it must CLOSE the issue when drift clears. A reporter
// that re-posts or re-opens on every tick is one people mute.
//
// Only pure decision/render logic is covered here. The `gh` I/O is a thin shell
// in the script's main(), deliberately kept free of branching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIssueBody, decideAction, MARKER } from '../ceremony-drift.mjs';

const DRIFT = [
  { id: 'T9', reason: 'inferred: all 6 declared scope glob(s) resolve to tracked files', rails: ['packages/ticket-sync/lib/schema.mjs'], blocker: 'rails-freeze' },
  { id: 'T42', reason: 'inferred: all 3 declared scope glob(s) resolve to tracked files', rails: ['packages/core/**'], blocker: 'rails-freeze' },
];

// ---- rendering ----

test('body names every drifting ticket and its frozen rails', () => {
  const body = renderIssueBody(DRIFT);
  for (const t of DRIFT) {
    assert.match(body, new RegExp(t.id));
    for (const rail of t.rails) assert.ok(body.includes(rail), `missing rail ${rail}`);
  }
});

test('body carries the exact ceremony command an operator must run', () => {
  const body = renderIssueBody(DRIFT);
  assert.match(body, /ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --write --base-ref origin\/main/);
});

test('body embeds the discovery marker', () => {
  assert.ok(renderIssueBody(DRIFT).includes(MARKER));
});

// Ordering must not depend on the order runTicketPrune happens to emit, or the
// body churns between runs and every tick looks like new drift.
test('body is stable regardless of input order (idempotence depends on this)', () => {
  assert.equal(renderIssueBody(DRIFT), renderIssueBody([...DRIFT].reverse()));
});

test('body distinguishes the two blocker kinds', () => {
  const mixed = [
    { id: 'T1', reason: 'r', rails: ['a/**'], blocker: 'rails-freeze' },
    { id: 'T2', reason: 'r', rails: ['b/**'], blocker: 'preexisting-completed-field' },
  ];
  const body = renderIssueBody(mixed);
  assert.match(body, /rails-freeze/);
  assert.match(body, /preexisting-completed-field/);
});

// ---- decisions ----

test('drift with no existing issue → open', () => {
  const d = decideAction({ drift: DRIFT, existingIssue: null });
  assert.equal(d.action, 'open');
  assert.ok(d.title.length > 0);
  assert.ok(d.body.includes(MARKER));
});

test('drift with an identical open issue → noop (no re-post churn)', () => {
  const first = decideAction({ drift: DRIFT, existingIssue: null });
  const again = decideAction({
    drift: DRIFT,
    existingIssue: { number: 7, title: first.title, body: first.body },
  });
  assert.equal(again.action, 'noop');
});

test('drift that CHANGED vs the open issue → update', () => {
  const first = decideAction({ drift: DRIFT, existingIssue: null });
  const grown = decideAction({
    drift: [...DRIFT, { id: 'T99', reason: 'r', rails: ['z/**'], blocker: 'rails-freeze' }],
    existingIssue: { number: 7, title: first.title, body: first.body },
  });
  assert.equal(grown.action, 'update');
  assert.equal(grown.number, 7);
  assert.match(grown.body, /T99/);
});

test('a title-only change still updates', () => {
  const first = decideAction({ drift: DRIFT, existingIssue: null });
  const d = decideAction({
    drift: DRIFT,
    existingIssue: { number: 7, title: 'something stale', body: first.body },
  });
  assert.equal(d.action, 'update');
});

test('drift cleared with an open issue → close', () => {
  const d = decideAction({ drift: [], existingIssue: { number: 7, title: 't', body: 'b' } });
  assert.equal(d.action, 'close');
  assert.equal(d.number, 7);
});

test('no drift and no issue → noop', () => {
  assert.equal(decideAction({ drift: [], existingIssue: null }).action, 'noop');
});

// The reporter must never be the reason a merge or a schedule tick fails: it is
// an issue-management job, not a gate. Callers rely on this to keep exit 0.
test('decideAction never throws on a malformed drift entry', () => {
  const junk = [{ id: 'T1' }, {}, { id: 'T2', rails: null, blocker: undefined }];
  const d = decideAction({ drift: junk, existingIssue: null });
  assert.equal(d.action, 'open');
  assert.match(d.body, /T1/);
});
