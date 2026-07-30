// WorkerAdapter: OpenCode CLI (`opencode run`, headless). Model plane (K2).
//
// DEFAULT invocation: `opencode run <prompt>` — OpenCode's non-interactive run
// mode. Confidence: medium — VERIFY the `run` subcommand/flags against the
// installed `opencode` version. Overridable via `command`/`args`.

import { defaultExec, mapResult, modelArgs } from './_shared.mjs';
import { UNREPORTED, jsonLines, normalizeUsage, reported } from './usage.mjs';

export const name = 'opencode';
export const pool = 'default';

/**
 * Run-time aliases this harness resolves for itself (operating-stack §4b rule 6).
 * `opencode run -m` takes a concrete `provider/model` pair — verified against the
 * installed CLI's `run --help` — so the only non-concrete value is the registry's
 * own `default` sentinel. A reviewer seat naming any of these is rejected at load:
 * reviewer identity must be a model ID, not something the harness picks later.
 */
export const aliases = Object.freeze(['default']);

/** `-m` accepts an explicit provider/model pair, so this adapter can serve a registry seat (§4c). */
export const forcesModel = true;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

/**
 * Parse usage out of `opencode run --format json` output (T152, §8a).
 *
 * `--format json` is documented as "raw JSON events" and emits JSONL — one
 * event per line. Measured against the installed CLI, tokens ride exactly one
 * event type:
 *
 *   type=step_start   part carries no tokens
 *   type=text         part carries no tokens
 *   type=step_finish  part.tokens + part.cost   <- the carrier
 *
 * A run with tool use emits several steps; each is a real model call, so their
 * counters SUM. Returns the `{usage, usageStatus, usageRaw}` triple, or
 * UNREPORTED when the stream carried no step_finish (plain-text output, an
 * older CLI, a crash before the first step) or the counters made no sense.
 */
export function parseUsage(output) {
  let sawCarrier = false;
  let input = 0;
  let total = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let outputRaw = 0;
  let reasoning = 0;

  for (const evt of jsonLines(output)) {
    if (evt.type !== 'step_finish') continue;
    const tokens = evt.part?.tokens;
    if (tokens === null || typeof tokens !== 'object') continue;
    sawCarrier = true;
    input += tokens.input ?? 0;
    total += tokens.total ?? 0;
    outputRaw += tokens.output ?? 0;
    reasoning += tokens.reasoning ?? 0;
    cacheRead += tokens.cache?.read ?? 0;
    cacheWrite += tokens.cache?.write ?? 0;
  }

  if (!sawCarrier) return UNREPORTED;

  // outputTokens is `total - input`, NOT `output`. Measured against the real
  // CLI, reasoning tokens are ADDITIVE rather than a subset of output:
  //   kimi-k3: input 61669 + output 16 = 61685, but total = 61732 = 61685 + 47
  // so mapping outputTokens <- output silently DROPS billed reasoning tokens
  // and makes a reasoning-heavy phase look cheaper than it was. Deriving from
  // the harness's own total is also robust to opencode adding a fourth token
  // category later, since it never trusts the component split.
  //
  // Folding reasoning into outputTokens is correct, not a workaround: spend's
  // diagnostics() works purely in phase shares of (input + output), and every
  // existing mapping already folds it the same way — OpenAI's
  // completion_tokens and Anthropic's output_tokens both include it. A
  // dedicated reasoningTokens counter is a real improvement, but it changes
  // spend.mjs, which is this ticket's declared rail — it belongs to #408.
  const usage = normalizeUsage({
    inputTokens: input,
    outputTokens: total - input,
    cachedTokens: cacheRead + cacheWrite,
  });
  if (usage === null) return UNREPORTED;

  // Keep the harness's own split verbatim alongside the normalized triple.
  // aggregateSpend ignores keys it does not know, so this stays byte-compatible
  // while making #408 backfillable from already-recorded entries rather than
  // starting from zero.
  return reported(usage, { input: input, output: outputRaw, reasoning, cache: { read: cacheRead, write: cacheWrite }, total });
}

/**
 * Rebuild the assistant's text from the `type=text` events, so `output` keeps
 * meaning "what the worker said" after the switch to `--format json`. Returns
 * null when the stream carried no text events, so the caller can fall back to
 * raw stdout rather than silently reporting an empty transcript.
 *
 * This is strictly cleaner than the plain-text mode it replaces: measured
 * against the real CLI, `opencode run` (no --format) prints ANSI escapes and a
 * decorative banner around the content —
 *   \x1b[0m\n> Sisyphus - ultraworker · glm-5.2\n\x1b[0m\nok\n
 * where the reconstruction yields exactly `ok`. Nothing but decoration is lost,
 * and the flail detector's transcript gets the content without the escapes.
 */
export function parseText(output) {
  const parts = [];
  for (const evt of jsonLines(output)) {
    if (evt.type === 'text' && typeof evt.part?.text === 'string') parts.push(evt.part.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'opencode', args, model }) {
  // Ask for machine-readable events so usage is observable at all. Added only
  // to the DEFAULT argv: an explicit `args` override is the caller's contract,
  // and silently appending a format flag could contradict it. Such a run simply
  // parses as unreported, which is the honest answer.
  const argv = args ?? ['run', '--format', 'json', ...modelArgs('-m', model), prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  const mapped = mapResult(res);
  const stdout = `${res.stdout ?? ''}`;
  const text = parseText(stdout);
  return {
    ...mapped,
    output: text === null ? mapped.output : `${text}${res.stderr ?? ''}`,
    ...parseUsage(stdout),
  };
}
