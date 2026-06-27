// session-hooks.mjs — advisory session lifecycle checks for OpenCode (plan
// Phase C). Both are ADVISORY and FAIL-SAFE: they only surface warnings, never
// throw, and no-op when the repo is not ADLC-initialized.
//
// Event-name note: the plan specified `session.created` + `session.ended`, but
// OpenCode exposes `session.created` and `session.idle` (there is no
// `session.ended`). We map the end-of-work audit onto `session.idle`.
//
// The subprocess calls are injected (`spawnImpl`) so the logic is unit-testable
// offline without `adlc` or `git` installed.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(spawnImpl, bin, args, cwd) {
  try {
    const r = spawnImpl(bin, args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err), error: err };
  }
}

/**
 * session.created check: is the environment ready for ADLC work / fan-out?
 * Advisory only. Returns { ready, skipped, warnings[] }.
 */
export function checkPreflight(root, { spawnImpl = spawnSync, env = process.env } = {}) {
  if (!existsSync(join(root, '.adlc', 'tickets.json'))) {
    return { ready: true, skipped: true, warnings: [] }; // not ADLC-initialized → no-op
  }
  const warnings = [];

  const ver = run(spawnImpl, 'adlc', ['--version'], root);
  if (ver.error || ver.status !== 0) {
    warnings.push('`adlc` is not on PATH — install @adlc/cli (npm i -g @adlc/cli) before running gates.');
  }

  const git = run(spawnImpl, 'git', ['status', '--porcelain'], root);
  if (!git.error && git.status === 0 && git.stdout.trim()) {
    warnings.push('git worktree is dirty — a non-deterministic tree weakens evidence; commit or stash before fan-out.');
  }

  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    warnings.push('ADLC_P4_ENFORCEMENT is not set — in-session rail enforcement is inactive (advisory). The CI gate remains authoritative.');
  }

  return { ready: warnings.length === 0, skipped: false, warnings };
}

/**
 * session.idle audit: is the gate-evidence chain intact? Advisory only.
 * Returns { ok, skipped, warning }.
 */
export function auditGateManifest(root, { spawnImpl = spawnSync } = {}) {
  if (!existsSync(join(root, '.adlc', 'manifest.jsonl'))) {
    return { ok: true, skipped: true, warning: null }; // nothing recorded yet → no-op
  }
  const res = run(spawnImpl, 'adlc', ['gate-manifest', 'verify', '--json'], root);
  if (res.error) {
    return { ok: true, skipped: true, warning: null }; // can't run the verifier → stay silent (advisory)
  }
  if (res.status !== 0) {
    return { ok: false, skipped: false, warning: `gate-manifest verify reported a problem: ${(res.stderr || res.stdout || '').trim().slice(0, 300)}` };
  }
  return { ok: true, skipped: false, warning: null };
}
