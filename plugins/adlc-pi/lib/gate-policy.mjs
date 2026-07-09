// gate-policy.mjs — the rails-aware argv policy for the native `adlc_gate` tool
// (spec 4.3). PORTED (not imported) from plugins/adlc-opencode/rails-checker.mjs
// — that directory is FROZEN, so the SEMANTICS are reproduced here against pi's
// own railHit (rails-checker.mjs). The contract is identical to opencode's
// adlc_gate policy:
//
//   - only read-only-by-default gates run through the tool while a ticket
//     freezes rails ("writers default to dry-run" is the repo-wide gate
//     contract); derived/defaulted-write gates are denied (their write targets
//     an argv scan cannot vet) — the adlc CLI stays their path, where the CI
//     diff gate backstops;
//   - EVERY gate denies command-executor flags (--*cmd — they run an arbitrary
//     program) and mutation opt-in flags (--write/--record/--append/--apply/
//     --fix — they turn a dry-run gate into a writer with a derived target);
//   - literal argv tokens (incl. --flag=value payloads and comma-lists) that
//     resolve to a frozen rail are denied;
//   - gate-manifest is vetted on its EFFECTIVE ledger FILE (--dir or the .adlc
//     default) rather than blanket-denied, because mid-build evidence recording
//     is a legitimate railed-session write;
//   - preflight's fixed self-cleaning scratch probes are vetted, not denied;
//   - an unknown gate → deny (fail closed; the StringEnum already constrains the
//     tool param, but the policy re-checks).
//
// This module is PURE (no pi runtime): the execute() in gate-tool.mjs applies it
// only while a ticket is active (pi's enforcement switch), matching opencode's
// "rails in force" guard.

import { railHit } from './rails-checker.mjs';

// Gates that may run through adlc_gate while rails are FROZEN: read-only by
// default. Ported verbatim from the opencode RAILS_SAFE_GATES set. Deliberately
// absent — gates that WRITE with derived/defaulted targets an argv scan cannot
// vet (hollow-test, review-calibration, consensus-fix, behavior-diff,
// gate-fuzzing) and any unknown/future gate (fail closed).
export const RAILS_SAFE_GATES = new Set([
  'preflight', 'spec-lint', 'premortem', 'parallax', 'coldstart',
  'merge-forecast', 'model-router', 'rejection-mining',
  'lesson-foundry', 'skill-rot', 'model-ratchet', 'flail-detector', 'rails-guard',
]);

// The deterministic adlc gates the tool's StringEnum constrains to. Excludes
// `review` (external, model-judged — not deterministic), `prosecute` (has its
// own native adlc_prosecute tool), `ticket` (external tracker sync, needs
// network), and the `run`/`accept` runner verbs. A gate the policy does not
// recognize is denied even if it slips past the enum.
export const GATE_NAMES = [
  // Spec and ticket shaping
  'parallax', 'spec-lint', 'premortem', 'coldstart', 'ticket-prune',
  // Execution supervision and rails
  'preflight', 'model-router', 'merge-forecast', 'rails-guard', 'build-gate',
  'flail-detector', 'consensus-fix',
  // Review evidence and calibration
  'behavior-diff', 'gate-manifest', 'hollow-test', 'review-calibration',
  'model-ratchet', 'gate-fuzzing',
  // Compounding defenses
  'lesson-foundry', 'rejection-mining', 'skill-rot',
];

// Mutation opt-in flags that turn a dry-run gate into a writer with a target an
// argv scan cannot vet.
const MUTATION_FLAGS = new Set(['--write', '--record', '--append', '--apply', '--fix']);

/**
 * Decide whether an adlc_gate call may run while a ticket freezes rails. Pure
 * and fail-safe: returns { decision: 'allow' | 'deny', reason }.
 *
 * @param {object} opts
 * @param {string} opts.gate            the gate name (already StringEnum-bounded)
 * @param {string[]} [opts.args]        the nested argv tokens
 * @param {object|null} opts.ticket     the active ticket (for railHit)
 * @param {string} opts.root            repo root
 */
