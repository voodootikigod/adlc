// dispatch.mjs — resolve an installed @adlc tool's bin and run it as a child,
// forwarding argv and propagating the gate exit code (0/1/2) verbatim.
// The dispatcher is a router: it adds NO behavior of its own to a tool's run.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve the absolute path to a tool's bin entry, reading the installed
 * package's own package.json so we honor whatever bin path it declares.
 *
 * @param {string} tool  Tool name, e.g. "spec-lint".
 * @returns {string | null}  Absolute bin path, or null if not installed / no bin.
 */
export function resolveBin(tool) {
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`@adlc/${tool}/package.json`);
  } catch {
    return null; // package not installed alongside the dispatcher
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : bin?.[tool];
  if (!rel) return null;
  return join(dirname(pkgJsonPath), rel);
}

/**
 * Run a tool with the given args, inheriting stdio so the child's output and
 * any interactive behavior reach the user directly.
 *
 * @param {string} tool
 * @param {string[]} args
 * @returns {{ code: number, error?: string }}
 *   code mirrors the child's exit code; on a dispatcher-level failure
 *   (tool not installed, spawn error, killed by signal) code is 1 with an
 *   operational `error` message — never 0, so a broken dispatch can't pass a gate.
 */
export function dispatch(tool, args) {
  const bin = resolveBin(tool);
  if (!bin) {
    return {
      code: 1,
      error: `tool not installed: @adlc/${tool} — run "npm i -g @adlc/cli" to install the full suite`,
    };
  }

  const res = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' });

  if (res.error) {
    return { code: 1, error: `failed to run @adlc/${tool}: ${res.error.message}` };
  }
  if (res.signal) {
    return { code: 1, error: `@adlc/${tool} terminated by signal ${res.signal}` };
  }
  // res.status is the child's exit code (0 pass / 1 op-error / 2 gate-fail).
  return { code: typeof res.status === 'number' ? res.status : 1 };
}
