import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTrustRootAuthorization } from '../lib/trust-root-authorization.mjs';

// #141 (T77): the trust-root change ceremony. Authorization is a `trust-root-change`
// LABEL (intent) plus a non-author CODEOWNER APPROVING review (authorization —
// GitHub forbids self-approval). The classifier is PURE; the GitHub I/O that
// gathers labels/reviews is a separate adapter. Default deny: anything short of a
// verifiable non-author-owner approval is unauthorized.

const OWNERS = ['voodootikigod', 'trusty-reviewer'];
const base = (over = {}) => ({
  labels: ['trust-root-change'],
  reviews: [{ user: 'trusty-reviewer', state: 'APPROVED', submittedAt: '2026-07-24T00:00:00Z' }],
  author: 'contributor',
  owners: OWNERS,
  ...over,
});

test('authorized: trust-root-change label + non-author CODEOWNER approval', () => {
  const r = classifyTrustRootAuthorization(base());
  assert.equal(r.authorized, true);
  assert.equal(r.approver, 'trusty-reviewer');
});

// Table of cases that must all remain DENIED (default-closed).
for (const [name, over] of [
  ['missing the label', { labels: [] }],
  ['author self-approval only', { author: 'trusty-reviewer' }], // reviewer == author
  ['approval from a non-CODEOWNER', { reviews: [{ user: 'random-user', state: 'APPROVED' }] }],
  ['owner requested changes, did not approve', { reviews: [{ user: 'trusty-reviewer', state: 'CHANGES_REQUESTED' }] }],
  ['owner only commented (no approval)', { reviews: [{ user: 'trusty-reviewer', state: 'COMMENTED' }] }],
  ['no reviews at all', { reviews: [] }],
  ['label present but approval later DISMISSED (stale)', {
    reviews: [
      { user: 'trusty-reviewer', state: 'APPROVED', submittedAt: '2026-07-24T00:00:00Z' },
      { user: 'trusty-reviewer', state: 'DISMISSED', submittedAt: '2026-07-24T01:00:00Z' },
    ],
  }],
]) {
  test(`denied: ${name}`, () => {
    const r = classifyTrustRootAuthorization(base(over));
    assert.equal(r.authorized, false, `expected denied for: ${name} — got ${JSON.stringify(r)}`);
    assert.equal(r.approver, null);
    assert.ok(r.reason && r.reason.length > 0);
  });
}

test('latest state wins: CHANGES_REQUESTED then APPROVED by the same owner → authorized', () => {
  const r = classifyTrustRootAuthorization(base({
    reviews: [
      { user: 'trusty-reviewer', state: 'CHANGES_REQUESTED', submittedAt: '2026-07-24T00:00:00Z' },
      { user: 'trusty-reviewer', state: 'APPROVED', submittedAt: '2026-07-24T01:00:00Z' },
    ],
  }));
  assert.equal(r.authorized, true);
  assert.equal(r.approver, 'trusty-reviewer');
});

test('a later COMMENTED review does NOT dismiss an earlier approval', () => {
  const r = classifyTrustRootAuthorization(base({
    reviews: [
      { user: 'trusty-reviewer', state: 'APPROVED', submittedAt: '2026-07-24T00:00:00Z' },
      { user: 'trusty-reviewer', state: 'COMMENTED', submittedAt: '2026-07-24T02:00:00Z' },
    ],
  }));
  assert.equal(r.authorized, true);
});

test('@-prefix and case are normalized for owners, author, and reviewer logins', () => {
  const r = classifyTrustRootAuthorization({
    labels: ['trust-root-change'],
    reviews: [{ user: 'Trusty-Reviewer', state: 'APPROVED' }],
    author: 'Contributor',
    owners: ['@voodootikigod', '@Trusty-Reviewer'],
  });
  assert.equal(r.authorized, true);
});

test('a non-default required label can be configured', () => {
  const over = { labels: ['ceremony:trust-root'], requiredLabel: 'ceremony:trust-root' };
  assert.equal(classifyTrustRootAuthorization(base(over)).authorized, true);
  // and the default label no longer authorizes under the custom name
  assert.equal(classifyTrustRootAuthorization(base({ requiredLabel: 'ceremony:trust-root' })).authorized, false);
});
