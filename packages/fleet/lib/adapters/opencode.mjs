// WorkerAdapter: OpenCode CLI (`opencode run`, headless). Model plane (K2).
//
// DEFAULT invocation: `opencode run <prompt>` — OpenCode's non-interactive run
// mode. Confidence: medium — VERIFY the `run` subcommand/flags against the
// installed `opencode` version. Overridable via `command`/`args`.

import { defaultExec, mapResult, modelArgs } from './_shared.mjs';
import { UNREPORTED, isCount, jsonLines, normalizeUsage, reported } from './usage.mjs';

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
 * §4b transport classes this harness can serve (issue #396).
 *
 * `gateway` — `opencode providers` manages the provider endpoints and
 * credentials itself, so a gateway seat names the transport and the HARNESS
 * knows where it lives. No endpoint is read from the registry: that keeps an
 * operator-controlled URL out of the dispatch path and needs no §4b schema
 * change. This is also how a LOCAL open-weights server is expressed —
 * `gateway:<name>`, mediated, with the endpoint in harness config.
 *
 * No `env` is declared for it: the credential lives in that same harness
 * config, so the worker needs no provider key in its environment at all.
 */
export const transports = Object.freeze({
  subscription: Object.freeze({}),
  gateway: Object.freeze({}),
});

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
  let sawTotal = true;   // cleared by any carrier that omits the optional `total`

  const { events, malformed } = jsonLines(output);
  // A truncated or partly-unparseable stream cannot be summed honestly: the
  // carriers we DID parse are a subset, and reporting a subset as complete
  // understates the call permanently while looking perfectly healthy.
  if (malformed) return UNREPORTED;

  for (const evt of events) {
    if (evt.type !== 'step_finish') continue;
    const tokens = evt.part?.tokens;
    // A carrier with NO usable token object is fatal, not skippable — skipping
    // it silently drops that step's spend from the sum (a newer CLI emitting a
    // carrier we don't understand must downgrade the whole call, not shrink it).
    if (tokens === null || typeof tokens !== 'object') return UNREPORTED;
    // EVERY field must be present and clean before it is accumulated. Defaulting
    // a missing counter to 0 would let a partial or version-skewed payload
    // assemble into a complete-looking triple that normalizeUsage cannot reject
    // — certifying an empty `tokens: {}` as a measured FREE call. A payload we
    // do not fully understand is unreported, not zero (adversarial-review).
    // The DOCUMENTED StepFinishPart shape is input/output/reasoning + cache
    // counters; `total` is an extra the installed runtime happens to emit and
    // is NOT required (adversarial-review compatibility). Requiring it made
    // every contract-shaped carrier from another provider or version parse as
    // unreported — the feature silently recording nothing on those routes.
    const documented = [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write];
    if (!documented.every(isCount)) return UNREPORTED;
    // `total` is optional, but if it IS present it must be a clean count — a
    // malformed one is a payload we do not understand, not one to ignore.
    if (tokens.total !== undefined && !isCount(tokens.total)) return UNREPORTED;
    sawCarrier = true;
    if (tokens.total === undefined) sawTotal = false;
    else total += tokens.total;
    input += tokens.input;
    outputRaw += tokens.output;
    reasoning += tokens.reasoning;
    cacheRead += tokens.cache.read;
    cacheWrite += tokens.cache.write;
  }

  if (!sawCarrier) return UNREPORTED;

  // outputTokens is a REMAINDER off the harness's own total, not `output`.
  // Measured against the real CLI, reasoning is ADDITIVE rather than a subset:
  //   kimi-k3: input 62779 + output 42 = 62821, but total = 62845 = 62821 + 24
  // so mapping outputTokens <- output silently DROPS billed reasoning and makes
  // a reasoning-heavy phase look cheaper than it was. Folding it in is what
  // every existing mapping already does — OpenAI's completion_tokens and
  // Anthropic's output_tokens both include it. A dedicated reasoningTokens
  // counter is a real improvement, but it changes spend.mjs, this ticket's
  // declared rail, so it belongs to #408.
  //
  // WHICH remainder depends on whether opencode counts cache INSIDE `input`,
  // and that could NOT be settled empirically: four real captures across two
  // models all report cache read/write of 0, which is consistent with BOTH
  // accountings. Guessing is not safe in either direction — if cache sits
  // outside `input`, a plain `total - input` folds every cached token into
  // outputTokens AND counts it again as cachedTokens, inflating output and
  // pricing cache at the output rate. So the payload is asked which identity
  // IT satisfies:
  //
  //   input + output + reasoning          == total  -> cache is inside input
  //   input + output + reasoning + cache  == total  -> cache is outside input
  //
  // Both yield the same generated-token figure, so the ledger is correct under
  // either. A payload satisfying NEITHER is an accounting we do not understand,
  // and is unreported rather than silently mis-booked (adversarial-review).
  const cached = cacheRead + cacheWrite;
  const generated = outputRaw + reasoning;

  // `generated` (output + reasoning) is the answer under BOTH accountings, so
  // it is what gets recorded. `total` is not needed to compute it — only to
  // CHECK it. When every carrier supplied a total, verify the stream is
  // self-consistent under one of the two accountings and reject it otherwise;
  // when total is absent (the documented shape), record generated directly
  // rather than discarding a perfectly good measurement.
  if (sawTotal) {
    const cacheInsideInput = input + generated === total;
    const cacheOutsideInput = input + generated + cached === total;
    if (!cacheInsideInput && !cacheOutsideInput) return UNREPORTED;
  }

  const usage = normalizeUsage({
    inputTokens: input,
    outputTokens: generated,
    cachedTokens: cached,
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
  for (const evt of jsonLines(output).events) {
    if (evt.type === 'text' && typeof evt.part?.text === 'string') parts.push(evt.part.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'opencode', args, model }) {
  // Ask for machine-readable events so usage is observable at all. Added only
  // to the DEFAULT argv: an explicit `args` override is the caller's contract,
  // and silently appending a format flag could contradict it.
  //
  // TRUST BOUNDARY (adversarial-review, injection): usage is parsed ONLY when
  // this adapter chose the argv itself. Under an `args` override the harness is
  // in plain-text mode, so stdout is the worker's own assistant text — content
  // a hostile ticket or repository can influence. Parsing it anyway let crafted
  // `step_finish` lines in that text be recorded as usageStatus 'reported',
  // i.e. caller-controlled numbers laundered into harness-ATTESTED telemetry.
  // That is precisely the claimed/reported boundary this ticket exists to hold.
  // (An earlier comment here asserted an override "simply parses as
  // unreported"; the code did not do that. It does now.)
  const selfSelected = args === undefined;
  const argv = args ?? ['run', '--format', 'json', ...modelArgs('-m', model), prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  const mapped = mapResult(res);
  if (!selfSelected) return { ...mapped, ...UNREPORTED };

  const stdout = `${res.stdout ?? ''}`;
  const text = parseText(stdout);
  return {
    ...mapped,
    output: text === null ? mapped.output : `${text}${res.stderr ?? ''}`,
    ...parseUsage(stdout),
  };
}
