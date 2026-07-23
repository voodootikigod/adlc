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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { initializeTicketStores, TicketService, detectTicketStore } from '@adlc/tickets';
import { runFleet, integrationBranchName } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';
import { completeTicketOnIntegration } from '../lib/complete.mjs';

function gitRunner(cwd) {
  return (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=fleet@test', '-c', 'user.name=fleet', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/** A temp git repo carrying a directory ticket store with one open ticket on an integration branch. */
function makeRepo(ticket = { id: 'T1', title: 'first' }) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-complete-'));
  const git = gitRunner(root);
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-q', '-m', 'root');
  initializeTicketStores(root);
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

    const res = completeTicketOnIntegration({ repo: root, ticketId: 'T1', integrationBranch, git });

    assert.equal(res.completed, true);
    assert.equal(isCompleted(root, 'T1'), true, 'store now records completed:true');
    assert.equal(commitCount(git), before + 1, 'a single completion commit landed on the run branch');

    // The commit is the add-only annotation: it touches the ticket shard and the
    // evidence ledger, nothing else.
    const touched = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    assert.ok(touched.some((p) => p.startsWith('.adlc/tickets/')), `commit touches a ticket shard: ${touched.join(', ')}`);
    assert.ok(touched.includes('.adlc/manifest.jsonl'), 'completion records manifest evidence in the same commit');
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

test('runFleet does NOT complete a ticket whose post-merge gate failed (T73 b)', async () => {
  const { deps, rec } = harness({ postMerge: () => ({ ok: false }) });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [T('T1')], runId: 'r', config, deps });
  assert.notEqual(summary.results.T1, 'merged', 'a gate-failed ticket must not be reported merged');
  assert.equal(rec.completed.length, 0, 'a gate-failed ticket is never completed');
});
