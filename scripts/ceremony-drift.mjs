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

// Embedded in the body so the job can identify its own issue even if the label
// is removed by hand, and so a human editing the issue can see it is managed.
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
export function renderIssueBody(needsCeremony) {
  const entries = [...(needsCeremony ?? [])].sort((a, b) =>
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );

  const rows = entries.map((t) => {
    const rails = Array.isArray(t?.rails) ? t.rails : [];
    const railList = rails.length ? rails.map((r) => `\`${r}\``).join(', ') : '_(none recorded)_';
    return [
      `### ${t?.id ?? '(unknown id)'}`,
      '',
      `- **Blocker:** \`${t?.blocker ?? 'unknown'}\``,
      `- **Frozen rails:** ${railList}`,
      `- **Detected because:** ${t?.reason ?? '(no reason recorded)'}`,
    ].join('\n');
  });

  return [
    MARKER,
    '',
    'These tickets have shipped (their declared scope resolves to tracked files on',
    '`main`) but are still active and still freezing rails. Under T36 a ticket\'s',
    'rails expire only when it is marked `completed: true`, so until that happens',
    'these rails keep freezing paths for unrelated future work.',
    '',
    '## Why a PR cannot fix this',
    '',
    '`rails-guard-ci.assertBaseTicketContractsPreserved` denies field changes to',
    'existing base tickets, so an ordinary PR cannot complete a railed ticket. This',
    'is reserved for the protected-base admin ceremony:',
    '',
    '```bash',
    CEREMONY_CMD,
    '```',
    '',
    'Review the diff before pushing — it completes every ticket listed below.',
    '',
    `## Drifting tickets (${entries.length})`,
    '',
    ...rows,
    '',
    '---',
    '',
    '_Maintained automatically by `.github/workflows/ceremony-drift.yml`. This issue',
    'closes on its own once the set is empty; edits to the body are overwritten._',
  ].join('\n');
}

/** Title reflects the count so the drift is legible from a notification alone. */
export function renderIssueTitle(needsCeremony) {
  const n = (needsCeremony ?? []).length;
  return `Ticket ceremony drift: ${n} shipped ticket${n === 1 ? '' : 's'} still freezing rails`;
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
export function selectTrackingIssue(issues) {
  return (issues ?? []).find((i) => typeof i?.body === 'string' && i.body.includes(MARKER)) ?? null;
}

/**
 * Decide what to do with the tracking issue. Pure — no I/O — so the idempotence
 * and close-on-clear contracts are testable without a GitHub token.
 * @param {{drift: object[], existingIssue: {number: number, title: string, body: string} | null}} input
 */
export function decideAction({ drift, existingIssue }) {
  const entries = drift ?? [];

  if (entries.length === 0) {
    return existingIssue
      ? { action: 'close', number: existingIssue.number }
      : { action: 'noop' };
  }

  const title = renderIssueTitle(entries);
  const body = renderIssueBody(entries);

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

function findExistingIssue() {
  // Label-scoped, so this set contains only this job's own issue(s) — the limit
  // is a sanity bound, not a search window (see LABEL above).
  const raw = gh(['issue', 'list', '--state', 'open', '--label', LABEL, '--limit', '100',
    '--json', 'number,title,body']);
  return selectTrackingIssue(JSON.parse(raw));
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

  if (process.env.DRY_RUN === '1') {
    console.log(`ceremony-drift: DRY_RUN=1, no issue changes`);
    return;
  }

  ensureLabel();
  const decision = decideAction({ drift, existingIssue: findExistingIssue() });
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
