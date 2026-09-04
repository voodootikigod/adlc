// CI follow-up (spec §6.9, §0.11, §7; AC 8, 40, 51, 66).
//
// ONE normalization function over the raw `gh pr checks --json
// name,state,bucket,workflow` rows: `bucket` is primary, `state` only
// disambiguates `skipping`; a missing/non-string bucket is red; blocking jobs
// are matched by NAME PREFIX on the raw name (so a matrix expansion cannot
// hide a job) — and, because the real output names the cross-model gate's job
// `gate` under workflow `cross-model-gate`, also by exact WORKFLOW equality.
// Head binding on every poll: the PR head must still be `attestedHead`.
// The CI-fix budget (`ciRoundsUsed`, max 2, fleet `--max-strikes 2
// --wall-clock-minutes 15`) is independent of the build budget.

import { branchFor } from './input.mjs';
import { redactStream, CHUNK_BYTES, WITHHELD_DEAD_END } from './redact.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'ci.ignoreHeadBinding',     // polls no longer compare headRefOid with attestedHead
  'ci.skippedIsPass',         // a skipped `test (N)` counts as pass
  'ci.shareBudgets',          // the CI fix round draws from roundsUsed / the shared wall-clock budget
  'ci.missingBucketIsPass',   // a row without a string bucket counts as pass
  'ci.redWaitsForPending',    // a red does not start the fix round while other jobs are pending
]);

