// Concern: consecutive-dry-pass tracking.
//
// `consecutiveDry` (lib/run.mjs ~L206, ~L246, ~L257) increments on every dry pass and resets
// to 0 the moment a non-dry pass is seen (findings.length > 0, regardless of disposition --
// even an all-killed pass is non-dry per classifyPass()). Each entry in `result.passes` records
// the counter's value as of that pass, so we can assert the increment/reset behavior per-pass
// rather than only the aggregate pass/fail outcome.
//
// Known blind spot (pre-existing on main, not introduced or fixed here): the pass gate at
// ~L295 reads `consecutiveDry >= 2 && openFindings.size === 0 && dryLenses.size >= 3`, but that
// `>= 2` is NOT an independently-testable boundary at this file's granularity. `dryLenses` (from
// `finalDryLenses()`) draws its distinct-lens set from the same trailing dry-pass run that
// increments `consecutiveDry`, and a set of >= 3 distinct lenses can only be built from a
// trailing streak of >= 3 passes -- so `dryLenses.size >= 3` already implies
// `consecutiveDry >= 3` on every path where the gate can actually pass. Deleting the
// `consecutiveDry >= 2 &&` clause from L295 entirely does not change this suite's outcome; a
// real mutation test for that clause would require exercising it against the dry-lens condition
// directly (or removing the dry-lens requirement), which is out of scope for a test-only file
// split. The *other* use of `consecutiveDry >= 2`, at ~L331 (selects which gate-fail message to
// return), IS correctly boundary-tested below by the "increments on each dry pass..." case.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProsecution } from '../lib/run.mjs';
import { FIXTURE_REVISION, finding, input, killedFinding, readManifest, tmpAdlc } from './helpers.mjs';

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

    // Each dry pass (security, correctness, behavior -- 3 of the 4 passes above) must write a
    // p5-dry-pass evidence entry to the manifest: this is the audit-trail record that a dry pass
    // occurred, and it is the trust boundary this whole package exists to protect (see
    // docs/specs/prosecute-coverage-split.md). Count, not just presence, so a regression that
    // drops the write for only some dry passes is also caught.
    const manifest = readManifest(dir);
    const dryPassEntries = manifest.split('\n').filter((line) => line.includes('"type":"p5-dry-pass"'));
    assert.equal(dryPassEntries.length, 3);
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
