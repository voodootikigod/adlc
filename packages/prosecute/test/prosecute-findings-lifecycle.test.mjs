// Concern: open-finding disposition tracking within a single prosecution run.
//
// classifyPass() / the pass loop (lib/run.mjs ~L225-267) tracks findings by a content-derived
// identity (findingIdentity(), ~L141-151): a 'verified' or 'needs-human' finding opens an
// entry, and a 'killed' finding with the *same identity* closes it. Findings that merely share
// an `id` field but differ in claim/evidence/etc. are different identities and do not resolve
// each other. The gate requires `openFindings.size === 0` in addition to the dry-lens/
// consecutive-dry conditions covered in the sibling test files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProsecution } from '../lib/run.mjs';
import { FIXTURE_REVISION, finding, input, killedFinding, tmpAdlc } from './helpers.mjs';

describe('open-finding lifecycle', () => {
  it('fails when verified findings remain without two dry passes', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [finding()] }],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
  });

  it('passes when a later killed disposition resolves an earlier verified finding', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding()] },
        { lens: 'security', findings: [killedFinding()] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.openFindings, []);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-finding-verified"/);
    assert.match(manifest, /"type":"p5-finding-killed"/);
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('keeps a verified finding open when a killed disposition only shares the id', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding({ id: 'F1', claim: 'auth bypass' })] },
        {
          lens: 'security',
          findings: [killedFinding({ id: 'F1', claim: 'different claim' })],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
        { lens: 'behavior', findings: [], dry_evidence: 'no behavior findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
  });

  it('does not complete when verified findings were seen before dry passes at the same revision', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding()] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('does not complete when verified findings appear after two dry passes', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [finding({ id: 'F2', category: 'test-integrity' })] },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 2);
    assert.equal(result.openFindings.length, 1);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('passes when a low finding is deferred and lists deferredIds in p5-complete and the result', () => {
    const dir = tmpAdlc();
    const deferredLow = finding({
      id: 'F-LOW-1',
      severity: 'low',
      verified_status: 'deferred',
      follow_up: 'T-1182',
      reason: 'spec gap belongs in follow-up ticket after merge',
    });
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [finding({ id: 'F-LOW-1', severity: 'low' })] },
        { lens: 'security', findings: [deferredLow] },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.openFindings, []);
    assert.deepEqual(result.deferredIds, ['F-LOW-1']);
    assert.equal(result.deferredFindings.length, 1);
    assert.equal(result.deferredFindings[0].follow_up, 'T-1182');
    const entries = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.type === 'p5-finding-deferred' && entry.finding.id === 'F-LOW-1'));
    const complete = entries.find((entry) => entry.type === 'p5-complete');
    assert.ok(complete);
    assert.deepEqual(complete.deferredIds, ['F-LOW-1']);
  });

  it('resolves a manifest-seeded open finding when a later run defers it and preserves seeded deferred findings', () => {
    const dir = tmpAdlc();
    const first = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [finding({ id: 'F-SEED-LOW', severity: 'low' })] }],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });
    assert.equal(first.exitCode, 2);
    assert.equal(first.openFindings.length, 1);

    const second = runProsecution(input(dir, {
      passes: [
        {
          lens: 'security',
          findings: [
            finding({
              id: 'F-SEED-LOW',
              severity: 'low',
              verified_status: 'deferred',
              follow_up: 'https://github.com/voodootikigod/adlc/issues/1182',
              reason: 'defer to follow-up issue',
            }),
          ],
        },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });
    assert.equal(second.exitCode, 2);
    assert.deepEqual(second.openFindings, []);
    assert.deepEqual(second.deferredIds, ['F-SEED-LOW']);

    const third = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
        { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
      ],
    }), { dir, ticket: 'T1', revision: FIXTURE_REVISION });
    assert.equal(third.exitCode, 0);
    assert.deepEqual(third.openFindings, []);
    assert.deepEqual(third.deferredIds, ['F-SEED-LOW']);
  });
});
