// WorkerAdapter: Google Antigravity CLI (`agy --print`). Model plane (K2).
//
// DEFAULT invocation: `agy --print [--model <model>]` with the prompt on STDIN.
// Confidence: HIGH — this shape is verified against antigravity-booster's
// runAgy (../antigravity-booster/lib/agy.mjs), which pipes the prompt to stdin
// and reads print-mode stdout. `model` comes from `fleet.model`. Overridable via
// `command`/`args`. agy meters per-model quota pools; a future multi-pool config
// (spec §10) can route `pool` per model, but v1 uses the single default pool.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'agy';
export const pool = 'default';

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'agy', args, model }) {
  const argv = args ?? ['--print', ...(model ? ['--model', model] : [])];
  // agy reads the prompt from stdin (not an argv position).
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs, input: prompt });
  return mapResult(res);
}
