// prosecutor.mjs — the deterministic P5 prosecution loop for pi (spec 4.1).
//
// This is first-party orchestration over @adlc/core's TESTED lens machinery:
// the loop fans out one fresh-context child per lens, dedupes across lenses,
// verifies survivors, records confirmed findings to the .adlc ledger, and loops
// until shouldContinue reports convergence. The child runner is INJECTED
// (`runLens(prompt, { signal, timeout }) -> string`) so unit tests drive a
// scripted fake — no real subprocess spawns under `node --test`. The default
// runner (defaultRunLens) spawns the repo's pinned `pi` binary in print mode.
//
// The decision logic (dedupe, survives-verification, loop-until-dry) is NOT
// re-implemented here: it lives in @adlc/core/prosecutor.mjs and is consumed
// as-is. This module is the pi-specific glue that turns those pure helpers into
// a running loop with bounded concurrency, per-lens timeouts, and degraded-lens
// reporting.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LENSES,
  VERIFIER,
  dedupeFindings,
  survivesVerification,
  shouldContinue,
  findingKey,
  recordFinding,
  extractJson,
} from '@adlc/core';
import { scrubHookSecrets } from '@adlc/context-handoff/lib/secret-scrub.mjs';

/** Default bounds (spec 4.1: max 4 concurrent, 120s/lens, max 3 rounds). */
export const DEFAULT_OPTIONS = Object.freeze({
  concurrency: 4,
  timeout: 120_000,
  maxRounds: 3,
  maxDry: 2,
  verifierSamples: 1,
});

/**
 * Resolve the child `pi` binary: the repo's pinned bin, falling back to `pi`
 * on PATH. Kept separate so tests can assert the resolution without spawning.
 */
export function resolvePiBin(repoRoot) {
  const local = join(repoRoot, 'node_modules', '.bin', 'pi');
  return existsSync(local) ? local : 'pi';
}

/**
 * The default lens runner: spawn a fresh-context child `pi` in print mode
 * (`-p <prompt> --no-session`) rooted at the repo. Children use the user's
 * configured provider/model — keyless by construction. The loop enforces the
 * timeout via the AbortSignal it passes, but the runner also self-guards so a
 * hung child is reaped even when called outside the loop.
 *
 * The child's environment is an explicitly scrubbed COPY of process.env — never
 * the live env object — so ADLC_MANIFEST_KEY/ADLC_ADMIN_KEY never reach a child
 * whose prompt embeds attacker-influenced diff text (issue #843), and the
 * parent process's own env is left untouched for every other consumer in this
 * process.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {typeof spawn} [opts.spawnFn] injectable spawn, default the real one
 * @returns {(prompt: string, ctl: { signal?: AbortSignal, timeout?: number }) => Promise<string>}
 */
export function defaultRunLens(repoRoot, { spawnFn = spawn } = {}) {
  const piBin = resolvePiBin(repoRoot);
  return (prompt, { signal, timeout = DEFAULT_OPTIONS.timeout } = {}) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env };
      scrubHookSecrets(env);
      const child = spawnFn(piBin, ['-p', prompt, '--no-session'], { cwd: repoRoot, env });
      let out = '';
      let err = '';
      const done = (fn, arg) => {
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fn(arg);
      };
      const timer = setTimeout(() => done(reject, new Error(`lens child timed out after ${timeout}ms`)), timeout);
      if (signal) {
        if (signal.aborted) return done(reject, signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', () => done(reject, signal.reason ?? new Error('aborted')), { once: true });
      }
      child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => done(reject, e));
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`lens child exited ${code}: ${err.slice(0, 300)}`));
      });
    });
}

/** Build the hostile-reviewer prompt for a single lens over the diff. */
export function buildLensPrompt(lens, diff, ticket) {
  return [
    `You are a hostile ADLC pre-merge reviewer working the "${lens.key}" lens.`,
    `Focus ONLY on: ${lens.focus}.`,
    ticket ? `Ticket ${ticket.id}: ${ticket.title}` : '',
    'Review the diff below and output a JSON array of findings. Each finding is an',
    'object with: severity (critical|high|medium|low), file, line_start, line_end',
    '(post-change line numbers; 0,0 = file-level), title, body, evidence (quoted',
    'from the diff), recommendation. Ground every finding in the diff; output [] if',
    'you find nothing. Output ONLY the JSON array.',
    '',
    '=== DIFF ===',
    diff,
  ].filter(Boolean).join('\n');
}

