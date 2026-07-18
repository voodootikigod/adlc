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

// Heuristic evidence: scope globs already resolve. Indistinguishable from an
// ACTIVE ticket whose work touches existing paths, so it must never be swept
// into a bulk-completion instruction.
const DRIFT = [
  { id: 'T9', reason: 'inferred: all 6 declared scope glob(s) resolve to tracked files', rails: ['packages/ticket-sync/lib/schema.mjs'], blocker: 'rails-freeze' },
  { id: 'T42', reason: 'inferred: all 3 declared scope glob(s) resolve to tracked files', rails: ['packages/core/**'], blocker: 'rails-freeze' },
];

// Explicit evidence: the ticket itself asserts it is finished.
const DONE = [
  { id: 'T7', reason: 'explicit status: "done"', rails: ['packages/core/**'], blocker: 'rails-freeze' },
];

// Asserting on /ticket-prune --ceremony/ is NOT sufficient: the body also
// MENTIONS the command in prose explaining why it is being withheld. A substring
// check would then read "the command is offered" from text saying the opposite.
// This looks for the runnable line inside the fenced block.
const RUNNABLE = 'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --write --base-ref origin/main';
const offersCommand = (body) => body.split('\n').some((l) => l.trim() === RUNNABLE);

// ---- rendering ----

test('body names every drifting ticket and its frozen rails', () => {
  const body = renderIssueBody(DRIFT);
  for (const t of DRIFT) {
    assert.match(body, new RegExp(t.id));
    for (const rail of t.rails) assert.ok(body.includes(rail), `missing rail ${rail}`);
  }
});

test('body carries the exact ceremony command for EXPLICITLY done tickets', () => {
  const body = renderIssueBody(DONE);
  assert.ok(offersCommand(body), 'explicit-status drift should offer the runnable command');
  assert.match(body, /## Confirmed shipped/);
});

// The core safety property. `inferred:` means "every scope glob already resolves
// to a tracked file", which is exactly what an ACTIVE ticket looks like when its
// work touches existing paths. Completing such a ticket expires its rails
// mid-build, and an instruction in a bot-filed issue carries more apparent
// authority than a CLI someone chose to run.
test('heuristic-only drift is NEVER given the bulk completion command', () => {
  const body = renderIssueBody(DRIFT);
  assert.ok(!offersCommand(body), 'heuristic-only drift must not offer the command');
  assert.match(body, /## Needs confirmation before completing \(2\)/);
  assert.match(body, /cannot distinguish "finished" from "in progress on existing files"/);
});

test('the ACTIVE ticket is quarantined out of every completion instruction', () => {
  const body = renderIssueBody([...DONE, ...DRIFT], { activeTicketId: 'T42' });
  assert.match(body, /## ⚠ Currently active — do NOT complete \(1\)/);
  const activeIdx = body.indexOf('Currently active');
  const confirmedIdx = body.indexOf('## Confirmed shipped');
  assert.ok(activeIdx < confirmedIdx, 'the warning must precede any command');
  // T42 must not appear under the clearable heading.
  const confirmedSection = body.slice(confirmedIdx, body.indexOf('## Needs confirmation'));
  assert.doesNotMatch(confirmedSection, /T42/);
  assert.match(body, /expire its rails while it is still being built/);
});

test('an explicitly-done ticket that is ALSO active stays quarantined', () => {
  const body = renderIssueBody(DONE, { activeTicketId: 'T7' });
  assert.match(body, /## ⚠ Currently active/);
  assert.doesNotMatch(body, /ticket-prune --ceremony/);
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
  const body = renderIssueBody(DONE);
  assert.match(body, /marked `completed: true`/);
  assert.doesNotMatch(body, /marked `completed: false`/);
});

// ---- the bulk command's blast radius ----
//
// `ticket-prune --ceremony` has NO per-ticket filter: it completes every stale
// rail-freezing ticket. Splitting the report into sections partitions the
// DISPLAY only. Rendering the command next to an "excluded" entry would be a
// false safety claim an operator acts on — completing in-flight work and
// expiring its rails. So the command appears only when EVERY rail-freezing entry
// is confirmed done.

const CONFIRMED = { id: 'T7', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' };
const HEURISTIC = { id: 'T9', reason: 'inferred: scope resolves', rails: ['b/**'], blocker: 'rails-freeze' };

test('confirmed alongside UNCONFIRMED withholds the command', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC]);
  assert.ok(!offersCommand(body), 'command would also complete the unconfirmed ticket');
  assert.match(body, /No bulk command is offered on this run/);
  assert.match(body, /no per-ticket filter/);
});

test('confirmed alongside an ACTIVE ticket withholds the command', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC], { activeTicketId: 'T9' });
  assert.ok(!offersCommand(body), 'command would also complete the in-flight ticket');
  assert.match(body, /## ⚠ Currently active/);
});

