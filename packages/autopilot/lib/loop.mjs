// The loop (spec §2) and the operator subcommands (§13.0).
//
//   loop:  acquire lock → preflightA → BASE_OID → preflightB → recover → quota
//          → token refresh → maintain open PRs → PR cap → select → triage →
//          (quota) → run → digest → rest
//
// `once` executes exactly one iteration. `--dry-run` performs ZERO mutations:
// no lock, no fetch, no worktree, no gh write, no manifest append — the plan is
// always `complete:false` with an explicit skip list. Every world-touching
// collaborator is reached through `deps` so the iteration is testable with fakes.

import { resolveOperatorLocal, parseDuration, applyLowering } from './config.mjs';
import { validateIssueNumber, InputError } from './input.mjs';
import { acquireLock, selfIdentity, defaultProbes, LockHeldError } from './lock.mjs';
import { LABEL_FOR_STATE } from './records.mjs';
import { buildContext } from './context.mjs';
import { loadDenylist } from './selection.mjs';
import { runIssue, resumeRun, RESUME_ACTIONS } from './run.mjs';
import { registerSeams, active as seam } from './mutations.mjs';

registerSeams(['loop.capBeforeResume', 'loop.dryRunClaimsComplete', 'loop.dryRunOmitsWorktreeItem', 'loop.ignoreRecoveryActions', 'loop.leakDryRunSsh', 'loop.fixedRest', 'loop.maintainWithoutDenylist', 'loop.dryRunSkipsQuotaGate']);

export const REST_DEFAULT_MS = 10 * 60_000;

