// build-gate-recovery-exception.test.mjs — end-to-end pipeline coverage for
// the Recovery Exception & Inspection Bash Exception (context-rot-threshold-
// calibration spec §1.3) as it actually runs in hooks.json's declared
// PreToolUse order: adlc-rails-guard.mjs, THEN adlc-build-gate.mjs, THEN
// adlc-handoff-gate.mjs, for every shell tool identity.
//
// Round-2 review of this ticket found that build-gate has its OWN,
// independent high-risk/degraded-context deny path with no recovery
// exception at all — a session working a high-risk ticket with an oversized
// transcript would have `pwd` and the recovery CLI denied by build-gate
// BEFORE the handoff gate's own (correctly unconditional) exception ever
// got a chance to run. Round-3 review found the SAME class of bug one hook
// earlier: rails-guard runs FIRST in the declared pipeline and denies the
// recovery CLI invocation outright (its shell classifier recognizes it as
// neither a known read-only command nor a path-transparent mutation)
// whenever the active ticket has declared rails — and the round-2 test
// omitted rails-guard entirely, which is exactly what let the gap through
// review undetected. This file runs ALL THREE hooks as real subprocesses,
// in the exact declared order, against a fixture with BOTH a high-risk
// ticket AND declared rails, so neither gap can hide behind the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { RECOVERY_CLI_PATH } from '@adlc/context-handoff';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAILS_GUARD_HOOK = join(HOOKS_DIR, 'adlc-rails-guard.mjs');
const BUILD_GATE_HOOK = join(HOOKS_DIR, 'adlc-build-gate.mjs');
const HANDOFF_HOOK = join(HOOKS_DIR, 'adlc-handoff-gate.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

const REAL_NODE = realpathSync(process.execPath);
const REAL_RECOVERY_CLI = realpathSync(RECOVERY_CLI_PATH);

/** Run one hook script as a real subprocess; returns { status, out }. */
function runHook(hookPath, dir, payload) {
  const env = {
    ...process.env,
    NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
  };
  let out = '';
  let status = 0;
  try {
    execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = e.stderr ?? '';
    status = e.status ?? 1;
  }
  return { status, out };
}

/** Run the EXACT declared hooks.json pipeline order for a shell tool: rails-guard, then build-gate, then handoff-gate. */
function runPipeline(dir, payload) {
  const rg = runHook(RAILS_GUARD_HOOK, dir, payload);
  if (rg.status !== 0) return { verdict: 'deny', stage: 'rails-guard', ...rg };
  const bg = runHook(BUILD_GATE_HOOK, dir, payload);
  if (bg.status !== 0) return { verdict: 'deny', stage: 'build-gate', ...bg };
  const hg = runHook(HANDOFF_HOOK, dir, payload);
  return { verdict: hg.status === 0 ? 'allow' : 'deny', stage: 'handoff-gate', ...hg };
}

/**
 * A high-risk, RAILED ticket + an oversized (>8 MiB — the recalibrated
 * build-gate DEFAULT_BYTES_THRESHOLD, Round-5) transcript — the exact
 * precondition both findings named. Was >256 KiB before the recalibration;
 * padding must stay above whatever the CURRENT threshold is or this fixture
 * silently stops being "degraded" and every test built on it goes vacuous.
 */
function setupHighRiskRailedDegradedSession() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-recovery-'));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  const ticket = {
    id: 'T1',
    title: 'high risk',
    body: 'y',
    risk: 'high',
    rails: ['src/**'],
    scope: ['src/**'],
  };
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  const line = JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'apply_patch' }] });
  const transcriptPath = join(dir, 'oversized.jsonl');
  writeFileSync(transcriptPath, `${line}\n`.repeat(50) + 'x'.repeat(9 * 1024 * 1024));
  return { dir, transcriptPath };
}

