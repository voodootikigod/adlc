// The digest protocol (spec §10; AC 69): one comment per run on the rolling
// issue labeled `adlc:autopilot-log`. The issue is located by label (none →
// create; several → the lowest + `digest-issue-ambiguous`), cached in the
// status file but re-validated OPEN before every post; the comment carries a
// run sentinel, the `digestPosted:false` intent is persisted FIRST, the issue's
// comments are searched for the sentinel, the comment is posted only if
// absent, and `digestPosted:true` is written only after gh confirms. A failure
// leaves the intent for the next iteration; the digest never blocks work.

import { ensureComment } from './github.mjs';
import { WITHHELD_BODY } from './redact.mjs';
import { validateIssueNumber } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'digest.skipSentinelSearch',   // the comment is posted without searching for the sentinel
  'digest.postWithoutIntent',    // digestPosted:false is not persisted before the post,
  'digest.requireRecord',
]);

export const LOG_LABEL = 'adlc:autopilot-log';
export const LOG_ISSUE_TITLE = 'ADLC autopilot log';
export const LOG_ISSUE_BODY = 'Rolling log of adlc-autopilot runs. One comment per run; do not close — a closed log issue is replaced by a new one.';
export const runSentinel = (runId) => `<!-- adlc-autopilot:run ${runId} -->`;
const ISSUE_NUMBER_RE = /\/issues\/(\d+)\b/;

/** The digest text (free text → the caller redacts). */
/** The run result as one line: a string outcome verbatim, an object as `state (reason)`. */
const renderOutcome = (o) => (typeof o === 'string' ? o : (o && typeof o === 'object' && o.state ? `${o.state}${o.reason ? ` (${o.reason})` : ''}` : null));

export function digestBody({ record, outcome, prUrl = null, quota = null }) {
  const steps = Array.isArray(record?.quotaSteps) ? record.quotaSteps : [];
  const first = steps[0]?.before ?? quota?.before ?? null; const last = steps[steps.length - 1]?.after ?? quota?.after ?? null;
  const fmt = (w) => (w && typeof w === 'object' && !w.unknown ? `5h ${w.fiveHour ?? '?'}% / 7d ${w.sevenDay ?? '?'}%${w.scoped != null ? ` / scoped ${w.scoped}%` : ''}` : 'n/a');
  const minutes = Math.round((record?.wallClockUsedMs ?? 0) / 60_000);
  return [
    `**Autopilot run** — issue #${record?.issue ?? '?'}`,
    `- ticket: ${record?.ticketId ?? 'n/a'}`,
    `- outcome: ${renderOutcome(outcome) ?? record?.state ?? 'unknown'}`,
    `- PR: ${prUrl ?? (record?.prNumber ? `#${record.prNumber}` : 'none')}`,
    `- rounds: ${record?.roundsUsed ?? 0} (CI fix rounds: ${record?.ciRoundsUsed ?? 0}), minutes: ${minutes}`,
    `- quota before/after: ${fmt(first)} → ${fmt(last)}`,
    `- findings ledger: .adlc/autopilot-runs/${record?.issue ?? '?'}.findings.jsonl (local)`,
    ...(record?.lastError ? [`- last error: ${record.lastError}`] : []),
  ].join('\n');
}

/** Locate (or create) the rolling log issue. Returns { number, created, ambiguous, reported[] }. */
export async function locateLogIssue({ ctx }) {
  const cached = ctx.status?.read?.()?.digestIssue ?? null;
  if (Number.isInteger(cached)) {
    let view = null;
    try { view = await ctx.gh.json(['issue', 'view', String(cached), '--json', 'number,state']); } catch { view = null; }
    if (view?.state === 'OPEN' && view.number === cached) return { number: cached, created: false, ambiguous: false, reported: [] };
  }
  const list = await ctx.gh.json(['issue', 'list', '--label', LOG_LABEL, '--state', 'open', '--json', 'number']);
  const numbers = (Array.isArray(list) ? list : []).map((i) => i?.number).filter(Number.isInteger).sort((a, b) => a - b);
  let number; let created = false;
  if (numbers.length === 0) {
    const r = await ctx.gh.run(['issue', 'create', '--title', LOG_ISSUE_TITLE, '--label', LOG_LABEL, '--body-file', '-'], { stdinBytes: LOG_ISSUE_BODY, retries: false });
    if (r.status !== 0) throw new Error(`gh issue create exited ${r.status}: ${r.stderr.trim().slice(0, 200)}`);
    const m = ISSUE_NUMBER_RE.exec(r.stdout) ?? ISSUE_NUMBER_RE.exec(r.stderr);
    if (!m) throw new Error('created log issue number unknown');
    number = Number(m[1]); created = true;
  } else number = numbers[0];
  const ambiguous = numbers.length > 1;
  ctx.status?.write?.({ digestIssue: number });
  return { number, created, ambiguous, reported: ambiguous ? ['digest-issue-ambiguous'] : [] };
}

/**
 * Post the digest for a run. Never throws; returns { ok, posted, logIssue, reported }.
 */
export async function postDigest({ ctx, record: given, outcome, issue = null, prUrl = null, quota = null }) {
  // A run dropped BEFORE its record existed (a pre-creation revalidation drop) still gets its
  // digest; nothing here dereferences a missing record (codex r4 B3).
  // Mutation seam `digest.requireRecord`: a null record throws (the summary is lost).
  if (!given && active('digest.requireRecord')) throw new TypeError('postDigest: record is required');
  const n = given?.issue ?? (issue != null ? validateIssueNumber(issue) : null);
  if (n == null) return { ok: false, posted: false, error: 'no issue for the digest', reported: [] };
  const record = given ?? { issue: n, state: typeof outcome === 'string' ? outcome : (outcome?.state ?? 'dropped') };
  if (record.digestPosted === true) return { ok: true, posted: false, reason: 'already-posted', reported: [] };
  const runId = record.runId ?? record.digestRunId ?? `issue-${n}-${String(record.token ?? '').slice(0, 12) || 'norecord'}`;
  const sentinel = runSentinel(runId);
  try {
    if (!active('digest.postWithoutIntent') && ctx.records.load(n)) ctx.records.update(n, { digestPosted: false, digestRunId: runId });
    const loc = await locateLogIssue({ ctx });
    const body = ctx.redactor.redact(digestBody({ record, outcome, prUrl, quota }), { withheld: WITHHELD_BODY }).text;
    let posted;
    if (active('digest.skipSentinelSearch')) {
      await ctx.gh.json(['issue', 'comment', String(loc.number), '--body-file', '-'], { stdinBytes: `${sentinel}\n${body}` });
      posted = true;
    } else posted = (await ensureComment(ctx.gh, loc.number, sentinel, body)).posted;
    if (ctx.records.load(n)) ctx.records.update(n, { digestPosted: true });
    return { ok: true, posted, logIssue: loc.number, created: loc.created, reported: loc.reported };
  } catch (e) {
    if (ctx.records.load(n)) ctx.records.update(n, { lastError: `digest: ${String(e.message).slice(0, 200)}` });
    ctx.log?.(`digest failed for #${n}: ${e.message}`);
    return { ok: false, posted: false, error: e.message, reported: [] };
  }
}
