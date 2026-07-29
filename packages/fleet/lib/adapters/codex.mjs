// WorkerAdapter: OpenAI Codex CLI (headless). Model plane (spec §7.3 K2).
//
// DEFAULT invocation: `codex exec <prompt>` — Codex's non-interactive/headless
// mode. Confidence: medium — VERIFY the exact non-interactive flags against the
// installed `codex` CLI version (newer builds add approval/sandbox flags such as
// `--full-auto`). Overridable: pass `command`/`args` (from `fleet.adapterCommand`
// / `fleet.adapterArgs`) so a CLI change is a config fix, not a code change.

import { defaultExec, mapResult, modelArgs } from './_shared.mjs';

export const name = 'codex';
export const pool = 'default';

/**
 * Run-time aliases this harness resolves for itself (operating-stack §4b rule 6).
 * `codex exec -m/--model <MODEL>` takes a concrete model slug — verified against
 * the installed CLI's `exec --help` — so the only non-concrete value is the
 * registry's own `default` sentinel.
 */
export const aliases = Object.freeze(['default']);

/** `-m/--model` accepts an explicit model slug, so this adapter can serve a registry seat (§4c). */
export const forcesModel = true;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'codex', args, model }) {
  // `codex exec [OPTIONS] [PROMPT]` — options precede the positional prompt.
  const argv = args ?? ['exec', ...modelArgs('-m', model), prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
