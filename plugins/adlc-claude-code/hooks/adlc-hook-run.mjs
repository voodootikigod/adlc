#!/usr/bin/env node
// TEMPORARY DEBUG LINE — remove after live-install confirmation (ADR 0003 item 1).
import { appendFileSync } from 'node:fs';
try { appendFileSync('/tmp/adlc-hook.log', `fired: ${process.argv.slice(2).join(' ')} pid=${process.pid}\n`); } catch {}
// adlc-hook-run.mjs — CWD-independent dispatcher for adlc-hook.mjs.
//
// Problem: hooks.json command strings may be executed via execFile() (no shell) or
// via a POSIX shell. If Claude Code uses execFile(), $(...) shell substitutions in the
// command string are not expanded — the node process would try to open a file literally
// named "$([ -f ...])" and exit MODULE_NOT_FOUND, blocking every Edit/Write/MultiEdit
// hook. This wrapper avoids any shell substitution entirely.
//
// Solution: import.meta.url is always the URL of this file itself, regardless of CWD.
// We derive adlc-hook.mjs's absolute path from __dirname-equivalent and exec it with
// the same arguments. This file is referenced by a literal relative path in hooks.json:
//   "node ./plugins/adlc-claude-code/hooks/adlc-hook-run.mjs <mode>"
// which is resolved from CWD = repo root (the assumed CC hook execution CWD).
// If CC uses plugin-source-dir as CWD the path "./hooks/adlc-hook-run.mjs" also works
// because this file lives in the same hooks/ directory as adlc-hook.mjs.
//
// Pre-GA note: The assumed CWD (repo root) must be confirmed during the live install
// test (see "Hook CWD assumption — live install confirmation required" checklist item
// in docs/adr/0003-adlc-claude-code-plugin.md). This wrapper eliminates the $(...) risk
// entirely — once the CWD is confirmed, the literal path in hooks.json can be locked
// down definitively.

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
