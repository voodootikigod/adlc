#!/usr/bin/env node
// adlc-hook-run.mjs — CWD-independent dispatcher for adlc-hook.mjs.
//
// Invoked via: node ${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs <mode>
// CC injects CLAUDE_PLUGIN_ROOT = the absolute path to the plugin's install directory
// (~/.claude/plugins/cache/adlc/<version>/), confirmed by live install (2026-06-22).
// CWD during hook execution = the user's project directory, NOT the plugin install dir,
// so a CWD-relative path cannot reach this file. The ${CLAUDE_PLUGIN_ROOT} form is the
// correct pattern (see docs/integrations/claude-code-plugin-hooks-investigation.md).
// Once node loads this file via that absolute path, import.meta.url gives us this
// file's own URL, letting us locate adlc-hook.mjs in the same hooks/ directory
// without any further CWD or path assumptions.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The enforcing modes must DENY — not silently allow — on a timeout or kill signal.
// In Claude Code a PreToolUse hook blocks the tool ONLY on exit code 2; exit 1 is a
// non-blocking error that lets the tool proceed (fail OPEN). So a timed-out enforcing
// hook must exit 2, not 1. Advisory modes exit 0 so they never block the user.
export const ENFORCING_MODES = new Set(['rails', 'buildgate', 'handoff']);

/** Exit code for a hook that timed out or was killed by a signal. */
export function timeoutExitCode(mode) {
  return ENFORCING_MODES.has(mode) ? 2 : 0;
}

// Self-terminate before CC's outer timeout fires to prevent silent session hangs.
// Timeouts mirror hooks.json values minus a 5 s buffer so the wrapper exits cleanly
// before CC sends SIGKILL. 'rails'/'buildgate' use 10 s (hooks.json: 15 s) because
// they are the security-critical enforcing hooks — a timeout here must be a hard
// deny, not silence. If CC reliably sends SIGKILL at its own timeout boundary this
// is belt-and-suspenders; confirm CC timeout enforcement during the live install test.
const TIMEOUTS_MS = {
  preflight: 55_000,  // hooks.json: 60 s
  context: 10_000,    // hooks.json: 15 s — T52: PreCompact/PostCompact/SubagentStart/SubagentStop
  flail: 25_000,      // hooks.json: 30 s
  manifest: 25_000,   // hooks.json: 30 s
  review: 25_000,     // hooks.json: 30 s
  rails: 10_000,      // hooks.json: 15 s — enforcing hook: deny on timeout
  buildgate: 10_000,  // hooks.json: 15 s — enforcing hook: deny on timeout
  handoff: 10_000,    // hooks.json timeout minus buffer — enforcing: deny on timeout
};

/**
 * Resolve the exit code for one hook dispatch. Pure and injectable: it RETURNS the
 * code instead of calling process.exit, and its spawn/exists/stderr dependencies are
 * parameters, so every path is unit-testable without spawning a real subprocess or
 * waiting on a real timeout. Behavior is identical to the previous inline dispatcher.
 */
export function dispatch(
  argv,
  {
    spawn = spawnSync,
    exists = existsSync,
    hookScript = join(dirname(fileURLToPath(import.meta.url)), 'adlc-hook.mjs'),
    stderr = (s) => process.stderr.write(s),
  } = {},
) {
  if (!exists(hookScript)) {
    // This should never happen — both files live in the same directory.
    stderr(`adlc-hook-run: adlc-hook.mjs not found at ${hookScript}\n`);
    return 1;
  }

  const mode = argv[2] ?? '';
  const timeoutMs = TIMEOUTS_MS[mode] ?? 25_000;

  const result = spawn(process.execPath, [hookScript, ...argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    timeout: timeoutMs,
  });

  if (result.error) {
    // ETIMEDOUT is raised by spawnSync when the timeout option fires.
    if (result.error.code === 'ETIMEDOUT') {
      stderr(`adlc-hook-run: hook timed out after ${timeoutMs} ms (mode: ${mode || '(none)'})\n`);
      return timeoutExitCode(mode);
    }
    stderr(`adlc-hook-run: failed to spawn adlc-hook.mjs: ${result.error.message}\n`);
    return 1;
  }

  // spawnSync sets signal when the child was killed by a signal (e.g. SIGTERM from timeout).
  if (result.signal) {
    stderr(`adlc-hook-run: hook killed by signal ${result.signal} (mode: ${mode || '(none)'})\n`);
    return timeoutExitCode(mode);
  }

  return result.status ?? 0;
}

// Only run the dispatcher when executed directly — the wrapper-timeout test imports this
// module for dispatch/timeoutExitCode, and an import must never spawn adlc-hook.mjs.
const invokedDirectly =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) process.exit(dispatch(process.argv));
