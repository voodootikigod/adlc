// §3: dry-streak, fan-failure→inconclusive, inconclusiveRounds, budget estimate, exit codes
// Uses injectable fake fan — NO network, NO real LLM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../lib/loop.mjs';
import { cannedCandidate, defeatableGateDescriptor } from '../lib/controls.mjs';

const BASELINE = { dir: '/fake/baseline' };
const CLONE_DIR = '/fake/clone';

// Fake fan that always returns one canned candidate that results in DEFEAT
function makeDefeatFan() {
  return async (_opts, _n) => {
    const c = cannedCandidate();
    return [{ ok: true, value: JSON.stringify(c) }];
  };
}

// Fake fan that always returns no valid candidates (no defeats)
function makeDryFan() {
  return async (_opts, _n) => {
    return [{ ok: true, value: JSON.stringify({
      id: 'cand-dry',
      strategy: 'base-ref-window',
      target: 'defeatable-gate',
      claimKind: 'freeze-integrity',
      rationale: 'dry round',
      diff: 'diff --git a/unrelated b/unrelated\n+// noop',  // off surface
      witnessProposal: { cmd: 'node', args: ['--test'] },
      setup: [],
    }) }];
  };
}

// Fake fan that always returns errors (fan failure)
function makeFailFan() {
  return async (_opts, _n) => {
    return [
      { ok: false, error: 'rate limited' },
      { ok: false, error: 'network error' },
      { ok: false, error: 'timeout' },
    ];
  };
}

// Stub classifyFn: always returns caught
function makeCaughtClassify() {
  return (_c, _suite, _baseline, _opts) => ({ result: 'caught', reason: 'gate caught' });
}

// Stub classifyFn: always returns out-of-scope
function makeOutOfScopeClassify() {
  return (_c, _suite, _baseline, _opts) => ({ result: 'out-of-scope', reason: 'off surface' });
}

const SUITE = [defeatableGateDescriptor()];

test('loop stops when dry-streak reaches K with no defeats → stoppedBy dry, no defeats', async () => {
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeDryFan(),
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 10,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.stoppedBy, 'dry');
  assert.equal(result.defeats.length, 0);
  assert.ok(result.rounds >= 3, `Expected at least 3 rounds, got ${result.rounds}`);
});

test('loop stops at maxRounds when no dry streak', async () => {
  // Each round has 1 valid (non-defeat) candidate — never dry enough
  // But we limit to 2 maxRounds and 5 dryRounds to force maxRounds stop
  // Actually dryRounds=5 and maxRounds=2, so we hit maxRounds first
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeDryFan(),
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 2,
    dryRounds: 5,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.stoppedBy, 'maxRounds');
  assert.equal(result.rounds, 2);
});

test('loop finds a defeat → resets dry streak; stops after K dry rounds post-defeat', async () => {
  const candidate = cannedCandidate();
  let roundCount = 0;

  // Round 1: defeat; rounds 2+: no defeat (off-surface)
  const fanFn = async () => {
    roundCount++;
    if (roundCount === 1) return [{ ok: true, value: JSON.stringify(candidate) }];
    return [{ ok: true, value: JSON.stringify({ ...candidate, diff: 'diff --git a/x b/x\n+noop' }) }];
  };

  const classifyFn = (_c, _suite, _baseline, _opts) => {
    if (roundCount === 1) return { result: 'DEFEAT', target: candidate.target, witnessSource: 'contract-derived', reason: 'test' };
    return { result: 'out-of-scope', reason: 'off surface' };
  };

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn,
    maxRounds: 20,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.stoppedBy, 'dry');
  assert.equal(result.defeats.length, 1);
  // Should stop after 1 defeat round + 3 dry rounds = 4 rounds
  assert.equal(result.rounds, 4);
});

