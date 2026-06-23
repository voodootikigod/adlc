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
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'adlc-hook.mjs');

if (!existsSync(hookScript)) {
  // This should never happen — both files live in the same directory.
  process.stderr.write(`adlc-hook-run: adlc-hook.mjs not found at ${hookScript}\n`);
  process.exit(1);
}

// Self-terminate before CC's outer timeout fires to prevent silent session hangs.
// Timeouts mirror hooks.json values minus a 5 s buffer so the wrapper exits cleanly
// before CC sends SIGKILL. 'rails' uses 10 s (hooks.json: 15 s) because it is the
// security-critical enforcing hook — a timeout here must be a hard deny, not silence.
// If CC reliably sends SIGKILL at its own timeout boundary this is belt-and-suspenders;
// confirm CC timeout enforcement during the live install test.
const mode = process.argv[2] ?? '';
const TIMEOUTS_MS = {
  preflight: 55_000, // hooks.json: 60 s
  flail: 25_000,     // hooks.json: 30 s
  manifest: 25_000,  // hooks.json: 30 s
  rails: 10_000,     // hooks.json: 15 s — enforcing hook: deny on timeout
};
const timeoutMs = TIMEOUTS_MS[mode] ?? 25_000;

const result = spawnSync(
  process.execPath,
  [hookScript, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
    timeout: timeoutMs,
  }
);

if (result.error) {
  // ETIMEDOUT is raised by spawnSync when the timeout option fires.
  if (result.error.code === 'ETIMEDOUT') {
    process.stderr.write(
      `adlc-hook-run: hook timed out after ${timeoutMs} ms (mode: ${mode || '(none)'})\n`
    );
    // rails mode is enforcing — deny the structured edit on timeout (fail closed).
    // Advisory hooks exit 0 on timeout so they never block the user.
    process.exit(mode === 'rails' ? 1 : 0);
  }
  process.stderr.write(`adlc-hook-run: failed to spawn adlc-hook.mjs: ${result.error.message}\n`);
  process.exit(1);
}

// spawnSync sets signal when the child was killed by a signal (e.g. SIGTERM from timeout).
if (result.signal) {
  process.stderr.write(
    `adlc-hook-run: hook killed by signal ${result.signal} (mode: ${mode || '(none)'})\n`
  );
  process.exit(mode === 'rails' ? 1 : 0);
}

process.exit(result.status ?? 0);