export const BLOCKING_PREFIXES = Object.freeze(['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'cross-model-gate', 'ticket-store-platform (']);
export const CI_FIX_MAX_STRIKES = 2;
export const CI_FIX_WALL_MINUTES = 15;
export const DEFAULT_CI_FIX_ROUNDS = 2;
export const MAX_RE_EVALUATIONS = 3;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const KEEP_LOG_CHARS = 64 * 1024;
export const POLL_MS = 60_000;

/** bucket → pass | red | wait | skipped (state only disambiguates skipping). */
export function normalizeRow(row) {
  const bucket = row?.bucket;
  if (typeof bucket !== 'string') return active('ci.missingBucketIsPass') ? 'pass' : 'red';
  switch (bucket) {
    case 'pass': return 'pass';
    case 'fail': return 'red';
    case 'pending': return 'wait';
    case 'skipping': return 'skipped';
    case 'cancel': return 'red';
    default: return 'red';
  }
}

/** The blocking prefix a row belongs to, or null for a non-blocking job. */
export function blockingPrefixOf(row, prefixes = BLOCKING_PREFIXES) {
  const name = typeof row?.name === 'string' ? row.name : '';
  const workflow = typeof row?.workflow === 'string' ? row.workflow : '';
  return prefixes.find((p) => name.startsWith(p)) ?? prefixes.find((p) => workflow === p) ?? null;
}

/**
 * The §6.9 table over the raw rows.
 * @returns {{ verdict:'pass'|'red'|'wait', red:string[], waiting:string[], missing:string[], ignored:string[], rows:[] }}
 */
export function normalizeChecks(rows, { blockingPrefixes = BLOCKING_PREFIXES, clockExpired = false } = {}) {
  if (!Array.isArray(rows)) return { verdict: 'red', red: ['<checks not a list>'], waiting: [], missing: [], ignored: [], rows: [] };
  const red = []; const waiting = []; const ignored = []; const seen = new Set(); const out = [];
  for (const row of rows) {
    const prefix = blockingPrefixOf(row, blockingPrefixes);
    const name = typeof row?.name === 'string' ? row.name : '<unnamed>';
    const norm = normalizeRow(row);
    if (!prefix) { ignored.push(name); out.push({ name, prefix: null, norm, blocking: false }); continue; }
    seen.add(prefix);
    let effective = norm;
    if (norm === 'skipped') effective = prefix.startsWith('test (') && !active('ci.skippedIsPass') ? 'red' : 'pass';
    if (effective === 'red') red.push(name);
    else if (effective === 'wait') waiting.push(name);
    out.push({ name, prefix, norm, effective, blocking: true, state: row?.state ?? null });
  }
  const missing = blockingPrefixes.filter((p) => !seen.has(p));
  if (clockExpired) for (const m of missing) red.push(`missing: ${m}`);
  const verdict = red.length ? 'red' : (waiting.length || (missing.length && !clockExpired)) ? 'wait' : 'pass';
  return { verdict, red, waiting, missing, ignored, rows: out };
}

/** The CI fix round's fleet allowance — independent of roundsUsed / wallClockUsedMs (§7). */
export function ciFixRoundBudget({ record, config }) {
  if (active('ci.shareBudgets')) {
    const maxRounds = config?.maxRounds ?? 15; const wall = config?.wallClockMinutes ?? 90;
    return { maxStrikes: Math.max(0, maxRounds - (record?.roundsUsed ?? 0)), wallClockMinutes: Math.max(0, wall - Math.floor((record?.wallClockUsedMs ?? 0) / 60_000)) };
  }
  return { maxStrikes: CI_FIX_MAX_STRIKES, wallClockMinutes: CI_FIX_WALL_MINUTES };
}
export const ciFixFleetArgs = (budget) => ['--max-strikes', String(budget.maxStrikes), '--wall-clock-minutes', String(budget.wallClockMinutes)];

/** `gh run view <id> --log-failed` under the 4 MiB cap, redacted in 64 KiB chunks, last 64 KiB kept. */
export async function fetchFailedLog({ ctx, runId }) {
  const r = await ctx.gh.run(['run', 'view', String(runId), '--log-failed'], { stdoutCap: MAX_LOG_BYTES, retries: false });
  const text = r.stdout ?? '';
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_BYTES) chunks.push(text.slice(i, i + CHUNK_BYTES));
  if (chunks.length === 0) chunks.push('');
  const red = redactStream(chunks, ctx.redactor, { keepChars: KEEP_LOG_CHARS });
  return { ok: red.ok && r.status === 0, text: red.ok ? red.text : WITHHELD_DEAD_END, truncated: r.truncated === true, status: r.status };
}

/** Best-effort dead-end material for the failing jobs at `head` (never throws). */
export async function collectFailedLogs({ ctx, issue, head, red }) {
  try {
    const runs = await ctx.gh.json(['run', 'list', '--branch', branchFor(issue), '--status', 'failure', '--json', 'databaseId,name,headSha', '--limit', '20']);
    const parts = [];
    for (const run of Array.isArray(runs) ? runs : []) {
      if (run?.headSha && head && run.headSha !== head) continue;
      if (!Number.isInteger(run?.databaseId)) continue;
      const log = await fetchFailedLog({ ctx, runId: run.databaseId });
      parts.push(`=== ${run.name ?? run.databaseId} (run ${run.databaseId})${log.truncated ? ' [truncated]' : ''}\n${log.text}`);
    }
    return parts.length ? parts.join('\n').slice(-KEEP_LOG_CHARS) : `[no failed run logs found for: ${red.join(', ')}]`;
  } catch (e) { return `[failed-run logs unavailable: ${String(e.message).slice(0, 200)}]`; }
}

async function pollChecks(ctx, prNumber) {
  // `gh pr checks` exits non-zero while checks are pending/failed; the JSON is still on stdout.
  const r = await ctx.gh.run(['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,workflow'], { retries: false });
  if (r.truncated) return null;
  try { const rows = JSON.parse(r.stdout); return Array.isArray(rows) ? rows : null; } catch { return null; }
}

/**
 * The watch loop. `runFixRound({ red, budget, fleetArgs, deadEnd })` is the
 * caller's retry protocol (fleet re-dispatch → … → fresh attestation → push)
 * and must return `{ ok, attestedHead }`. `sleep`/`ctx.now` are injectable.
 */
export async function watchCi({ ctx, record, attestedHead, budgetMs, poll = POLL_MS, runFixRound, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxReEvaluations = MAX_RE_EVALUATIONS }) {
  const n = record.issue; const pr = record.prNumber;
  const config = ctx.config?.autopilot ?? {};
  const budget = budgetMs ?? (config.ciWatchMinutes ?? 30) * 60_000;
  const fixLimit = config.ciFixRounds ?? DEFAULT_CI_FIX_ROUNDS;
  let head = attestedHead; let deadline = ctx.now() + budget; let cur = ctx.records.load(n) ?? record;
  ctx.records.update(n, { state: 'ci-watch', attestedHead: head });
  for (;;) {
    const view = await ctx.gh.json(['pr', 'view', String(pr), '--json', 'headRefOid']);
    if (!active('ci.ignoreHeadBinding') && view?.headRefOid !== head) {
      ctx.records.update(n, { state: 'oid-mismatch', lastError: `oid-mismatch: PR #${pr} head ${view?.headRefOid ?? 'unknown'} != attestedHead ${head}` });
      return { outcome: 'oid-mismatch', expected: head, observed: view?.headRefOid ?? null, comment: `oid-mismatch: PR #${pr} head ${view?.headRefOid ?? 'unknown'} != attested ${head}` };
    }
    const rows = await pollChecks(ctx, pr);
    const expired = ctx.now() >= deadline;
    const norm = rows ? normalizeChecks(rows, { clockExpired: expired }) : { verdict: 'wait', red: [], waiting: ['<poll failed>'], missing: [] };
    if (norm.verdict === 'red' && !(active('ci.redWaitsForPending') && norm.waiting.length)) {
      const used = cur.ciRoundsUsed ?? 0;
      if (used >= fixLimit) {
        return { outcome: 'ci-red', red: norm.red, label: 'adlc:autopilot-ci-red', comment: `CI red after ${used} fix round(s): ${norm.red.join(', ')}` };
      }
      const ordinal = ((ctx.status?.read?.()?.startsThisIteration) ?? 0) + 1;
      const quota = await ctx.quota.sample({ ordinal, fresh: true });
      if (!quota.ok) { const pausedAt = ctx.now(); await sleep(poll); deadline += ctx.now() - pausedAt; continue; }
      const fix = ciFixRoundBudget({ record: cur, config });
      if (fix.maxStrikes <= 0 || fix.wallClockMinutes <= 0) return { outcome: 'ci-red', red: norm.red, label: 'adlc:autopilot-ci-red', comment: `CI fix budget exhausted: ${norm.red.join(', ')}` };
      ctx.records.update(n, { ciRoundsUsed: used + 1 }); // charged BEFORE the round starts
      const deadEnd = await collectFailedLogs({ ctx, issue: n, head, red: norm.red });
      const res = await runFixRound({ red: norm.red, budget: fix, fleetArgs: ciFixFleetArgs(fix), deadEnd, round: used + 1 });
      if (!res?.ok) return { outcome: 'fix-round-failed', code: res?.code ?? 'fix-round-failed', red: norm.red, round: used + 1 };
      head = res.attestedHead; deadline = ctx.now() + budget; cur = ctx.records.load(n) ?? cur;
      ctx.records.update(n, { state: 'ci-watch', attestedHead: head });
      continue;
    }
    if (norm.verdict === 'pass' && (active('ci.ignoreHeadBinding') || view?.headRefOid === head)) {
      ctx.records.update(n, { state: 'done' });
      return { outcome: 'done', head };
    }
    if (expired) {
      const re = (cur.ciReEvaluations ?? 0) + 1;
      if (re >= maxReEvaluations) return { outcome: 'ci-incomplete', label: 'adlc:autopilot-ci-red', waiting: norm.waiting, missing: norm.missing, comment: `ci-incomplete: still waiting on ${[...norm.waiting, ...norm.missing].join(', ')}` };
      ctx.records.update(n, { state: 'ci-watch', ciReEvaluations: re });
      return { outcome: 'ci-watch', reEvaluations: re, waiting: norm.waiting, missing: norm.missing };
    }
    await sleep(poll);
  }
}
