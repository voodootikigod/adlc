// spend.mjs — aggregate recorded token usage into the §6 unit of account.
//
// ADLC.md §6 defines the lifecycle's unit of account as "cost per merged,
// verified change" and a barbell spend shape (heavy P1/P5, light P4). C11
// says the manifest records "token spend per phase". Neither was
// instrumented (issue #272) — usage was never parsed off provider
// responses, so nothing had numbers to aggregate. This module is the
// aggregation half; @adlc/core's `complete()`/`fan()` `onUsage` callback is
// the collection half, and individual gates opt in by passing usage through
// to their own gate-manifest `record()` call as `data.usage`.
//
// A manifest entry that wants to be counted here sets `data.usage` to
// `{ inputTokens, outputTokens, cachedTokens, provider, model, tier }` (the
// exact shape `complete()`'s onUsage callback produces) — either one call's
// usage, or a caller-summed total across a fan-out, at the caller's choice.
// Entries without `data.usage` are simply not counted; this file never
// estimates or fabricates a number for them.

import { loadFiltered } from './show.mjs';

/**
 * Gate name → ADLC lifecycle phase. Gates not listed here (deterministic tools
 * with no LLM spend, or tools not yet wired to report usage) fall under
 * 'unphased'.
 *
 * TWO NAMING AXES land in this one table, deliberately:
 *
 *   1. GATE TOOL names (spec-lint, coldstart, prosecute, …). Source of truth:
 *      the `/adlc:adlc` skill's phase-routing table — canonical, mirrored here
 *      rather than re-derived.
 *   2. PHASE names (p4, p5). The fleet records its own evidence under the phase
 *      it just ran, not under a tool name: see packages/fleet/lib/scheduler.mjs's
 *      `effects.record('p4', ok)` and live-deps.mjs's `recordDispatchUsage`,
 *      both of which reach `adlc gate-manifest record p4` and land as
 *      `gate: 'p4'`.
 *
 * The lowercase entries are NOT stray duplicates of the 'P4'/'P5' VALUES — do
 * not "clean them up". Without them every fleet dispatch's spend falls to
 * 'unphased', which made P4 — the phase ADLC.md §6 says should be LIGHT in a
 * healthy barbell — the one phase whose spend could not be attributed at all,
 * and left the §6 `share('P4') > 0.4` diagnostic unable to fire (#418).
 *
 * This map is itself a cache (ADLC Principle 10) — if a gate moves phases
 * or a new LLM-backed gate ships, update this table. `adlc spend --json`
 * surfaces any gate name it doesn't recognize under 'unphased' rather than
 * silently mis-attributing it, so staleness here is visible, not silent.
 */
export const PHASE_BY_GATE = {
  'spec-lint': 'P1',
  premortem: 'P1',
  parallax: 'P1',
  coldstart: 'P2',
  'model-router': 'P2',
  'merge-forecast': 'P2',
  'rails-guard': 'P3',
  'flail-detector': 'P4',
  'consensus-fix': 'P4',
  p4: 'P4',
  'hollow-test': 'P5',
  'behavior-diff': 'P5',
  'review-calibration': 'P5',
  prosecute: 'P5',
  p5: 'P5',
  'lesson-foundry': 'P7',
  'rejection-mining': 'P7',
  'skill-rot': 'maintenance',
  'model-ratchet': 'maintenance',
  'gate-fuzzing': 'maintenance',
};

function phaseForGate(gate) {
  return PHASE_BY_GATE[gate] ?? 'unphased';
}

function emptyBucket() {
  // `unmeasuredCalls` makes a bucket SELF-DESCRIBING. Without it, "0 tokens" is
  // ambiguous between a phase that cost nothing and a phase whose calls we could
  // not measure — the same collapse of "unknown" into "free" that T152's
  // no-fabrication rule exists to prevent, one layer up.
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unmeasuredCalls: 0 };
}

function addUsage(bucket, usage) {
  bucket.calls += 1;
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.cachedTokens += usage.cachedTokens ?? 0;
}

/**
 * A call that HAPPENED and was NOT measured.
 *
 * It moves `unmeasuredCalls` and NOTHING else — deliberately not `calls`, which
 * keeps its established meaning of MEASURED calls because it is the denominator
 * every per-call token average divides by. Diluting it would change the meaning
 * of existing arithmetic in every consumer (T152's roundtrip test pins exactly
 * this). No token counter is touched either, not even `+= 0`: a bucket that
 * quietly gained a zero is indistinguishable from a measured free one.
 */
function addUnmeasured(bucket) {
  bucket.unmeasuredCalls += 1;
}

