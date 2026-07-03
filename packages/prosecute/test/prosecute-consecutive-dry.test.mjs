// Concern: consecutive-dry-pass tracking.
//
// `consecutiveDry` (lib/run.mjs ~L206, ~L246, ~L257) increments on every dry pass and resets
// to 0 the moment a non-dry pass is seen (findings.length > 0, regardless of disposition --
// even an all-killed pass is non-dry per classifyPass()). The gate at ~L295 requires
// `consecutiveDry >= 2`. Each entry in `result.passes` records the counter's value as of that
// pass, so we can assert the increment/reset behavior per-pass rather than only the aggregate
// pass/fail outcome.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProsecution } from '../lib/run.mjs';
import { FIXTURE_REVISION, finding, input, killedFinding, tmpAdlc } from './helpers.mjs';

describe('consecutiveDry counter', () => {
  it('increments on each dry pass and resets to 0 when a non-dry pass appears in between', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        // Non-dry: a killed finding still has findings.length > 0, so this must reset the streak.
        { lens: 'tests', findings: [killedFinding({ id: 'F9' })] },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.passes[0].consecutiveDry, 1);
    assert.equal(result.passes[1].consecutiveDry, 2);
    assert.equal(result.passes[2].consecutiveDry, 0);
    assert.equal(result.passes[3].consecutiveDry, 1);
    // Streak was reset, so only 1 consecutive dry pass remains at the end: gate-fail.
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /convergence budget ended before two consecutive dry passes/);
  });

  it('re-accumulates two consecutive dry passes after a reset', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [killedFinding({ id: 'F9' })] },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
        { lens: 'integration', findings: [], dry_evidence: 'no integration findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.passes[0].consecutiveDry, 1);
    assert.equal(result.passes[1].consecutiveDry, 0);
    assert.equal(result.passes[2].consecutiveDry, 1);
    assert.equal(result.passes[3].consecutiveDry, 2);
    assert.equal(result.passes[4].consecutiveDry, 3);
    // Three distinct trailing dry lenses (tests, behavior, integration) and consecutiveDry >= 2.
    assert.equal(result.exitCode, 0);
  });

  it('does not count an all-killed pass as dry', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [killedFinding({ id: 'F1' })] },
        { lens: 'correctness', findings: [killedFinding({ id: 'F2', category: 'correctness' })] },
        { lens: 'tests', findings: [killedFinding({ id: 'F3', category: 'test-integrity' })] },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.passes.every((pass) => pass.dry === false), true);
    assert.equal(result.passes.every((pass) => pass.consecutiveDry === 0), true);
  });

  it('does not count a needs-human-only pass as dry', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding({ id: 'F1', verified_status: 'needs-human' })] },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.passes[0].dry, false);
    assert.equal(result.passes[0].consecutiveDry, 0);
    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
  });
});
