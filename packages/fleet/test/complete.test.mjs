// T73 — fleet auto-completes a ticket on the integration branch after a passing
// merge gate. Two levels of proof:
//   1. completeTicketOnIntegration against a REAL directory store + REAL git repo,
//      proving (a) a merged+gate-passed ticket ends completed:true ON THE BRANCH
//      (a commit lands) and (c) a re-run over an already-completed ticket is a
//      no-op (no second commit, no error).
//   2. runFleet wiring, proving completion is GATED — invoked after a passing
//      post-merge gate, and (b) NEVER invoked when the post-merge gate fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTicketStores, TicketService, detectTicketStore, ticketFilename, readTicketLock } from '@adlc/tickets';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { runFleet, integrationBranchName } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';
import { completeTicketOnIntegration, revertCompletionCommit } from '../lib/complete.mjs';

function gitRunner(cwd) {
  return (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=fleet@test', '-c', 'user.name=fleet', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/** A temp git repo carrying a directory ticket store with one open ticket on an integration branch. */
function makeRepo(ticket = { id: 'T1', title: 'first' }, { bootstrapManifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-complete-'));
  const git = gitRunner(root);
  git('init', '-b', 'main');
  // A realistic .gitignore (mirrors this repo's own .adlc/* block, spec §4.8): without
  // it, completeTicketOnIntegration's explicit `git add -- ... artifact.rel` for a
  // segment path is untested against the actual ignore rules that gate whether `git
  // add` throws (a bare `-A`/`.` staging, used elsewhere in this fixture, silently
  // skips ignored paths instead of throwing — it would NOT have caught a missing
  // `!.adlc/manifest.d/` exception the way the real explicit-pathspec add does).
  writeFileSync(join(root, '.gitignore'), [
    '.adlc/*',
    '!.adlc/tickets.json',
    '!.adlc/tickets/',
    '!.adlc/tickets/**',
    '!.adlc/manifest.jsonl',
    '!.adlc/manifest.d/',
    '!.adlc/manifest.d/**',
    '.adlc/manifest.d/.lineage',
    '.adlc/tickets.lock',
    '',
  ].join('\n'));
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'root');
  initializeTicketStores(root);
  // Bootstrap a manifest ledger so completion evidence APPENDS — the supported case
  // (rails-guard-ci allows append, denies create). Tests that want the un-bootstrapped
  // repo pass { bootstrapManifest: false }.
  if (bootstrapManifest) {
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '{"seq":1,"gate":"bootstrap","ts":"2026-01-01T00:00:00.000Z","data":{"note":"test-bootstrap"},"prev":null}\n');
  }
  const service = new TicketService(detectTicketStore({ root }), { root });
  service.apply(service.planCreate(ticket));
  git('add', '-A');
  git('commit', '-q', '-m', 'author ticket');
  const integrationBranch = integrationBranchName('t73');
  git('branch', integrationBranch);
  git('checkout', '-q', integrationBranch);
  return { root, git, integrationBranch };
}

const commitCount = (git) => Number(git('rev-list', '--count', 'HEAD'));
const isCompleted = (root, id) => detectTicketStore({ root }).load().get(id)?.completed === true;

test('completeTicketOnIntegration marks completed:true and commits it onto the run branch (T73 a)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    assert.equal(isCompleted(root, 'T1'), false, 'precondition: ticket starts open');
    const before = commitCount(git);

    // The post-merge gate runs a build on the integration branch immediately
    // before completion and can leave untracked output in the tree. The
    // completion commit MUST be path-scoped and never sweep such files into the
    // PR-riding commit (an `git add -A` would).
    writeFileSync(join(root, 'dist-leaked-build-artifact.js'), '// build output the gate left behind\n');

    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(res.completed, true);
    assert.equal(isCompleted(root, 'T1'), true, 'store now records completed:true');
    assert.equal(commitCount(git), before + 1, 'a single completion commit landed on the run branch');

    // The commit is the add-only annotation: it touches the ticket shard and the
    // evidence ledger — and NOTHING else.
    const touched = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    assert.ok(touched.some((p) => p.startsWith('.adlc/tickets/')), `commit touches a ticket shard: ${touched.join(', ')}`);
    assert.ok(touched.includes('.adlc/manifest.jsonl'), 'completion records manifest evidence in the same commit');
    assert.deepEqual(
      touched.filter((p) => !p.startsWith('.adlc/')),
      [],
      `completion commit is scoped to .adlc/ — it must not sweep in unrelated tree state, but committed: ${touched.join(', ')}`,
    );
    // The stray build output stays untracked (never staged by the scoped commit).
    assert.match(git('status', '--porcelain'), /\?\? dist-leaked-build-artifact\.js/, 'the build artifact remains untracked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('completeTicketOnIntegration is idempotent — a re-run over an already-completed ticket is a no-op (T73 c)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    const after = commitCount(git);

    const again = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(again.completed, false, 'no completion performed the second time');
    assert.equal(again.alreadyComplete, true, 'and it says so, rather than erroring');
    assert.equal(commitCount(git), after, 'no second commit is created');
    assert.equal(isCompleted(root, 'T1'), true, 'ticket stays completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed completion commit is rolled back — the shared integration checkout stays clean (T73)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    // A git that behaves normally except it refuses to COMMIT (e.g. a rejecting
    // commit hook). add/reset delegate to real git so staging is real.
    const failingGit = (...args) => {
      if (args[0] === 'commit') throw new Error('commit rejected by hook');
      return git(...args);
    };

    assert.throws(
      () => completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: failingGit }),
      /commit rejected/,
      'the completion surfaces the commit failure',
    );

    // The on-disk transaction was undone: the ticket is open again...
    assert.equal(isCompleted(root, 'T1'), false, 'the completion write is rolled back');
    // ...and NOTHING is left staged or modified in the shared checkout — a later
    // fleet step must not find orphaned completion state to sweep into a commit.
    assert.equal(git('status', '--porcelain'), '', 'the integration checkout is clean after the failed completion');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a RAILED ticket completes normally — rails are enforced by rails-guard-ci on the diff, not by TicketService', () => {
  // Guards against a plausible-but-wrong belief that fleet cannot complete railed
  // tickets. TicketService only refuses completion for ids passed as `protectedIds`
  // to its constructor, and NO production path (CLI included) populates that — it
  // defaults to empty. The real rails protection is rails-guard-ci over the PR diff,
  // which exempts a completed:true-only annotation. So railed tickets DO auto-complete.
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'railed', rails: ['test/contract.test.mjs'], scope: ['src/**'] });
  try {
    // A rail is declared, so the store is a frozen trust root: completion still
    // succeeds, but it is now an AUDITED override that must be signable — hence
    // the key (packages/tickets/test/bypass-audit.test.mjs). Fleet already passes
    // resolveKeyFromEnv() here in production; what changed is that a keyless
    // environment refuses instead of recording an unsigned entry.
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git, key: 'test-manifest-key' });
    assert.equal(res.completed, true, 'a railed ticket is not silently left open');
    assert.equal(isCompleted(root, 'T1'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('completion REFUSES when the shared checkout is not on the integration branch', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    // Another local process switched the shared checkout away between the post-merge
    // gate and completion. Every git op here targets current HEAD, so without a check
    // the lifecycle commit would land on the wrong branch.
    git('checkout', '-q', 'main');

    assert.throws(
      () => completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git }),
      /checkout is on "main", not the integration branch/,
      'it fails closed instead of committing to whatever is checked out',
    );
    assert.equal(isCompleted(root, 'T1'), false, 'and mutates nothing');
    assert.equal(git('status', '--porcelain'), '', 'leaving the checkout clean');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a checkout switch DURING the commit is detected, not silently accepted', () => {
  // The race we cannot prevent (no lock we hold serializes `git checkout`) must at
  // least be detected: a completion that landed somewhere we do not own is never
  // reported as success.
  const { root, git, integrationBranch } = makeRepo();
  try {
    let switched = false;
    const switchingGit = (...args) => {
      const out = git(...args);
      if (args[0] === 'commit' && !switched) { switched = true; git('checkout', '-q', 'main'); }
      return out;
    };
    let caught = null;
    try { completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: switchingGit }); }
    catch (error) { caught = error; }

    assert.ok(caught, 'the post-commit verification catches the switch');
    assert.match(caught.message, /after committing/);
    // Detection alone is not enough: the commit LANDED, the caller's re-gate never
    // runs, so this must quarantine rather than be logged and swallowed.
    assert.equal(caught.branchContaminated, true, 'it is flagged as branch contamination');
    // And it must NOT have written files into whatever checkout we ended up on.
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main', 'we ended up on the other branch');
    assert.equal(git('status', '--porcelain'), '', 'no paths were restored into the unknown checkout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runFleet QUARANTINES when the checkout switched during the completion commit', async () => {
  const rec = { prs: [] };
  const contaminating = Object.assign(new Error('refusing to complete (after committing): checkout is on "main"'), { branchContaminated: true });
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: () => { throw contaminating; },
    openPR: ({ integrationBranch }) => { rec.prs.push(integrationBranch); },
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.equal(summary.contaminated, true, 'an ungated commit on the branch quarantines the run');
  assert.match(summary.contaminationReason ?? '', /UNGATED completion commit/);
  assert.deepEqual(rec.prs, [], 'no PR is opened carrying the ungated commit');
});

