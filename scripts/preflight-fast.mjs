#!/usr/bin/env node
// preflight-fast.mjs — fail-fast local preflight runner.
// Runs sub-second static gates first (toolkit floor, rail-freeze, findings
// ledger scan + append-only, reviewer-directed comments) before spending time
// on the parallel test suite and diff-scoped mutation gate.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Ordered gate plan with sub-second static checks first, followed by tests and
 * mutation-gate.
 */
export function buildFastPreflightGates(base = 'origin/main') {
  return [
    { name: 'toolkit-floor', argv: ['node', ['scripts/toolkit-floor-check.mjs']] },
    { name: 'rail-freeze', argv: ['node', ['scripts/rails-guard-ci.mjs', base]] },
    { name: 'findings-ledger', argv: ['node', ['scripts/scan-findings-ledger.mjs']] },
    { name: 'findings-append-only', argv: ['node', ['scripts/guard-findings-ledger-append-only.mjs', base]] },
    { name: 'reviewer-directed-comments', argv: ['node', ['scripts/check-reviewer-directed-comments.mjs', base]] },
    { name: 'tests', argv: ['node', ['scripts/run-tests.mjs']] },
    { name: 'mutation-gate', argv: ['node', ['scripts/mutation-gate.mjs', base, '--max', '12']] },
  ];
}

export function runFastPreflight({
  base = 'origin/main',
  staticOnly = false,
  spawn = spawnSync,
  cwd = REPO_ROOT,
} = {}) {
  const all = buildFastPreflightGates(base);
  const gates = staticOnly ? all.slice(0, 5) : all;
  for (const gate of gates) {
    const [cmd, args] = gate.argv;
    const bin = cmd === 'node' ? process.execPath : cmd;
    const res = spawn(bin, args, { cwd, stdio: 'inherit' });
    if (res.error) return { ok: false, failedGate: gate.name, status: 1, error: res.error.message };
    if (res.status !== 0) return { ok: false, failedGate: gate.name, status: res.status ?? 1 };
  }
  return { ok: true, failedGate: null, status: 0 };
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const staticOnly = args.includes('--static-only');
  const base = args.find((a) => !a.startsWith('--')) ?? 'origin/main';
  const result = runFastPreflight({ base, staticOnly });
  process.exit(result.status);
}
