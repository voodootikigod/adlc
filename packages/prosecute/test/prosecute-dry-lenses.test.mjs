// Concern: dry-lens counting.
//
// finalDryLenses() (lib/run.mjs ~L123-131) walks passResults from the end backwards while
// `pass.dry` is true, collecting `pass.lens` into a Set -- so repeated lenses in the trailing
// run do not inflate the count, and any non-dry pass in the trailing run stops the walk. The
// gate at lib/run.mjs ~L295 requires `dryLenses.size >= 3`. These tests exercise the boundary
// directly: two distinct trailing dry lenses must NOT satisfy the gate, three distinct trailing
// dry lenses must.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProsecution } from '../lib/run.mjs';
import { FIXTURE_REVISION, finding, input, killedFinding, tmpAdlc } from './helpers.mjs';

describe('finalDryLenses boundary', () => {
  it('does NOT pass with exactly two distinct trailing dry lenses', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.match(result.message, /fewer than three distinct dry lenses/);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('passes with three distinct trailing dry lenses', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.openFindings, []);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('does not let a repeated lens count twice toward the distinct-lens threshold', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings, attempt 1' },
        { lens: 'security', findings: [], dry_evidence: 'no security findings, attempt 2' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    // Three trailing dry passes, but only two distinct lenses (security repeated).
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /fewer than three distinct dry lenses/);
  });

  it('records p5-complete with the sorted set of distinct dry lenses', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [killedFinding()] },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'p5-complete');
    assert.deepEqual(manifest.dryLenses, ['behavior', 'correctness', 'tests']);
  });

  it('does not count dry lenses from before a later finding toward final convergence', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings before later review work' },
        { lens: 'correctness', findings: [finding({ id: 'F2', category: 'test-integrity' })] },
        { lens: 'correctness', findings: [killedFinding({ id: 'F2', category: 'test-integrity' })] },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings after refutation' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings after refutation' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.openFindings, []);
    assert.match(result.message, /fewer than three distinct dry lenses/);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });
});