/** Build the refutation prompt handed to a fresh verifier child per finding. */
export function buildVerifierPrompt(finding, diff, ticket) {
  return [
    'You are an ADLC prosecution VERIFIER. You are given ONE finding. Try to',
    'REFUTE it, not to agree. Build the most concrete reproduction or',
    'counterexample you can, then decide whether it is a real defect.',
    ticket ? `Ticket ${ticket.id}: ${ticket.title}` : '',
    'Output ONLY a JSON object: { "real": true|false, "reason": "<mechanism>" }.',
    'Set real=true only with a concrete repro/mechanism; real=false only with a',
    'concrete counterexample or proof it is already handled.',
    '',
    '=== FINDING ===',
    JSON.stringify({
      severity: finding.severity,
      file: finding.file,
      line_start: finding.line_start,
      line_end: finding.line_end,
      title: finding.title,
      body: finding.body,
      evidence: finding.evidence,
    }, null, 2),
    '',
    '=== DIFF ===',
    diff,
  ].filter(Boolean).join('\n');
}

/**
 * Tolerant finding parser: extract the first JSON value from model output and
 * normalize to an array of finding objects that carry a `file`. Unparseable or
 * fileless output yields zero findings (a garbled lens contributes nothing; it
 * is NOT counted as an error — only a runner timeout/throw is a degraded lens).
 */
export function parseFindings(text) {
  let value;
  try {
    value = extractJson(text);
  } catch {
    return [];
  }
  const list = Array.isArray(value) ? value : Array.isArray(value?.findings) ? value.findings : [value];
  return list.filter((f) => f && typeof f === 'object' && typeof f.file === 'string' && f.file.trim() !== '');
}

/** Parse a single verifier vote; a non-boolean `real` yields an invalid vote. */
export function parseVote(text) {
  try {
    const v = extractJson(text);
    if (v && typeof v === 'object' && typeof v.real === 'boolean') return { real: v.real, reason: v.reason };
  } catch { /* fall through to invalid */ }
  return {}; // invalid vote — survivesVerification discards it (fail-closed)
}

/** Best-effort model hint so the summary can surface which model answered. */
export function extractModelHint(text) {
  const m = /"model"\s*:\s*"([^"]+)"/.exec(text) || /\bmodel[:=]\s*([\w./-]+)/i.exec(text);
  return m ? m[1] : null;
}

/** Run `worker` over `items` with at most `limit` in flight; preserves order. */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Await `promise`, but abort via `controller` and reject after `timeout` ms.
 * This makes the loop the authority on the per-lens deadline: even a runner
 * that ignores its signal and never settles is abandoned here (AC3).
 */
function withDeadline(promise, timeout, controller) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { controller.abort(new Error(`lens timed out after ${timeout}ms`)); } catch { /* noop */ }
      reject(new Error(`lens timed out after ${timeout}ms`));
    }, timeout);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Deterministic P5 loop.
 *
 * @param {object} args
 * @param {string} args.diff              the change under prosecution
 * @param {object|null} args.ticket       active ticket (for prompt context)
 * @param {(prompt: string, ctl: {signal: AbortSignal, timeout: number}) => Promise<string>} args.runLens
 *   injected child runner (default child pi). Both lens and verifier prompts go
 *   through this one runner; the prompt text distinguishes them.
 * @param {object} [args.options]         bounds (see DEFAULT_OPTIONS)
 * @param {string} [args.recordDir]       .adlc dir for recordFinding (default '.adlc')
 * @param {(finding: object, dir?: string) => any} [args.record]  recorder (default recordFinding)
 * @param {(msg: string) => void} [args.onProgress]  optional progress callback
 * @returns {Promise<{rounds:number, findings:object[], dryPasses:number,
 *   verdict:'CLEAN'|'FINDINGS', degradedLenses:object[], models:string[]}>}
 */
