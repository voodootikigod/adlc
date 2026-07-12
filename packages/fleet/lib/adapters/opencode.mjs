// WorkerAdapter: OpenCode CLI (`opencode run`, headless). Model plane (K2).
//
// DEFAULT invocation: `opencode run <prompt>` — OpenCode's non-interactive run
// mode. Confidence: medium — VERIFY the `run` subcommand/flags against the
// installed `opencode` version. Overridable via `command`/`args`.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'opencode';
export const pool = 'default';

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'opencode', args }) {
  const argv = args ?? ['run', prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
