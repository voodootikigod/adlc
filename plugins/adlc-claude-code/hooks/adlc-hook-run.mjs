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

/**
 * Exit code for a wrapper that failed before it could dispatch — an unresolvable entry
 * point, or any unexpected error during module evaluation. Same fail-closed direction as
 * a timeout: enforcing modes deny (2), advisory modes stay out of the user's way (0).
 */
export function importFailureExitCode(mode) {
  return ENFORCING_MODES.has(mode) ? 2 : 0;
}

/**
 * Whether this module is the process entry point: 'yes' | 'no' | 'unknown'.
 *
 * 'unknown' means argv[1] could not be resolved on disk — a virtual or synthetic entry
 * point from a bundler, an embedded REPL, or a test runner. It must never collapse into
 * 'no': the caller may well have invoked us as the entry point, and quietly declining to
 * dispatch exits 0, which lets an enforcing hook's tool call proceed ungated. Callers
 * treat 'unknown' as fail-closed. The probe itself never throws.
 */
export function entryPointState(moduleUrl, argv1, { realpath = realpathSync } = {}) {
  if (!argv1) return 'no';
  // Plain string match first: when argv[1] already names this file, the answer is 'yes'
  // without touching the filesystem at all, so a broken fs cannot turn a direct
  // invocation into a deny. The realpath probes below only exist to see through symlinks
  // (the ESM loader canonicalises import.meta.url, node does not canonicalise argv[1]).
  const selfPath = fileURLToPath(moduleUrl);
  if (selfPath === argv1) return 'yes';
  let self;
  try {
    self = realpath(selfPath);
  } catch {
    return 'unknown';
  }
  if (self === argv1) return 'yes';
  try {
    return realpath(argv1) === self ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
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
  // SessionStart continuation notice: advisory, so a timeout exits 0. Same
  // budget as the enforcing modes, minus the same buffer — the value is stated
  // once here rather than restated from hooks.json, which is free to drift.
  handoffstart: 10_000,
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
  // The operational-error paths below return 1, which does NOT block in Claude Code, so
  // they fail open for enforcing modes exactly as a timeout used to. That is deliberate
  // here and tracked in #567: denying on a broken install would block the repair too, so
  // the escape hatch has to be designed with it rather than flipped in passing.
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

// Only run the dispatcher when executed directly — the wrapper tests import this module
// for dispatch/timeoutExitCode, and an import must never spawn adlc-hook.mjs.
//
// Everything below runs during module evaluation, where an uncaught throw exits 1. In
// Claude Code exit 1 does NOT block a tool call, so a crash here is the same fail-open
// hole seam 6 closed for timeouts — and it lands earlier, before dispatch() and its
// timeout handling exist. Hence the guard: any failure resolves to a deny for enforcing
// modes, and advisory modes are left exactly as non-blocking as they were.
try {
  const state = entryPointState(import.meta.url, process.argv[1]);
  if (state === 'yes') {
    process.exit(dispatch(process.argv));
  } else if (state === 'unknown') {
    const mode = process.argv[2] ?? '';
    const code = importFailureExitCode(mode);
    process.stderr.write(
      `adlc-hook-run: ${code === 2 ? 'DENY — ' : ''}cannot resolve the wrapper's own entry ` +
        `point (argv[1]: ${process.argv[1]}), so it cannot confirm the ` +
        `${mode || '(none)'} hook ran.` +
        `${code === 2 ? ' Denying rather than allowing an ungated tool call.' : ''}\n`,
    );
    // Advisory modes get the diagnostic but no block: code is 0, so fall through and let
    // module evaluation finish normally rather than exiting out from under an importer.
    if (code !== 0) process.exit(code);
  }
} catch (err) {
  const mode = process.argv[2] ?? '';
  const code = importFailureExitCode(mode);
  process.stderr.write(
    `adlc-hook-run: ${code === 2 ? 'DENY — ' : ''}the wrapper failed before dispatching ` +
      `(mode: ${mode || '(none)'}): ${err?.message ?? err}\n`,
  );
  process.exit(code);
}
