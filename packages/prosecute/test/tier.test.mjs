// Concern: trust-root-tier classifier (T39 AC1).
//
// classifyTrustRootTier({ changedFiles, tickets }) is pure/offline/deterministic.
// A change is trust-root tier iff any changed file matches ANY surface class:
//   1. an exact trust-root file,
//   2. an enforcement-package prefix,
//   3. a gated-artifact producer-package prefix,
//   4. a rails deny-path glob declared on any ticket.
// Positive AND negative fixtures for every surface class; an ordinary diff is FALSE.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrustRootTier } from '../lib/tier.mjs';

const TICKETS = [
  { id: 'T7', title: 'auth', scope: ['src/**'], rails: ['test/auth/**'], edges: [] },
  { id: 'T8', title: 'noise', scope: ['src/**'], rails: [], edges: [] },
];

describe('classifyTrustRootTier — positive surface classes', () => {
  it('TRUE for an exact trust-root file (rails-guard-ci.mjs)', () => {
    const r = classifyTrustRootTier({ changedFiles: ['scripts/rails-guard-ci.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('scripts/rails-guard-ci.mjs')));
  });

  it('TRUE for the CI workflow template and hash pin and tickets.json', () => {
    for (const f of ['docs/ci/rails-guard.yml', 'scripts/test/rails-guard-workflow-hashes.json', '.adlc/tickets.json']) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${f} should be trust-root`);
      assert.ok(r.reasons.some((x) => x.includes(f)));
    }
  });

  it('TRUE for an enforcement-package prefix (packages/prosecute/…)', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages/prosecute/lib/run.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('packages/prosecute/')));
  });

  it('TRUE for every enforcement package', () => {
    for (const p of ['packages/rails-guard/', 'packages/prosecute/', 'packages/gate-manifest/', 'packages/build-gate/']) {
      const r = classifyTrustRootTier({ changedFiles: [`${p}lib/x.mjs`], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${p} should be trust-root`);
    }
  });

  it('TRUE for a gated-artifact producer package (ticket-prune / ticket-sync)', () => {
    for (const p of ['packages/ticket-prune/', 'packages/ticket-sync/']) {
      const r = classifyTrustRootTier({ changedFiles: [`${p}lib/y.mjs`], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${p} should be trust-root`);
      assert.ok(r.reasons.some((x) => x.includes(p)));
    }
  });

  it('TRUE for a change that hits a ticket rails deny-path glob', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/auth/login.test.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('T7') && x.includes('test/auth/**')));
  });
});

describe('classifyTrustRootTier — negative / ordinary diffs', () => {
  it('FALSE for a docs-only change', () => {
    const r = classifyTrustRootTier({ changedFiles: ['apps/docs/x.mdx'], tickets: TICKETS });
    assert.deepEqual(r, { isTrustRootTier: false, reasons: [] });
  });

  it('FALSE for a non-enforcement package change', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages/spec-lint/lib/y.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, false);
    assert.deepEqual(r.reasons, []);
  });

  it('FALSE for a source change outside any rails deny-path', () => {
    const r = classifyTrustRootTier({ changedFiles: ['src/app.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, false);
  });

  it('FALSE for empty inputs / defaults', () => {
    assert.deepEqual(classifyTrustRootTier({}), { isTrustRootTier: false, reasons: [] });
    assert.deepEqual(classifyTrustRootTier(), { isTrustRootTier: false, reasons: [] });
  });
});

describe('classifyTrustRootTier — hygiene', () => {
  it('dedups repeated reasons across multiple files hitting the same surface', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['packages/prosecute/lib/a.mjs', 'packages/prosecute/lib/b.mjs'],
      tickets: TICKETS,
    });
    const enforcement = r.reasons.filter((x) => x.includes('packages/prosecute/'));
    assert.equal(enforcement.length, 1);
  });

  it('normalizes backslash paths to POSIX before matching', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages\\prosecute\\lib\\a.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
  });

  it('collects reasons from several distinct surfaces at once', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['scripts/rails-guard-ci.mjs', 'packages/ticket-sync/lib/z.mjs', 'test/auth/x.test.mjs'],
      tickets: TICKETS,
    });
    assert.equal(r.isTrustRootTier, true);
    assert.equal(r.reasons.length, 3);
  });
});
