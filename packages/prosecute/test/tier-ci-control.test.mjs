// Concern: the CI definitions that run the required gates, and the file that
// names who may approve a trust-root change, are themselves trust-root tier.
//
// Every required status check except `gate` is defined by a workflow the pull
// request itself supplies, so an edit to that workflow can make a required
// check report success without running. The base-controlled `gate` job only
// demands a cross-model attestation for what this classifier tiers, so these
// surfaces must tier unconditionally — including their test-looking paths.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyTrustRootTier } from '../lib/tier.mjs';

const REQUIRED_GATES = fileURLToPath(new URL('../../../docs/ci/required-gates.json', import.meta.url));

const tiers = (file) => classifyTrustRootTier({ changedFiles: [file], tickets: [] });

describe('classifyTrustRootTier — CI control surfaces', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/workflows/cross-model-gate.yml',
    '.github/workflows/gate-liveness.yml',
    '.github/workflows/new-workflow.yaml',
    '.github/actions/install-bubblewrap/action.yml',
    '.github/actions/test/action.yml',
  ]) {
    it(`TRUE for ${file}`, () => {
      const r = tiers(file);
      assert.equal(r.isTrustRootTier, true, `${file} must be trust-root tier`);
      assert.ok(r.reasons.some((x) => x.includes('CI control surface')), JSON.stringify(r.reasons));
    });
  }

  for (const file of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
    it(`TRUE for the code-owners file at ${file}`, () => {
      const r = tiers(file);
      assert.equal(r.isTrustRootTier, true, `${file} must be trust-root tier`);
      assert.ok(r.reasons.some((x) => x.includes(`trust-root file ${file}`)), JSON.stringify(r.reasons));
    });
  }

  it('TRUE for the permanently locked /tmp fixture guard', () => {
    const r = tiers('scripts/test/tmp-fixture-boundary.test.mjs');
    assert.equal(r.isTrustRootTier, true);
  });

  it('a non-canonical path under .github/workflows tiers (over-tiering is the safe direction)', () => {
    assert.equal(tiers('.github/workflows/../workflows/ci.yml').isTrustRootTier, true);
  });

  for (const file of [
    '.github/ISSUE_TEMPLATE/bug.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'docs/github-workflows.md',
    'src/.github/workflows/ci.yml',
    'packages/x/CODEOWNERS',
    'CODEOWNERS.md',
  ]) {
    it(`FALSE for the lookalike ${file}`, () => {
      assert.equal(tiers(file).isTrustRootTier, false, `${file} must not tier`);
    });
  }

  it('every workflow that declares a required gate in docs/ci/required-gates.json tiers', () => {
    const { workflows } = JSON.parse(readFileSync(REQUIRED_GATES, 'utf8'));
    const workflowPaths = Object.keys(workflows);
    assert.ok(workflowPaths.length > 0);
    for (const file of workflowPaths) {
      assert.equal(tiers(file).isTrustRootTier, true, `${file} defines a required gate and must tier`);
    }
  });
});
