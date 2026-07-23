#!/usr/bin/env node
// adlc-stop.mjs — end-of-session audit for Cursor (T18 / T47).
// Wired by default (documented Cursor `stop` event); opt out with scaffold
// `wireUnpinned: false`, `--no-unpinned`, or ADLC_CURSOR_WIRE_UNPINNED=0.
//
// What it does (advisory only, never blocks, never throws):
//   1. `adlc gate-manifest verify --json` — is the gate-evidence chain intact?
//   2. The issue-#59 mechanical adversarial-review trigger: if the working
//      tree/branch diff is risk-gated (@adlc/core classifyRiskTier) and no
//      satisfying adversarial-review gate-manifest record exists
//      (@adlc/core decideAdversarialReviewNotice), emit a notice.
// Mirrors plugins/adlc-opencode/lib/session-hooks.mjs's session.idle audits.

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyRiskTier, decideAdversarialReviewNotice, ticketStoreExists } from '@adlc/core';
import { resolveActiveTicketId } from '../rails-checker.mjs';
import { candidateRoots } from './adlc-rails-guard.mjs';

// Exported for test/stop-preflight.test.mjs (T18 P5 hollow-test amendment):
// the status/stdout/stderr mapping below is otherwise unobservable.
export function run(spawnImpl, bin, args, cwd) {
  try {
    const r = spawnImpl(bin, args, { cwd, encoding: 'utf8' });
    return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  } catch (err) {
    return { status: 1, stdout: '', stderr: String(err), error: err };
  }
}

/**
 * Repo-relative changed paths: working tree (`git status --porcelain -z`, the
 * -z form is NUL-separated and never C-quotes paths), untracked files, and the
 * committed diff against the merge-base of the first reachable trunk
 * candidate. Best-effort: any git failure contributes nothing.
 */
// Exported for test/stop-preflight.test.mjs (T18 F1): the porcelain slice(3)
// parse and merge-base fallback are otherwise only reachable through stopAudit's
// risk-tier branch. Directly testable seam — this hook is T18 scope, not a rail.
export function gitChangedPaths(root, { spawnImpl = spawnSync, base } = {}) {
  const paths = new Set();

  const status = run(spawnImpl, 'git', ['status', '--porcelain', '--no-renames', '-z'], root);
  if (!status.error && status.status === 0 && status.stdout) {
    for (const rec of status.stdout.split('\0')) {
      const p = rec.slice(3).trim();
      if (p) paths.add(p);
    }
  }

  const untracked = run(spawnImpl, 'git', ['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (!untracked.error && untracked.status === 0 && untracked.stdout) {
    for (const p of untracked.stdout.split('\0')) if (p.trim()) paths.add(p.trim());
  }

  const baseCandidates = base ? [base] : ['main', 'master', 'origin/main', 'origin/master'];
  for (const c of baseCandidates) {
    const exists = run(spawnImpl, 'git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], root);
    if (exists.error || exists.status !== 0) continue;
    const mergeBase = run(spawnImpl, 'git', ['merge-base', c, 'HEAD'], root);
    if (mergeBase.error || mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
    const diff = run(spawnImpl, 'git', ['diff', '--name-only', '-z', mergeBase.stdout.trim(), '--'], root);
    if (!diff.error && diff.status === 0 && diff.stdout) {
      for (const p of diff.stdout.split('\0')) if (p.trim()) paths.add(p.trim());
    }
    break;
  }

  return [...paths];
}

/**
 * The stop-time audit. Advisory only. Returns { skipped, warnings: string[] }.
 */
export function stopAudit(root, { spawnImpl = spawnSync, env = process.env, base } = {}) {
  if (!ticketStoreExists(root, env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null)) {
    return { skipped: true, warnings: [] }; // not ADLC-initialized → no-op
  }
  const warnings = [];

  // 1. Gate-evidence chain integrity.
  if (existsSync(join(root, '.adlc', 'manifest.jsonl'))) {
    const verify = run(spawnImpl, 'adlc', ['gate-manifest', 'verify', '--json'], root);
    if (!verify.error && verify.status !== 0) {
      warnings.push(`gate-manifest verify reported a problem: ${(verify.stderr || verify.stdout || '').trim().slice(0, 300)}`);
    }
    // verifier unreachable → stay silent (advisory)
  }

  // 2. Risk-gated adversarial-review check (issue #59).
  const changed = gitChangedPaths(root, { spawnImpl, base });
  const { gated } = classifyRiskTier(changed);
  if (gated) {
    const active = resolveActiveTicketId(root, env);
    const ticketId = active.conflict ? null : active.id; // advisory: degrade, never fail closed

    let manifestEntries = [];
    if (existsSync(join(root, '.adlc', 'manifest.jsonl'))) {
      const show = run(spawnImpl, 'adlc', ['gate-manifest', 'show', '--json'], root);
      if (!show.error && show.status === 0 && show.stdout) {
        try {
          const parsed = JSON.parse(show.stdout);
          if (Array.isArray(parsed.entries)) manifestEntries = parsed.entries;
        } catch { /* unparseable → no provable entries */ }
      }
    }

    const decision = decideAdversarialReviewNotice({ changedPaths: changed, manifestEntries, ticketId });
    if (decision.needed) {
      const tiers = [...new Set(decision.matches.map((m) => m.tier))].join(', ');
      warnings.push(
        `risk-gated change (${tiers}) with no adversarial-review gate-manifest record` +
        `${ticketId ? ` for ticket ${ticketId}` : ''}. Run \`npx adversarial-review --providers\` and record ` +
        `the verdict via \`adlc gate-manifest record adversarial-review --ticket ${ticketId ?? '<id>'} ` +
        `--files '<paths>' --data '{...}'\` before merging.`,
      );
    }
  }

  return { skipped: false, warnings };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { /* advisory: ignore */ }
  }
  try {
    const root = candidateRoots(payload)[0] ?? process.cwd();
    const { warnings } = stopAudit(root, { env: process.env });
    for (const w of warnings) process.stderr.write(`adlc-stop: ${w}\n`);
  } catch { /* advisory: never crash */ }
  // The stop event's stdout contract is unpinned; emit an empty no-op object.
  process.stdout.write('{}');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
