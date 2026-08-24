// T-01M0122YKBY211SPJNFGPCH4TN — the ticket-store add-vs-alter comparison anchors to
// the MERGE-BASE of the trusted base and HEAD, never to the base TIP.
//
// Reproduction this pins (#493 / #509, 2026-08-14): PR #509 batch-marked 42 tickets
// `completed: true` on main. PR #493, whose commits only ADD nine new shards, was then
// denied with "base ticket T-01KYJ3NMV8ZZDFD9DB31DJEGJF contract cannot change in a PR"
// — its stale tree still carried that shard WITHOUT the completed flag, and a
// tip-anchored comparison reads that reverse-direction difference as the PR altering a
// ticket it never touched. The same shape denies a base-side ADD as a removal. Only a
// rebase cleared it, and every long-lived PR re-hits it after any store change on base.
//
// What must NOT move with it, and is pinned here too: the rails union and the T36
// `completed` trust anchor still read the BASE TIP. Reading completion from the tip is
// the documented forge-resistance design, and reading rails from the tip can only widen
// the frozen set — the fail-safe direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticketFilename } from '@adlc/tickets';
import { isCompletionAnnotationOnly, runRailFreezeGate } from '../lib/ci/rail-freeze.mjs';
import { resolveMergeBase } from '../lib/ci/git.mjs';
import { GateDeny, GateFail } from '../lib/ci/errors.mjs';

const SHA = (char) => char.repeat(40);

function writeStore(root, tickets) {
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ schema: 1, tickets }, null, 2) + '\n');
}

/**
 * A repo whose base branch (`main`) can advance INDEPENDENTLY of the PR branch
 * (`feat`), which is the whole point: a fixture where the merge-base and the base tip
 * are the same commit cannot tell the two anchors apart.
 */
function scratchRepo({ tickets, seedFiles = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'store-merge-base-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@test.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
    schema: 1,
    securityMode: 'unsigned-fallback',
    acknowledgedNewRailBypass: true,
  }, null, 2) + '\n');
  writeStore(root, tickets);
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  for (const [file, content] of Object.entries(seedFiles)) {
    mkdirSync(join(root, file.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const branchPoint = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feat');
  return { root, g, branchPoint };
}

/** Move the BASE TIP past the branch point, leaving the PR branch stale. */
function advanceMain(g, mutate, message) {
  g('checkout', '-q', 'main');
  mutate();
  g('add', '-A');
  g('commit', '-q', '-m', message);
  g('checkout', '-q', 'feat');
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const gate = (root) => runRailFreezeGate({ cwd: root, base: 'main', env: {}, stdio: 'pipe' });

// ── the false red ───────────────────────────────────────────────────────────────

test('AC1: a ticket COMPLETED on the base after the branch point is not a phantom alteration', () => {
  // The literal #493/#509 shape: the base marks a railless ticket completed; the stale
  // PR tree still carries the un-annotated copy and touches no ticket at all.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-SHIPPED', title: 'shipped elsewhere' }],
  });
  try {
    advanceMain(g, () => writeStore(root, [{ id: 'T-SHIPPED', title: 'shipped elsewhere', completed: true }]),
      'base: mark T-SHIPPED completed');
    writeFileSync(join(root, 'feature.mjs'), 'export const f = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'PR work that never touches the store');
    const res = gate(root);
    assert.equal(res.status, 0, 'a base-side completion must not read as the PR altering that ticket');
  } finally { cleanup(root); }
});

test('AC1: a ticket ADDED on the base after the branch point is not read as a removal', () => {
  // Same defect, other direction: the base gains a shard the stale branch has never
  // seen, and a tip-anchored comparison calls its absence a removal.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-ORIGINAL', title: 'was here at the branch point' }],
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-ORIGINAL', title: 'was here at the branch point' },
      { id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' },
    ]), 'base: author a new ticket');
    writeFileSync(join(root, 'feature.mjs'), 'export const f = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'PR work that never touches the store');
    const res = gate(root);
    assert.equal(res.status, 0, 'a ticket the PR never had cannot have been removed by the PR');
  } finally { cleanup(root); }
});

// ── what the gate must still deny ───────────────────────────────────────────────

test('AC2: genuinely altering a ticket present at the merge-base is still denied', () => {
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-ORIGINAL', title: 'as authored' }],
  });
  try {
    // The base moves too, so the denial below is reached under the NEW anchor rather
    // than surviving only because the two anchors happened to coincide.
    advanceMain(g, () => writeStore(root, [
      { id: 'T-ORIGINAL', title: 'as authored' },
      { id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' },
    ]), 'base: author a new ticket');
    writeStore(root, [{ id: 'T-ORIGINAL', title: 'quietly rewritten by the PR' }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'PR rewrites a ticket contract');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateDeny && /T-ORIGINAL contract cannot change/.test(error.message),
      'an alteration of a merge-base ticket is exactly what this check exists to deny'
    );
  } finally { cleanup(root); }
});

