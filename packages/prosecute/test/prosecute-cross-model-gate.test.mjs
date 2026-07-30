// Concern: trust-root-tier cross-model gate in runProsecution (T39 AC3, AC4).
//
// When requireCrossModel is true, a P5 that would otherwise pass (two consecutive
// dry passes, three distinct dry lenses, no open findings) ALSO requires a
// distinct-provider cross-model `approve` bound to the CURRENT revision. Missing ->
// exit 2 with a naming message + a p5-cross-model-missing evidence entry. When
// requireCrossModel is false (default), behavior is byte-identical to today.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProsecution } from '../lib/run.mjs';
import { recordCrossModelReview as realRecordCrossModelReview } from '../lib/cross-model.mjs';
import { record as realGmRecord } from '@adlc/gate-manifest/lib/record.mjs';
import { FIXTURE_REVISION, input, tmpAdlc } from './helpers.mjs';

// #326 hardening: attestations must be HMAC-signed to be trusted; set the key so
// recordCrossModelReview signs and the gate can verify.
process.env.ADLC_MANIFEST_KEY = 'test-cross-model-gate-signing-key';

// Explicit-key wrappers (spec Layer 2): env stays set only to prove it is inert.
const TEST_KEY = 'test-cross-model-gate-signing-key';
const recordCrossModelReview = (o = {}) => realRecordCrossModelReview({ key: TEST_KEY, ...o });
const record = (o = {}) => realGmRecord({ key: TEST_KEY, ...o });

const REV = FIXTURE_REVISION;

// A pass set that converges cleanly (three distinct trailing dry lenses).
function cleanPasses() {
  return [
    { lens: 'security', findings: [], dry_evidence: 'no security findings' },
    { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
    { lens: 'tests', findings: [], dry_evidence: 'no test findings' },
  ];
}

// The ordered sequence of evidence entry types written to the manifest. Two runs
// of the same input must emit the same shape of evidence (AC4 regression proof);
// we compare the type sequence rather than full entries because the fixtures embed
// per-tempdir absolute paths in transcript/review-packet fields.
function entryTypes(dir) {
  return readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l).type);
}

describe('cross-model gate — trust-root tier (requireCrossModel=true)', () => {
  it('AC3: exits 2 when no matching cross-model attestation exists', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'anthropic',
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /cross-model adversarial approve from a distinct provider/);
    assert.match(result.message, new RegExp(REV));
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-cross-model-missing"/);
    assert.doesNotMatch(manifest, /"type":"p5-complete"/);
  });

  it('AC3: exits 0 once a distinct-provider approve bound to the current revision exists', () => {
    const dir = tmpAdlc();
    recordCrossModelReview({ ticket: 'T1', revision: REV, provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'anthropic',
    });
    assert.equal(result.exitCode, 0);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
  });

  it('AC3: a stale-revision approve does NOT clear the gate', () => {
    const dir = tmpAdlc();
    recordCrossModelReview({ ticket: 'T1', revision: 'stale-rev', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'anthropic',
    });
    assert.equal(result.exitCode, 2);
  });

  it('AC3: a same-provider (non-distinct) attestation does NOT satisfy the gate', () => {
    const dir = tmpAdlc();
    // recordCrossModelReview refuses to create this, so inject it directly to
    // prove the READ side (hasCrossModelApprove) also rejects a forged same-model entry.
    record({ gate: 'cross-model-review', ticket: 'T1', rawData: JSON.stringify({ provider: 'anthropic', authorProvider: 'anthropic', verdict: 'approve', revision: REV }), dir });
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'anthropic',
    });
    assert.equal(result.exitCode, 2);
  });

  it('does not require cross-model when the underlying P5 already fails', () => {
    // Only two distinct dry lenses: P5 fails for the ordinary reason, not the
    // cross-model reason — the tier gate must not mask the real failure message.
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [
        { lens: 'security', findings: [], dry_evidence: 'no security findings' },
        { lens: 'correctness', findings: [], dry_evidence: 'no correctness findings' },
      ],
    }), { key: TEST_KEY, dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'anthropic' });
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /fewer than three distinct dry lenses/);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.doesNotMatch(manifest, /"type":"p5-cross-model-missing"/);
  });

  it('author anchoring: a run whose author EQUALS the attestation reviewer does NOT pass', () => {
    // A valid distinct entry (reviewer openai, author anthropic) exists, but THIS
    // prosecution declares its author is openai — same as the reviewer. Distinctness
    // is measured against the prosecution-declared author, so the gate must fail.
    const dir = tmpAdlc();
    recordCrossModelReview({ ticket: 'T1', revision: REV, provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, authorProvider: 'openai',
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /cross-model adversarial approve from a distinct provider/);
  });

  it('FAILS CLOSED (exit 1) when a tiered run supplies no author-provider', () => {
    // Cannot prove the reviewer is distinct from the author without knowing the
    // author, so a trust-root-tier run without --author-provider is an op-error.
    const dir = tmpAdlc();
    recordCrossModelReview({ ticket: 'T1', revision: REV, provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir });
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: true, // authorProvider omitted
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((e) => /author-provider|ADLC_AUTHOR_PROVIDER/.test(e)));
  });
});

describe('cross-model gate — non-trust-root tier is unaffected (AC4)', () => {
  it('requireCrossModel=false passes exactly as today (no cross-model entry needed)', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, { passes: cleanPasses() }), { key: TEST_KEY,
      dir, ticket: 'T1', revision: REV, requireCrossModel: false,
    });
    assert.equal(result.exitCode, 0);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p5-complete"/);
    assert.doesNotMatch(manifest, /cross-model/);
  });

  it('the default (option omitted) is byte-identical to explicit requireCrossModel=false', () => {
    const dirA = tmpAdlc();
    const dirB = tmpAdlc();
    const resA = runProsecution(input(dirA, { passes: cleanPasses() }), { key: TEST_KEY, dir: dirA, ticket: 'T1', revision: REV });
    const resB = runProsecution(input(dirB, { passes: cleanPasses() }), { key: TEST_KEY, dir: dirB, ticket: 'T1', revision: REV, requireCrossModel: false });
    assert.deepEqual({ ...resA }, { ...resB });
    // Same ordered evidence shape, and neither run touches the cross-model path.
    assert.deepEqual(entryTypes(dirA), entryTypes(dirB));
    assert.ok(!entryTypes(dirA).some((t) => t.includes('cross-model')));
  });

  it('an ordinary failing change is unchanged with the option omitted', () => {
    const dir = tmpAdlc();
    const result = runProsecution(input(dir, {
      passes: [{ lens: 'security', findings: [], dry_evidence: 'no findings' }],
    }), { key: TEST_KEY, dir, ticket: 'T1', revision: REV });
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /convergence budget ended before two consecutive dry passes/);
  });
});
