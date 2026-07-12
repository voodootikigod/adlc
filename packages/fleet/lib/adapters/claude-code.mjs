// The v1 WorkerAdapter: headless Claude Code (spec §4, §7.2; K2 model plane).
//
// The adapter is a pure I/O shim — no retry, gate, or git logic (that is all
// scheduler policy, so future codex/agy/opencode adapters inherit it). It:
//   - provision(): writes the worktree's .claude/settings.local.json allowlist,
//     translating config command strings into Claude Code permission-rule form
//     (the load-bearing syntax step — premortem F1);
//   - dispatch(): runs `claude -p … --permission-mode acceptEdits` in the
//     worktree on the MODEL plane (provider egress + its own auth), explicitly
//     NOT wrapped in the no-network repo-command sandbox (K2), or it could never
//     authenticate.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const name = 'claude-code';
export const pool = 'default';

/**
 * Translate a config command string into a Claude Code permission rule. A raw
 * string allowlists NOTHING (premortem F1), so each becomes `Bash(<cmd>)`; a
 * command already carrying a `:*` wildcard is preserved.
 */
export function toPermissionRule(command) {
  return `Bash(${command})`;
}

/** Build the settings.local.json object for a worktree from config (§7.2). */
export function buildSettings(config = {}) {
  const gate = config.gate ?? {};
  const cmds = [
    ...(config.init ? [config.init] : []),
    ...(gate.build ? [gate.build] : []),
    ...(gate.test ? [gate.test] : []),
    ...(config.allowedCommands ?? []),
  ];
  const allow = [
    ...cmds.map(toPermissionRule),
    // read-only git the worker may need; NOT git commit (orchestrator commits).
    'Bash(git status)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
  ];
  return { permissions: { allow, deny: [] } };
}

/**
 * Write the allowlist settings into the worktree. Returns the object written.
 * `writeJson` is injectable so tests need no real filesystem.
 */
export function provision({ worktree, config, writeJson = defaultWriteJson }) {
  const settings = buildSettings(config);
  const path = join(worktree, '.claude', 'settings.local.json');
  writeJson(path, settings);
  return { settings, path };
}

function defaultWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Dispatch one build attempt. Runs on the MODEL plane: the worker process keeps
 * provider egress + its own auth and is NOT sandboxed (K2). `env` is the
 * model-plane env the scheduler built (ADLC_P4_ENFORCEMENT=1 + ADLC_TICKET + the
 * worker's own model auth). Returns { exitCode, output, timedOut }.
 *
 * @param exec injectable spawn: (cmd, args, opts) => { status, stdout, stderr, signal }
 */
export function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec }) {
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--output-format', 'text'];
  const res = exec('claude', args, { cwd: worktree, env, timeout: timeoutMs });
  const timedOut = res.signal === 'SIGTERM' || res.killed === true || res.timedOut === true;
  return {
    exitCode: typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1),
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    timedOut,
  };
}

function defaultExec(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, encoding: 'utf8' });
}