export function checkGateArgv({ gate, args = [], ticket, root }) {
  const g = String(gate ?? '').trim().toLowerCase();
  const nested = (Array.isArray(args) ? args : []).filter((t) => typeof t === 'string');
  const deny = (why) => ({
    decision: 'deny',
    reason: `adlc_gate(${g || '?'}): ${why} — run the gate via the adlc CLI instead, where the CI diff gate backstops it`,
  });

  // Unknown gate → fail closed. The StringEnum already constrains the tool
  // param, but a spoofed/forwarded call is re-checked here.
  if (!GATE_NAMES.includes(g)) return deny('unknown gate');

  // (1) literal tokens — flags' inline values and comma-separated lists included.
  for (const raw of nested) {
    let token = raw.trim();
    if (!token) continue;
    if (token.startsWith('-')) {
      const eq = token.indexOf('=');
      if (eq === -1) continue; // bare flag; its value arrives as the next token
      token = token.slice(eq + 1).trim();
      if (!token) continue;
    }
    for (const part of token.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const hit = railHit(p, ticket, root);
      if (hit) return deny(`nested argument "${raw}" resolves to frozen rail "${hit}"`);
    }
  }

  // (2) mutation opt-ins and (3) command-executor flags — denied for EVERY gate.
  for (const raw of nested) {
    const flag = raw.trim().split('=')[0];
    const flagLc = flag.toLowerCase();
    if (MUTATION_FLAGS.has(flag) || MUTATION_FLAGS.has(flagLc)) return deny(`mutation flag "${flag}" requests a write with a gate-derived target`);
    // --review-cmd, --test-cmd, --allow-cmd, and any future *cmd/*command flag
    // hand the gate an arbitrary program to run — no argv scan can vet a command
    // string. Fail closed. Case-insensitive (P5 finding F3). Deliberately NOT
    // broadened to run/exec/eval/shell: real read-only flags collide with those
    // (`--dry-run`, `--eval`), so widening would false-deny legitimate gate use.
    if (/^--[a-z][a-z-]*(?:cmd|command)$/.test(flagLc)) {
      return deny(`command-executor flag "${flag}" runs an arbitrary program, which an in-session guard cannot vet`);
    }
  }

  const hasFlag = (flag) => nested.some((t) => { const s = t.trim(); return s === flag || s.startsWith(`${flag}=`); });
  const vetLedger = (path) => {
    const hit = railHit(path, ticket, root);
    return hit ? deny(`gate write target "${path}" resolves to frozen rail "${hit}"`) : null;
  };

  if (g === 'gate-manifest') {
    // Vet the EFFECTIVE ledger FILE (not the directory — the directory always
    // ancestor-hits the implicit .adlc trust root, which would outlaw legitimate
    // mid-build evidence recording).
    let effectiveDir = '.adlc';
    for (let i = 0; i < nested.length; i++) {
      const t = nested[i].trim();
      if (t === '--dir' && typeof nested[i + 1] === 'string') effectiveDir = nested[i + 1].trim();
      else if (t.startsWith('--dir=')) effectiveDir = t.slice('--dir='.length).trim();
    }
    const denied = vetLedger(`${effectiveDir.replace(/\/+$/, '')}/manifest.jsonl`);
    if (denied) return denied;
  } else if (!RAILS_SAFE_GATES.has(g)) {
    // Not proven read-only-by-default (hollow-test, review-calibration,
    // consensus-fix, behavior-diff, gate-fuzzing) → fail closed.
    return deny('this gate derives or defaults its write targets, which an in-session argv scan cannot vet while rails are frozen');
  } else {
    // A rails-safe gate may still request a ledger write via --record-verdict;
    // vet that known target.
    if (hasFlag('--record-verdict')) {
      const denied = vetLedger('.adlc/manifest.jsonl');
      if (denied) return denied;
    }
    // preflight's DEFAULT run probes writability with fixed, self-cleaning
    // scratch writes. Vet those known paths instead of denying the gate — they
    // only conflict when explicitly railed.
    if (g === 'preflight') {
      for (const scratch of [
        '.adlc/tmp/preflight-test',
        '.worktrees/preflight-test',
        '.git/refs/heads/preflight-test-branch',
        '.git/worktrees/preflight-test',
      ]) {
        const denied = vetLedger(scratch);
        if (denied) return denied;
      }
    }
  }

  return { decision: 'allow', reason: `gate "${g}" is rails-safe for in-session execution` };
}