test('AC3: removing a ticket that existed at the merge-base is still denied', () => {
  const { root, g } = scratchRepo({
    tickets: [
      { id: 'T-KEEP', title: 'kept' },
      { id: 'T-DROPPED', title: 'about to be dropped' },
    ],
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-KEEP', title: 'kept' },
      { id: 'T-DROPPED', title: 'about to be dropped' },
      { id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' },
    ]), 'base: author a new ticket');
    writeStore(root, [{ id: 'T-KEEP', title: 'kept' }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'PR drops a ticket');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateDeny && /T-DROPPED cannot be removed/.test(error.message),
      'a real removal must still deny, and must name the ticket the PR actually dropped'
    );
  } finally { cleanup(root); }
});

test('AC4: completion-annotation-only of a RAILLESS merge-base ticket is still allowed', () => {
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-RAILLESS', title: 'no rails, so completing it grants nothing' }],
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-RAILLESS', title: 'no rails, so completing it grants nothing' },
      { id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' },
    ]), 'base: author a new ticket');
    writeStore(root, [{ id: 'T-RAILLESS', title: 'no rails, so completing it grants nothing', completed: true }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'ticket-prune tombstones a shipped ticket');
    const res = gate(root);
    assert.equal(res.status, 0, 'the bounded #104/T36 allowance survives the re-anchoring');
  } finally { cleanup(root); }
});

test('the bounded allowance stays bounded: completing a RAILED merge-base ticket is denied', () => {
  // The allowance's whole safety argument is that a railless ticket has nothing to
  // unfreeze. Re-anchoring must not have widened it to railed tickets.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-RAILED', title: 'freezes a path', rails: ['test/frozen/**'] }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-RAILED', title: 'freezes a path', rails: ['test/frozen/**'] },
      { id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' },
    ]), 'base: author a new ticket');
    writeStore(root, [{ id: 'T-RAILED', title: 'freezes a path', rails: ['test/frozen/**'], completed: true }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'PR tries to self-expire its own rails');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateDeny && /T-RAILED contract cannot change/.test(error.message),
      'a PR must never be able to expire the rails freezing its own paths'
    );
  } finally { cleanup(root); }
});

test('the allowance needs BOTH anchors railless: rails ADDED on the base after the branch point deny it', () => {
  // codex cross-model review R1, confirmed by measurement. Merge-base anchoring alone
  // would judge this ticket railless and let the PR annotate it completed. Git then
  // merges the base's `rails` (near the top of the shard) with the PR's `completed`
  // (at the bottom) WITHOUT a conflict, and T36 reads completion from the tip — so the
  // freshly declared rail expires with no ceremony. The allowance must see the tip too.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-GAINED-RAILS', title: 'railless at the branch point' }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-GAINED-RAILS', title: 'railless at the branch point', rails: ['test/frozen/**'] },
    ]), 'base: the ticket declares a rail after the branch point');
    writeStore(root, [{ id: 'T-GAINED-RAILS', title: 'railless at the branch point', completed: true }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'PR annotates it completed while stale');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateDeny && /T-GAINED-RAILS contract cannot change/.test(error.message),
      'a ticket railed at the TIP can never be completed by an ordinary PR'
    );
  } finally { cleanup(root); }
});

test('isCompletionAnnotationOnly refuses a tip-railed ticket even when the merge-base copy is railless', () => {
  // The same rule at the unit boundary, where the two anchors can be varied one at a
  // time: identical inputs, one flag, opposite verdicts.
  const branchPoint = { id: 'T-X', title: 'railless here' };
  const head = { id: 'T-X', title: 'railless here', completed: true };
  assert.equal(isCompletionAnnotationOnly(branchPoint, head, false), true,
    'railless at both anchors is the bounded #104/T36 allowance');
  assert.equal(isCompletionAnnotationOnly(branchPoint, head, true), false,
    'railed at the tip revokes the allowance, whatever the branch point said');
  assert.equal(isCompletionAnnotationOnly(branchPoint, head), false,
    'omitting the tip-rails fact must deny, never silently grant the allowance');
});

// ── what deliberately did NOT move: the tip-anchored trust reads ────────────────

test('AC5: the rails union and the T36 completed anchor still read the BASE TIP', () => {
  // T-RAILED is in flight at the merge-base and COMPLETED at the tip. The PR edits the
  // path it froze. Tip-anchored T36 expires the rail, so the edit passes; had the rails
  // union followed the store comparison down to the merge-base, the ticket would read as
  // still in flight and this edit would be denied.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-RAILED', title: 'freezes a path', rails: ['test/frozen/**'] }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-RAILED', title: 'freezes a path', rails: ['test/frozen/**'], completed: true },
    ]), 'base: the admin ceremony completes the railed ticket');
    writeFileSync(join(root, 'test', 'frozen', 'contract.test.mjs'), 'export const t = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'edit a path whose rail expired on the base');
    const res = gate(root);
    assert.equal(res.status, 0, 'completion read from the TIP must expire the rail for this PR');
  } finally { cleanup(root); }
});

