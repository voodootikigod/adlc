#!/usr/bin/env node
// gate-fuzzing — standing red-team / gate calibration (ADLC C-tool)
// Exit codes: 0 = no gate defeated (earned clean), 2 = gate defeated, 1 = op error

import { parseArgs, opError, pass, gateFail, printJson } from '@adlc/core';
import { detectProvider } from '@adlc/core';
import { runLoop } from '../lib/loop.mjs';
import { classifyCandidate } from '../lib/classify.mjs';
import { computeVerdict } from '../lib/verdict.mjs';
import { detectSandbox } from '../lib/sandbox.mjs';
import { runControlSelfTest } from '../lib/controls.mjs';
import { buildPromptOnlyOutput } from '../lib/fan.mjs';
import { recordDefeats } from '../lib/record.mjs';

// ── arg parsing ─────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    suite:              { type: 'string' },
    n:                  { type: 'string', default: '6' },
    tier:               { type: 'string', default: 'mid' },
    'max-rounds':       { type: 'string', default: '10' },
    'dry-rounds':       { type: 'string', default: '3' },
    'token-budget':     { type: 'string', default: '200000' },
    'witness-trials':   { type: 'string', default: '3' },
    'max-fail-rate':    { type: 'string', default: '0.5' },
    'canary-budget':    { type: 'string', default: '2' },
    'behavioral-witness': { type: 'boolean', default: false },
    'allow-cmd':        { type: 'string', multiple: true },
    'unsafe-no-sandbox': { type: 'boolean', default: false },
    'strict-budget':    { type: 'boolean', default: false },
    'fail-on-behavioral': { type: 'boolean', default: false },
    record:             { type: 'boolean', default: false },
    triage:             { type: 'boolean', default: false },
    json:               { type: 'boolean', default: false },
    'prompt-only':      { type: 'boolean', default: false },
    help:               { type: 'boolean', default: false },
  },
});

// ── help ─────────────────────────────────────────────────────────────────────

if (values.help) {
  console.log(`
gate-fuzzing — standing red-team / gate calibration (ADLC C-tool)

Usage:
  gate-fuzzing [--suite <path>] [--n <int>] [--tier cheap|mid]
               [--max-rounds <int>] [--dry-rounds <int>] [--token-budget <int>]
               [--witness-trials <int>] [--max-fail-rate <float>] [--canary-budget <int>]
               [--behavioral-witness] [--allow-cmd <name>...] [--unsafe-no-sandbox]
               [--strict-budget] [--fail-on-behavioral]
               [--record] [--triage] [--json] [--prompt-only] [--help]

Options:
  --suite <path>          Gate suite JSON (default: .adlc/gate-suite.json)
  --n <int>               Fan width per round (default: 6)
  --tier cheap|mid        Adversary model tier (default: mid; frontier rejected)
  --max-rounds <int>      Hard round ceiling (default: 10)
  --dry-rounds <int>      K consecutive no-new-defeat rounds to stop (default: 3)
  --token-budget <int>    Estimated token ceiling (default: 200000)
  --witness-trials <int>  N witness runs per side, must be unanimous (default: 3)
  --max-fail-rate <float> Fan-failure fraction for inconclusive round (default: 0.5)
  --canary-budget <int>   Rounds to beat potency canary (default: 2)
  --behavioral-witness    Enable independent witness approval for behavioral defeats
  --allow-cmd <name>      Extend interpreter allowlist (default: node,git,npm,npx)
  --unsafe-no-sandbox     Run without OS sandbox (ONLY inside disposable VM)
  --strict-budget         Any inconclusive stop → exit 1 (default: CI mode)
  --fail-on-behavioral    Behavioral defeats → exit 2 (default: REPORT only)
  --record                Write repro artifacts + findings (default: dry-run)
  --triage                Cheap-model root-cause annotation (never affects verdict)
  --json                  Machine-readable JSON output
  --prompt-only           Print adversary prompts and exit 0 (zero API keys needed)
  --help                  Show this help

Exit codes:
  0   Earned clean (canary beaten, no defeats found)
  1   Operational error (dirty tree, no sandbox, control self-test failed, etc.)
  2   A gate was defeated by a wrong-but-passing, independently-witnessed candidate

Sandbox:
  gate-fuzzing executes adversary-generated diffs, setup, and witnesses.
  It requires bwrap (Linux) or sandbox-exec (macOS) to confine execution.
  Without a sandbox binary, use --unsafe-no-sandbox ONLY inside a disposable VM.

ADLC Phase: C-tool (continuous calibration, scheduled/nightly)
`);
  process.exit(0);
}

