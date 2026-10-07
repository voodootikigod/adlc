// gate-tool.mjs — the first-party core of the native `adlc_gate` tool (Phase 4.2).
//
// The tool-HOOK wrapper (registering `adlc_gate` with the host so the model can
// call it) lives in index.mjs against the confirmed plugin `tool` contract; this
// module is the pure, testable dispatch it delegates to: validate the requested
// gate against the known gate set, build the `adlc <gate> …` argv, run it, and
// return a structured result. No SDK, no host api — unit-testable offline.

import { spawnSync } from 'node:child_process';
import { GATE_BINS } from '../gate-bins.mjs';
import { runGateKeyless, makeAsk } from './keyless-bridge.mjs';

const GATE_SET = new Set(GATE_BINS);

// A gate run's wall-clock bound. SIGKILL because a gate that ignores SIGTERM
// would otherwise outlive the bound inside the host process.
const GATE_TIMEOUT_MS = 120_000;

const INSTALL_HINT = 'Is @adlc/cli installed (npm i -g @adlc/cli)?';

/**
 * Why a spawnSync result carries no exit code, or null when it has one.
 * spawnSync reports a signal death as `{ status: null, signal }` with no
 * `error`, and its own timeout as `{ status: null, error: ETIMEDOUT }`; neither
 * is a gate verdict.
 *
 * @returns {{error: 'spawn-failed'|'timed-out'|'killed'|'no-exit-code', detail: string}|null}
 */
function incompleteRun(res) {
  if (res?.error?.code === 'ENOENT') {
    return { error: 'spawn-failed', detail: `adlc was not found. ${INSTALL_HINT}` };
  }
  if (res?.error?.code === 'ETIMEDOUT') {
    return { error: 'timed-out', detail: `timed out after ${GATE_TIMEOUT_MS}ms and was killed` };
  }
  if (res?.error) return { error: 'spawn-failed', detail: String(res.error.message ?? res.error) };
  if (typeof res?.status === 'number') return null;
  if (res?.signal) return { error: 'killed', detail: `killed by ${res.signal} before it exited` };
  return { error: 'no-exit-code', detail: 'the process reported no exit code' };
}

// Gates that IMPLEMENT --prompt-only (verified against each package's source —
// see the membership test). In OpenCode these run keyless (--prompt-only routed
// to the host model via the bridge); a plain CLI run of them would need an API
// key, so the tool surfaces that distinction rather than failing opaquely.
// Deliberately NOT here (no --prompt-only; they run as plain CLI gates):
// merge-forecast, model-router, hollow-test, behavior-diff, skill-rot.
export const LLM_BACKED_GATES = new Set([
  'parallax', 'premortem', 'spec-lint', 'coldstart', 'consensus-fix',
  'lesson-foundry', 'rejection-mining', 'gate-fuzzing', 'review-calibration',
]);

/**
 * Validate + run a deterministic (non-LLM) ADLC gate as `adlc <gate> [args…]`.
 * Returns a structured result the tool wrapper hands back to the model:
 *   { title, output, metadata: { gate, exitCode, llmBacked } }
 * Fail-safe: an unknown gate, a spawn failure, or a run that ended without an
 * exit code (timeout, signal) returns a structured error result with
 * `exitCode: null` rather than throwing, so a tool call never crashes the turn
 * and a killed gate is never read as a verdict.
 */
