// WorkerAdapter: OpenCode CLI (`opencode run`, headless). Model plane (K2).
//
// DEFAULT invocation: `opencode run <prompt>` — OpenCode's non-interactive run
// mode. Confidence: medium — VERIFY the `run` subcommand/flags against the
// installed `opencode` version. Overridable via `command`/`args`.

import { defaultExec, mapResult, modelArgs } from './_shared.mjs';

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

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'opencode', args, model }) {
  const argv = args ?? ['run', ...modelArgs('-m', model), prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
