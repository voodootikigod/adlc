// WorkerAdapter: GitHub Copilot CLI (`copilot -p`, non-interactive). Model plane (K2).
//
// DEFAULT invocation: `copilot -p <prompt> --allow-all-tools` — Copilot's
// non-interactive mode REQUIRES an allow-all-tools posture to run without
// approval prompts (verified against Copilot CLI 1.0.73; text output only, no
// JSON mode — see docs/integrations/copilot-probe-appendix.md).
//
// Permission posture is tunable. Denial always beats allow (even
// --allow-all-tools), so a fleet worker can strip capabilities:
//   * denyShell: true     → appends `--deny-tool shell` (removes the whole shell
//                           tool category — a read/write-only worker).
//   * allowTools/denyTools → extra `--allow-tool`/`--deny-tool` patterns
//                           (kind(argument): shell/write/url/<mcp-server>).
// Overridable wholesale via `command`/`args` (a CLI change is a config fix).
import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'copilot';
export const pool = 'default';

export async function dispatch({
  worktree,
  prompt,
  timeoutMs,
  env,
  exec = defaultExec,
  command = 'copilot',
  args,
  denyShell = false,
  allowTools,
  denyTools,
}) {
  let argv = args;
  if (!argv) {
    argv = ['-p', prompt, '--allow-all-tools'];
    for (const tool of allowTools ?? []) argv.push('--allow-tool', tool);
    for (const tool of denyTools ?? []) argv.push('--deny-tool', tool);
    if (denyShell) argv.push('--deny-tool', 'shell');
  }
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}
