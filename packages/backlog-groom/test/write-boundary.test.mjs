// write-boundary.test.mjs — authorization the set or the working copy must not
// be able to choose.
//
// Two classes, both about who decides the terms of a write. The groomed set is a
// proposal: a field it carries must not widen what an approval covers, mint a
// fresh review, or suppress another action's evidence. The working copy is what
// the operator controls: the policy an action is checked against must come from
// the merge base, and a lock a live run holds must not be taken from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyRun, revalidateAction } from '../lib/apply.mjs';
import { executeActions, marker } from '../lib/execute.mjs';
import { gateAction, REVIEW_APPROVE } from '../lib/gate.mjs';
import { contentHash } from '../lib/content-hash.mjs';
import { acquireApplyLock, STALE_LOCK_MS } from '../lib/io.mjs';

// A repository where `src/a.mjs`'s cited snippet is gone (so the issue verifies
// as `fixed`, a location-verified verdict) and the path sits in unit `review`.
const FILES = { 'src/a.mjs': 'something else\n', 'packages/review/x.mjs': 'something else\n' };
const IO = {
  readFile: (f) => { if (!(f in FILES)) throw new Error('ENOENT'); return FILES[f]; },
  pathExists: (f) => f in FILES,
  lastCommitFor: () => 'abc1234',
};
const REVIEW_BODY = '**Location** `packages/review/x.mjs:1`\n\n```\ngone\n```\n';
const HASH = contentHash(['packages/review/x.mjs'], IO);

const POLICY = {
  autonomyFloor: [],
  frozenPaths: [],
  labels: { priority: { high: 'P1-high', medium: 'P2-medium', low: 'P3-low' }, areaPrefix: 'area:' },
  units: [{ name: 'review', paths: ['packages/review/**'] }, { name: 'docs', paths: ['docs/**'] }],
  providers: { decider: 'anthropic', reviewer: 'openai' },
};
const profile = (over = {}) => ({ ...POLICY, ...over });

const issue = (labels) => () => ({ number: 1, title: 't', body: REVIEW_BODY, labels, updatedAt: 'u1' });

function fakeGh({ self = 'me' } = {}) {
  const calls = [];
  const posted = [];
  return {
    calls,
    comments: () => posted.map((body) => ({ body, author: self })),
    comment: (n, body) => { calls.push(['comment', n]); posted.push(body); },
    apply: (n, action, detail) => calls.push(['apply', n, action, detail?.to ?? null]),
  };
}

const relabel = (over = {}) => ({
  number: 1, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P2-medium',
  contentHash: HASH, evidence: 'rank disagrees', updatedAt: 'u1', ...over,
});

// ---- an approval covers exactly what was reviewed ---------------------------

