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
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function addUsage(bucket, usage) {
  bucket.calls += 1;
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.cachedTokens += usage.cachedTokens ?? 0;
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

  for (const entry of entries) {
    const usage = entry?.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    entriesWithUsage++;

    const phase = phaseForGate(entry.gate);
    byPhase[phase] ??= emptyBucket();
    addUsage(byPhase[phase], usage);

    byGate[entry.gate] ??= { ...emptyBucket(), phase };
    addUsage(byGate[entry.gate], usage);

    addUsage(total, usage);
  }

  return { byPhase, byGate, total, entriesWithUsage, entriesTotal: entries.length };
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
  const phasesWithSpend = Object.keys(byPhase).filter((p) => p !== 'unphased');
  if (phasesWithSpend.length < 2 || total.inputTokens + total.outputTokens === 0) return [];

  const out = [];
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

  if (aggregate.entriesWithUsage === 0) {
    lines.push(
      `no recorded usage (0 of ${aggregate.entriesTotal} manifest entries carry data.usage).`,
      'gates report usage by threading complete()\'s onUsage callback into their own',
      'gate-manifest record() call as data.usage — see packages/gate-manifest/lib/spend.mjs.'
    );
    return lines;
  }

  lines.push(`spend by phase (${aggregate.entriesWithUsage} of ${aggregate.entriesTotal} entries carry usage):`, '');
  const totalAll = totalTokens(aggregate.total) || 1;
  for (const phase of PHASE_ORDER) {
    const bucket = aggregate.byPhase[phase];
    if (!bucket) continue;
    const tokens = totalTokens(bucket);
    const share = ((tokens / totalAll) * 100).toFixed(1);
    const bar = '█'.repeat(Math.max(1, Math.round((tokens / totalAll) * 20)));
    lines.push(
      `  ${phase.padEnd(12)} ${bar.padEnd(20)} ${share.padStart(5)}%  ` +
      `${bucket.calls} call(s), ${tokens} tokens (in=${bucket.inputTokens} out=${bucket.outputTokens} cached=${bucket.cachedTokens})`
    );
  }
  lines.push('');
  lines.push(
    `total: ${aggregate.total.calls} call(s), ${totalTokens(aggregate.total)} tokens ` +
    `(in=${aggregate.total.inputTokens} out=${aggregate.total.outputTokens} cached=${aggregate.total.cachedTokens})`
  );

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