test('completion REFUSES without an integrationBranch to verify against', () => {
  const { root, git } = makeRepo();
  try {
    assert.throws(
      () => completeTicketOnIntegration({ repo: root, ticketId: 'T1', git }),
      /requires integrationBranch/,
      'the verification target is mandatory — it cannot be silently skipped',
    );
    assert.equal(isCompleted(root, 'T1'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the completion commit is CI-shaped — completed:true-only shard + append-only manifest (rails-guard-ci)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const shardRel = `.adlc/tickets/${ticketFilename('T1')}`;
    const baseShard = JSON.parse(git('show', `HEAD:${shardRel}`));
    const baseManifest = git('show', 'HEAD:.adlc/manifest.jsonl');
    assert.ok(!('completed' in baseShard), 'precondition: base shard has no completed field');

    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    // Shard diff is EXACTLY `completed: true` added — what rails-guard-ci's
    // isCompletionAnnotationOnly exempts (add-only on a pristine field).
    const headShard = JSON.parse(git('show', `HEAD:${shardRel}`));
    assert.equal(headShard.completed, true);
    const { completed, ...headWithoutCompleted } = headShard;
    assert.deepEqual(headWithoutCompleted, baseShard, 'the only shard change is the completed:true annotation');

    // Manifest diff is append-only — what rails-guard-ci requires (HEAD starts with base).
    const headManifest = git('show', 'HEAD:.adlc/manifest.jsonl');
    assert.ok(headManifest.startsWith(baseManifest), 'the manifest is append-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The assertion above independently RE-IMPLEMENTS what rails-guard-ci accepts. A model of
// the consumer cannot catch drift in the real consumer (AGENTS.md), so this test round-trips
// an actual fleet completion commit through the REAL scripts/rails-guard-ci.mjs gate that CI
// runs on the PR — the producer→consumer contract, not a fleet-side approximation of it
// (adversarial-review round-32).
const RAILS_GUARD_CI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'rails-guard-ci.mjs');

test('PRODUCER→CONSUMER: a fleet completion commit is ACCEPTED by the real rails-guard-ci gate', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const base = git('rev-parse', 'HEAD'); // the pre-completion tip; the diff base CI uses
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    assert.equal(res.completed, true, 'precondition: a real completion commit was produced');

    // Run the ACTUAL gate against the ACTUAL commit, in the repo, exactly as CI would.
    const r = spawnSync(process.execPath, [RAILS_GUARD_CI, base], { cwd: root, encoding: 'utf8' });
    assert.equal(
      r.status, 0,
      `the real rails-guard-ci must accept the fleet completion commit (exit ${r.status}):\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('on a repo with NO manifest baseline, completion is skipped — it never creates a manifest CI would reject', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    assert.equal(res.completed, false);
    assert.equal(res.reason, 'no-manifest-baseline', 'it degrades to merged-not-completed with a clear reason');
    assert.equal(isCompleted(root, 'T1'), false, 'the ticket stays open');
    assert.ok(!existsSync(join(root, '.adlc', 'manifest.jsonl')), 'no manifest was created');
    assert.equal(git('status', '--porcelain'), '', 'the checkout is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- T-MANIFEST-FOREST: segmented repo (adversarial-review finding) ----
// TicketService's evidence writer routes to a segment once activated; Fleet's
// completion/rollback must stage, commit, and withdraw THAT file, not root's
// manifest.jsonl unconditionally.

function activateSegments(root) {
  const dir = join(root, '.adlc', 'manifest.d');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

function openSegmentFile(root) {
  const segDir = join(root, '.adlc', 'manifest.d');
  const name = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
  return name ? join(segDir, name) : null;
}

test('completeTicketOnIntegration in a segmented repo commits the SEGMENT, never touches root (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');
    const before = commitCount(git);

    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(res.completed, true);
    assert.equal(isCompleted(root, 'T1'), true);
    assert.equal(commitCount(git), before + 1);
    assert.match(res.ledgerPath, /^\.adlc\/manifest\.d\/.+\.jsonl$/);
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'root must never be created once segmented');

    const touched = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    assert.ok(touched.includes(res.ledgerPath), `commit touches the segment file: ${touched.join(', ')}`);
    assert.ok(!touched.includes('.adlc/manifest.jsonl'), 'root must not be part of the completion commit');

    const segFile = openSegmentFile(root);
    const firstEntry = JSON.parse(readFileSync(segFile, 'utf8').trim().split('\n')[0]);
    assert.equal(Object.hasOwn(firstEntry, 'anchor'), true, 'the segment\'s first entry must carry the anchor');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withdrawing a segmented completion removes the freshly-minted segment entirely — no stray evidence left behind', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');

    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    assert.equal(res.completed, true);
    const segFile = openSegmentFile(root);
    assert.ok(existsSync(segFile), 'precondition: the segment exists after completion');

    revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, ledgerPath: res.ledgerPath, integrationBranch, git });

    assert.equal(isCompleted(root, 'T1'), false, 'the completion annotation is withdrawn');
    assert.equal(git('rev-parse', 'HEAD'), res.preCompletionSha);
    assert.equal(existsSync(segFile), false, 'a freshly-minted segment must be removed entirely on withdrawal, not left with a withdrawn entry a later commit could sweep in');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second segmented completion continues the SAME open segment, not a fresh one', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    const service = new TicketService(detectTicketStore({ root }), { root });
    service.apply(service.planCreate({ id: 'T2', title: 'second' }));
    git('add', '-A');
    git('commit', '-q', '-m', 'author T2');

    const res2 = completeTicketOnIntegration({ repo: root, ticketId: 'T2', integrationBranch, git });
    assert.equal(res2.completed, true);
    const segDir = join(root, '.adlc', 'manifest.d');
    const segments = readdirSync(segDir).filter((n) => n.endsWith('.jsonl'));
    assert.equal(segments.length, 1, 'both completions must land in the SAME segment, not mint a second one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed SECOND segmented completion (already-open segment) rolls back to the exact prior bytes, not to empty', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    const service = new TicketService(detectTicketStore({ root }), { root });
    service.apply(service.planCreate({ id: 'T2', title: 'second' }));
    git('add', '-A');
    git('commit', '-q', '-m', 'author T2');

    const segFile = openSegmentFile(root);
    const priorBytes = readFileSync(segFile);

    // A pre-commit hook that always rejects, forcing the failed-commit rollback path
    // on a segment that already existed BEFORE this completion (the peeked, not
    // freshly-minted, artifact).
    const hooksDir = join(root, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    assert.throws(() => completeTicketOnIntegration({ repo: root, ticketId: 'T2', integrationBranch, git }));

    assert.ok(existsSync(segFile), 'an already-open segment must NOT be deleted on rollback — only a freshly-minted one is');
    assert.deepEqual(readFileSync(segFile), priorBytes, 'the segment is restored to its exact prior bytes, not truncated to empty');
    assert.equal(isCompleted(root, 'T2'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Adversarial-review finding: an external checkout switch between resolveManifestArtifact's
// peek (before the write) and TicketService.apply's real write (which resolves the CURRENT
// branch independently) can redirect the evidence into a DIFFERENT segment than the one Fleet
// captured priorManifest for. Simulated by repointing HEAD's symbolic ref (no working-tree
// change) partway through the transaction, on the SECOND `rev-parse HEAD` call — the first
// belongs to the entry assertOnBranch check, the second is preCompletionSha, right before
// service.apply runs.
function makeMidTransactionBranchSwitchGit(baseGit, root, switchToBranch) {
  let revParseHeadCount = 0;
  return (...args) => {
    const result = baseGit(...args);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      revParseHeadCount += 1;
      if (revParseHeadCount === 2) {
        execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${switchToBranch}`], { cwd: root, stdio: 'ignore' });
      }
    }
    return result;
  };
}

test('a checkout switch mid-transaction is detected and quarantined, never silently mis-restored (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');
    // Open integration's own segment first (the peeked, already-open case).
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    const integrationSegFile = openSegmentFile(root);
    const integrationSegBytesBefore = readFileSync(integrationSegFile);

    const service = new TicketService(detectTicketStore({ root }), { root });
    service.apply(service.planCreate({ id: 'T2', title: 'second' }));
    git('add', '-A');
    git('commit', '-q', '-m', 'author T2');
    git('branch', 'other-branch');

    const racingGit = makeMidTransactionBranchSwitchGit(git, root, 'other-branch');
    let caught;
    try {
      completeTicketOnIntegration({ repo: root, ticketId: 'T2', integrationBranch, git: racingGit });
      assert.fail('expected the race to be detected and thrown');
    } catch (error) { caught = error; }

    assert.equal(caught.ledgerDirty, true, 'a detected race must flag the ledger dirty for quarantine, not report a clean rollback');
    assert.deepEqual(
      readFileSync(integrationSegFile), integrationSegBytesBefore,
      'integration\'s own segment (captured priorManifest belongs to it) must never be touched by a restore targeting the WRONG file'
    );
    assert.equal(isCompleted(root, 'T2'), false, 'the ticket store itself is still safely reverted (covered by the ticket lock, not the raced segment)');
  } finally {
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${integrationBranch}`], { cwd: root, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a checkout switch during a PENDING completion never deletes another branch\'s pre-existing segment (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');

    // "other-branch" gets its OWN, pre-existing segment with REAL prior content —
    // never git-added/committed, so it stays on disk untouched by the later
    // checkout back to integrationBranch (git does not remove untracked files).
    git('checkout', '-q', '-b', 'other-branch');
    const otherService = new TicketService(detectTicketStore({ root }), { root });
    otherService.apply(otherService.planCreate({ id: 'T9', title: 'other' }));
    otherService.apply(otherService.planComplete('T9'));
    const otherSegFile = openSegmentFile(root);
    const otherSegFirstLineBefore = readFileSync(otherSegFile, 'utf8').split('\n')[0];

    git('checkout', '-q', integrationBranch);
    // Precondition: integration itself has NOT opened its own segment (pending case) —
    // the only segment file on disk right now is other-branch's untracked one.
    assert.equal(readdirSync(join(root, '.adlc', 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 1);

    const racingGit = makeMidTransactionBranchSwitchGit(git, root, 'other-branch');
    let caught;
    try {
      completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: racingGit });
      assert.fail('expected the race to be detected and thrown');
    } catch (error) { caught = error; }

    assert.equal(caught.ledgerDirty, true, 'a pending-case race into an EXISTING other-branch segment must also be detected');
    assert.ok(existsSync(otherSegFile), 'other-branch\'s pre-existing segment must never be deleted — priorManifest=null must not be trusted here');
    assert.equal(
      readFileSync(otherSegFile, 'utf8').split('\n')[0], otherSegFirstLineBefore,
      'other-branch\'s original T9 evidence (first line) must survive untouched'
    );
  } finally {
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${integrationBranch}`], { cwd: root, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed segmented completion commit rolls back the segment exactly (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');

    // A pre-commit hook that always rejects, forcing completeTicketOnIntegration's
    // failed-commit rollback path.
    const hooksDir = join(root, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const before = commitCount(git);
    assert.throws(() => completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git }));

    assert.equal(commitCount(git), before, 'no commit landed');
    // .lineage is local, gitignored bookkeeping (spec §4.8, matched by this
    // fixture's own .gitignore) — it legitimately stays on disk as an untracked,
    // IGNORED artifact regardless of the rollback's correctness (git status
    // --porcelain omits ignored paths by default, so it never appears below).
    // What matters is that no SEGMENT (the actual evidence) or ticket-store
    // change survives.
    const status = git('status', '--porcelain').split('\n').filter(Boolean);
    assert.deepEqual(status, [], `the checkout has no committable evidence left dangling: ${status.join(', ')}`);
    const segFiles = existsSync(join(root, '.adlc', 'manifest.d')) ? readdirSync(join(root, '.adlc', 'manifest.d')).filter((n) => n.endsWith('.jsonl')) : [];
    assert.deepEqual(segFiles, [], 'the newly-minted segment must be removed entirely, not left with a withdrawn entry');
    assert.equal(isCompleted(root, 'T1'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Adversarial-review finding: completeTicketOnIntegration's SUCCESS path commits
// the entire ledgerPath file, including a concurrent recorder's entry that won the
// mint race for a brand-new segment (resolveManifestArtifactAfterWrite's `raced`
// flag). That flag used to be dropped on the floor — never returned, never reaching
// revertCompletionCommit — so a LATER withdrawal (the post-completion re-gate
// failing) would `git restore` ledgerPath back to its pre-commit (nonexistent)
// state, deleting the concurrent recorder's entry along with the withdrawn one.
// Simulated with the same mid-transaction injection technique as the checkout-switch
// tests above: a real gate-manifest append lands in what becomes THIS completion's
// freshly-minted segment, in the window between Fleet's pre-write peek (no segment
// open) and its own write.
function makeMidTransactionConcurrentRecorderGit(baseGit, root) {
  let revParseHeadCount = 0;
  return (...args) => {
    const result = baseGit(...args);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      revParseHeadCount += 1;
      if (revParseHeadCount === 2) {
        appendManifestEntry({ gate: 'concurrent-recorder', data: { note: 'raced' } }, join(root, '.adlc'), { cwd: root, key: null });
      }
    }
    return result;
  };
}

test('a completion that shares its freshly-minted segment with a concurrent recorder is refused on withdrawal, never deletes their entry (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');

    const racingGit = makeMidTransactionConcurrentRecorderGit(git, root);
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: racingGit });

    assert.equal(res.completed, true, 'the write itself is correct — nothing is lost at commit time');
    assert.equal(res.raced, true, 'the completion must flag that its segment was shared with a concurrent recorder');

    const segFile = openSegmentFile(root);
    const linesAfterCommit = readFileSync(segFile, 'utf8').trim().split('\n');
    assert.equal(linesAfterCommit.length, 2, 'both the concurrent recorder\'s entry and this completion\'s entry landed in the commit');

    // The caller re-gates the completion commit; it fails, so withdrawal is attempted —
    // this must refuse rather than delete the concurrent recorder's entry.
    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, ledgerPath: res.ledgerPath, raced: res.raced, git }),
      /refusing to withdraw/,
      'withdrawal must refuse a raced completion rather than blindly restore ledgerPath to its pre-commit (nonexistent) state',
    );
    assert.ok(existsSync(segFile), 'the segment — holding the concurrent recorder\'s entry — must survive the refused withdrawal');
    assert.equal(readFileSync(segFile, 'utf8').trim().split('\n').length, 2, 'both entries remain intact; nothing was deleted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Adversarial-review finding (second round): the ABOVE test covers a brand-new
// (pending) segment. This covers the mirror case — an ALREADY-OPEN segment, where
// priorManifest is captured OUTSIDE the ledger lock. A concurrent recorder can
// append to that SAME segment in the unlocked window between that read and this
// completion's own locked write; the file-identity check alone (raced only on a
// DIFFERENT segment) never caught this, so priorManifest silently stopped being an
// exact preimage of "everything except our own entry".
test('a completion into an ALREADY-OPEN segment that races a concurrent recorder is also refused on withdrawal (T-MANIFEST-FOREST)', () => {
  const { root, git, integrationBranch } = makeRepo({ id: 'T1', title: 'first' }, { bootstrapManifest: false });
  try {
    activateSegments(root);
    git('add', '-A');
    git('commit', '-q', '-m', 'activate segments');

    // Open the segment first with a real completion — no race here, just establishing
    // the "already open" precondition the race below needs.
    completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    const service = new TicketService(detectTicketStore({ root }), { root });
    service.apply(service.planCreate({ id: 'T2', title: 'second' }));
    git('add', '-A');
    git('commit', '-q', '-m', 'author T2');

    const racingGit = makeMidTransactionConcurrentRecorderGit(git, root);
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T2', integrationBranch, git: racingGit });

    assert.equal(res.completed, true, 'the write itself is correct — nothing is lost at commit time');
    assert.equal(res.raced, true, 'the completion must flag that its ALREADY-OPEN segment gained an extra entry it did not write');

    const segFile = openSegmentFile(root);
    const linesAfterCommit = readFileSync(segFile, 'utf8').trim().split('\n');
    assert.equal(linesAfterCommit.length, 3, 'T1\'s entry, the concurrent recorder\'s entry, and T2\'s completion all landed in the commit');

    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, ledgerPath: res.ledgerPath, raced: res.raced, git }),
      /refusing to withdraw/,
      'withdrawal must refuse rather than restore priorManifest and silently delete the concurrent recorder\'s entry',
    );
    assert.equal(readFileSync(segFile, 'utf8').trim().split('\n').length, 3, 'all three entries remain intact; nothing was deleted');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the completion holds the ticket writer lock across the transaction AND the commit, then releases it (T73)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    // Observe the lock state at commit time: the transaction, the commit, and any
    // rollback must run under ONE held lock so a concurrent writer cannot interleave
    // and be clobbered by the rollback.
    let lockHeldDuringCommit = null;
    const observingGit = (...args) => {
      if (args[0] === 'commit') lockHeldDuringCommit = readTicketLock(root);
      return git(...args);
    };
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: observingGit });
    assert.equal(res.completed, true);
    assert.ok(lockHeldDuringCommit, 'the writer lock is held during the commit — transaction+commit are atomic');
    assert.ok(!readTicketLock(root), 'and the lock is released afterward (no stale lock left behind)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed commit does NOT erase a concurrent manifest evidence append (data loss)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    // A concurrent recorder appends gate evidence between our transaction and the
    // commit — it holds the LEDGER lock, which our ticket lock does not cover.
    const concurrentLine = '{"seq":99,"gate":"concurrent-recorder","ts":"2026-01-02T00:00:00.000Z","data":{},"prev":null}';
    const failingGit = (...args) => {
      if (args[0] === 'commit') {
        writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}${concurrentLine}\n`);
        throw new Error('commit rejected by hook');
      }
      return git(...args);
    };

    assert.throws(() => completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: failingGit }), /commit rejected/);

    const manifestAfter = readFileSync(manifestPath, 'utf8');
    assert.ok(manifestAfter.includes('concurrent-recorder'), 'the concurrent evidence append survives the rollback');
    assert.equal(isCompleted(root, 'T1'), false, 'while the shard is still rolled back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed commit whose evidence CANNOT be withdrawn flags the ledger dirty (so the caller quarantines)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const failingGit = (...args) => {
      if (args[0] === 'commit') {
        // Concurrent recorder appends AFTER our evidence — ours is no longer the tail,
        // so it cannot be removed without disturbing theirs.
        writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}{"seq":97,"gate":"concurrent","ts":"2026-01-04T00:00:00.000Z","data":{},"prev":null}\n`);
        throw new Error('commit rejected by hook');
      }
      return git(...args);
    };

    let caught = null;
    try { completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: failingGit }); }
    catch (error) { caught = error; }

    assert.ok(caught, 'the completion still fails');
    assert.equal(caught.ledgerDirty, true, 'and marks the ledger dirty so the branch gets quarantined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean failed commit does NOT flag the ledger dirty (evidence withdrawn exactly)', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const failingGit = (...args) => {
      if (args[0] === 'commit') throw new Error('commit rejected by hook');
      return git(...args);
    };
    let caught = null;
    try { completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git: failingGit }); }
    catch (error) { caught = error; }

    assert.ok(caught);
    assert.notEqual(caught.ledgerDirty, true, 'no concurrent append ⇒ our entry was removed exactly ⇒ no quarantine');
    assert.equal(git('status', '--porcelain'), '', 'and the checkout is clean');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runFleet QUARANTINES the branch when completion evidence could not be withdrawn', async () => {
  const rec = { prs: [] };
  const dirty = Object.assign(new Error('commit rejected by hook'), { ledgerDirty: true });
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: () => { throw dirty; },
    openPR: ({ integrationBranch }) => { rec.prs.push(integrationBranch); },
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.equal(summary.contaminated, true, 'a dirty ledger quarantines the branch');
  assert.deepEqual(rec.prs, [], 'and no PR is opened from it');
  assert.notEqual(summary.results.T1, 'merged');
});

