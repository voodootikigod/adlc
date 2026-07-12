// WorkerAdapter: Cursor agent CLI (`cursor-agent -p`, headless print). Model plane (K2).
//
// DEFAULT invocation: `cursor-agent -p <prompt>` — Cursor's headless/print CLI.
// Confidence: medium — VERIFY the `cursor-agent` binary name and `-p` flag
// against the installed Cursor CLI. Overridable via `command`/`args`.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'cursor';
export const pool = 'default';

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'cursor-agent', args }) {
  const argv = args ?? ['-p', prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