/**
 * The CLOSED status vocabulary T152 established. Each of these asserts that a
 * model call happened — `reported` and `claimed` say its counters are on the
 * entry, `unreported` says they are not knowable.
 *
 * Membership is checked rather than "any non-empty string" because the ledger is
 * append-only and read by versions of this code that do not exist yet. A future
 * status meaning the OPPOSITE — `skipped`, `failed`, `disabled` — would
 * otherwise be counted as a call and silently inflate a phase
 * (adversarial-review). An unrecognized status is not evidence of anything.
 */
const USAGE_STATUSES = new Set(['reported', 'claimed', 'unreported']);

/**
 * Is this entry evidence of a model call whose tokens we do not have?
 *
 * `usageStatus` is the T152 vocabulary — its presence means a producer went out
 * of its way to say "a call happened here". Most ledger entries (ticket-complete,
 * rails-frozen, a bare printed-prompt verdict) carry no status and were never a
 * model call; they stay uncounted.
 *
 * An idempotent REPLAY is excluded: `packages/prosecute/lib/run.mjs` records a
 * replayed pass as `{usageStatus, usageReplayOf}` with NO usage precisely so the
 * counters are not recorded twice. That is exactly the shape checked here, so
 * counting it would multiply one model call by its retry count — the failure
 * T152's one-carrier-per-call rule prevents for tokens, arriving instead in a
 * counter with no total to make it visible.
 */
function isUnmeasuredCall(data) {
  if (!USAGE_STATUSES.has(data?.usageStatus)) return false;
  return !(typeof data.usageReplayOf === 'string' && data.usageReplayOf.length > 0);
}

function totalTokens(bucket) {
  return bucket.inputTokens + bucket.outputTokens;
}

/**
 * Aggregate token usage recorded in manifest entries by phase and by gate.
 *
 * @param {object[]} entries - manifest entries (as returned by loadFiltered/readEntries)
 * @returns {{
 *   byPhase: Record<string, {calls:number, inputTokens:number, outputTokens:number, cachedTokens:number}>,
 *   byGate:  Record<string, {calls:number, inputTokens:number, outputTokens:number, cachedTokens:number, phase:string}>,
 *   total:   {calls:number, inputTokens:number, outputTokens:number, cachedTokens:number},
 *   entriesWithUsage: number,
 *   entriesTotal: number,
 * }}
 */
export function aggregateSpend(entries) {
  const byPhase = {};
  const byGate = {};
  const total = emptyBucket();
  let entriesWithUsage = 0;

  let unmeasuredCalls = 0;

  for (const entry of entries) {
    const data = entry?.data;
    const usage = data?.usage;
    const measured = usage !== null && typeof usage === 'object';
    // A replay is already counted; it is never a call of its own, measured or not.
    const replay = typeof data?.usageReplayOf === 'string' && data.usageReplayOf.length > 0;
    const unmeasured = !measured && !replay && isUnmeasuredCall(data);
    if (replay || (!measured && !unmeasured)) continue;

    const phase = phaseForGate(entry.gate);
    byPhase[phase] ??= emptyBucket();
    byGate[entry.gate] ??= { ...emptyBucket(), phase };

    if (measured) {
      entriesWithUsage++;
      addUsage(byPhase[phase], usage);
      addUsage(byGate[entry.gate], usage);
      addUsage(total, usage);
    } else {
      unmeasuredCalls++;
      addUnmeasured(byPhase[phase]);
      addUnmeasured(byGate[entry.gate]);
      addUnmeasured(total);
    }
  }

  return { byPhase, byGate, total, entriesWithUsage, unmeasuredCalls, entriesTotal: entries.length };
}

/**
 * The §6 diagnostics, made mechanical. Each checks a specific claim ADLC.md
 * makes about what a healthy spend shape looks like, against the aggregate.
 * Returns [] when there isn't enough data to say anything (fewer than 2
 * phases with recorded spend) — these are heuristics for a human to look
 * at, not a gate; they never fail a build.
 */
