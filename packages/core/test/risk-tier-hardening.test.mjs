import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdversarialReviewNotice } from '../lib/risk-tier.mjs';

describe('T-P10: risk-tier adversarial-review verdict and scoping hardening', () => {
  it('rejects unscoped adversarial-review entries lacking both ticket and non-empty files', () => {
    for (const entry of [
      { gate: 'adversarial-review', data: { verdict: 'approve' } },
      { gate: 'adversarial-review', ticket: '   ', files: {}, data: { verdict: 'approve' } },
    ]) {
      const res = decideAdversarialReviewNotice({
        changedPaths: ['src/auth/login.mjs'],
        manifestEntries: [entry],
        ticketId: 'T1',
      });
      assert.equal(res.needed, true, 'unscoped entry must not silence risk-tier notice');
    }
  });

  it('rejects adversarial-review entries whose verdict is not approve', () => {
    for (const verdict of ['needs-attention', 'fail', 'blocked', '', null]) {
      const res = decideAdversarialReviewNotice({
        changedPaths: ['src/auth/login.mjs'],
        manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1', data: { verdict } }],
        ticketId: 'T1',
      });
      assert.equal(res.needed, true, `verdict=${JSON.stringify(verdict)} must not satisfy notice`);
    }
  });

  it('accepts ticket-scoped or file-scoped adversarial-review entries with verdict === approve', () => {
    assert.equal(
      decideAdversarialReviewNotice({
        changedPaths: ['src/auth/login.mjs'],
        manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1', data: { verdict: 'approve' } }],
        ticketId: 'T1',
      }).needed,
      false,
    );
    assert.equal(
      decideAdversarialReviewNotice({
        changedPaths: ['src/auth/login.mjs'],
        manifestEntries: [{ gate: 'adversarial-review', files: { 'src/auth/login.mjs': 'abc' }, data: { verdict: 'approve' } }],
        ticketId: 'T1',
      }).needed,
      false,
    );
  });
});
