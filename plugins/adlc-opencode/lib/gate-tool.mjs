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
 * Fail-safe: an unknown gate or a spawn failure returns a structured error
 * result rather than throwing, so a tool call never crashes the turn.
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
    res = spawnImpl('adlc', [name, ...cleanArgs], { cwd, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    return {
      title: `adlc_gate: ${name} could not run`,
      output: `Failed to execute \`adlc ${name}\`: ${String(err?.message ?? err)}. Is @adlc/cli installed (npm i -g @adlc/cli)?`,
      metadata: { gate: name, exitCode: null, llmBacked, error: 'spawn-failed' },
    };
  }
  const exitCode = res.status ?? (res.error ? 1 : 0);
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
 * by an isolated child session (makeAsk), and the answers are returned. This is
 * what makes the keyless bridge LIVE code — adlc_gate calls it for LLM gates so
 * they work inside OpenCode with no API key. Returns a structured result, or
 * null when the client can't spawn sessions (caller falls back to the CLI).
 */
export async function runGateKeyless2({ gate, args = [], client, parentID, cwd = process.cwd(), spawnImpl }) {
  const ask = makeAsk(client, { parentID });
  if (!ask) return null; // no session API → let the caller fall back
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

/**
 * Build the `adlc_gate` custom-tool definition map for the plugin `tool` hook
 * (Phase 4.2). `schema` is the host's zod (from @opencode-ai/plugin's
 * `tool.schema`), injected so this stays testable without the peer dependency.
 * `client` is the plugin's SDK client — when present, LLM-backed gates run
 * KEYLESS through the host model (child sessions); deterministic gates and the
 * no-client fallback run the CLI. Returns `{ adlc_gate: ToolDefinition }`.
 */
export function buildGateTool(schema, { root = process.cwd(), client, spawnImpl } = {}) {
  return {
    adlc_gate: {
      description:
        'Run an ADLC lifecycle gate and return its result. Gates: ' +
        `${GATE_BINS.join(', ')}. Prefer this over shelling out to \`adlc\` directly ` +
        '— it validates the gate name, runs LLM-backed gates keyless through the ' +
        'session model, and returns structured output. While rails are frozen, ' +
        'write-capable gates (hollow-test, review-calibration, consensus-fix, ' +
        'behavior-diff, gate-fuzzing) and mutation flags (--write/--record/' +
        '--append) are denied here — run those via the `adlc` CLI instead.',
      args: {
        gate: schema.string().describe('The ADLC gate to run, e.g. "preflight", "spec-lint", "coldstart", "merge-forecast".'),
        args: schema.array(schema.string()).optional().describe('Extra CLI arguments for the gate, e.g. ["--json"].'),
      },
      execute: async (a, ctx) => {
        const gate = String(a?.gate ?? '').trim();
        const args = a?.args ?? [];
        const cwd = ctx?.directory ?? ctx?.worktree ?? root;
        let result = null;
        // LLM-backed gate + a usable client → run keyless through the host model.
        if (LLM_BACKED_GATES.has(gate) && client) {
          result = await runGateKeyless2({ gate, args, client, parentID: ctx?.sessionID, cwd, spawnImpl });
        }
        // Deterministic gate, no client, or keyless unavailable → CLI.
        if (!result) {
          result = runGate({ gate, args, cwd, ...(spawnImpl ? { spawnImpl } : {}) });
        }
        try { ctx?.metadata?.({ title: result.title, metadata: result.metadata }); } catch { /* best-effort */ }
        return { title: result.title, output: result.output, metadata: result.metadata };
      },
    },
  };
}