export function diagnostics(aggregate) {
  const { byPhase, total } = aggregate;
  const unmeasured = aggregate.unmeasuredCalls ?? 0;
  const out = [];

  // A CALL-COUNT observation, kept rigidly separate from every spend claim
  // below. It names itself as counting calls, and says why that is not a spend
  // share, because a reader who mistakes one for the other gets a confident
  // wrong answer: a P1 call against a frontier model and a P4 call on a cheap
  // seat are one call each and can differ by orders of magnitude in cost.
  const phasesWithCalls = Object.keys(byPhase).filter((p) => p !== 'unphased');
  // The count MUST describe exactly the calls the shape lists. `unmeasuredCalls`
  // is a whole-ledger total including `unphased`, so quoting it beside a
  // phase-only shape attributes unphased calls to the phases shown — and can
  // state a number larger than the calls listed (adversarial-review).
  const shownUnmeasured = phasesWithCalls.reduce((n, p) => n + byPhase[p].unmeasuredCalls, 0);

  const phasesWithSpend = Object.keys(byPhase).filter((p) => p !== 'unphased' && totalTokens(byPhase[p]) > 0);
  const sharesComputable = phasesWithSpend.length >= 2 && total.inputTokens + total.outputTokens > 0;

  // The call-count shape is the FALLBACK view, emitted only when no share of
  // spend can be computed. Printing it beside real token shares contradicts
  // them: one unmeasured call among ten thousand measured ones would announce
  // that the whole distribution is "counts, not spend" while accurate shares sat
  // directly beneath it (adversarial-review). Where shares ARE computable, the
  // caveat below states the same limitation without discrediting them.
  if (!sharesComputable && shownUnmeasured > 0 && phasesWithCalls.length >= 2) {
    const shape = phasesWithCalls
      .sort()
      .map((p) => `${p}=${byPhase[p].calls + byPhase[p].unmeasuredCalls}`)
      .join(' ');
    out.push(
      `call(s) by phase — COUNTS, NOT SPEND: ${shape}. ${shownUnmeasured} of these call(s) reported no ` +
      'tokens, so this is the shape of where work happened, not a share of what it cost.'
    );
  }

  if (!sharesComputable) {
    // §8c: degraded data cannot silently pass. Saying nothing here is what let a
    // ledger of real, unpriced calls look like a ledger of no activity.
    if (unmeasured > 0) {
      out.push(
        `§6 spend shape is UNKNOWN: ${unmeasured} recorded call(s) reported no token counts, and fewer ` +
        'than two phases have measured spend, so no share of spend can be computed from this ledger.'
      );
    }
    return out;
  }
  if (unmeasured > 0) {
    out.push(
      `the §6 shares below are computed over MEASURED tokens only — ${unmeasured} further call(s) ` +
      'reported none, so the true distribution may differ.'
    );
  }
  const share = (phase) => (byPhase[phase] ? totalTokens(byPhase[phase]) / (totalTokens(total) || 1) : 0);

  // "Spend concentrated in P4 → re-exploring the codebase every run" (ADLC.md §6).
  if (share('P4') > 0.4) {
    out.push(
      `P4 (Build) is ${(share('P4') * 100).toFixed(0)}% of recorded spend — ADLC.md §6: ` +
      `"spend concentrated in P4 → the team is re-exploring the codebase every run. ` +
      `Missing skills, oversized tickets, or no Distill phase."`
    );
  }

  // "P5 spend trending up over time → P7 isn't converting findings into lints/skills"
  // — trend needs history this single snapshot doesn't have; flag the shape instead:
  // heavy P5 with no P7 spend at all is the precondition for that trend.
  if (share('P5') > 0.3 && !byPhase.P7) {
    out.push(
      `P5 (Prosecute) is ${(share('P5') * 100).toFixed(0)}% of recorded spend with zero P7 (Distill) ` +
      `spend recorded — ADLC.md §6: "P5 spend trending up over time → P7 isn't converting findings ` +
      `into lints/skills; you're re-buying the same lessons."`
    );
  }

  // "Spend flat run-over-run → the compounding loop is broken" — same caveat: this
  // snapshot can't see run-over-run trend, only flag that P7 recorded nothing.
  //
  // A P7 bucket holding only UNMEASURED calls still means P7 work happened; the
  // compounding loop is running and merely unpriced. Claiming it is broken there
  // would be the same "unknown read as zero" this module now refuses.
  if (!byPhase.P7) {
    out.push(
      `No P7 (Distill) spend recorded — ADLC.md §6: "the compounding loop is broken" ` +
      `if this holds run-over-run; P7 is what makes run N+1 cheaper than run N.`
    );
  }

  return out;
}

/**
 * Render the aggregate as human-readable text: the barbell histogram (per
 * phase, in ADLC.md's own P0..P7 + maintenance/unphased order) plus the §6
 * diagnostics.
 */
