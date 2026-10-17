// Concern: classifyTrustRootTier skips only the rails the ticket under
// prosecution adds itself (#1180). `ownTicket: { id, baseRails }` names that
// ticket and the rails the BASE tip declares for it; a rail of that ticket
// missing from baseRails applies after merge and does not tier the change.
// Rails on the base, rails of any other ticket, completed tickets and every
// other surface class keep their previous result. Omitting ownTicket changes
// nothing (pinned on the full positive-surface matrix below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrustRootTier } from '../lib/tier.mjs';

const TICKETS = [
  { id: 'T7', title: 'auth', scope: ['src/**'], rails: ['test/auth/**'], edges: [] },
  { id: 'T8', title: 'noise', scope: ['src/**'], rails: [], edges: [] },
];

describe('classifyTrustRootTier — a ticket\'s own new rails apply after merge (#1180)', () => {
  const own = (over = {}) => ({ id: 'T1', title: 'own', scope: ['src/**'], rails: ['test/own/**'], edges: [], ...over });

  it('an own rail absent from the base does not tier, and is reported as skipped', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/own/a.test.mjs'], tickets: [own()], ownTicket: { id: 'T1', baseRails: [] } });
    assert.deepEqual(r, { isTrustRootTier: false, reasons: [], skippedOwnRails: ['test/own/**'] });
  });

  it('an own rail already on the base still tiers', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/own/a.test.mjs'], tickets: [own()], ownTicket: { id: 'T1', baseRails: ['test/own/**'] } });
    assert.equal(r.isTrustRootTier, true);
    assert.deepEqual(r.reasons, ['touches rails deny-path of ticket T1: test/own/**']);
    assert.deepEqual(r.skippedOwnRails, []);
  });

  it('another ticket\'s rail still tiers; the skip is keyed on ownTicket.id only', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/auth/x.test.mjs'], tickets: [own(), ...TICKETS], ownTicket: { id: 'T1', baseRails: [] } });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('ticket T7')));
    assert.deepEqual(r.skippedOwnRails, []);
  });

  it('another ticket sharing the same glob still tiers the change', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['test/own/a.test.mjs'],
      tickets: [own(), own({ id: 'T2' })],
      ownTicket: { id: 'T1', baseRails: [] },
    });
    assert.deepEqual(r.reasons, ['touches rails deny-path of ticket T2: test/own/**']);
    assert.deepEqual(r.skippedOwnRails, ['test/own/**']);
  });

  it('a completed ticket does not tier (unchanged) and reports nothing skipped', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/own/a.test.mjs'], tickets: [own({ completed: true })], ownTicket: { id: 'T1', baseRails: ['test/own/**'] } });
    assert.deepEqual(r, { isTrustRootTier: false, reasons: [], skippedOwnRails: [] });
  });

  it('base rail a, HEAD adds rail b: a change to a tiers, a change to b does not', () => {
    const tickets = [own({ rails: ['test/a/**', 'test/b/**'] })];
    const ownTicket = { id: 'T1', baseRails: ['test/a/**'] };
    const a = classifyTrustRootTier({ changedFiles: ['test/a/x.test.mjs'], tickets, ownTicket });
    assert.equal(a.isTrustRootTier, true);
    assert.deepEqual(a.reasons, ['touches rails deny-path of ticket T1: test/a/**']);
    const b = classifyTrustRootTier({ changedFiles: ['test/b/x.test.mjs'], tickets, ownTicket });
    assert.deepEqual(b, { isTrustRootTier: false, reasons: [], skippedOwnRails: ['test/b/**'] });
  });

  it('an own new rail plus a trust-root file tiers with the trust-root reason only', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['test/own/a.test.mjs', 'scripts/rails-guard-ci.mjs'],
      tickets: [own()],
      ownTicket: { id: 'T1', baseRails: [] },
    });
    assert.equal(r.isTrustRootTier, true);
    assert.deepEqual(r.reasons, ['touches trust-root file scripts/rails-guard-ci.mjs']);
    assert.deepEqual(r.skippedOwnRails, ['test/own/**']);
  });

  it('a skipped rail is listed once however many changed files it matches', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/own/a.test.mjs', 'test/own/b.test.mjs'], tickets: [own()], ownTicket: { id: 'T1', baseRails: [] } });
    assert.deepEqual(r, { isTrustRootTier: false, reasons: [], skippedOwnRails: ['test/own/**'] });
  });

  it('a malformed ownTicket (no usable id, or no baseRails array) skips nothing', () => {
    for (const ownTicket of [{}, { id: '' }, { id: '  ', baseRails: [] }, { id: 7, baseRails: [] }, null, { id: 'T1' }, { id: 'T1', baseRails: 'test/own/**' }]) {
      // The ticket carries the same id as ownTicket, so only the guard can stop the skip.
      const r = classifyTrustRootTier({ changedFiles: ['test/own/a.test.mjs'], tickets: [own({ id: ownTicket?.id ?? 'T1' })], ownTicket });
      assert.equal(r.isTrustRootTier, true, `ownTicket ${JSON.stringify(ownTicket)} must not skip`);
      assert.deepEqual(r.skippedOwnRails, []);
    }
  });

  it('omitting ownTicket reproduces the previous result on the full positive-surface matrix', () => {
    const files = [
      'scripts/rails-guard-ci.mjs', 'docs/ci/rails-guard.yml', 'scripts/test/rails-guard-workflow-hashes.json',
      'package.json', 'package-lock.json', '.npmrc', 'CODEOWNERS', '.github/workflows/ci.yml', '.github/actions/x/action.yml',
      'packages/rails-guard/lib/x.mjs', 'packages/prosecute/lib/x.mjs', 'packages/gate-manifest/lib/x.mjs',
      'packages/build-gate/lib/x.mjs', 'packages/ticket-prune/lib/x.mjs', 'packages/ticket-sync/lib/x.mjs',
      'test/auth/login.test.mjs',
    ];
    for (const f of files) {
      const omitted = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(omitted.isTrustRootTier, true, `${f} should still tier with ownTicket omitted`);
      assert.deepEqual(omitted.skippedOwnRails, []);
      // Naming the rail-owning ticket with all its rails on the base changes nothing.
      const allOnBase = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS, ownTicket: { id: 'T7', baseRails: ['test/auth/**'] } });
      assert.deepEqual(allOnBase, omitted, `${f}: an ownTicket whose rails are all on the base must not change the result`);
    }
  });
});