test('AC5: a rail declared on the BASE TIP after the branch point still freezes this PR', () => {
  // The other half of the tip anchor: rails read from the tip can only WIDEN the frozen
  // set, which is the fail-safe direction. A ticket that does not exist at the merge-base
  // must still freeze its paths for a stale PR.
  const { root, g } = scratchRepo({
    tickets: [{ id: 'T-ORIGINAL', title: 'freezes nothing' }],
    seedFiles: { 'test/frozen/contract.test.mjs': 'export const t = 1;\n' },
  });
  try {
    advanceMain(g, () => writeStore(root, [
      { id: 'T-ORIGINAL', title: 'freezes nothing' },
      { id: 'T-LATE-RAIL', title: 'freezes a path from the tip', rails: ['test/frozen/**'] },
    ]), 'base: a new ticket declares a rail');
    writeFileSync(join(root, 'test', 'frozen', 'contract.test.mjs'), 'export const t = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'edit a path frozen only at the tip');
    const res = gate(root);
    assert.equal(res.status, 2, 'a rail added on the base after the branch point still binds this PR');
  } finally { cleanup(root); }
});

// ── the denial names the backend the repo actually has ─────────────────────────

test('on the DIRECTORY store the denial names that store, not .adlc/tickets.json', () => {
  // A repo on the sharded store told its ticket "cannot change in .adlc/tickets.json" is
  // being sent to a file it does not have. The merge-base re-anchoring must not blur
  // which backend the message describes.
  const root = mkdtempSync(join(tmpdir(), 'store-merge-base-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const shard = (ticket) => writeFileSync(
    join(root, '.adlc', 'tickets', ticketFilename(ticket.id)),
    JSON.stringify(ticket, null, 2) + '\n'
  );
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@test.invalid');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
      schema: 1,
      securityMode: 'unsigned-fallback',
      acknowledgedNewRailBypass: true,
    }, null, 2) + '\n');
    writeFileSync(join(root, '.adlc', 'tickets', '.store.json'),
      JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }, null, 2) + '\n');
    shard({ id: 'T-SHARDED', title: 'lives in its own file' });
    writeFileSync(join(root, 'README.md'), 'baseline\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base on the directory store');
    g('checkout', '-q', '-b', 'feat');
    advanceMain(g, () => shard({ id: 'T-ADDED-ON-BASE', title: 'authored after the branch point' }),
      'base: author a new shard');
    shard({ id: 'T-SHARDED', title: 'quietly rewritten by the PR' });
    g('add', '-A');
    g('commit', '-q', '-m', 'PR rewrites a shard');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateDeny
        && /T-SHARDED contract cannot change in the \.adlc\/tickets\/ store/.test(error.message),
      'the denial must name the backend this repo actually runs'
    );
  } finally { cleanup(root); }
});

// ── fail closed when no single merge-base exists ────────────────────────────────

test('disjoint histories fail CLOSED (exit 1), never fall back to the base tip', () => {
  const { root, g } = scratchRepo({ tickets: [{ id: 'T-ORIGINAL', title: 'as authored' }] });
  try {
    g('checkout', '-q', '--orphan', 'unrelated');
    g('add', '-A');
    g('commit', '-q', '-m', 'a root commit sharing no history with main');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateFail && /merge-base/.test(error.message),
      'no common ancestor means no anchor; the gate must refuse rather than guess'
    );
  } finally { cleanup(root); }
});

// ── resolveMergeBase's HEAD guard, through the module's own git seam ────────────
// Every function in lib/ci/git.mjs takes its git runner as a parameter (createGit
// binds one to a cwd), which is the seam these use. Real git moves "non-zero status"
// and "empty stdout" together for `rev-parse --verify --quiet`, so only a stub can
// separate them — and they must be separated, because the guard fails closed on
// EITHER, not on both at once.

test('resolveMergeBase returns the single merge-base when git reports exactly one', () => {
  const git = (args) => (args[0] === 'rev-parse'
    ? { status: 0, stdout: `${SHA('a')}\n` }
    : { status: 0, stdout: `${SHA('b')}\n` });
  assert.equal(resolveMergeBase(git, SHA('c')), SHA('b'));
});

test('resolveMergeBase fails closed when rev-parse SUCCEEDS but prints nothing', () => {
  const git = (args) => (args[0] === 'rev-parse'
    ? { status: 0, stdout: '  \n' }
    : { status: 0, stdout: `${SHA('b')}\n` });
  assert.throws(
    () => resolveMergeBase(git, SHA('c')),
    (error) => error instanceof GateFail && /HEAD does not resolve to a commit/.test(error.message),
    'an empty resolution is not a HEAD, whatever the exit status said'
  );
});

