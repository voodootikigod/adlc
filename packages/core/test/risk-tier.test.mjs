// risk-tier.test.mjs — the ADR-0007 §1 risk-tier path-pattern matcher and the
// adversarial-review notice decision are both PURE functions (no I/O), so they
// are unit-tested directly here, no subprocess/temp-repo needed. This is the
// primitive both plugins/adlc-claude-code (ported verbatim, see its own header
// comment) and plugins/adlc-opencode (imports @adlc/core directly) build on.
//
// Written FIRST (TDD): this file fails against a repo with no risk-tier.mjs,
// then packages/core/lib/risk-tier.mjs is added to make it pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_TIER_PATTERNS,
  matchRiskTier,
  classifyRiskTier,
  decideAdversarialReviewNotice,
} from '../lib/risk-tier.mjs';

// ---- matchRiskTier: one path at a time ----

test('matchRiskTier: auth/trust-boundary path matches', () => {
  const hit = matchRiskTier('src/auth/login.mjs');
  assert.equal(hit.tier, 'auth-trust-boundary');
});

test('matchRiskTier: security control / deny path (rail guard) matches', () => {
  const hit = matchRiskTier('plugins/adlc-cursor/hooks/adlc-rails-guard.mjs');
  assert.equal(hit.tier, 'security-control-deny-path');
});

test('matchRiskTier: secrets (.env) matches', () => {
  assert.equal(matchRiskTier('.env').tier, 'secrets');
  assert.equal(matchRiskTier('config/.env.production').tier, 'secrets');
});

test('matchRiskTier: secrets (key/pem files) matches', () => {
  assert.equal(matchRiskTier('certs/server.pem').tier, 'secrets');
  assert.equal(matchRiskTier('certs/server.key').tier, 'secrets');
});

test('matchRiskTier: data-loss/destructive op matches', () => {
  assert.equal(matchRiskTier('src/jobs/purge-old-records.mjs').tier, 'data-loss-destructive');
});

test('matchRiskTier: schema/migration matches', () => {
  assert.equal(matchRiskTier('db/migrations/2026_add_users.sql').tier, 'schema-migration');
});

test('matchRiskTier: CI/CD or supply-chain matches', () => {
  assert.equal(matchRiskTier('.github/workflows/ci.yml').tier, 'ci-cd-supply-chain');
  assert.equal(matchRiskTier('packages/core/package.json').tier, 'ci-cd-supply-chain');
});

test('matchRiskTier: an ordinary source file matches nothing', () => {
  assert.equal(matchRiskTier('src/utils/format-date.mjs'), null);
});

test('matchRiskTier: normalizes backslashes before matching', () => {
  const hit = matchRiskTier('src\\auth\\login.mjs');
  assert.equal(hit.tier, 'auth-trust-boundary');
});

test('RISK_TIER_PATTERNS is frozen (accidental mutation is caught)', () => {
  assert.throws(() => {
    RISK_TIER_PATTERNS.secrets.push('**/*.oops');
  });
});

// ---- classifyRiskTier: a whole changeset ----

test('classifyRiskTier: not gated when no path matches any tier', () => {
  const res = classifyRiskTier(['README.md', 'src/utils/format-date.mjs']);
  assert.equal(res.gated, false);
  assert.deepEqual(res.matches, []);
});

test('classifyRiskTier: gated when at least one path matches', () => {
  const res = classifyRiskTier(['README.md', 'src/auth/login.mjs']);
  assert.equal(res.gated, true);
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].path, 'src/auth/login.mjs');
  assert.equal(res.matches[0].tier, 'auth-trust-boundary');
});

test('classifyRiskTier: multiple hits across tiers are all reported', () => {
  const res = classifyRiskTier(['src/auth/login.mjs', '.github/workflows/ci.yml', 'db/migrations/x.sql']);
  assert.equal(res.gated, true);
  assert.equal(res.matches.length, 3);
});

test('classifyRiskTier: empty/undefined input is not gated', () => {
  assert.equal(classifyRiskTier([]).gated, false);
  assert.equal(classifyRiskTier(undefined).gated, false);
});

// ---- decideAdversarialReviewNotice: hook decision logic, mocked manifest state ----

test('decideAdversarialReviewNotice: not gated → never needed, regardless of manifest', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['README.md'],
    manifestEntries: [],
    ticketId: null,
  });
  assert.equal(res.needed, false);
  assert.deepEqual(res.matches, []);
});

test('decideAdversarialReviewNotice: gated + no manifest entries at all → needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [],
    ticketId: null,
  });
  assert.equal(res.needed, true);
  assert.equal(res.matches.length, 1);
});

test('decideAdversarialReviewNotice: gated + an unrelated gate recorded → still needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'rails-bypass', ticket: 'T1' }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, true);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded for THIS ticket → not needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1' }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, false);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded for a DIFFERENT ticket → still needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T2' }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, true);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded with NO ticket field, active ticket known → satisfies (untargeted review still counts)', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review' }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, false);
});

test('decideAdversarialReviewNotice: gated + no active ticket resolved + ANY adversarial-review record exists → satisfies', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T9' }],
    ticketId: null,
  });
  assert.equal(res.needed, false);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded with --files for a DIFFERENT path (same ticket) → still needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1', files: { 'unrelated/file.mjs': 'deadbeef' } }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, true);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded with --files for a DIFFERENT path, no ticket at all → still needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', files: { 'unrelated/file.mjs': 'deadbeef' } }],
    ticketId: null,
  });
  assert.equal(res.needed, true);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded with --files overlapping the gated path → not needed', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1', files: { 'src/auth/login.mjs': 'deadbeef' } }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, false);
});

test('decideAdversarialReviewNotice: gated + adversarial-review recorded with an EMPTY --files map → falls back to ticket-only scoping (not needed)', () => {
  const res = decideAdversarialReviewNotice({
    changedPaths: ['src/auth/login.mjs'],
    manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1', files: {} }],
    ticketId: 'T1',
  });
  assert.equal(res.needed, false);
});

test('decideAdversarialReviewNotice: defaults (no args) → not needed, no throw', () => {
  const res = decideAdversarialReviewNotice();
  assert.equal(res.needed, false);
  assert.deepEqual(res.matches, []);
});