/** One iteration. Returns { outcome, exitCode, document }. */
export async function iterate({ ctx, deps, pinnedIssue = null, force = false }) {
  const { preflight, recover, maintain, selection, triage, effects, digest, status, quota, tokenRefresh } = deps;
  const log = ctx.log;
  const out = { outcome: null, exitCode: 0, document: { dryRun: ctx.dryRun, incomplete: [] } };
  const sleep = (why) => { out.outcome = `sleep:${why}`; out.document.outcome = out.outcome; return out; };

  // §9 phase A — needs no baseline. Any failure → exit 1 (once) / sleep (loop).
  await preflight.phaseA(ctx);
  // §6.0 — the pinned baseline, via the network repository only.
  try { ctx.baseOid = await preflight.resolveBaseline(ctx); }
  catch (e) { log(`baseline unresolved: ${e.message}`); out.exitCode = 1; out.document.error = e.code ?? 'base-unresolved'; return sleep('base-unresolved'); }
  out.document.baseOid = ctx.baseOid;
  // §9 phase B — every repository input read at BASE_OID.
  const b = await preflight.phaseB(ctx, { dryRun: ctx.dryRun });
  out.document.restMinutes = ctx.config?.autopilot?.restMinutes ?? null;
  out.document.preflightB = b;
  if (!b.complete) out.document.incomplete.push(...b.incomplete);
  if (ctx.dryRun) {
    // A dry-run stops before anything mutating; the plan carries what it could check.
    return await dryRunPlan({ ctx, deps, pinnedIssue, force, out });
  }
  status.write({ startsThisIteration: 0, iterationId: ctx.iterationId, baseOid: ctx.baseOid });

  // §2.1 — pending terminal effects are replayed first, then recovery BEFORE selection.
  for (const rec of ctx.records.all()) { try { await effects.reconcilePendingEffects(ctx, rec); } catch (e) { log(`effects replay failed for issue ${rec.issue}: ${e.message}`); } }
  const recovered = await recover.recover({ ctx });
  // Mutation seam `loop.ignoreRecoveryActions`: recovery's classification is discarded (the stranding defect).
  const resumable = seam('loop.ignoreRecoveryActions') ? null : (recovered?.actions ?? []).find((a) => RESUME_ACTIONS.includes(a.action));

  // §3 — the loop-head quota sample.
  let q = await quota.sample({ ordinal: 1, fresh: true });
  status.recordQuota('loop-head', q);
  if (!q.ok) return sleep(`quota:${q.reason}`);

  // §6.4 item 14 — token refresh, gated + reconciled; still short → sleep.
  if (b.tokenShort) {
    const refreshed = await tokenRefresh({ ctx, quota });
    if (!refreshed.ok) return sleep('token-expiring');
    q = await quota.sample({ ordinal: status.incrementStarts(), fresh: true });
    if (!q.ok) return sleep(`quota:${q.reason}`);
  }

  // §8 — open-PR maintenance (every fix round re-checks quota inside). The protected-path
  // denylist is loaded FIRST: maintenance's actual-diff checks need it before selection does.
  // Mutation seam `loop.maintainWithoutDenylist`: maintenance runs before the list is loaded.
  if (!seam('loop.maintainWithoutDenylist')) ctx.denylist = ctx.denylist ?? await (deps.selection.loadDenylist ?? loadDenylist)({ ctx });
  await maintain.maintainOpenPrs({ ctx, baseOid: ctx.baseOid, deps: deps.maintenanceDeps() });
  const active = maintain.activePrCount(ctx.records.all());
  // The PR cap throttles NEW work only: a resumable run is in flight already, and gating it behind the
  // cap would strand it forever on a repository at the limit (agy r3 c4). Mutation seam
  // `loop.capBeforeResume`: the cap is checked before the resume branch.
  if (seam('loop.capBeforeResume') && active >= ctx.config.autopilot.maxOpenPrs) return sleep('pr-cap');

  // §2.1 — a resumable run continues BEFORE any new selection (its worktree/branch would
  // otherwise exclude its own issue forever). One resume per iteration, then the rest.
  if (resumable && (pinnedIssue == null || pinnedIssue === resumable.issue)) {
    out.document.resume = { action: resumable.action, issue: resumable.issue };
    const result = await resumeRun({ ctx, deps, action: resumable.action, issue: resumable.issue });
    out.document.run = result;
    await digest.postDigest({ ctx, record: ctx.records.load(resumable.issue), issue: resumable.issue, outcome: result });
    out.outcome = `resumed:${result.state}`;
    out.exitCode = result.state === 'blocked' ? 2 : 0;
    return out;
  }

  if (active >= ctx.config.autopilot.maxOpenPrs) return sleep('pr-cap');

  // §4 — selection.
  const sel = await selection.select({ ctx, pinned: pinnedIssue, force });
  out.document.selection = sel;
  if (!sel.picked) {
    if (pinnedIssue != null) { out.exitCode = 2; out.document.excludedBy = sel.excludedRule; return sleep(`excluded:${sel.excludedRule}`); }
    return sleep('no-candidate');
  }
  const issue = sel.picked;

  // §5 — triage (the shaping call re-checks quota first).
  let shapingSample = null;
  const preModelCall = async () => {
    shapingSample = await quota.sample({ ordinal: status.incrementStarts(), fresh: true });
    return shapingSample.ok ? { ok: true } : { ok: false, reason: `quota:${shapingSample.reason}` };
  };
  const verdict = await triage.triage({ ctx, issue: sel.issue, authorization: sel.authorization, revision: sel.revision, preModelCall });
  if (shapingSample?.ok && typeof quota.reconcile === 'function') { try { await quota.reconcile('shaping', shapingSample, { issue }); } catch (e) { log(`shaping reconcile failed: ${e.message}`); } }
  out.document.verdict = verdict.verdict;
  if (verdict.verdict === 'CLARIFY') {
    await triage.clarifyEffects({ ctx, issue, sentinel: verdict.sentinel, body: verdict.body });
    return sleep('clarify');
  }
  // After PROCEED, before dispatch: cache the ticket and re-check quota.
  q = await quota.sample({ ordinal: status.incrementStarts(), fresh: true });
  if (!q.ok) { await deps.cacheShapedTicket({ ctx, issue, ticket: verdict.ticket, revision: sel.revision }); return sleep(`quota:${q.reason}`); }

  // §6–§7 — the run.
  const result = await runIssue({ ctx, deps, issue, ticket: verdict.ticket, revision: sel.revision, authorization: sel.authorization });
  out.document.run = result;
  await digest.postDigest({ ctx, record: ctx.records.load(issue), issue, outcome: result });
  out.outcome = result.state;
  out.exitCode = result.state === 'blocked' ? 2 : 0;
  return out;
}