test('sanity: rails-guard alone denies an ordinary shell command for a railed ticket', () => {
  // Confirms rails-guard's own enforcement wasn't accidentally weakened by
  // the recovery-exception addition — it still denies commands that are
  // neither the recovery CLI nor a recognized read-only/path-transparent
  // shape. (rails-guard alone now correctly ALLOWS the real recovery
  // command — that is the fix this file exists to prove, exercised in the
  // full-pipeline tests below; a standalone-deny assertion for the recovery
  // command itself would be testing the pre-fix bug, not the fixed
  // behavior.)
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const r = runHook(RAILS_GUARD_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-sanity-rails',
      transcript_path: transcriptPath,
      command: 'echo hi',
    });
    assert.equal(r.status, 2, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity: build-gate alone denies an ordinary shell command for a high-risk, degraded session', () => {
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const r = runHook(BUILD_GATE_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-sanity',
      transcript_path: transcriptPath,
      command: 'ls',
    });
    assert.equal(r.status, 2, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the full declared 3-hook pipeline allows bare pwd for a high-risk, railed, degraded session', () => {
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const result = runPipeline(dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-pwd',
      transcript_path: transcriptPath,
      command: 'pwd',
    });
    assert.equal(result.verdict, 'allow', `denied at ${result.stage}: ${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the full declared 3-hook pipeline allows the real recovery command for a high-risk, railed, degraded session', () => {
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const result = runPipeline(dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-recovery',
      transcript_path: transcriptPath,
      command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-recovery --write`,
    });
    assert.equal(result.verdict, 'allow', `denied at ${result.stage}: ${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the full declared 3-hook pipeline still denies an ordinary shell command for a high-risk, railed, degraded session', () => {
  // Confirms the exception is narrow — the fix does not accidentally open
  // any of the three gates up wholesale.
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const result = runPipeline(dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-ordinary',
      transcript_path: transcriptPath,
      command: 'ls -la',
    });
    assert.equal(result.verdict, 'deny');
    assert.ok(['rails-guard', 'build-gate'].includes(result.stage), result.stage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rails-guard alone denies the recovery command when a second, single-character command-bearing field is present', () => {
  // Pins the candidates filter's `c.length > 0` boundary: collectCommandText
  // walks the WHOLE payload for any command/cmd/input/script/chars key, so a
  // stray single-character value elsewhere in the payload becomes a second
  // "candidate" alongside the real recovery command. The exception only
  // fires when EXACTLY ONE non-empty candidate is found (an unambiguous
  // single command) — with two candidates present it must fall through to
  // ordinary enforcement and deny, exactly as it would for any other
  // multi-command-field payload it can't safely disambiguate.
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const r = runHook(RAILS_GUARD_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-noise-onechar',
      transcript_path: transcriptPath,
      command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-noise-onechar --write`,
      note: { chars: 'x' },
    });
    assert.notEqual(r.status, 0, `expected the ambiguous two-candidate payload to be denied, got status=${r.status} out=${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rails-guard alone still allows the recovery command when a second, EMPTY command-bearing field is present', () => {
  // Pins the candidates filter's `typeof c === 'string' && c.length > 0`
  // conjunction: collectCommandText can legitimately surface an empty
  // string from an unrelated payload field (e.g. an empty `script`/`chars`
  // key elsewhere). The filter must still discard it — an empty string is
  // never a real second command — leaving exactly one real candidate so the
  // exception still fires and allows.
  const { dir, transcriptPath } = setupHighRiskRailedDegradedSession();
  try {
    const r = runHook(RAILS_GUARD_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-noise-empty',
      transcript_path: transcriptPath,
      command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-noise-empty --write`,
      note: { chars: '' },
    });
    assert.equal(r.status, 0, `expected the empty-string noise field to be filtered out, got status=${r.status} out=${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rails-guard alone allows bare pwd even with a corrupt/unreadable ticket store', () => {
  // Round-3 review found that rails-guard resolved the active ticket and
  // loaded the ticket store BEFORE the recovery/inspection exception ran —
  // a malformed store denied pwd/recovery before the exception ever got a
  // chance, reproducing the total-lockout bug through the gate's own
  // state-validation path instead of its shell classifier.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-guard-corrupt-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // Deliberately malformed: not valid JSON at all.
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{not valid json');
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));

    const r = runHook(RAILS_GUARD_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-corrupt-store',
      command: 'pwd',
    });
    assert.equal(r.status, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rails-guard alone allows the real recovery command even with an unknown active ticket id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-guard-unknown-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
    // Points at a ticket id that does not exist in the store.
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'DOES-NOT-EXIST' }));

    const r = runHook(RAILS_GUARD_HOOK, dir, {
      tool_name: 'exec_command',
      session_id: 'consumer-unknown-ticket',
      command: `${REAL_NODE} ${REAL_RECOVERY_CLI} bypass --session consumer-unknown-ticket --write`,
    });
    assert.equal(r.status, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