export async function prosecute({ diff, ticket = null, runLens, options = {}, recordDir = '.adlc', record = recordFinding, onProgress } = {}) {
  if (typeof runLens !== 'function') throw new Error('prosecute: runLens must be a function');
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Empty diff → nothing to prosecute. Zero lenses, zero children, CLEAN. This
  // is the fast path the live smoke exercises (base=HEAD, no spawns) (AC5).
  if (!diff || diff.trim() === '') {
    return { rounds: 0, findings: [], dryPasses: 0, verdict: 'CLEAN', degradedLenses: [], models: [] };
  }

  const seen = new Set();          // findingKey of every finding ever surfaced (dedupe vs SEEN, not confirmed) — AC2
  const confirmed = [];            // survived verification + recorded
  const degradedLenses = [];       // { lens, round, reason } — AC3
  const models = new Set();
  let dryStreak = 0;
  let dryPasses = 0;
  let round = 0;

  const noteModel = (text) => { const h = extractModelHint(text); if (h) models.add(h); };

  while (round < opts.maxRounds) {
    round += 1;
    onProgress?.(`round ${round}: fanning out ${LENSES.length} lenses`);

    // --- fan out lenses (bounded concurrency, per-lens deadline) ---
    const lensResults = await runPool(LENSES, opts.concurrency, async (lens) => {
      const controller = new AbortController();
      try {
        const out = await withDeadline(
          runLens(buildLensPrompt(lens, diff, ticket), { signal: controller.signal, timeout: opts.timeout }),
          opts.timeout,
          controller
        );
        noteModel(out);
        return parseFindings(out);
      } catch (err) {
        degradedLenses.push({ lens: lens.key, round, reason: err?.message ?? String(err) });
        return [];
      }
    });

    const deduped = dedupeFindings(lensResults.flat());
    // Fresh = not seen in any prior round. Mark seen BEFORE verification so a
    // finding the verifier REJECTS this round does not re-enter as "new" next
    // round (AC2: dedupe vs seen, not vs confirmed).
    const fresh = deduped.filter((f) => !seen.has(findingKey(f)));
    for (const f of fresh) seen.add(findingKey(f));

    // --- verify each fresh finding (fresh verifier children) ---
    let freshConfirmed = 0;
    for (const f of fresh) {
      const votes = await runPool(
        new Array(opts.verifierSamples).fill(0),
        opts.concurrency,
        async () => {
          const controller = new AbortController();
          try {
            const out = await withDeadline(
              runLens(buildVerifierPrompt(f, diff, ticket), { signal: controller.signal, timeout: opts.timeout }),
              opts.timeout,
              controller
            );
            noteModel(out);
            return parseVote(out);
          } catch {
            // A verifier that errors casts no valid vote; survivesVerification
            // fails closed (an all-error verifier keeps the finding as a blocker).
            return {};
          }
        }
      );
      if (survivesVerification(votes)) {
        record(
          {
            file: f.file,
            desc: (f.title || f.body || 'prosecution finding').trim(),
            category: 'prosecution',
            severity: f.severity,
            line: Number.isInteger(f.line_start) && f.line_start > 0 ? f.line_start : 1,
            verdict: 'confirmed',
          },
          recordDir
        );
        confirmed.push(f);
        freshConfirmed += 1;
      }
    }

    // --- convergence (loop-until-dry, @adlc/core controller) ---
    const step = shouldContinue({ freshThisRound: freshConfirmed, dryStreak, maxDry: opts.maxDry });
    if (step.dryStreak > dryStreak) dryPasses += 1; // this round surfaced no new confirmed finding
    dryStreak = step.dryStreak;
    if (!step.continue) break;
  }

  return {
    rounds: round,
    findings: confirmed,
    dryPasses,
    verdict: confirmed.length ? 'FINDINGS' : 'CLEAN',
    degradedLenses,
    models: [...models],
  };
}

/** Human-readable one-block summary for the tool result text. */
export function renderSummary(summary) {
  const lines = [
    `ADLC prosecution: ${summary.verdict} (${summary.rounds} round${summary.rounds === 1 ? '' : 's'}, ${summary.dryPasses} dry pass${summary.dryPasses === 1 ? '' : 'es'})`,
  ];
  if (summary.models.length) lines.push(`Models: ${summary.models.join(', ')}`);
  if (summary.degradedLenses.length) {
    lines.push(`Degraded lenses (not counted as clean): ${summary.degradedLenses.map((d) => `${d.lens}@r${d.round}`).join(', ')}`);
  }
  if (summary.findings.length === 0) {
    lines.push('No confirmed findings survived verification.');
  } else {
    lines.push(`${summary.findings.length} confirmed finding${summary.findings.length === 1 ? '' : 's'}:`);
    for (const f of summary.findings) {
      lines.push(`- [${f.severity ?? 'medium'}] ${f.file}:${f.line_start ?? 0} — ${f.title ?? f.body ?? ''}`);
    }
  }
  return lines.join('\n');
}