test('fan failure rate above threshold → round marked inconclusive, dryStreak NOT advanced', async () => {
  // All rounds are failures (above 0.5 fail rate)
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeFailFan(),
    classifyFn: makeCaughtClassify(),
    maxRounds: 3,
    dryRounds: 2,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 3,
  });

  // All rounds inconclusive, so stoppedBy should be maxRounds (not dry — dryStreak never advanced)
  assert.equal(result.stoppedBy, 'maxRounds');
  assert.equal(result.inconclusiveRounds, 3);
  assert.equal(result.rounds, 3);
});

test('inconclusiveRounds counted correctly when all rounds fail', async () => {
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeFailFan(),
    classifyFn: makeCaughtClassify(),
    maxRounds: 5,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 2,
  });

  assert.equal(result.inconclusiveRounds, 5);
});

test('token budget exceeded → stoppedBy budget', async () => {
  // Each round uses estimated tokens; with tiny budget, first round exceeds it
  const result = await runLoop(SUITE, BASELINE, {
    fanFn: makeDefeatFan(),
    classifyFn: makeCaughtClassify(),
    maxRounds: 10,
    dryRounds: 3,
    tokenBudget: 1,  // 1 token budget — will be exceeded after 1 round
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.stoppedBy, 'budget');
});

test('duplicate defeats not counted as new defeats (dryStreak advances)', async () => {
  const candidate = cannedCandidate();
  let roundCount = 0;

  // Every round produces the same defeat (duplicate)
  const fanFn = async () => {
    roundCount++;
    return [{ ok: true, value: JSON.stringify(candidate) }];
  };

  // Always returns DEFEAT
  const classifyFn = () => ({
    result: 'DEFEAT',
    target: candidate.target,
    witnessSource: 'contract-derived',
    reason: 'test',
  });

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn,
    maxRounds: 10,
    dryRounds: 3,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  // First round finds defeat, subsequent rounds are "dry" (same defeat is duplicate)
  assert.equal(result.defeats.length, 1, 'Should have exactly 1 unique defeat');
  assert.equal(result.stoppedBy, 'dry');
  // Round 1 has new defeat, rounds 2-4 are dry → stops after round 4
  assert.equal(result.rounds, 4);
});

// ─── token budget: must charge the prompt, not just the completion ───────────
// Regression coverage for the undercount bug: estimateTokens was called
// without the per-instance prompt text, so --token-budget metered output
// only. Real spend for this workload is input-dominated (system+user prompt
// built per fan instance), so a budget that never sees it isn't a budget.

test('token estimate charges promptChars from each fan result, not output/error text alone', async () => {
  // 4000 prompt chars + 2 output chars('ok') = 4002 chars -> ceil(4002/4) = 1001 tokens.
  // If promptChars were ignored (the bug), this would estimate ceil(2/4) = 1.
  const fanFn = async () => [{ ok: true, value: 'ok', promptChars: 4000 }];

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 1,
    dryRounds: 5,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.tokensEstimated, 1001, 'must charge promptChars, not just completion/error text');
});

test('token budget trips on prompt tokens alone, even with a tiny completion (previously invisible to the estimator)', async () => {
  // promptChars alone (~10k tokens) exceeds a 5k budget; output is 2 chars.
  // Before the fix, this round would have estimated ~1 token and never stopped.
  const fanFn = async () => [{ ok: true, value: 'ok', promptChars: 40_000 }];

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 5,
    dryRounds: 5,
    tokenBudget: 5_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.stoppedBy, 'budget', 'prompt tokens alone must be able to trip the budget');
  assert.equal(result.rounds, 1, 'should stop after the first round once prompt tokens are charged');
});

test('token estimate treats a missing promptChars as 0 (backward compatible with fixtures/stubs that omit it)', async () => {
  const fanFn = async () => [{ ok: true, value: 'ok' }]; // no promptChars field, like the older fixtures above

  const result = await runLoop(SUITE, BASELINE, {
    fanFn,
    classifyFn: makeOutOfScopeClassify(),
    maxRounds: 1,
    dryRounds: 5,
    tokenBudget: 1_000_000,
    maxFailRate: 0.5,
    cloneDir: CLONE_DIR,
    n: 1,
  });

  assert.equal(result.tokensEstimated, 1); // ceil('ok'.length / 4) = 1
});