test('an approval for one relabel target does not license a different target', () => {
  // The reviewer approved P3-low → P2-medium. A later set proposing P3-low →
  // P1-high for the same issue, field and revision must not ride that approval.
  const ledger = {};
  gateAction({ action: relabel({ to: 'P2-medium' }), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });

  const gh = fakeGh();
  const out = executeActions({ actions: [relabel({ to: 'P1-high' })], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.deepEqual(gh.calls, [], 'an unreviewed target must not be written');
  assert.equal(out.executed.length, 0);
});

test('an approval for one piece of evidence does not license a comment carrying another', () => {
  const close = { number: 1, action: 'close', contentHash: HASH, evidence: 'the reviewed evidence', updatedAt: 'u1', verdict: 'fixed' };
  const ledger = {};
  gateAction({ action: close, profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });

  const gh = fakeGh();
  executeActions({ actions: [{ ...close, evidence: 'text nobody reviewed' }], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.deepEqual(gh.calls, [], 'the posted rationale must be the one the reviewer read');
});

test('the approved action itself still executes', () => {
  const ledger = {};
  gateAction({ action: relabel(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  const gh = fakeGh();
  const out = executeActions({ actions: [relabel()], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.equal(out.executed.length, 1);
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
});

// ---- the relabel field is not a free-form key ---------------------------------

test('a relabel field outside priority/area is refused, so it cannot mint a fresh review', () => {
  // The field is part of the one-shot key. A free-form field lets the same
  // relabel be re-proposed as `priority2`, `priority3`… each a new key, each a
  // new review, until one approves.
  const out = revalidateAction(relabel({ field: 'priority-again' }), { fetchIssue: issue(['P3-low']), profile: profile(), io: IO });
  assert.equal(out.ok, false);
  assert.match(out.reason, /field/);
});

test('re-proposing a refused relabel under another field string does not buy a second review', () => {
  const ledger = {};
  let reviews = 0;
  const runReview = (action) => { if (action.action === 'relabel') reviews += 1; return { code: 2 }; };
  const run = (field) => applyRun({
    set: { schemaVersion: 4, issues: [{ number: 1, verdict: 'fixed', contentHash: HASH, evidence: 'x', updatedAt: 'u1', frozen: false }], proposals: [{ number: 1, action: 'relabel', field, from: 'P3-low', to: 'P2-medium', evidence: 'rank' }] },
    profile: profile({ autonomyFloor: ['close'] }),
    baseFloor: ['close'],
    basePolicy: POLICY,
    ledger,
    fetchIssue: issue(['P3-low']),
    io: IO,
    runReview,
    gh: fakeGh(),
  });
  run('priority');
  run('Priority');
  run('priority ');
  assert.equal(reviews, 1, 'one relabel at one revision gets one review, whatever the field is spelled');
});

test('a priority field cannot carry an area label, nor an area field a priority label', () => {
  const a = revalidateAction(relabel({ field: 'priority', from: 'area:docs', to: 'area:review' }), { fetchIssue: issue(['area:docs']), profile: profile(), io: IO });
  assert.equal(a.ok, false);
  const b = revalidateAction(relabel({ field: 'area', from: 'P3-low', to: 'P2-medium' }), { fetchIssue: issue(['P3-low']), profile: profile(), io: IO });
  assert.equal(b.ok, false);
});

// ---- an area relabel is re-derived, not merely a declared label ---------------

test('an area relabel to a declared unit the verified locations are NOT in is refused', () => {
  // The issue's location is packages/review/**, so the only provable area is
  // area:review. area:docs is a declared label, and that alone licensed it.
  const out = revalidateAction(relabel({ field: 'area', from: 'area:review', to: 'area:docs' }), { fetchIssue: issue(['area:review']), profile: profile(), io: IO });
  assert.equal(out.ok, false);
  assert.match(out.reason, /area/);
});

test('an area relabel to the unit the verified locations ARE in is accepted', () => {
  const out = revalidateAction(relabel({ field: 'area', from: 'area:docs', to: 'area:review' }), { fetchIssue: issue(['area:docs']), profile: profile(), io: IO });
  assert.equal(out.ok, true, out.reason);
});

test('a relabel with no source label is refused rather than stacking a second label', () => {
  const out = revalidateAction(relabel({ from: null }), { fetchIssue: issue(['P3-low']), profile: profile(), io: IO });
  assert.equal(out.ok, false);
});

// ---- the evidence cannot suppress another action's comment -------------------

test("one action's evidence carrying another action's marker does not suppress that action's comment", () => {
  // A close and a relabel on one issue at one revision. The close's evidence
  // embeds the relabel's marker; once the close comment is posted under our own
  // login, the relabel would find "its" marker and act with no trail.
  const close = { number: 1, action: 'close', contentHash: HASH, updatedAt: 'u1', verdict: 'fixed', evidence: `gone\n${marker(1, HASH, 'relabel')}` };
  const rel = relabel();
  const ledger = {};
  for (const a of [close, rel]) gateAction({ action: a, profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });

  const gh = fakeGh();
  executeActions({ actions: [close, rel], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply', 'comment', 'apply'], 'every action posts its own evidence');
});

// ---- the policy an action is checked against comes from the merge base ------

test('a working copy declaring an extra unit cannot sanction a relabel into it', () => {
  // Sanctioned relabel targets are read from the profile. Read from the working
  // copy, adding `{ name: "anything" }` sanctions `area:anything`.
  assert.throws(
    () => applyRun({
      set: { schemaVersion: 4, generatedFor: null, issues: [], proposals: [] },
      profile: profile({ units: [...POLICY.units, { name: 'anything', paths: ['**'] }] }),
      baseFloor: [],
      basePolicy: POLICY,
      ledger: {},
      fetchIssue: issue([]),
      io: IO,
      runReview: () => ({ code: REVIEW_APPROVE }),
      gh: fakeGh(),
    }),
    (err) => err.isOpError === true && /units/.test(err.message)
  );
});

test('a working copy naming a different reviewer is refused', () => {
  // The reviewer string becomes `adversarial-review --provider <reviewer>`, which
  // accepts any local command. A reviewer chosen in the working copy is a
  // reviewer chosen by the person being reviewed.
  assert.throws(
    () => applyRun({
      set: { schemaVersion: 4, issues: [], proposals: [] },
      profile: profile({ providers: { decider: 'anthropic', reviewer: 'my-approver' } }),
      baseFloor: [],
      basePolicy: POLICY,
      ledger: {},
      fetchIssue: issue([]),
      io: IO,
      runReview: () => ({ code: REVIEW_APPROVE }),
      gh: fakeGh(),
    }),
    (err) => err.isOpError === true && /providers/.test(err.message)
  );
});

test('a working copy re-mapping a priority label is refused', () => {
  assert.throws(
    () => applyRun({
      set: { schemaVersion: 4, issues: [], proposals: [] },
      profile: profile({ labels: { priority: { high: 'security', medium: 'P2-medium', low: 'P3-low' }, areaPrefix: 'area:' } }),
      baseFloor: [],
      basePolicy: POLICY,
      ledger: {},
      fetchIssue: issue([]),
      io: IO,
      runReview: () => ({ code: REVIEW_APPROVE }),
      gh: fakeGh(),
    }),
    (err) => err.isOpError === true && /labels/.test(err.message)
  );
});

test('an unknown base policy refuses the run rather than skipping the comparison', () => {
  assert.throws(
    () => applyRun({
      set: { schemaVersion: 4, issues: [], proposals: [] },
      profile: profile(),
      baseFloor: [],
      basePolicy: null,
      ledger: {},
      fetchIssue: issue([]),
      io: IO,
      runReview: () => ({ code: REVIEW_APPROVE }),
      gh: fakeGh(),
    }),
    (err) => err.isOpError === true
  );
});

test('a working copy whose policy matches the base proceeds', () => {
  const out = applyRun({
    set: { schemaVersion: 4, issues: [], proposals: [] },
    profile: profile(),
    baseFloor: [],
    basePolicy: POLICY,
    ledger: {},
    fetchIssue: issue([]),
    io: IO,
    runReview: () => ({ code: REVIEW_APPROVE }),
    gh: fakeGh(),
  });
  assert.equal(out.executed.length, 0);
});

// ---- a live run's lock is never taken ----------------------------------------

test('a stale-lock recoverer that loses the race does not take the winner\'s live lock', () => {
  // Two runs find the same dead holder. A recovers first: claims, clears and
  // retakes the lock. B's rename then moves A's NEW lock, not the stale one B
  // examined — and without checking, B clears it and both runs hold "the" lock.
  const dir = mkdtempSync(join(tmpdir(), 'groom-lock-race-'));
  try {
    const path = join(dir, 'ledger.json.lock');
    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ pid: 999999, startedAt: 'long ago' })}\n`);

    let releaseA = null;
    const bIo = {
      pid: 222,
      alive: () => false,
      rename: (from, to) => {
        // A completes its whole recovery in the gap before B's rename lands.
        if (!releaseA) releaseA = acquireApplyLock(path, { pid: 111, alive: () => false });
        renameSync(from, to);
      },
    };

    assert.throws(() => acquireApplyLock(path, bIo), (err) => err.isOpError === true);
    assert.ok(releaseA, 'A must have recovered the lock');
    assert.ok(existsSync(join(path, 'owner.json')), "A's lock must still be in place");
    assert.equal(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid, 111, 'the lock must still be A\'s');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired owner-less lock is still recovered when nobody else got there first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groom-lock-expired-'));
  try {
    const path = join(dir, 'ledger.json.lock');
    mkdirSync(path);
    const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    const release = acquireApplyLock(path, { pid: 333, alive: () => false });
    assert.equal(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid, 333);
    release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead-owner lock is still recovered when nobody else got there first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groom-lock-dead-'));
  try {
    const path = join(dir, 'ledger.json.lock');
    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ pid: 999999, startedAt: 'long ago' })}\n`);
    const release = acquireApplyLock(path, { pid: 444, alive: () => false });
    assert.equal(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid, 444);
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