async function dryRunPlan({ ctx, deps, pinnedIssue, force, out }) {
  const { selection, triage } = deps;
  // Mutation seam `loop.dryRunOmitsWorktreeItem`: the plan hides that fleet's dry run needs a worktree.
  if (!seam('loop.dryRunOmitsWorktreeItem')) out.document.incomplete.push('fleet-dry-run-needs-worktree');
  const sel = await selection.select({ ctx, pinned: pinnedIssue, force });
  out.document.selection = sel;
  if (sel.picked) {
    const ticket = ctx.local.dryRunShape
      ? (await triage.triage({ ctx, issue: sel.issue, authorization: sel.authorization, revision: sel.revision, dryRun: true, preModelCall: quotaGateForModelCalls(ctx) })).ticket
      : selection.placeholderTicket({ issue: sel.issue });
    out.document.ticket = ticket;
    out.document.fleetArgv = deps.fleetArgvPreview({ ctx, issue: sel.picked, ticketId: 'T-<ULID>', roundsUsed: 0, wallClockUsedMs: 0 });
    out.document.prTitle = deps.prTitlePreview({ issue: sel.issue, ticket });
  } else if (pinnedIssue != null) {
    out.exitCode = 2; out.document.excludedBy = sel.excludedRule;
  }
  // Mutation seam `loop.dryRunClaimsComplete`: a dry run reports itself complete.
  out.document.complete = seam('loop.dryRunClaimsComplete');
  out.outcome = 'dry-run';
  return out;
}

/**
 * The read-only commands (status/select/triage) run phase A on a dry-run context, which
 * stages temporary SSH material; it is released here, on every exit path (codex r2 B3).
 * Mutation seam `loop.leakDryRunSsh`: the material is left behind.
 */
async function releaseDryRun(ctx) {
  if (seam('loop.leakDryRunSsh')) return;
  await ctx.cleanupIteration?.();
}

/** `once`: exactly one iteration. */
export async function runOnce({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  if (local.issue != null) validateIssueNumber(local.issue, 'issue');
  if (flags.force && local.issue == null) throw new InputError('force', '--force requires --issue');
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: local.dryRun, overrides });
  let lock = null;
  if (!ctx.dryRun) {
    try { lock = acquireLock(ctx.paths.adlc, { self: selfIdentity(), probes: defaultProbes(), now: ctx.now }); }
    catch (e) { if (e instanceof LockHeldError) return { exitCode: 1, document: { ok: false, code: 'lock-held' }, text: 'adlc-autopilot: lock-held' }; throw e; }
    ctx.lock = lock;
  }
  try {
    const it = await iterate({ ctx, deps: ctx.deps, pinnedIssue: local.issue != null ? validateIssueNumber(local.issue) : null, force: local.force });
    return { exitCode: it.exitCode, document: it.document, text: `adlc-autopilot: ${it.outcome}` };
  } finally {
    if (lock) lock.release();
    await ctx.cleanupIteration?.();
  }
}

/**
 * The quota start gate for a MODEL call made outside the run loop (dry-run shaping, the triage
 * command): a refused window refuses the call — a dry run must not spend quota the loop would
 * have refused (codex r7 B1). Seam `loop.dryRunSkipsQuotaGate`.
 */
function quotaGateForModelCalls(ctx) {
  if (seam('loop.dryRunSkipsQuotaGate')) return null;
  return async (what) => {
    const q = await ctx.quota.sample({ ordinal: 1, fresh: true });
    return q.ok ? { ok: true } : { ok: false, reason: `quota:${q.reason}${what ? ` (${what})` : ''}` };
  };
}

/**
 * The rest between iterations: the operator's --rest, else the COMMITTED `autopilot.restMinutes`
 * the iteration read in phase B (reported in its document), else 10 minutes (codex r3 B7).
 * Mutation seam `loop.fixedRest`: the committed value is ignored.
 */
export function restMsFor({ local, document }) {
  if (local?.restMs != null) return local.restMs;
  const committed = seam('loop.fixedRest') ? null : document?.restMinutes;
  return parseDuration(String(committed ?? 10));
}

/** `loop`: iterate, rest, repeat; SIGTERM finishes the current step and exits 0. */
export async function runLoop({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  let stop = false;
  const onTerm = () => { stop = true; };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onTerm);
  try {
    for (;;) {
      const r = await runOnce({ flags, env, cwd, deps: overrides });
      if (stop) return { exitCode: 0, text: 'adlc-autopilot: stopped' };
      if (r.exitCode === 1 && r.document?.code === 'lock-held') return r;
      await (overrides.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(restMsFor({ local, document: r.document }));
      if (stop) return { exitCode: 0, text: 'adlc-autopilot: stopped' };
    }
  } finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onTerm); }
}

export async function statusCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: true, overrides });
  const doc = ctx.status.read() ?? {};
  let preflight = null;
  try { await ctx.deps.preflight.phaseA(ctx); preflight = { ok: true }; } catch (e) { preflight = { ok: false, code: e.code ?? 'error', message: e.message }; }
  finally { await releaseDryRun(ctx); }
  const document = { ...doc, preflight, records: ctx.records.all().map((r) => ({ issue: r.issue, state: r.state, prNumber: r.prNumber ?? null, label: LABEL_FOR_STATE[r.state] ?? null })) };
  return { exitCode: 0, document, text: JSON.stringify(document, null, 2) };
}