// ── validate args ─────────────────────────────────────────────────────────────

const n = parseInt(values.n, 10);
const maxRounds = parseInt(values['max-rounds'], 10);
const dryRounds = parseInt(values['dry-rounds'], 10);
const tokenBudget = parseInt(values['token-budget'], 10);
const witnessTrials = parseInt(values['witness-trials'], 10);
const maxFailRate = parseFloat(values['max-fail-rate']);
const tier = values.tier;

if (isNaN(n) || n < 1) opError('--n must be a positive integer');
if (isNaN(maxRounds) || maxRounds < 1) opError('--max-rounds must be a positive integer');
if (isNaN(dryRounds) || dryRounds < 1) opError('--dry-rounds must be a positive integer');
if (isNaN(tokenBudget) || tokenBudget < 1) opError('--token-budget must be a positive integer');
if (isNaN(witnessTrials) || witnessTrials < 1) opError('--witness-trials must be a positive integer');
if (isNaN(maxFailRate) || maxFailRate < 0 || maxFailRate > 1) opError('--max-fail-rate must be between 0 and 1');
if (tier === 'frontier') opError('--tier frontier is rejected (frontier-free constraint)');
if (!['cheap', 'mid'].includes(tier)) opError('--tier must be cheap or mid');

const allowedCmds = new Set(['node', 'git', 'npm', 'npx', ...(values['allow-cmd'] ?? [])]);

// ── sandbox check (§1.7, Fix 1) ────────────────────────────────────────────

const sandboxType = detectSandbox();

if (!sandboxType && !values['unsafe-no-sandbox'] && !values['prompt-only']) {
  opError(
    'No OS sandbox binary found (bwrap on Linux, sandbox-exec on macOS).\n' +
    'Pass --unsafe-no-sandbox to run candidate commands without sandboxing\n' +
    '(ONLY safe inside a disposable VM or container).'
  );
}

// ── provider check (if not prompt-only) ────────────────────────────────────

if (!values['prompt-only']) {
  const provider = detectProvider();
  if (!provider) {
    opError(
      'No LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
      'Or use --prompt-only to print prompts without calling a provider.'
    );
  }
}

// ── load suite ──────────────────────────────────────────────────────────────

let suite;
try {
  const { loadSuite } = await import('../lib/gate-adapter.mjs');
  suite = loadSuite(values.suite ?? null, process.cwd());
} catch (e) {
  opError(e.message);
}

const gates = suite.gates;

// ── prompt-only (§8) ────────────────────────────────────────────────────────

if (values['prompt-only']) {
  const prompts = buildPromptOnlyOutput(gates, n);
  for (const p of prompts) console.log(p + '\n');
  process.exit(0);
}

// ── control self-test (§5.1/5.2) ─────────────────────────────────────────────

const controlResult = runControlSelfTest(classifyCandidate);
if (!controlResult.ok) {
  if (!values.json) {
    console.error('CONTROL SELF-TEST FAILED — classifier machinery is broken:');
    for (const err of controlResult.errors) console.error('  ' + err);
  } else {
    printJson({ error: 'control-self-test-failed', details: controlResult });
  }
  process.exit(1);
}

if (!values.json) {
  console.log(`control self-test: PASS (defeatable=${controlResult.defeatableStub}, sound=${controlResult.soundStub})`);
}

// ── main run ─────────────────────────────────────────────────────────────────
// SECURITY-CRITICAL (Fix 2): each candidate executes in a FRESH disposable clone
// under the OS sandbox, NEVER in the real working tree. The loop provisions a
// clone per candidate via provisionFn and always destroys it.

const repoRoot = process.cwd();

