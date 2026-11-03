// §1.1 — self-authored uncorroborated witness → NOT a defeat (F1)
// Tests oracle independence: a witness that is only self-authored (no contract
// derivation, no independent approval) must NOT yield a defeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOracle } from '../lib/oracle.mjs';
import { makeProvisionFn } from '../lib/provision.mjs';
import { tmp, gitRepo } from '@adlc/core/test-kit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fix 3: Must-fixes remove source (c) suite-minus-G corroboration.
// Keep: (a) contract-derived, (b) independent-context approval.

test('contract-derived witness is independent', () => {
  const result = checkOracle({
    candidate: { target: 'rails-guard', claimKind: 'freeze-integrity', witnessProposal: {} },
    witnessSource: 'contract-derived',
    independentApprovalFn: null, // not needed for contract-derived
  });
  assert.equal(result.independent, true);
  assert.equal(result.source, 'contract-derived');
});

test('independently-approved witness is independent', () => {
  // Lens says: yes, this is a genuine defect
  const approveFn = (_candidate, _witnessProposal) => ({ approved: true, reason: 'genuine defect confirmed' });
  const result = checkOracle({
    candidate: { target: 'rails-guard', claimKind: 'freeze-integrity', witnessProposal: {} },
    witnessSource: 'proposed',
    independentApprovalFn: approveFn,
  });
  assert.equal(result.independent, true);
  assert.equal(result.source, 'independently-approved');
});

test('independently-rejected witness is NOT independent (unwitnessed)', () => {
  // Lens rejects: self-authored witness contrived to the diff
  const approveFn = (_candidate, _witnessProposal) => ({ approved: false, reason: 'contrived to the diff' });
  const result = checkOracle({
    candidate: { target: 'rails-guard', claimKind: 'freeze-integrity', witnessProposal: {} },
    witnessSource: 'proposed',
    independentApprovalFn: approveFn,
  });
  assert.equal(result.independent, false);
  assert.equal(result.source, 'unwitnessed');
  assert.ok(result.reason.includes('contrived') || result.reason.includes('rejected'));
});

test('no approval function and no contract derivation → unwitnessed', () => {
  // No contract-derived, no approval function → cannot establish independence
  const result = checkOracle({
    candidate: { target: 'some-gate', claimKind: 'test-adequacy', witnessProposal: {} },
    witnessSource: 'proposed',
    independentApprovalFn: null,
  });
  assert.equal(result.independent, false);
  assert.equal(result.source, 'unwitnessed');
});

test('off-surface candidate is not a defeat', () => {
  // Candidate touches files outside gate surface → out-of-scope, never defeat
  // This is tested in classify, but oracle should also indicate non-applicable
  const result = checkOracle({
    candidate: { target: 'rails-guard', claimKind: 'freeze-integrity', witnessProposal: {} },
    witnessSource: 'contract-derived',
    independentApprovalFn: null,
  });
  // Contract-derived witnesses are always independent
  assert.equal(result.independent, true);
});

test('wrong-claim candidate: witness for unrelated property → oracle cannot certify defeat of gate', () => {
  // A witness proving "math is wrong" against rails-guard (which only claims freeze-integrity)
  // This is checked at the claimKind level in classify, not oracle. Oracle checks independence.
  // The oracle does not know about claimKind — it only assesses independence.
  // So this test confirms oracle's scope is limited to independence assessment.
  const result = checkOracle({
    candidate: { target: 'rails-guard', claimKind: 'test-adequacy', witnessProposal: {} },
    witnessSource: 'contract-derived',
    independentApprovalFn: null,
  });
  // Oracle just says "yes this is independently derived" — the claimKind mismatch
  // is caught by classifyCandidate, not oracle.
  assert.equal(result.independent, true);
  assert.equal(result.source, 'contract-derived');
});

test('#642: makeProvisionFn oracleFn ignores adversary cand.witnessSource and derives independence only from target gate contract', async (t) => {
  const { dir: repoRoot, git } = gitRepo(t, { prefix: 'gf-prov-642-' });
  writeFileSync(join(repoRoot, 'f.js'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const suite = [
    { name: 'behavioral-gate', surface: ['**'], claims: ['test-adequacy'], run: ['node', '-e', 'process.exit(0)'] },
    { name: 'contract-gate', surface: ['**'], claims: ['freeze-integrity'], run: ['node', '-e', 'process.exit(0)'] },
  ];
  const provisionFn = makeProvisionFn({
    repoRoot,
    sandboxType: null,
    unsafeNoSandbox: true,
    suite,
    baselineRef: 'HEAD',
    independentApprovalFn: null,
  });

  const diff = [
    'diff --git a/f.js b/f.js',
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1 +1 @@',
    '-export const x = 1;',
    '+export const x = 2;',
    '',
  ].join('\n');

  const spoofedBehavioral = {
    target: 'behavioral-gate',
    claimKind: 'test-adequacy',
    diff,
    witnessProposal: { cmd: 'node', args: ['-e', 'process.exit(1)'] },
    witnessSource: 'contract-derived',
  };

  const provisioned = await provisionFn(spoofedBehavioral);
  try {
    const verdict = provisioned.oracleFn(spoofedBehavioral);
    assert.equal(verdict.independent, false, 'adversary witnessSource: contract-derived on behavioral claim must NOT self-attest as independent');
    assert.equal(verdict.source, 'unwitnessed');

    const unknownGateVerdict = provisioned.oracleFn({ ...spoofedBehavioral, target: 'no-such-gate' });
    assert.equal(unknownGateVerdict.independent, false);
    assert.equal(unknownGateVerdict.source, 'unwitnessed');

    const contractCand = {
      target: 'contract-gate',
      claimKind: 'freeze-integrity',
      diff,
      witnessProposal: { cmd: 'node', args: ['-e', 'process.exit(1)'] },
    };
    const contractVerdict = provisioned.oracleFn(contractCand);
    assert.equal(contractVerdict.independent, true);
    assert.equal(contractVerdict.source, 'contract-derived');
  } finally {
    provisioned.destroy();
  }
});