test('withdrawing the completion commit does NOT destroy unrelated tracked work in the shared checkout', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    assert.equal(res.completed, true);

    // Unrelated tracked work present in the shared integration checkout, as another
    // step may legitimately have staged/modified. A checkout-wide reset --hard would
    // destroy it.
    const unrelated = join(root, 'unrelated.txt');
    writeFileSync(unrelated, 'work in progress\n');
    git('add', '--', 'unrelated.txt');

    revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, integrationBranch, git });

    assert.equal(isCompleted(root, 'T1'), false, 'the completion annotation is withdrawn');
    assert.equal(git('rev-parse', 'HEAD'), res.preCompletionSha, 'HEAD is back at the pre-completion commit');
    assert.ok(existsSync(unrelated), 'unrelated tracked work is NOT destroyed');
    assert.equal(readFileSync(unrelated, 'utf8'), 'work in progress\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withdrawal REFUSES when HEAD moved — it never uncommits another process work', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    // Another process commits on the shared integration branch after our completion.
    writeFileSync(join(root, 'other.txt'), 'concurrent work\n');
    git('add', '--', 'other.txt');
    git('commit', '-q', '-m', 'concurrent commit by another process');
    const headBefore = git('rev-parse', 'HEAD');

    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, git }),
      /HEAD is .*no longer the completion commit/,
      'it refuses rather than rewinding past a concurrent commit',
    );
    assert.equal(git('rev-parse', 'HEAD'), headBefore, 'the concurrent commit is still on the branch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withdrawal REFUSES on a DIFFERENT branch pointing at the same commit — it never rewinds the wrong branch', () => {
  // SHA identity is not branch identity. Another branch can legitimately point at the
  // completion commit; if the shared checkout switched to it, every SHA precondition
  // would pass and `reset --soft` would rewind THAT branch, leaving the rejected
  // completion on the integration branch.
  const { root, git, integrationBranch } = makeRepo();
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    // A sibling branch at the very same commit, and an external switch onto it.
    git('branch', 'sibling-at-same-commit');
    git('checkout', '-q', 'sibling-at-same-commit');
    assert.equal(git('rev-parse', 'HEAD'), res.completionSha, 'precondition: SHA checks would all pass');

    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, git }),
      /refusing to withdraw \(before rewinding\).*sibling-at-same-commit/s,
      'branch identity is verified, not just the commit SHA',
    );
    assert.equal(git('rev-parse', 'sibling-at-same-commit'), res.completionSha, 'the sibling branch was not rewound');
    assert.equal(git('rev-parse', integrationBranch), res.completionSha, 'and the integration branch is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withdrawal REFUSES when the shard gained a concurrent update — it never erases another writer edit', () => {
  // The gap this closes: the ticket lock is released when completion returns, and the
  // caller then runs a potentially long post-completion gate. A legal non-sensitive
  // ticket update during that window records NO manifest evidence, so the ledger check
  // cannot see it — only a shard content check can.
  const { root, git, integrationBranch } = makeRepo();
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    const shardAbs = join(root, res.shardPath);
    const edited = { ...JSON.parse(readFileSync(shardAbs, 'utf8')), title: 'legitimately retitled during the gate' };
    writeFileSync(shardAbs, `${JSON.stringify(edited, null, 2)}\n`);

    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, git }),
      /ticket shard changed since the completion commit/,
      'it refuses rather than reverting the concurrent edit away',
    );
    assert.match(readFileSync(shardAbs, 'utf8'), /legitimately retitled during the gate/, 'the concurrent edit survives');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withdrawal REFUSES when the ledger gained a concurrent append — no false attestation left behind', () => {
  const { root, git, integrationBranch } = makeRepo();
  try {
    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });
    // A concurrent recorder appends gate evidence after our completion commit.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}{"seq":98,"gate":"concurrent","ts":"2026-01-03T00:00:00.000Z","data":{},"prev":null}\n`);

    assert.throws(
      () => revertCompletionCommit({ repo: root, toSha: res.preCompletionSha, shardPath: res.shardPath, completionSha: res.completionSha, integrationBranch, git }),
      /evidence ledger changed since the completion commit/,
      'it refuses rather than erasing their evidence or leaving ours to be swept into a later commit',
    );
    assert.ok(readFileSync(manifestPath, 'utf8').includes('concurrent'), 'the concurrent evidence is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- runFleet wiring: completion is gated on a passing post-merge gate --------

const T = (id) => ({ id, title: id, scope: [`src/${id}/**`], edges: [] });

function harness({ postMerge = () => ({ ok: true }) } = {}) {
  const rec = { completed: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: postMerge,
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: ({ ticket, integrationBranch }) => { rec.completed.push({ id: ticket.id, integrationBranch }); },
    openPR: () => {},
  };
  return { deps, rec };
}

test('runFleet completes a merged+gate-passed ticket via the completeTicket effect', async () => {
  const { deps, rec } = harness();
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.equal(summary.results.T1, 'merged');
  assert.deepEqual(rec.completed, [{ id: 'T1', integrationBranch: integrationBranchName('r') }]);
});

// The completion adds a commit AFTER the post-merge gate, so the gate is re-run over
// it. A failing re-gate withdraws ONLY the completion — never the shipped merge.
function regateHarness({ regatePasses, revert = 'ok' }) {
  const rec = { completed: [], reverted: [], gateCalls: 0 };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    // 1st call = post-merge gate (passes); 2nd = the re-gate over the completion commit.
    postMergeGate: () => { rec.gateCalls += 1; return { ok: rec.gateCalls === 1 ? true : regatePasses }; },
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: ({ ticket }) => { rec.completed.push(ticket.id); return { completed: true, preCompletionSha: 'PRE' }; },
    revertCompletion: ({ toSha }) => { rec.reverted.push(toSha); },
    openPR: () => {},
  };
  if (revert === 'throw') deps.revertCompletion = () => { throw new Error('reset failed: index.lock held'); };
  if (revert === 'missing') delete deps.revertCompletion;
  return { deps, rec };
}