// The active section must not promise an exclusion the command cannot deliver.
test('the active-ticket warning never claims the command excludes it', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC], { activeTicketId: 'T9' });
  assert.doesNotMatch(body, /excluded from the command below/);
});

test('confirmed plus a manual-decision entry still offers the command', () => {
  // preexisting-completed-field entries are not rails-freeze, so --ceremony
  // leaves them alone; withholding here would be needlessly restrictive.
  const manual = { id: 'T8', reason: 'explicit status: "done"', rails: [], blocker: 'preexisting-completed-field' };
  assert.ok(offersCommand(renderIssueBody([CONFIRMED, manual])));
});

test('an unresolvable pointer withholds the command even when all are confirmed', () => {
  assert.ok(!offersCommand(renderIssueBody([CONFIRMED], { activeTicketUnknown: true })));
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

// The marker is public — it renders into the issue body and is trivially copied.
// Treating "body contains the marker" as authority would let anyone who can open
// an issue have it labeled, rewritten, or closed by a job holding issues:write.
test('an authors filter rejects a forged marker from another author', () => {
  const issues = [{ number: 9, body: `${MARKER} forged`, author: { login: 'untrusted-user' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['github-actions[bot]'] }), null);
  // Without the filter (the labeled fast path) the same issue is still matched —
  // there, applying the label was itself the authorization.
  assert.equal(selectTrackingIssue(issues)?.number, 9);
});

test('an authors filter accepts the managed author', () => {
  const issues = [{ number: 9, body: `${MARKER} real`, author: { login: 'github-actions[bot]' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['github-actions[bot]'] }).number, 9);
});

// Guessing between two marked issues risks overwriting or closing the wrong one,
// and both are destructive under issues:write.
test('two marked issues throw rather than picking one', () => {
  const two = [
    { number: 1, body: `${MARKER} a`, author: { login: 'github-actions[bot]' } },
    { number: 2, body: `${MARKER} b`, author: { login: 'github-actions[bot]' } },
  ];
  assert.throws(() => selectTrackingIssue(two), /ambiguous tracking issue/);
  assert.throws(() => selectTrackingIssue(two, { authors: ['github-actions[bot]'] }), /ambiguous/);
});

test('ambiguity is judged AFTER the author filter (one real + one forged is fine)', () => {
  const mixed = [
    { number: 1, body: `${MARKER} real`, author: { login: 'github-actions[bot]' } },
    { number: 2, body: `${MARKER} forged`, author: { login: 'untrusted-user' } },
  ];
  assert.equal(selectTrackingIssue(mixed, { authors: ['github-actions[bot]'] }).number, 1);
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
  { id: 'T1', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' },
  { id: 'T2', reason: 'explicit status: "done"', rails: [], blocker: 'preexisting-completed-field' },
];

test('body separates the two blockers into their own sections', () => {
  const body = renderIssueBody(MIXED);
  assert.match(body, /## Confirmed shipped — clearable by the ceremony \(1\)/); // rails-freeze
  assert.match(body, /## Needs a manual decision \(1\)/);                       // preexisting-completed-field
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

// Evidence handling is an ALLOW-LIST: anything that is not an explicit
// done-status — inferred, absent, malformed, or a reason string that gets
// renamed upstream — must land in "needs confirmation". Failing open here would
// promote a ticket into the rail-expiring command on evidence nobody verified.
test('unknown or missing evidence falls back to needs-confirmation, not clearable', () => {
  for (const reason of [undefined, '', 'r', 'some future reason string', null]) {
    const body = renderIssueBody([{ id: 'TX', reason, rails: ['a/**'], blocker: 'rails-freeze' }]);
    assert.doesNotMatch(body, /ticket-prune --ceremony/, `reason ${JSON.stringify(reason)} must not be clearable`);
    assert.match(body, /## Needs confirmation before completing \(1\)/);
  }
});

// resolveActiveTicketId returns a RESULT and never throws; a malformed or
// conflicting pointer is ok:false (#196's fail-closed contract). When it cannot
// be resolved we do not know which ticket is in flight, so nothing may be
// advertised as safe to bulk-complete — not even explicitly-done entries.
test('an unresolvable active-ticket pointer suppresses the bulk command entirely', () => {
  const body = renderIssueBody(DONE, { activeTicketUnknown: true });
  assert.doesNotMatch(body, /ticket-prune --ceremony/);
  assert.doesNotMatch(body, /## Confirmed shipped/);
  assert.match(body, /## Needs confirmation before completing \(1\)/);
  assert.match(body, /active-ticket pointer could not be resolved/);
});

test('decideAction threads the unknown-pointer state into the body', () => {
  const d = decideAction({ drift: DONE, existingIssue: null, activeTicketUnknown: true });
  assert.equal(d.action, 'open');
  assert.doesNotMatch(d.body, /ticket-prune --ceremony/);
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