export async function selectCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: true, overrides });
  try {
    await ctx.deps.preflight.phaseA(ctx);
    ctx.baseOid = await ctx.deps.preflight.resolveBaseline(ctx);
    const sel = await ctx.deps.selection.select({ ctx, top: flags.top ? Number(flags.top) : null });
    return { exitCode: 0, document: sel, text: sel.ranked.map((r) => `${String(r.number).padStart(6)}  ${String(r.score).padStart(5)}  ${r.excluded ?? 'eligible'}`).join('\n') };
  } finally { await releaseDryRun(ctx); }
}

/** `quota` — also the pre-strike helper form (§3.2) when --iteration/--start-ordinal are given. */
export async function quotaCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: true, overrides, quotaOnly: true });
  const helper = flags.startOrdinal === 'auto';
  if (helper) {
    const token = env.ADLC_AUTOPILOT_LOCK_TOKEN;
    if (!token || !ctx.lockHeldBy(token)) return { exitCode: 1, document: { ok: false, code: 'lock-not-held' }, text: 'quota helper: lock-not-held' };
    if (flags.wallClockRemaining != null) {
      const margin = ctx.deps.tokenMargin({ ctx });
      if (margin.minutesLeft < Number(flags.wallClockRemaining) + 30) return { exitCode: 1, document: { ok: false, code: 'token-expiring', minutesLeft: margin.minutesLeft }, text: 'quota helper: token-expiring' };
    }
    const ordinal = ctx.status.incrementStarts();
    const q = await ctx.quota.sample({ ordinal, fresh: true });
    return { exitCode: q.ok ? 0 : 1, document: { ...q, ordinal }, text: `quota: ${q.ok ? 'ok' : q.reason} (ordinal ${ordinal})` };
  }
  const q = await ctx.quota.sample({ ordinal: 1, fresh: true });
  return { exitCode: q.ok ? 0 : 1, document: q, text: `quota: ${q.ok ? 'ok' : q.reason} 5h=${q.windows?.fiveHour} 7d=${q.windows?.sevenDay} scoped=${q.windows?.scoped}` };
}

export async function triageCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const n = validateIssueNumber(flags.issue, 'issue');
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: true, overrides });
  try {
    await ctx.deps.preflight.phaseA(ctx);
    ctx.baseOid = await ctx.deps.preflight.resolveBaseline(ctx);
    const sel = await ctx.deps.selection.select({ ctx, pinned: n });
    if (!sel.picked) return { exitCode: 2, document: { issue: n, excludedBy: sel.excludedRule }, text: `issue ${n} excluded: ${sel.excludedRule}` };
    const v = await ctx.deps.triage.triage({ ctx, issue: sel.issue, authorization: sel.authorization, revision: sel.revision, dryRun: true, preModelCall: quotaGateForModelCalls(ctx) });
    return { exitCode: v.verdict === 'PROCEED' ? 0 : 2, document: v, text: `triage ${n}: ${v.verdict}` };
  } finally { await releaseDryRun(ctx); }
}

export async function resetCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const n = validateIssueNumber(flags.issue, 'issue');
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: false, overrides });
  const lock = acquireLock(ctx.paths.adlc, { self: selfIdentity(), probes: defaultProbes(), now: ctx.now });
  ctx.lock = lock;
  try {
    await ctx.deps.preflight.phaseA(ctx);
    const r = await ctx.modules.reset.resetCommand({ ctx, issue: n, confirmDelete: flags.confirmDelete ?? null, deleteRemote: flags.deleteRemote, attempts: flags.attempts });
    const printed = Array.isArray(r.printed) ? r.printed.join('\n') : '';
    return { exitCode: r.exitCode ?? (r.ok ? 0 : 2), document: r, text: [r.exitCode === 0 ? `reset ${n}: ${r.code ?? 'ok'}` : `reset ${n} refused: ${r.code}`, printed].filter(Boolean).join('\n') };
  } finally { lock.release(); }
}

export async function initCommand({ flags, env, cwd, deps: overrides = {} }) {
  const local = resolveOperatorLocal(flags, env);
  const ctx = await buildContext({ flags, env, cwd, local, dryRun: !flags.write, overrides });
  const r = await ctx.deps.init({ ctx, labels: flags.labels, service: flags.service, write: flags.write });
  return { exitCode: r.exitCode ?? 0, document: r, text: r.text ?? '' };
}

export { applyLowering };