export function runGate({ gate, args = [], spawnImpl = spawnSync, cwd = process.cwd() }) {
  const name = String(gate ?? '').trim();
  if (!GATE_SET.has(name)) {
    return {
      title: `adlc_gate: unknown gate "${name}"`,
      output: `"${name}" is not a known ADLC gate. Known gates: ${GATE_BINS.join(', ')}.`,
      metadata: { gate: name, exitCode: null, llmBacked: false, error: 'unknown-gate' },
    };
  }
  const cleanArgs = (Array.isArray(args) ? args : []).map(String);
  const llmBacked = LLM_BACKED_GATES.has(name);
  let res;
  try {
    res = spawnImpl('adlc', [name, ...cleanArgs], { cwd, encoding: 'utf8', timeout: GATE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch (err) {
    return {
      title: `adlc_gate: ${name} could not run`,
      output: `Failed to execute \`adlc ${name}\`: ${String(err?.message ?? err)}. ${INSTALL_HINT}`,
      metadata: { gate: name, exitCode: null, llmBacked, error: 'spawn-failed' },
    };
  }
  const incomplete = incompleteRun(res);
  if (incomplete) {
    return {
      title: `adlc_gate: ${name} did not complete`,
      output: `\`adlc ${name}\` produced no verdict: ${incomplete.detail}. Treat the gate as NOT passed.`,
      metadata: { gate: name, exitCode: null, llmBacked, error: incomplete.error },
    };
  }
  const exitCode = res.status;
  const stdout = (res.stdout ?? '').trim();
  const stderr = (res.stderr ?? '').trim();
  const body = stdout || stderr || '(no output)';
  return {
    title: `adlc ${name} → exit ${exitCode}`,
    output: llmBacked && exitCode !== 0 && /api|key|provider/i.test(stderr)
      ? `${body}\n\n(Note: ${name} is LLM-backed — inside OpenCode run it keyless via --prompt-only so the host model answers, no API key.)`
      : body,
    metadata: { gate: name, exitCode, llmBacked },
  };
}

/**
 * Run an LLM-backed gate KEYLESSLY via the host model (Phase 4.1 → 4.2 wiring):
 * the gate runs in `--prompt-only` mode to emit its prompts, each is answered
 * by a tool-less host generation (makeAsk), and the answers are returned. This is
 * what makes the keyless bridge LIVE code — adlc_gate calls it for LLM gates so
 * they work inside OpenCode with no API key. Returns a structured result, or
 * null when the host has no generate API (caller falls back to the CLI).
 */
export async function runGateKeyless2({ gate, args = [], generate, cwd = process.cwd(), spawnImpl }) {
  const ask = makeAsk(generate);
  if (!ask) return null; // no generate API → let the caller fall back
  try {
    const { prompts, answers } = await runGateKeyless({
      bin: 'adlc',
      args: [gate, ...args.map(String)],
      ask,
      cwd,
      ...(spawnImpl ? { spawnImpl } : {}),
    });
    const output = answers.filter(Boolean).join('\n\n---\n\n') || '(no answer)';
    return {
      title: `adlc ${gate} (keyless, ${prompts.length} prompt${prompts.length === 1 ? '' : 's'})`,
      output,
      metadata: { gate, keyless: true, prompts: prompts.length, llmBacked: true },
    };
  } catch (err) {
    // The gate does not IMPLEMENT --prompt-only (set drift, or an upstream flag
    // change): the gate is runnable, just not keyless — fall back to the plain
    // CLI. Matched by the bridge's explicit error code, NOT by message shape: a
    // genuine nonzero exit from a prompt-only-supporting gate (bad args, crash)
    // must surface as keyless-failed, not be silently downgraded to a CLI run.
    if (err?.code === 'PROMPT_ONLY_UNSUPPORTED') return null;
    return {
      title: `adlc_gate: ${gate} keyless run failed`,
      output: `Keyless dispatch of ${gate} failed: ${String(err?.message ?? err)}.`,
      metadata: { gate, keyless: true, llmBacked: true, error: 'keyless-failed' },
    };
  }
}

/** A `{ title, output, metadata }` gate/prosecute result → an OpenCode v2 `Tool.Result`. */
export function toToolResult(result) {
  return { content: `${result.title}\n\n${result.output}`, metadata: { title: result.title, ...result.metadata } };
}

// v2 plugin tools default to Code Mode, reachable only through the `execute`
// tool — which the rails guard denies while rails are in force (its code
// carries no vettable target). The ADLC tools must stay callable then, so they
// are registered as direct tools.
export const DIRECT_TOOL_OPTIONS = Object.freeze({ codemode: false });

/**
 * Build the `adlc_gate` OpenCode v2 tool (`Tool.Info`, registered through
 * `ctx.tool.transform(ed => ed.add(...))`). The input schema is plain JSON
 * Schema, so no host schema library is needed. `generate` is the plugin
 * context's `ctx.generate` — when present, LLM-backed gates run KEYLESS through
 * the host model; deterministic gates and the no-generate fallback run the
 * CLI. v2 tool contexts carry no directory, so gates run in
 * `root`.
 */
export function buildGateTool({ root = process.cwd(), generate, spawnImpl } = {}) {
  return {
    name: 'adlc_gate',
    description:
      'Run an ADLC lifecycle gate and return its result. Gates: ' +
      `${GATE_BINS.join(', ')}. Prefer this over shelling out to \`adlc\` directly ` +
      '— it validates the gate name, runs LLM-backed gates keyless through the ' +
      'session model, and returns structured output. While rails are frozen, ' +
      'write-capable gates (hollow-test, review-calibration, consensus-fix, ' +
      'behavior-diff, gate-fuzzing) and mutation flags (--write/--record/' +
      '--append) are denied here — run those via the `adlc` CLI instead.',
    input: {
      type: 'object',
      properties: {
        gate: { type: 'string', description: 'The ADLC gate to run, e.g. "preflight", "spec-lint", "coldstart", "merge-forecast".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments for the gate, e.g. ["--json"].' },
      },
      required: ['gate'],
      additionalProperties: false,
    },
    options: DIRECT_TOOL_OPTIONS,
    execute: async (a) => {
      const gate = String(a?.gate ?? '').trim();
      const args = Array.isArray(a?.args) ? a.args : [];
      let result = null;
      // LLM-backed gate + a usable generate API → run keyless through the host model.
      if (LLM_BACKED_GATES.has(gate) && generate) {
        result = await runGateKeyless2({ gate, args, generate, cwd: root, spawnImpl });
      }
      // Deterministic gate, no generate API, or keyless unavailable → CLI.
      if (!result) {
        result = runGate({ gate, args, cwd: root, ...(spawnImpl ? { spawnImpl } : {}) });
      }
      return toToolResult(result);
    },
  };
}
