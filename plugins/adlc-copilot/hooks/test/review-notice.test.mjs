// review-notice.test.mjs — T50. Drift test: the Stop-hook's inline
// KEEP-IN-SYNC copy of packages/core/lib/risk-tier.mjs must produce
// IDENTICAL output to the real module across shared fixtures (same
// precedent as build-gate.test.mjs for T49 / packages/core/test/shell.test.mjs
// for rails-guard). Plus stopReview/gitChangedPaths behavior coverage,
// mirroring plugins/adlc-cursor/test/stop-preflight.test.mjs's structure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  matchRiskTier as hookMatchRiskTier,
  classifyRiskTier as hookClassifyRiskTier,
  decideAdversarialReviewNotice as hookDecideNotice,
  globMatch as hookGlobMatch,
  gitChangedPaths,
  resolveActiveTicketIdAdvisory,
  stopReview,
  run,
} from '../adlc-lifecycle.mjs';

import {
  matchRiskTier as coreMatchRiskTier,
  classifyRiskTier as coreClassifyRiskTier,
  decideAdversarialReviewNotice as coreDecideNotice,
} from '../../../../packages/core/lib/risk-tier.mjs';
import { globMatch as coreGlobMatch } from '../../../../packages/core/lib/tickets.mjs';

const PATH_FIXTURES = [
  'src/auth/login.js', 'src/index.mjs', '.env', 'config/.env.production',
  'src/security/guard.mjs', 'db/migrations/001_init.sql', '.github/workflows/ci.yml',
  'package.json', 'src/utils/delete-account.mjs', 'README.md',
];

test('drift: matchRiskTier/classifyRiskTier are identical to packages/core/lib/risk-tier.mjs', () => {
  for (const path of PATH_FIXTURES) {
    assert.deepEqual(hookMatchRiskTier(path), coreMatchRiskTier(path), `matchRiskTier drift for ${path}`);
  }
  assert.deepEqual(hookClassifyRiskTier(PATH_FIXTURES), coreClassifyRiskTier(PATH_FIXTURES));
});

test('drift: globMatch handles leading **/ patterns identically to @adlc/core', () => {
  const cases = [['**/.env', '.env'], ['**/auth/**', 'auth/x.mjs'], ['**/*guard*', 'guard.mjs']];
  for (const [pattern, path] of cases) {
    assert.equal(hookGlobMatch(pattern, path), coreGlobMatch(pattern, path));
  }
});

test('drift: decideAdversarialReviewNotice is identical to packages/core/lib/risk-tier.mjs across notice scenarios', () => {
  const scenarios = [
    { changedPaths: [], manifestEntries: [], ticketId: null },
    { changedPaths: ['README.md'], manifestEntries: [], ticketId: null },
    { changedPaths: ['src/auth/login.js'], manifestEntries: [], ticketId: 'T1' },
    { changedPaths: ['src/auth/login.js'], manifestEntries: [{ gate: 'adversarial-review', ticket: 'T1' }], ticketId: 'T1' },
    { changedPaths: ['src/auth/login.js'], manifestEntries: [{ gate: 'adversarial-review', ticket: 'T2' }], ticketId: 'T1' },
    { changedPaths: ['src/auth/login.js'], manifestEntries: [{ gate: 'adversarial-review' }], ticketId: 'T1' },
  ];
  for (const s of scenarios) {
    assert.deepEqual(hookDecideNotice(s), coreDecideNotice(s), `decideAdversarialReviewNotice drift for ${JSON.stringify(s)}`);
  }
});

// --- gitChangedPaths / stopReview behavior, mirroring plugins/adlc-cursor's test structure ---

function routedSpawn(routes = []) {
  const calls = [];
  const impl = (bin, args) => {
    calls.push({ bin, args });
    for (const [match, result] of routes) if (match(bin, args)) return result;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { impl, calls };
}

function mkAdlcRoot() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-review-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [] }));
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  return root;
}

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-gitcp-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { root, git };
}

