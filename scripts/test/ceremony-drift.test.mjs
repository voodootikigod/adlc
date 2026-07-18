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
import {
  renderIssueBody,
  renderIssueTitle,
  decideAction,
  selectTrackingIssue,
  MARKER,
} from '../ceremony-drift.mjs';

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

// The marker is only useful if GitHub actually hides it. A malformed marker
// still "matches" itself — every test comparing against the constant passes —
// while rendering as visible junk at the top of the issue.
test('marker is a well-formed HTML comment (renders invisibly)', () => {
  assert.match(MARKER, /^<!--.*-->$/);
});

// This line is the operator-facing statement of the T36 rule. Inverted, it is
// not a typo — it is wrong instructions in the one place someone reads them.
test('body states the completion rule correctly', () => {
  const body = renderIssueBody(DRIFT);
  assert.match(body, /marked `completed: true`/);
  assert.doesNotMatch(body, /marked `completed: false`/);
});

// ---- title ----

test('title is singular for one ticket and plural otherwise', () => {
  assert.match(renderIssueTitle([{ id: "T1" }]), /1 shipped ticket awaiting/);
  assert.match(renderIssueTitle([{ id: "T1" }, { id: "T2" }]), /2 shipped tickets awaiting/);
  assert.match(renderIssueTitle([]), /0 shipped tickets awaiting/);
});

// ---- issue discovery ----
//
// If this ever stops matching an issue that exists, the job opens a DUPLICATE on
// every run — the exact churn idempotence exists to prevent. It lived in the gh
// I/O shell and was untested until mutation testing surfaced it.

test('selectTrackingIssue finds the issue carrying the marker', () => {
  const found = selectTrackingIssue([
    { number: 1, body: 'unrelated issue' },
    { number: 2, body: `${MARKER}\n\nthe tracking issue` },
  ]);
  assert.equal(found.number, 2);
});

test('selectTrackingIssue returns null when no issue carries the marker', () => {
  assert.equal(selectTrackingIssue([{ number: 1, body: 'unrelated' }]), null);
  assert.equal(selectTrackingIssue([]), null);
  assert.equal(selectTrackingIssue(null), null);
});

test('selectTrackingIssue tolerates missing/non-string bodies without throwing', () => {
  const found = selectTrackingIssue([
    { number: 1 },
    { number: 2, body: null },
    { number: 3, body: 42 },
    null,
    { number: 4, body: `${MARKER} here` },
  ]);
  assert.equal(found.number, 4);
});

// Ordering must not depend on the order runTicketPrune happens to emit, or the
// body churns between runs and every tick looks like new drift.
test('body is stable regardless of input order (idempotence depends on this)', () => {
  assert.equal(renderIssueBody(DRIFT), renderIssueBody([...DRIFT].reverse()));
});

// Fixture note: a 'preexisting-completed-field' entry ALWAYS has `rails: []` —
// ceremonyDisposition() checks non-empty rails first and classifies those as
// 'rails-freeze'. An earlier version of this test gave it rails, asserting
// against a state the producer cannot emit.
const MIXED = [
  { id: 'T1', reason: 'r', rails: ['a/**'], blocker: 'rails-freeze' },
  { id: 'T2', reason: 'r', rails: [], blocker: 'preexisting-completed-field' },
];

test('body separates the two blockers into their own sections', () => {
  const body = renderIssueBody(MIXED);
  assert.match(body, /## Clearable by the ceremony \(1\)/);
  assert.match(body, /## Needs a manual decision \(1\)/);
});

// The advertised command completes ONLY rails-freeze entries; --ceremony refuses
// to overwrite a deliberately-set `completed` value. Promising it clears
// everything would be instructions that never stop being wrong, on an issue that
// can never close.
test('the ceremony command is not advertised as clearing manual-decision entries', () => {
  const body = renderIssueBody(MIXED);
  const manualIdx = body.indexOf('## Needs a manual decision');
  const cmdIdx = body.indexOf('ticket-prune --ceremony');
  assert.ok(cmdIdx !== -1 && manualIdx !== -1);
  assert.ok(cmdIdx < manualIdx, 'ceremony command must sit in the clearable section, above it');
  assert.match(body.slice(manualIdx), /will \*\*not\*\* clear them/);
});

test('a drift set of only manual-decision entries advertises no ceremony command', () => {
  const body = renderIssueBody([MIXED[1]]);
  assert.doesNotMatch(body, /ticket-prune --ceremony/);
  assert.match(body, /## Needs a manual decision \(1\)/);
});

// 'preexisting-completed-field' entries always have empty rails, so a title
// asserting everything is "freezing rails" would be false whenever one appears.
test('title does not claim rails are frozen', () => {
  assert.doesNotMatch(renderIssueTitle(MIXED), /freezing rails/);
  assert.match(renderIssueTitle(MIXED), /2 shipped tickets awaiting completion/);
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
