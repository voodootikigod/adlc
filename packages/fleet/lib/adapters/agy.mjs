// WorkerAdapter: Google Antigravity CLI (`agy --print`). Model plane (K2).
//
// DEFAULT invocation: `agy --print [--model <model>]` with the prompt on STDIN.
// Confidence: HIGH — this shape is verified against antigravity-booster's
// runAgy (../antigravity-booster/lib/agy.mjs), which pipes the prompt to stdin
// and reads print-mode stdout. `model` comes from `fleet.model`. Overridable via
// `command`/`args`. agy meters per-model quota pools; a future multi-pool config
// (spec §10) can route `pool` per model, but v1 uses the single default pool.

import { defaultExec, mapResult, modelArgs } from './_shared.mjs';

export const name = 'agy';
export const pool = 'default';

/** Run-time aliases this harness resolves for itself (operating-stack §4b rule 6). */
export const aliases = Object.freeze(['default']);

/** `--model` accepts an explicit model, so this adapter can serve a registry seat (§4c). */
export const forcesModel = true;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'agy', args, model }) {
  // `modelArgs` (not a bare truthiness check) so the registry's `default`
  // sentinel is NOT emitted literally as `--model default` — that names a model
  // agy does not have. It means "let the harness resolve its own default".
  const argv = args ?? ['--print', ...modelArgs('--model', model)];
  // agy reads the prompt from stdin (not an argv position).
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs, input: prompt });
  return mapResult(res);
}
