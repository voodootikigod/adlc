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
// No `--write`: that flag also tombstones rails-less stale tickets, which never
// appear in this report, so the command would write outside the set it shows.
// Pinned literally here so reintroducing the flag fails this suite too, not only
// the end-to-end blast-radius test.
const RUNNABLE = 'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --base-ref origin/main';
const offersCommand = (body) => body.split('\n').some((l) => l.trim() === RUNNABLE);

// The report documents the ceremony as a PROCEDURE WITH PRECONDITIONS. It never
// certifies it as safe, because it cannot: it renders a snapshot at commit A
// while the command recomputes its own target set whenever the operator runs it,
// and `.adlc/current-ticket.json` is gitignored so a CI checkout can never see
// whether anything is in flight. These assert the report keeps saying so.
const CERTIFICATION_CLAIMS = [
  /safe to run as-is/,
  /excluded from the command/,
  /no bulk command is offered/,
];
const makesNoSafetyClaim = (body) => CERTIFICATION_CLAIMS.every((re) => !re.test(body));

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
  assert.ok(offersCommand(body), 'the procedure documents the runnable command');
  assert.match(body, /## Explicitly done/);
});

// The core safety property. `inferred:` means "every scope glob already resolves
// to a tracked file", which is exactly what an ACTIVE ticket looks like when its
// work touches existing paths. Completing such a ticket expires its rails
// mid-build, and an instruction in a bot-filed issue carries more apparent
// authority than a CLI someone chose to run.
test('heuristic-only drift is sorted as unconfirmed and never certified', () => {
  const body = renderIssueBody(DRIFT);
  assert.match(body, /## Needs confirmation before completing \(2\)/);
  assert.match(body, /cannot distinguish "finished" from "in progress on existing files"/);
  assert.ok(makesNoSafetyClaim(body));
});

test('the ACTIVE ticket is listed first, under its own warning', () => {
  const body = renderIssueBody([...DONE, ...DRIFT], { activeTicketId: 'T42' });
  assert.match(body, /## ⚠ Currently active — do NOT complete \(1\)/);
  const activeIdx = body.indexOf('Currently active');
  const doneIdx = body.indexOf('## Explicitly done');
  assert.ok(activeIdx < doneIdx, 'the warning must precede the rest of the report');
  // The active ticket is not double-listed under the done heading.
  const doneSection = body.slice(doneIdx, body.indexOf('## Needs confirmation'));
  assert.doesNotMatch(doneSection, /T42/);
  assert.match(body, /expire its rails while it is still being built/);
  assert.ok(makesNoSafetyClaim(body));
});

test('an explicitly-done ticket that is ALSO active is flagged, not silently cleared', () => {
  const body = renderIssueBody(DONE, { activeTicketId: 'T7' });
  assert.match(body, /## ⚠ Currently active/);
  // It must NOT claim the command skips it — the command has no per-ticket filter.
  assert.match(body, /including this one/);
  assert.ok(makesNoSafetyClaim(body));
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

test('mixed confirmed/unconfirmed states the blast radius rather than certifying', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC]);
  assert.match(body, /no per-ticket filter/);
  assert.ok(makesNoSafetyClaim(body));
});

test('an ACTIVE ticket is surfaced with an explicit do-not-complete warning', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC], { activeTicketId: 'T9' });
  assert.match(body, /## ⚠ Currently active/);
  assert.match(body, /expire its rails while it is still being built/);
  assert.ok(makesNoSafetyClaim(body));
});

// The active section must not promise an exclusion the command cannot deliver.
test('the active-ticket warning never claims the command excludes it', () => {
  const body = renderIssueBody([CONFIRMED, HEURISTIC], { activeTicketId: 'T9' });
  assert.doesNotMatch(body, /excluded from the command below/);
});

test('confirmed plus a manual-decision entry still renders the procedure', () => {
  const manual = { id: 'T8', reason: 'explicit status: "done"', rails: [], blocker: 'preexisting-completed-field' };
  const body = renderIssueBody([CONFIRMED, manual]);
  assert.ok(offersCommand(body));
  assert.ok(makesNoSafetyClaim(body));
});

test('an unresolvable pointer sorts everything as unconfirmed', () => {
  const body = renderIssueBody([CONFIRMED], { activeTicketUnknown: true });
  assert.match(body, /## Needs confirmation before completing \(1\)/);
  assert.doesNotMatch(body, /## Explicitly done/);
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
  assert.match(body, /## Explicitly done \(1\)/);                        // rails-freeze
  assert.match(body, /## Needs a manual decision \(1\)/);                       // preexisting-completed-field
});

// The advertised command completes ONLY rails-freeze entries; --ceremony refuses
// to overwrite a deliberately-set `completed` value. Promising it clears
// everything would be instructions that never stop being wrong, on an issue that
// can never close.
test('manual-decision entries are documented as NOT cleared by the ceremony', () => {
  const body = renderIssueBody(MIXED);
  const manualIdx = body.indexOf('## Needs a manual decision');
  assert.ok(manualIdx !== -1);
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
    assert.doesNotMatch(body, /## Explicitly done/, `reason ${JSON.stringify(reason)} must not read as confirmed`);
    assert.match(body, /## Needs confirmation before completing \(1\)/);
  }
});

// resolveActiveTicketId returns a RESULT and never throws; a malformed or
// conflicting pointer is ok:false (#196's fail-closed contract). When it cannot
// be resolved we do not know which ticket is in flight, so nothing may be
// advertised as safe to bulk-complete — not even explicitly-done entries.
test('an unresolvable active-ticket pointer downgrades every entry to unconfirmed', () => {
  const body = renderIssueBody(DONE, { activeTicketUnknown: true });
  assert.doesNotMatch(body, /## Explicitly done/);
  assert.match(body, /## Needs confirmation before completing \(1\)/);
  assert.match(body, /active-ticket pointer could not be resolved/);
});

test('decideAction threads the unknown-pointer state into the body', () => {
  const d = decideAction({ drift: DONE, existingIssue: null, activeTicketUnknown: true });
  assert.equal(d.action, 'open');
  assert.doesNotMatch(d.body, /## Explicitly done/);
});

// The procedure section is the one place the command appears. It must always
// disclose what CI cannot see, and always lead with the dry run.
test('the procedure discloses the CI blind spots and leads with a dry run', () => {
  const body = renderIssueBody(DRIFT);
  assert.ok(offersCommand(body), 'the procedure documents the command');
  assert.match(body, /cannot tell you it is safe to run the command/);
  assert.match(body, /gitignored/);                       // the place blind spot
  assert.match(body, /re-computes its own target set/);   // the time blind spot
  const dryIdx = body.indexOf('# dry run');
  assert.ok(dryIdx !== -1 && dryIdx < body.indexOf(RUNNABLE), 'dry run must come first');
  assert.ok(makesNoSafetyClaim(body));
});

test('a drift set with nothing rail-freezing renders no procedure at all', () => {
  const manualOnly = [{ id: 'T8', reason: 'explicit status: "done"', rails: [], blocker: 'preexisting-completed-field' }];
  const body = renderIssueBody(manualOnly);
  assert.doesNotMatch(body, /## Clearing these/);
  assert.ok(!offersCommand(body));
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