export function renderSpendReport(aggregate) {
  const PHASE_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'maintenance', 'unphased'];
  const lines = [];

  // Only a ledger with NO counted calls at all is a dead end. A ledger full of
  // unmeasured calls has a real shape — which phases the work happened in — and
  // saying "no recorded usage" there taught the operator the gate was broken
  // when it was reporting faithfully about calls it could not price.
  if (aggregate.total.calls === 0 && (aggregate.unmeasuredCalls ?? 0) === 0) {
    lines.push(
      `no recorded calls (0 of ${aggregate.entriesTotal} manifest entries carry data.usage or data.usageStatus).`,
      'gates report usage by threading complete()\'s onUsage callback into their own',
      'gate-manifest record() call as data.usage — see packages/gate-manifest/lib/spend.mjs.'
    );
    return lines;
  }

  const anyUnmeasured = (aggregate.unmeasuredCalls ?? 0) > 0;
  lines.push(
    `spend by phase (${aggregate.entriesWithUsage} of ${aggregate.entriesTotal} entries carry usage` +
      (anyUnmeasured ? `; ${aggregate.unmeasuredCalls} call(s) happened with tokens UNKNOWN` : '') +
      '):',
    ''
  );
  const totalAll = totalTokens(aggregate.total) || 1;
  for (const phase of PHASE_ORDER) {
    const bucket = aggregate.byPhase[phase];
    if (!bucket) continue;
    const tokens = totalTokens(bucket);
    // A phase whose calls were ALL unmeasured gets NO percentage and NO bar.
    // The barbell is a claim about spend, and one P1 call against a frontier
    // model and one P4 call on a cheap seat are both "one call" — presenting a
    // call share in the same shape as a token share would be a confident wrong
    // number, which is worse than the silence it replaced.
    if (bucket.calls === 0 && bucket.unmeasuredCalls > 0) {
      lines.push(
        `  ${phase.padEnd(12)} ${''.padEnd(20)} ${'—'.padStart(5)}   ` +
        `${bucket.unmeasuredCalls} call(s), tokens unknown (unmeasured)`
      );
      continue;
    }
    const share = ((tokens / totalAll) * 100).toFixed(1);
    const bar = '█'.repeat(Math.max(1, Math.round((tokens / totalAll) * 20)));
    const caveat = bucket.unmeasuredCalls > 0 ? ` [+${bucket.unmeasuredCalls} unmeasured call(s)]` : '';
    lines.push(
      `  ${phase.padEnd(12)} ${bar.padEnd(20)} ${share.padStart(5)}%  ` +
      `${bucket.calls} call(s), ${tokens} tokens (in=${bucket.inputTokens} out=${bucket.outputTokens} cached=${bucket.cachedTokens})${caveat}`
    );
  }
  if (anyUnmeasured) {
    lines.push(
      '',
      'shares are over MEASURED tokens only; a phase marked unmeasured made real calls',
      'whose cost this tool cannot see (e.g. a gate whose printed prompt your harness answered).'
    );
  }
  lines.push('');
  // The TOTAL line has the same hazard as a phase line: printing "0 tokens" over
  // a ledger of unmeasured calls states a cost this tool does not know. When
  // nothing was measured it must say so; when some was, it must scope the number
  // to the calls it actually covers.
  if (aggregate.total.calls === 0 && anyUnmeasured) {
    lines.push(`total: ${aggregate.unmeasuredCalls} call(s), tokens unknown (none of these calls reported usage)`);
  } else {
    // "total" must mean TOTAL. Leading with the measured count while a further
    // N calls went unmeasured contradicts itself, and anything scraping the
    // familiar `total: N call(s)` shape would record the wrong number
    // (adversarial-review). The breakdown follows the true total instead.
    const measured = aggregate.total.calls;
    const head = anyUnmeasured
      ? `total: ${measured + aggregate.unmeasuredCalls} call(s) — ${measured} measured, ${aggregate.unmeasuredCalls} unmeasured`
      : `total: ${measured} call(s)`;
    const scope = anyUnmeasured ? ` across the ${measured} measured` : '';
    lines.push(
      `${head}, ${totalTokens(aggregate.total)} tokens ` +
      `(in=${aggregate.total.inputTokens} out=${aggregate.total.outputTokens} cached=${aggregate.total.cachedTokens})${scope}`
    );
  }

  const diag = diagnostics(aggregate);
  if (diag.length > 0) {
    lines.push('', 'diagnostics (ADLC.md §6):');
    for (const d of diag) lines.push(`  - ${d}`);
  }

  return lines;
}

/**
 * Load manifest entries and aggregate — the entry point CLI/tests use.
 * @param {object} opts
 * @param {string|undefined} opts.ticket
 * @param {string} [opts.dir]
 */
export function loadSpend({ ticket, dir } = {}) {
  const { entries, skipped } = loadFiltered({ ticket, dir });
  return { aggregate: aggregateSpend(entries), skipped };
}
