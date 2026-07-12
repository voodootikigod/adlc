// WorkerAdapter: OpenAI Codex CLI (headless). Model plane (spec §7.3 K2).
//
// DEFAULT invocation: `codex exec <prompt>` — Codex's non-interactive/headless
// mode. Confidence: medium — VERIFY the exact non-interactive flags against the
// installed `codex` CLI version (newer builds add approval/sandbox flags such as
// `--full-auto`). Overridable: pass `command`/`args` (from `fleet.adapterCommand`
// / `fleet.adapterArgs`) so a CLI change is a config fix, not a code change.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'codex';
export const pool = 'default';

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'codex', args }) {
  const argv = args ?? ['exec', prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