// Refuse to run against a dirty tree — a clone of a dirty tree is ambiguous and
// the candidate diff may not apply cleanly.
try {
  const { isGitRepo, isDirty } = await import('@adlc/core');
  if (!isGitRepo(repoRoot)) {
    opError(`not a git repository: ${repoRoot} (gate-fuzzing clones the repo to run candidates)`);
  }
  if (isDirty(repoRoot)) {
    opError('working tree is dirty — commit or stash before fuzzing (clones must be reproducible)');
  }
} catch (e) {
  opError(`git precondition check failed: ${e.message}`);
}

// Injectable fan function (wraps core fan for real use)
const { fanAdversary } = await import('../lib/fan.mjs');
const fanFn = async (opts, nFan) => {
  return fanAdversary({
    gates,
    n: nFan,
    tier,
    maxTokens: 4096,
    completeFn: null, // uses core fan for real runs
  });
};

// Per-candidate provisionFn: fresh disposable clone + sandbox-bound gate/witness.
const { makeProvisionFn } = await import('../lib/provision.mjs');
const provisionFn = makeProvisionFn({
  repoRoot,
  sandboxType,
  unsafeNoSandbox: values['unsafe-no-sandbox'],
  suite: gates,
  baselineRef: 'HEAD',
  // Behavioral oracle lens (b) only enabled with --behavioral-witness. Wiring a
  // real fresh-context approval model is out of scope for offline runs; absent a
  // configured lens, behavioral defeats stay unwitnessed (conservative).
  independentApprovalFn: null,
});

// classifyFn receives sandbox-bound runGateFn/runWitnessFn/oracleFn from provisionFn.
const classifyFn = (candidate, suiteDefs, baseline, classifyOpts) => {
  return classifyCandidate(candidate, suiteDefs, baseline, {
    ...classifyOpts,
    witnessTrials,
  });
};

const loopResult = await runLoop(gates, { dir: repoRoot }, {
  fanFn,
  classifyFn,
  provisionFn,
  maxRounds,
  dryRounds,
  tokenBudget,
  maxFailRate,
  n,
  allowedCmds,
});

// ── record defeats ────────────────────────────────────────────────────────────

let recorded = 0;
if (values.record && loopResult.defeats.length > 0) {
  const records = recordDefeats(loopResult.defeats, process.cwd());
  recorded = records.length;
}

// ── verdict ─────────────────────────────────────────────────────────────────

const verdict = computeVerdict({
  defeats: loopResult.defeats,
  stoppedBy: loopResult.stoppedBy,
  inconclusiveRounds: loopResult.inconclusiveRounds,
  rounds: loopResult.rounds,
  strictBudget: values['strict-budget'],
  failOnBehavioral: values['fail-on-behavioral'],
});

// ── report ────────────────────────────────────────────────────────────────────

if (values.json) {
  printJson({
    exhaustive: loopResult.exhaustive,
    stoppedBy: loopResult.stoppedBy,
    rounds: loopResult.rounds,
    candidatesGenerated: loopResult.rounds * n,
    defeats: verdict.defeats.map((d) => ({
      id: d.id,
      strategy: d.strategy,
      target: d.target,
      claimKind: d.claimKind,
      witnessSource: d.witnessSource ?? d.verdict?.witnessSource,
    })),
    byCategory: Object.fromEntries(
      verdict.defeats.map((d) => [`gate-bypass:${d.strategy}`, 1])
    ),
    tokensEstimated: loopResult.tokensEstimated,
    inconclusiveRounds: loopResult.inconclusiveRounds,
    controlSelfTest: {
      defeatableStub: controlResult.defeatableStub,
      soundStub: controlResult.soundStub,
      ok: controlResult.ok,
    },
    recorded,
    summary: verdict.summary,
  });
} else {
  console.log(`\ngate-fuzzing: ${verdict.summary}`);
  console.log(`  rounds: ${loopResult.rounds}, stoppedBy: ${loopResult.stoppedBy}`);
  console.log(`  defeats: ${verdict.defeats.length} (contract: ${verdict.contractDefeats}, behavioral: ${verdict.behavioralDefeats})`);
  console.log(`  tokensEstimated: ~${loopResult.tokensEstimated}`);
  if (verdict.inconclusive) {
    console.error('\nWARNING: run was inconclusive — results cannot certify absence of defeats');
  }
}

process.exit(verdict.exitCode);
