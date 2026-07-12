// WorkerAdapter: Pi coding agent (headless). Model plane (K2).
//
// DEFAULT invocation: `pi run <prompt>`. Confidence: LOW — pi has no `-p` flag;
// docs/specs/pi-native-flush.md documents the native non-interactive patterns as
// a child `pi` subprocess or the SDK's `createAgentSession` / `--mode rpc`
// (JSONL). The exact headless CLI form must be VERIFIED against the installed
// `@earendil-works/pi-coding-agent` version; until then this default is a
// best-effort placeholder and is expected to be set via `fleet.adapterArgs`
// (e.g. `["--mode","rpc"]` with the prompt on stdin). Overridable via
// `command`/`args`, and `useStdin` routes the prompt to stdin for the rpc form.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'pi';
export const pool = 'default';

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'pi', args, useStdin = false }) {
  const argv = args ?? ['run', prompt];
  const opts = { cwd: worktree, env, timeout: timeoutMs };
  if (useStdin) opts.input = prompt;
  const res = await exec(command, argv, opts);
  return mapResult(res);
}