test('resolveMergeBase fails closed when rev-parse FAILS but still prints something', () => {
  const git = (args) => (args[0] === 'rev-parse'
    ? { status: 128, stdout: `${SHA('b')}\n` }
    : { status: 0, stdout: `${SHA('d')}\n` });
  assert.throws(
    () => resolveMergeBase(git, SHA('c')),
    (error) => error instanceof GateFail && /HEAD does not resolve to a commit/.test(error.message),
    'output from a failed git command is not evidence — anchoring to it would be fail-open'
  );
});

// ── loading the store AT the merge-base ─────────────────────────────────────────

test('no store at the merge-base leaves nothing to preserve — not a mass phantom removal', () => {
  // A branch older than the ticket store itself. Both sides then create a store, so a
  // tip-anchored comparison would call every tip ticket "removed"; the merge-base says
  // correctly that no contract existed to preserve.
  const root = mkdtempSync(join(tmpdir(), 'store-merge-base-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@test.invalid');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
      schema: 1,
      securityMode: 'unsigned-fallback',
      acknowledgedNewRailBypass: true,
    }, null, 2) + '\n');
    writeFileSync(join(root, 'README.md'), 'before the ticket store existed\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'pre-store base');
    g('checkout', '-q', '-b', 'feat');
    advanceMain(g, () => writeStore(root, [{ id: 'T-ON-MAIN', title: 'authored on the base' }]),
      'base: introduce the ticket store');
    writeStore(root, [{ id: 'T-ON-BRANCH', title: 'authored on the branch' }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'branch introduces its own store');
    const res = gate(root);
    assert.equal(res.status, 0, 'an absent merge-base store is a vacuous comparison, not a removal');
  } finally { cleanup(root); }
});

test('an UNREADABLE store at the merge-base fails CLOSED, never reads as an empty one', () => {
  // The distinction the absent-store allowance rests on: only STORE_NOT_FOUND is a
  // vacuous comparison. Unverifiable input must fail closed exactly as the base-tip
  // load does — an invalid store silently read as "no contracts" would disable the
  // check for any PR that could arrange one.
  const root = mkdtempSync(join(tmpdir(), 'store-merge-base-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@test.invalid');
    g('config', 'user.name', 'Test');
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), JSON.stringify({
      schema: 1,
      securityMode: 'unsigned-fallback',
      acknowledgedNewRailBypass: true,
    }, null, 2) + '\n');
    writeFileSync(join(root, '.adlc', 'tickets.json'), '{ this is not json\n');
    writeFileSync(join(root, 'README.md'), 'baseline\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base with a corrupt store');
    g('checkout', '-q', '-b', 'feat');
    advanceMain(g, () => writeStore(root, [{ id: 'T-ON-MAIN', title: 'repaired on the base' }]),
      'base: repair the store');
    writeStore(root, [{ id: 'T-ON-BRANCH', title: 'repaired on the branch' }]);
    g('add', '-A');
    g('commit', '-q', '-m', 'branch repairs the store');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateFail
        && /cannot load merge-base ticket store: INVALID_JSON/.test(error.message),
      'an unverifiable merge-base store must fail the job, never widen what the PR may do'
    );
  } finally { cleanup(root); }
});

test('an AMBIGUOUS merge-base (criss-cross history) fails CLOSED, never picks one', () => {
  // A criss-cross leaves two best common ancestors. Bare `git merge-base` silently picks
  // one, so the comparison basis would be an anchor nobody chose — and local and CI could
  // pick differently.
  const { root, g } = scratchRepo({ tickets: [{ id: 'T-ORIGINAL', title: 'as authored' }] });
  try {
    writeFileSync(join(root, 'feat.txt'), 'feat side\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'F1');
    const f1 = g('rev-parse', 'HEAD').trim();
    g('checkout', '-q', 'main');
    writeFileSync(join(root, 'main.txt'), 'main side\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'M1');
    const m1 = g('rev-parse', 'HEAD').trim();
    g('merge', '-q', '--no-ff', '-m', 'main merges F1', f1);
    g('checkout', '-q', 'feat');
    g('merge', '-q', '--no-ff', '-m', 'feat merges M1', m1);
    const bases = g('merge-base', '--all', 'main', 'HEAD').trim().split('\n').filter(Boolean);
    assert.equal(bases.length, 2, 'fixture precondition: the history really is criss-crossed');
    assert.throws(
      () => gate(root),
      (error) => error instanceof GateFail && /merge-base/.test(error.message),
      'ambiguity must be refused, not resolved by guessing'
    );
  } finally { cleanup(root); }
});
