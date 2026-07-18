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

const CEREMONY_CMD =
  'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --write --base-ref origin/main';

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
      const railList = rails.length ? rails.map((r) => `\`${r}\``).join(', ') : '_(none)_';
      return [
        `### ${t?.id ?? '(unknown id)'}`,
        '',
        `- **Blocker:** \`${t?.blocker ?? 'unknown'}\``,
        `- **Frozen rails:** ${railList}`,
        `- **Detected because:** ${t?.reason ?? '(no reason recorded)'}`,
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

  // EVIDENCE STRENGTH decides what may be advertised as a bulk action.
  //
  // classifyTicket() reports two very different things under one `stale` flag:
  //   explicit status: "done"  -> the ticket SAYS it is finished. Authoritative.
  //   inferred: all N scope glob(s) resolve to tracked files on the base ref
  //                            -> a HEURISTIC. It is also exactly what an ACTIVE
  //                               ticket looks like when its work touches paths
  //                               that already exist, which is the common case.
  //
  // Completing a ticket expires its rails. Advertising a one-line bulk command
  // over heuristic evidence therefore invites an operator to disable rail
  // protection on work that is still in flight — and an issue filed by a bot
  // carries more apparent authority than a CLI someone chose to run.
  //
  // So this is an ALLOW-LIST: only an explicit done-status earns the bulk
  // command. Inferred, missing, malformed, or unrecognized evidence all fall to
  // "needs confirmation". Keying off `inferred:` instead would mean a renamed
  // reason string, or an absent one, silently promotes a ticket into the
  // rail-expiring instruction — failing OPEN on the one decision here that can
  // destroy in-flight protection.
  //
  // And if the active-ticket pointer could not be resolved at all, nothing is
  // clearable: we cannot say which ticket is in flight, so we cannot say which
  // one the command would wrongly complete.
  const isConfirmedDone = (t) =>
    !activeTicketUnknown && String(t?.reason ?? '').startsWith('explicit status:');
  const isActive = (t) => activeTicketId != null && t?.id === activeTicketId;

  const activeEntries = railsFreeze.filter(isActive);
  const confirmed = railsFreeze.filter((t) => !isActive(t) && isConfirmedDone(t));
  const unconfirmed = railsFreeze.filter((t) => !isActive(t) && !isConfirmedDone(t));

  // The command may be shown ONLY when every rail-freezing entry is confirmed.
  //
  // `ticket-prune --ceremony` has no per-ticket filter: it completes EVERY stale
  // rail-freezing ticket it finds. Splitting the report into sections therefore
  // partitions the DISPLAY, not the command's effect. Rendering it beside an
  // active or unconfirmed entry — under a heading saying that entry is excluded —
  // would be a false safety claim an operator acts on, completing in-flight work
  // and expiring its rails. Sectioning is presentation; this is the safety gate.
  const bulkIsSafe = confirmed.length > 0 && activeEntries.length === 0 && unconfirmed.length === 0;

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
      'Because the ceremony command has no per-ticket filter — it completes every',
      'stale rail-freezing ticket it finds — no bulk command is offered while this',
      'ticket is listed. If it genuinely is finished, clear the active-ticket',
      'pointer first, then re-run this check.',
      '',
      ...rowsFor(activeEntries),
      ''
    );
  }

  if (confirmed.length) {
    sections.push(
      `## Confirmed shipped — clearable by the ceremony (${confirmed.length})`,
      '',
      'These carry an explicit done-shaped `status`, so the ticket itself asserts it',
      'is finished. Under T36 rails expire only once a ticket is marked `completed: true`,',
      'so until then they keep freezing paths for unrelated work.',
      '',
      '`rails-guard-ci.assertBaseTicketContractsPreserved` denies field changes to',
      'existing base tickets, so an ordinary PR cannot complete a railed ticket. This',
      'is reserved for the protected-base admin ceremony.',
      '',
      ...(bulkIsSafe
        ? ['Every rail-freezing entry below is confirmed done, so the bulk command is',
           'safe to run as-is:',
           '',
           '```bash',
           CEREMONY_CMD,
           '```',
           '',
           'Review the diff before pushing.']
        : ['> **No bulk command is offered on this run.** `ticket-prune --ceremony` has',
           '> no per-ticket filter — it completes *every* stale rail-freezing ticket,',
           '> which would include the entries listed in the other sections. Resolve',
           '> those first (or complete these individually via the protected-base path),',
           '> then re-run this check.']),
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
      'these is not finished, give it an explicit status (or complete the others',
      'individually) rather than running the bulk command.',
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

  return [
    MARKER,
    '',
    'Shipped tickets whose declared scope resolves to tracked files on `main`, but',
    'which are still active in the ticket store.',
    '',
    ...sections,
    '---',
    '',
    '_Maintained automatically by `.github/workflows/ceremony-drift.yml`. This issue',
    'closes on its own once the set is empty; edits to the body are overwritten._',
  ].join('\n');
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
  if (authors) candidates = candidates.filter((i) => authors.includes(i?.author?.login));

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
  execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 10 * 1024 * 1024 });

/** Idempotent; --force makes re-creating an existing label a no-op. */
function ensureLabel() {
  gh(['label', 'create', LABEL, '--force', '--color', 'B60205',
    '--description', 'Shipped tickets whose rails have not expired (managed by ceremony-drift.yml)']);
}

// Sanity bound for the unlabeled sweep. Far above any plausible open-issue count
// for this repo; if it is ever hit, the labeled lookup above is the load-bearing
// path anyway.
const SWEEP_LIMIT = 1000;

// Applying the label requires write access, so a labeled issue is already an
// authorization signal. The unlabeled sweep has no such signal and must verify
// authorship instead — see selectTrackingIssue. Overridable for tests and for
// repos whose automation runs under a different identity.
const MANAGED_AUTHORS = (process.env.ADLC_DRIFT_AUTHORS ?? 'github-actions[bot]')
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
  const unlabeled = selectTrackingIssue(
    JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', String(SWEEP_LIMIT),
      '--json', ISSUE_FIELDS])),
    { authors: MANAGED_AUTHORS }
  );
  if (!unlabeled) return null;

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