test('runFleet re-gates the completion commit and withdraws it when that gate fails (T73)', async () => {
  const { deps, rec } = regateHarness({ regatePasses: false });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.equal(summary.results.T1, 'merged', 'the shipped merge is NOT reverted by a completion re-gate failure');
  assert.deepEqual(rec.completed, ['T1']);
  assert.equal(rec.gateCalls, 2, 'the gate ran again over the new completion commit');
  assert.deepEqual(rec.reverted, ['PRE'], 'the completion commit is withdrawn to the pre-completion sha');
});

test('runFleet keeps the completion when the re-gate over it passes (T73)', async () => {
  const { deps, rec } = regateHarness({ regatePasses: true });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.equal(summary.results.T1, 'merged');
  assert.equal(rec.gateCalls, 2, 'the completion commit is still validated');
  assert.deepEqual(rec.reverted, [], 'nothing is withdrawn when the completion commit gates clean');
});

test('runFleet FAILS the ticket when a gate-rejected completion cannot be withdrawn (throwing revert)', async () => {
  // A swallowed rollback failure would leave a gate-rejected commit on the branch and
  // let it ride into the fleet PR — the ticket must fail loudly instead.
  const { deps } = regateHarness({ regatePasses: false, revert: 'throw' });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.notEqual(summary.results.T1, 'merged', 'a branch carrying an ungated commit is never reported merged');
  assert.equal(summary.merged, 0, 'and it does not count toward opening the PR');
});

