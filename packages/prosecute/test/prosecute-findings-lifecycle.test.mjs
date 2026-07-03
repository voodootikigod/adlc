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
});