test('stopReview SKIPS a repo with no .adlc/ — nothing spawned', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-noadlc-'));
  const { impl, calls } = routedSpawn();
  try {
    const res = stopReview(root, { spawnImpl: impl, env: {} });
    assert.deepEqual(res, { skipped: true, warning: null });
    assert.equal(calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gitChangedPaths (-z, slice(3)): a staged-then-modified file WITH SPACES yields the clean whole path', () => {
  const { root, git } = gitRepo();
  try {
    writeFileSync(join(root, 'seed.txt'), 'x');
    git('add', 'seed.txt'); git('commit', '-qm', 'seed');
    const p = 'staged then modified.js';
    writeFileSync(join(root, p), 'v1');
    git('add', p);
    writeFileSync(join(root, p), 'v2');
    const changed = gitChangedPaths(root, { base: 'no-such-base' });
    assert.ok(changed.includes(p));
    assert.ok(!changed.some((c) => c !== p && c.endsWith(p)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gitChangedPaths includes a branch-only committed file via the merge-base diff against the base', () => {
  const { root, git } = gitRepo();
  try {
    writeFileSync(join(root, 'base.txt'), 'x');
    git('add', 'base.txt'); git('commit', '-qm', 'base');
    git('branch', '-M', 'main');
    git('checkout', '-q', '-b', 'feature');
    const committed = 'feature-only.js';
    writeFileSync(join(root, committed), 'y');
    git('add', committed); git('commit', '-qm', 'feature');
    const changed = gitChangedPaths(root, { base: 'main' });
    assert.ok(changed.includes(committed));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopReview: risk-gated change with no record fires the notice', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('show'), { status: 0, stdout: JSON.stringify({ entries: [] }), stderr: '' }],
  ]);
  try {
    const res = stopReview(root, { spawnImpl: impl, env: { ADLC_TICKET: 'T50' } });
    assert.equal(res.skipped, false);
    assert.ok(res.warning);
    assert.match(res.warning, /auth-trust-boundary/);
    assert.match(res.warning, /T50/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopReview: a record scoped to a DIFFERENT ticket still fires the notice (ticket-scoping)', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('show'),
      { status: 0, stdout: JSON.stringify({ entries: [{ gate: 'adversarial-review', ticket: 'T99' }] }), stderr: '' }],
  ]);
  try {
    const res = stopReview(root, { spawnImpl: impl, env: { ADLC_TICKET: 'T50' } });
    assert.ok(res.warning, 'a record for a different ticket must not satisfy the active ticket');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopReview: a record for the ACTIVE ticket silences the notice', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }],
    [(b, a) => b === 'adlc' && a.includes('show'),
      { status: 0, stdout: JSON.stringify({ entries: [{ gate: 'adversarial-review', ticket: 'T50' }] }), stderr: '' }],
  ]);
  try {
    const res = stopReview(root, { spawnImpl: impl, env: { ADLC_TICKET: 'T50' } });
    assert.equal(res.warning, null, 'an in-ticket record must silence the notice');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopReview: no risk-gated paths changed — silent, no warning', () => {
  const root = mkAdlcRoot();
  const { impl } = routedSpawn([
    [(b, a) => b === 'git' && a[0] === 'status', { status: 0, stdout: ' M README.md\0', stderr: '' }],
    [(b, a) => b === 'git' && a[0] === 'rev-parse', { status: 1, stdout: '', stderr: '' }],
  ]);
  try {
    const res = stopReview(root, { spawnImpl: impl, env: {} });
    assert.equal(res.warning, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveActiveTicketIdAdvisory degrades a conflict to null instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-advisory-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
    const id = resolveActiveTicketIdAdvisory(root, { ADLC_TICKET: 'T2' }); // conflicts with file's T1
    assert.equal(id, null, 'a conflict must degrade to null, never throw, for this advisory context');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run() converts a THROWING spawn into { status: 1 } instead of propagating', () => {
  const r = run(() => { throw new Error('kaboom'); }, 'git', [], '/tmp');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kaboom/);
});