test('runFleet FAILS the ticket when a gate-rejected completion has no withdrawal path wired', async () => {
  // Optional-chaining on a missing dep must not read as "successfully withdrawn".
  const { deps } = regateHarness({ regatePasses: false, revert: 'missing' });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });

  assert.notEqual(summary.results.T1, 'merged', 'a missing withdrawal path is a failure, not a silent success');
  assert.equal(summary.merged, 0);
});

test('a failed withdrawal QUARANTINES the branch — no PR even when another ticket merges cleanly', async () => {
  // The hole this closes: failing only the affected ticket still left the rejected
  // commit on the SHARED branch, so a second clean ticket made merged>0 and openPR
  // fired with the contaminated branch.
  const rec = { prs: [], gateCalls: 0, merges: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: ({ ticket }) => { rec.merges.push(ticket.id); return { mergeSha: 'M', preMergeSha: 'P' }; },
    // Every merge-gate passes; every completion RE-gate fails (calls 2,4,...).
    postMergeGate: () => { rec.gateCalls += 1; return { ok: rec.gateCalls % 2 === 1 }; },
    revertMerge: () => ({ method: 'reset', ok: true }),
    completeTicket: () => ({ completed: true, preCompletionSha: 'PRE' }),
    revertCompletion: () => { throw new Error('reset failed: index.lock held'); },
    openPR: ({ integrationBranch }) => { rec.prs.push(integrationBranch); },
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1'), T('T2')], runId: 'r', config, deps });

  assert.equal(summary.contaminated, true, 'the run is marked contaminated');
  assert.deepEqual(rec.prs, [], 'NO PR is opened from a quarantined branch');
  assert.equal(summary.prCount, 0);
  assert.equal(rec.merges.length, 1, 'no further merge lands on the quarantined branch');
});

test('quarantine is persisted and survives RESUME — a resumed run refuses to work or open a PR', async () => {
  // Quarantine is a property of the branch, not the process. A resume that started
  // "clean" would happily merge onto — and publish — a branch still carrying the
  // gate-rejected commit.
  const { deps } = regateHarness({ regatePasses: false, revert: 'throw' });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const first = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.equal(first.contaminated, true);
  assert.equal(first.status.contaminated, true, 'the quarantine is recorded IN the persisted status');

  // Resume with that persisted status: the branch is still contaminated.
  const rec2 = { dispatched: [], prs: [], merges: [] };
  const resumeDeps = {
    ...deps,
    dispatch: ({ ticket }) => { rec2.dispatched.push(ticket.id); return { exitCode: 0, output: 'TICKET-DONE' }; },
    mergeToIntegration: ({ ticket }) => { rec2.merges.push(ticket.id); return { mergeSha: 'M', preMergeSha: 'P' }; },
    openPR: ({ integrationBranch }) => { rec2.prs.push(integrationBranch); },
  };
  const resumed = await runFleet({
    all: [T('T1'), T('T2')], runId: 'r', config, deps: resumeDeps,
    resume: { status: first.status, integrationBranch: first.integrationBranch },
  });

  assert.equal(resumed.contaminated, true, 'the resumed run restores the quarantine');
  assert.deepEqual(rec2.prs, [], 'no PR is opened from the quarantined branch on resume');
  assert.equal(resumed.prCount, 0);
  assert.deepEqual(rec2.dispatched, [], 'and it fails closed BEFORE dispatching work that can never land');
  assert.deepEqual(rec2.merges, [], 'nothing merges onto the quarantined branch');
});

test('a REFUSED merge-revert quarantines the branch — the gate-rejected merge never reaches a PR', async () => {
  // The post-merge gate FAILURE path (older than T73) must honor rev.ok: revertMerge
  // returns { ok:false, method:'refused' } when it cannot undo the merge, leaving a
  // gate-rejected merge on the shared branch. That is the same hazard the completion
  // withdrawal path quarantines for, and it must be treated identically.
  const rec = { prs: [], merges: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: ({ ticket }) => { rec.merges.push(ticket.id); return { mergeSha: 'M', preMergeSha: 'P' }; },
    // T1's post-merge gate fails; T2's would pass — but the branch is already quarantined.
    postMergeGate: ({ ticket }) => ({ ok: ticket.id !== 'T1' }),
    revertMerge: () => ({ method: 'refused', ok: false, reason: 'integration HEAD moved and git revert failed' }),
    completeTicket: () => ({ completed: true, preCompletionSha: 'PRE' }),
    openPR: ({ integrationBranch }) => { rec.prs.push(integrationBranch); },
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1'), T('T2')], runId: 'r', config, deps });

  assert.equal(summary.contaminated, true, 'a refused merge-revert quarantines the run');
  // The quarantine reason is surfaced verbatim from revertMerge.
  assert.match(summary.contaminationReason ?? '', /git revert failed|HEAD moved/);
  assert.deepEqual(rec.prs, [], 'no PR is opened carrying the gate-rejected merge');
  assert.equal(rec.merges.length, 1, 'no further merge lands on the quarantined branch');
  assert.notEqual(summary.results.T1, 'merged');
});

test('a moved-HEAD revert (ungated intervening commit) QUARANTINES the run — no PR', async () => {
  // revertMerge returns ok:false when it reverted our merge but an UNGATED intervening
  // commit remains on the branch. That must quarantine, exactly like a refused revert.
  const rec = { prs: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: () => ({ ok: false }),
    revertMerge: () => ({ method: 'revert', ok: false, reason: 'HEAD moved; merge reverted but the intervening commit is UNGATED' }),
    openPR: ({ integrationBranch }) => { rec.prs.push(integrationBranch); },
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1'), T('T2')], runId: 'r', config, deps });

  assert.equal(summary.contaminated, true, 'the ungated intervening commit quarantines the run');
  assert.match(summary.contaminationReason ?? '', /UNGATED/);
  assert.deepEqual(rec.prs, [], 'no PR carrying the ungated commit');
});

test('runFleet does NOT complete a ticket whose post-merge gate failed (T73 b)', async () => {
  const { deps, rec } = harness({ postMerge: () => ({ ok: false }) });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.notEqual(summary.results.T1, 'merged', 'a gate-failed ticket must not be reported merged');
  assert.equal(rec.completed.length, 0, 'a gate-failed ticket is never completed');
});
