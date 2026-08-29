// The executable command sequence (spec AC 30, plus the sequence halves of
// AC 36, 38, 46, 82, 108, 144): one `runIssue` against a REAL temporary
// repository with a bare origin, fake tools on the pinned paths that record
// argv and create the files the real tools would, and assertions on the
// repository, the origin and the recorded argv — never on module internals.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as fsSync from 'node:fs';
import { join } from 'node:path';
import { runIssue } from '../lib/run.mjs';
import { branchFor } from '../lib/input.mjs';
import { createSequenceFixture, FAKE_TOOLS } from './helpers/sequence-fixture.mjs';
import { FAKE, GIT } from './helpers/recover-fixture.mjs';

async function fullRun(opts = {}) {
  const fx = await createSequenceFixture(opts);
  try {
    const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    return { fx, result };
  } catch (e) { fx.cleanup(); throw e; }
}

export async function ac30_fullSequence() {
  const { fx, result } = await fullRun({ gateStatus: (name, call) => (call === 0 ? 1 : 0) });
  try {
    const n = fx.issue; const branch = branchFor(n); const wt = fx.paths.issueWorktree(n);
    assert.equal(result.state, 'done', `the run ends done: ${JSON.stringify(result)}\n${fx.logs.join('\n')}`);
    assert.ok(existsSync(wt), 'ISSUE_WT exists');
    const shards = readdirSync(join(wt, '.adlc', 'tickets')).filter((f) => f.endsWith('.json'));
    assert.equal(shards.length, 1, 'one ticket shard under <ISSUE_WT>/.adlc/tickets/');
    assert.equal(fx.marker(branch)?.length, 64, 'the ownership marker is in the repo local config');
    const mb = fx.sh(['merge-base', fx.baseOid, branch]);
    assert.equal(mb, fx.baseOid, 'merge-base with the recorded baseOid IS baseOid');
    const record = fx.ctx.records.load(n);
    assert.equal(fx.remoteOid(branch), record.attestedHead, 'the pushed head equals attestedHead');
    const rc = fx.state.recordCrossModel;
    assert.ok(rc?.length >= 1, 'record-cross-model ran');
    assert.equal(fx.sh(['rev-parse', `${record.attestedHead}^`]), rc.at(-1).head, 'the attested head sits directly on the HEAD the record-cross-model fake saw');
    // preflight-fake failure on the first pass → a second fleet invocation with --dead-end-file and --max-strikes 14
    const fleets = fx.argvsOf(FAKE.adlc).filter((a) => a[0] === 'fleet' && a[1] === 'run');
    assert.equal(fleets.length, 2, 'two fleet invocations');
    assert.ok(!fleets[0].includes('--dead-end-file'), 'the first carries no dead-end file');
    assert.ok(fleets[1].includes('--dead-end-file'), 'the second carries --dead-end-file');
    assert.equal(fleets[1][fleets[1].indexOf('--max-strikes') + 1], '14', 'the second carries --max-strikes 14');
    const completes = fx.argvsOf(FAKE.adlc).filter((a) => a[0] === 'ticket' && a[1] === 'complete');
    assert.equal(completes.length, 1, 'adlc ticket complete invoked exactly once');
    const idx = (pred) => fx.recorder.findIndex(pred);
    const lastGateOk = fx.recorder.map((r, i) => [r, i]).filter(([r]) => r.argv[0] === FAKE_TOOLS.bwrap).at(-1)[1];
    assert.ok(idx((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'ticket' && r.argv[2] === 'complete') > lastGateOk, 'complete runs after the last successful preflight gate');
  } finally { fx.cleanup(); }
}
test('AC30: a full once --issue N run produces the worktree, the shard, the marker, a branch whose merge-base with baseOid is baseOid, a pushed head equal to the attested head; a gate failure on the first pass yields a second fleet invocation with --dead-end-file and --max-strikes 14 and exactly one ticket complete after the last successful gate', { timeout: 120_000 }, ac30_fullSequence);

const PASS_ROWS = ['test (18)', 'test (20)', 'test (22)', 'rails-guard', 'mutation-gate', 'cross-model-gate', 'ticket-store-platform (ubuntu-latest, 20)'].map((name) => ({ name, state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }));
const RED_ROWS = PASS_ROWS.map((r) => (r.name === 'rails-guard' ? { ...r, state: 'FAILURE', bucket: 'fail' } : r));
const gitSpawns = (fx) => fx.recorder.filter((r) => r.argv[0] === GIT);
const pushSpawns = (fx) => gitSpawns(fx).filter((r) => r.argv.includes('push') && r.argv.some((a) => String(a).startsWith('--git-dir=')));
const adlcSpawns = (fx, ...verbs) => fx.recorder.filter((r) => r.argv[0] === FAKE.adlc && verbs.every((v, i) => r.argv[i + 1] === v));
const commitMessages = (fx, wt) => fx.sh(['log', '--format=%s', 'HEAD'], wt).split('\n');

export async function ac36_verifyThenPushSequence() {
  // (a) a CI red → one fix round → a second push whose lease names the FIRST pushed OID.
  {
    const { fx, result } = await fullRun({ checks: (state) => (state.checkPolls === 1 ? RED_ROWS : PASS_ROWS) });
    try {
      const n = fx.issue; const branch = branchFor(n);
      assert.equal(result.state, 'done', JSON.stringify(result));
      const pushes = pushSpawns(fx);
      assert.equal(pushes.length, 2, 'two pushes: the initial one and the fix round');
      const lease = (r) => r.argv.find((a) => String(a).startsWith('--force-with-lease='));
      assert.equal(lease(pushes[0]), `--force-with-lease=refs/heads/${branch}:`, 'the first push expects an ABSENT remote ref');
      const firstOid = pushes[0].argv.at(-1).split(':')[0];
      assert.equal(lease(pushes[1]), `--force-with-lease=refs/heads/${branch}:${firstOid}`, 'the second push carries the previously recorded remote OID');
      const fleets = adlcSpawns(fx, 'fleet', 'run');
      assert.equal(fleets.length, 2);
      assert.deepEqual(fleets[1].argv.slice(fleets[1].argv.indexOf('--max-strikes'), fleets[1].argv.indexOf('--max-strikes') + 4), ['--max-strikes', '2', '--wall-clock-minutes', '15'], 'the CI fix round runs on the CI budget');
      assert.equal(fx.state.prEdits, 1, 'the second success edits the PR, never creates a second one');
    } finally { fx.cleanup(); }
  }
  // (b) HEAD ≠ attestedHead immediately before the push → no push, state oid-mismatch, no PR.
  {
    const { fx, result } = await fullRun({ onManifestVerify: (cwd, state, f) => { if (state.completeCalls > 0 && !state.moved) { state.moved = true; f.sh(['commit', '-q', '--allow-empty', '-m', 'sneaked in'], cwd); } } });
    try {
      assert.equal(result.state, 'oid-mismatch', JSON.stringify(result));
      assert.equal(pushSpawns(fx).length, 0, 'zero pushes');
      assert.equal(fx.state.prs.length, 0, 'no PR upsert');
      assert.equal(fx.ctx.records.load(fx.issue).state, 'oid-mismatch');
    } finally { fx.cleanup(); }
  }
  // (c) a lease failure (the remote ref appeared) → no PR upsert, state oid-mismatch.
  {
    const fx0 = await createSequenceFixture();
    // The remote ref appears immediately BEFORE the push spawn (a spawn pre-hook), so the lease is stale.
    fx0.hooks.push((req) => { if (!fx0.state.raced && req.argv.includes('push') && req.argv.some((a) => String(a).startsWith('--git-dir='))) { fx0.state.raced = true; fx0.sh(['push', '-q', fx0.originPath, `${fx0.baseOid}:refs/heads/${branchFor(fx0.issue)}`]); } });
    const fx = fx0;
    const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    try {
      assert.equal(result.state, 'oid-mismatch', JSON.stringify(result));
      assert.equal(pushSpawns(fx).length, 1, 'the push was attempted once');
      assert.equal(fx.state.prs.length, 0, 'no PR upsert after a lease failure');
      assert.equal(fx.remoteOid(branchFor(fx.issue)), fx.baseOid, 'the remote ref was not overwritten');
    } finally { fx.cleanup(); }
  }
}
test('AC36: the push carries --force-with-lease=refs/heads/…:<previous remote OID>; HEAD ≠ attestedHead before the push → no push, oid-mismatch; a lease failure → no PR upsert, oid-mismatch', { timeout: 240_000 }, ac36_verifyThenPushSequence);

export async function ac38_reviewedAttestedPushed() {
  {
    const { fx, result } = await fullRun({ reviewVerdict: (call) => (call === 0 ? 'needs-attention' : 'approve') });
    try {
      const n = fx.issue; const wt = fx.paths.issueWorktree(n); const record = fx.ctx.records.load(n);
      assert.equal(result.state, 'done', JSON.stringify(result));
      const reviews = fx.recorder.filter((r) => r.argv[0] === FAKE_TOOLS['adversarial-review']);
      assert.equal(reviews.length, 2);
      for (const r of reviews) { assert.deepEqual(r.argv.slice(1, 3), ['--base', fx.baseOid]); assert.equal(r.cwd, wt, 'the final review runs in ISSUE_WT'); }
      const firstComplete = fx.recorder.findIndex((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'ticket' && r.argv[2] === 'complete');
      assert.ok(fx.recorder.indexOf(reviews[0]) > firstComplete, 'the review follows the completion commit');
      const rc = fx.state.recordCrossModel; assert.equal(rc.length, 1);
      assert.equal(rc[0].head, record.reviewedHead, 'record-cross-model ran while HEAD == reviewedHead');
      const manifestOnly = fx.sh(['diff', '--name-only', `${record.attestedHead}^`, record.attestedHead], wt).split('\n').filter(Boolean);
      assert.ok(manifestOnly.length > 0 && manifestOnly.every((p) => /^\.adlc\/manifest\.d\/.*\.jsonl$/.test(p)), `the manifest commit names only .adlc/manifest.d/*.jsonl: ${manifestOnly.join(',')}`);
      assert.equal(fx.remoteOid(branchFor(n)), record.attestedHead, 'the pushed OID equals attestedHead');
      // needs-attention → a retry round whose dead-end file carries the findings
      const fleets = adlcSpawns(fx, 'fleet', 'run'); assert.equal(fleets.length, 2);
      const deadEnd = fleets[1].argv[fleets[1].argv.indexOf('--dead-end-file') + 1];
      assert.match(readFileSync(deadEnd, 'utf8'), /planted finding/, 'the findings are the dead-end content');
    } finally { fx.cleanup(); }
  }
  // a fake that writes a source file between 7a (review) and 7b (attest) → oid-mismatch, no push
  {
    const { fx, result } = await fullRun({ reviewerSideEffect: (cwd, call, f) => { f.sh(['commit', '-q', '--allow-empty', '-m', 'between 7a and 7b'], cwd); } });
    try {
      assert.equal(result.state, 'oid-mismatch', JSON.stringify(result));
      assert.equal(pushSpawns(fx).length, 0, 'no push');
      assert.equal(fx.state.recordCrossModel, undefined, 'nothing was attested');
    } finally { fx.cleanup(); }
  }
}
test('AC38: the final review runs with --base <baseOid> in ISSUE_WT after the completion commit; record-cross-model runs at HEAD == reviewedHead; the manifest commit names only manifest segments; the pushed OID is attestedHead; a write between 7a and 7b → oid-mismatch; needs-attention → a retry round with the findings as dead-end content', { timeout: 240_000 }, ac38_reviewedAttestedPushed);

export async function ac46_reopenForRetry() {
  const { fx, result } = await fullRun({ reviewVerdict: (call) => (call === 0 ? 'needs-attention' : 'approve') });
  try {
    const n = fx.issue; const wt = fx.paths.issueWorktree(n);
    assert.equal(result.state, 'done', JSON.stringify(result));
    const updates = adlcSpawns(fx, 'ticket', 'update');
    assert.equal(updates.length, 1, 'exactly one reopen update');
    const a = updates[0].argv.slice(1);
    assert.deepEqual(a.slice(0, 5), ['ticket', 'update', fx.state.updates[0].before.id, '--input', '-']);
    assert.ok(a.includes('--expect') && a.includes('--authorize') && a.includes('--write') && a.includes('--root'), 'carries --expect/--authorize/--write/--root');
    assert.equal(a[a.indexOf('--root') + 1], wt);
    const { before, stdin } = fx.state.updates[0];
    assert.deepEqual({ ...stdin, id: before.id }, { ...before, completed: false }, 'stdin is the FULL document from the preceding show with only completed → false');
    assert.equal(before.completed, true, 'the shard was complete before the reopen');
    const reopenIdx = fx.recorder.findIndex((r) => r.argv[0] === GIT && r.argv.includes('commit') && r.argv.some((x) => /^chore\(ticket\): reopen/.test(String(x))));
    const secondFleet = fx.recorder.indexOf(adlcSpawns(fx, 'fleet', 'run')[1]);
    assert.ok(reopenIdx !== -1 && reopenIdx < secondFleet, 'the reopen commit precedes the second fleet invocation');
    assert.ok(commitMessages(fx, wt).some((m) => /^chore\(ticket\): reopen/.test(m)));
    const shard = readdirSync(join(wt, '.adlc', 'tickets')).filter((f) => f.endsWith('.json'))[0];
    assert.equal(JSON.parse(readFileSync(join(wt, '.adlc', 'tickets', shard), 'utf8')).completed, true, 'the final shard is completed:true');
  } finally { fx.cleanup(); }
}
test('AC46: a needs-attention after the completion commit → one `adlc ticket update <ULID> --input - --expect <hash> --authorize --write --root <ISSUE_WT>` whose stdin is the full shard with only completed:false, a `chore(ticket): reopen` commit before the second fleet invocation, and a final shard that is completed:true', { timeout: 240_000 }, ac46_reopenForRetry);

export async function ac82_revalidationBeforeWriteAndDispatch() {
  const cases = [
    ['updatedAt changed', { mutate: (s) => { s.issue.updatedAt = '2026-08-28T11:00:00Z'; } }],
    ['skip label added', { mutate: (s, f) => { f.gh.labels[String(f.issue)] = ['adlc:autopilot-skip']; } }],
    ['closed', { mutate: (s) => { s.issue.state = 'CLOSED'; } }],
    ['new open PR', { prs: true }],
  ];
  for (const [name, c] of cases) {
    const fx = await createSequenceFixture(c.prs ? { prsOpenAtStart: [{ number: 99, head: branchFor(7), state: 'OPEN' }] } : {});
    try {
      c.mutate?.(fx.state, fx);
      const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: '2026-08-28T10:00:00Z' }, authorization: { ok: true } });
      assert.equal(result.reason, 'revalidation-changed', `${name}: ${JSON.stringify(result)}`);
      assert.ok(!existsSync(fx.paths.issueWorktree(fx.issue)), `${name}: zero worktree creation`);
      assert.equal(adlcSpawns(fx, 'fleet', 'run').length, 0, `${name}: zero fleet spawns`);
    } finally { fx.cleanup(); }
  }
  // triggered before dispatch (the issue changes while the ticket is being shaped/recorded) → the worktree is retired, zero fleet spawns
  {
    const fx = await createSequenceFixture({ onColdstart: (s) => { s.issue.updatedAt = '2026-08-28T11:30:00Z'; } });
    try {
      const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: '2026-08-28T10:00:00Z' }, authorization: { ok: true } });
      assert.equal(result.reason, 'revalidation-changed', JSON.stringify(result));
      assert.equal(adlcSpawns(fx, 'fleet', 'run').length, 0, 'zero fleet spawns');
      assert.ok(!existsSync(fx.paths.issueWorktree(fx.issue)), 'the worktree was retired');
      assert.equal(fx.localOid(branchFor(fx.issue)), null, 'the branch was retired');
    } finally { fx.cleanup(); }
  }
}
test('AC82: a changed updatedAt, a newly added adlc:autopilot-skip, a closed state or a new open PR on the re-read → zero worktree creation before step 1, or retirement of the worktree with zero fleet spawns before dispatch, outcome revalidation-changed', { timeout: 240_000 }, ac82_revalidationBeforeWriteAndDispatch);

export async function ac108_mirrorOutputReachesIntegrationBranch() {
  const { fetchBackWorkerBranch } = await import('../lib/mirror.mjs');
  // A fleet fake that performs the REAL fetch-back: the worker commits in a clone of the worker MIRROR,
  // pushes its branch into the mirror, and the caller repository receives it through the §6.4 sequence.
  const mirrorFleet = async (args, { cwd }, f, state) => {
    const n = state.issue.number; const branch = branchFor(n); const ticketId = args[args.indexOf('--tickets') + 1];
    const runId = `${20260828130000 + state.fleetRuns}`; const integration = `fleet/run-${runId}`;
    const mirror = f.ctx.paths.mirror(n);
    const cutTip = f.sh(['rev-parse', branch], cwd);
    f.sh(['branch', `fleet/${ticketId}`, cutTip], cwd); // fleet's ensureWorkerBranchInRepo: the CAS target exists at the cut tip before dispatch
    const wc = join(f.root, `worker-${runId}`);
    f.sh(['clone', '-q', mirror, wc]);
    f.sh(['checkout', '-q', '-b', `fleet/${ticketId}`, cutTip], wc);
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    mk(join(wc, 'packages', 'x'), { recursive: true }); wf(join(wc, 'packages', 'x', 'impl.js'), 'export const widget = "from the mirror";\n');
    f.sh(['add', '-A'], wc); f.sh(['commit', '-q', '-m', 'feat(x): widget via mirror'], wc);
    f.sh(['push', '-q', mirror, `HEAD:refs/heads/fleet/${ticketId}`], wc);
    const back = await fetchBackWorkerBranch({ ctx: f.ctx, issueWt: cwd, mirror, workerBranch: `fleet/${ticketId}`, cutTip });
    f.sh(['branch', integration, back.head], cwd);
    state.workerHead = back.head;
    return { stdout: JSON.stringify({ fleetRunId: runId, exitCode: 0, reason: null, integrationBranch: integration, readPolicy: 'bounded', gitSource: 'mirror', egress: 'allowlist', strikesConsumed: 1, tickets: { [ticketId]: { state: 'merged' } } }) };
  };
  const { fx, result } = await fullRun({ fleet: mirrorFleet });
  try {
    const n = fx.issue; const branch = branchFor(n); const integration = 'fleet/run-20260828130001';
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.equal(fx.localOid(integration), fx.state.workerHead, `${integration} in the caller repository is the worker's head`);
    assert.equal(fx.sh(['show', `${integration}:packages/x/impl.js`]).trim(), 'export const widget = "from the mirror";', 'the integration branch carries the worker commit');
    assert.equal(fx.sh(['merge-base', '--is-ancestor', integration, branch]), '', `${branch} fast-forwarded onto it`);
    const mirror = fx.ctx.paths.mirror(n);
    const gateSpawns = fx.recorder.filter((r) => r.argv[0] === FAKE_TOOLS.bwrap);
    assert.ok(gateSpawns.length > 0 && gateSpawns.every((r) => !r.argv.some((a) => String(a).includes(mirror))), 'no gate argv references the mirror path');
  } finally { fx.cleanup(); }
}
test('AC108: a fleet fake that performs the real fetch-back leaves fleet/run-<id> in the caller repository with the worker commit, adlc/autopilot/issue-<n> fast-forwards onto it, and no gate argv references the mirror path', { timeout: 120_000 }, ac108_mirrorOutputReachesIntegrationBranch);

export async function ac144_pushSourceIsTheAttestedOid() {
  const { withMutation } = await import('../lib/mutations.mjs');
  const fx = await createSequenceFixture({ onManifestVerify: (cwd, state, f) => { if (state.completeCalls > 0 && !state.moved) { state.moved = true; f.sh(['commit', '-q', '--allow-empty', '-m', 'moved after attestation'], cwd); } } });
  try {
    const n = fx.issue; const branch = branchFor(n); const netGit = fx.paths.netGit;
    const heads = () => fx.sh(['--git-dir', netGit, 'for-each-ref', 'refs/heads']);
    assert.equal(heads(), '', 'NET_GIT has no refs/heads before');
    // The head check is disabled ONLY to observe the push source: the branch moves after attestation, the push still names the OID.
    const result = await withMutation('push.skipHeadCheck', () => runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } }));
    assert.equal(result.state, 'done', `${JSON.stringify(result)} record=${JSON.stringify({ lastError: fx.ctx.records.load(fx.issue)?.lastError, reasonText: fx.ctx.records.load(fx.issue)?.reasonText })}`);
    const record = fx.ctx.records.load(n);
    const push = pushSpawns(fx)[0];
    assert.ok(push, 'a NET_GIT push was recorded');
    assert.deepEqual(push.argv.slice(1, 3), [`--git-dir=${netGit}`, 'push']);
    assert.match(push.argv[3], /^--force-with-lease=refs\/heads\//);
    assert.equal(push.argv[4], fx.ctx.remote.remotePushUrl, 'the push names the pinned push URL');
    assert.equal(push.argv[5], `${record.attestedHead}:refs/heads/${branch}`, 'the push source is the attested OID, never a branch name');
    assert.equal(heads(), '', 'NET_GIT has no refs/heads after');
    assert.equal(fx.remoteOid(branch), record.attestedHead, "the bare remote's branch equals attestedHead");
    assert.notEqual(fx.localOid(branch), record.attestedHead, 'the local branch moved after attestation …');
    assert.equal(fx.state.moved, true, '… and what was pushed did not change');
  } finally { fx.cleanup(); }
}
test('AC144: the push argv is --git-dir=<NET_GIT> push --force-with-lease=… <pushUrl> <attestedHead>:refs/heads/adlc/autopilot/issue-<n>; NET_GIT has no refs/heads before or after; the bare remote equals attestedHead; moving the branch between attestation and push does not change what is pushed', { timeout: 120_000 }, ac144_pushSourceIsTheAttestedOid);

export async function ac44_diffSizeGate() {
  // reviewMaxBytes + 1 bytes of diff → round failure diff-too-large with zero reviewer calls; two consecutive → blocked.
  const big = 'x'.repeat(400);
  const fx = await createSequenceFixture({ config: { reviewMaxBytes: 300 }, worker: (wt, { round }) => { const { mkdirSync: mk, writeFileSync: wf } = fsSync; mk(join(wt, 'packages', 'x'), { recursive: true }); wf(join(wt, 'packages', 'x', 'impl.js'), `${big} ${round}\n`); } });
  try {
    const result = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(result.state, 'blocked', JSON.stringify(result));
    assert.equal(result.reason, 'diff-too-large');
    assert.equal(fx.recorder.filter((r) => r.argv[0] === FAKE_TOOLS['adversarial-review']).length, 0, 'zero adversarial-review calls');
    const fleets = adlcSpawns(fx, 'fleet', 'run');
    assert.equal(fleets.length, 2, 'two rounds: the second consecutive failure blocks');
    assert.match(readFileSync(fleets[1].argv[fleets[1].argv.indexOf('--dead-end-file') + 1], 'utf8'), /diff-too-large/);
  } finally { fx.cleanup(); }
  // both reviewer argvs carry --max-bytes 262144 and never --allow-summary-review
  const { fx: fx2, result: r2 } = await fullRun({ reviewVerdict: (call) => (call === 0 ? 'needs-attention' : 'approve') });
  try {
    assert.equal(r2.state, 'done');
    const reviews = fx2.recorder.filter((r) => r.argv[0] === FAKE_TOOLS['adversarial-review']);
    assert.equal(reviews.length, 2);
    for (const r of reviews) {
      assert.equal(r.argv[r.argv.indexOf('--max-bytes') + 1], '262144');
      assert.ok(!r.argv.includes('--allow-summary-review'));
    }
  } finally { fx2.cleanup(); }
}
test('AC44: a diff of reviewMaxBytes + 1 bytes → round failure diff-too-large with zero adversarial-review calls; two consecutive → blocked; every reviewer argv carries --max-bytes 262144 and never --allow-summary-review', { timeout: 240_000 }, ac44_diffSizeGate);

export async function ac38_malformedReviewIsUnavailable() {
  // Exit 0 with output that is not a review document is UNAVAILABLE (review-unavailable), never an approve.
  const fx = await createSequenceFixture({ reviewVerdict: () => ({ status: 0, stdout: 'Reviewed. Looks fine.\n' }) });
  try {
    const r = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.notEqual(r.state, 'done', `a status-0 non-document never ships: ${JSON.stringify(r)}`);
    assert.equal(pushSpawns(fx).length, 0, 'nothing was pushed');
    assert.equal(fx.recorder.filter((x) => x.argv[0] === FAKE.gh && x.argv[1] === 'pr' && x.argv[2] === 'create').length, 0, 'no PR was opened');
  } finally { fx.cleanup(); }
  const fx2 = await createSequenceFixture({ reviewVerdict: () => ({ status: 0, stdout: JSON.stringify({ findings: [] }) }) });
  try {
    const r = await runIssue({ ctx: fx2.ctx, deps: fx2.ctx.deps, issue: fx2.issue, ticket: fx2.ticket, revision: { updatedAt: fx2.state.issue.updatedAt }, authorization: { ok: true } });
    assert.notEqual(r.state, 'done', `a document with no verdict never ships: ${JSON.stringify(r)}`);
  } finally { fx2.cleanup(); }
}
test('AC38: a reviewer exit 0 whose output is not a review document (or names no verdict) is review-unavailable — nothing is pushed and no PR opens', { timeout: 240_000 }, ac38_malformedReviewIsUnavailable);

export async function ac38_retryRefreshesEvidence() {
  // A reopened (retry) ticket is a new ticket text: its P2 evidence is re-recorded before the retry dispatch.
  const fx = await createSequenceFixture({ reviewVerdict: (call) => (call === 0 ? 'needs-attention' : 'approve') });
  try {
    const r = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(r.state, 'done', JSON.stringify(r));
    const reopens = fx.recorder.filter((x) => x.argv[0] === FAKE.adlc && x.argv[1] === 'ticket' && x.argv[2] === 'update').length;
    assert.ok(reopens >= 1, 'the retry reopened the ticket');
    const coldstarts = fx.recorder.filter((x) => x.argv[0] === FAKE.adlc && x.argv[1] === 'coldstart' && x.argv.includes('--record-verdict')).length;
    assert.ok(coldstarts >= 2, `the coldstart verdict was recorded again for the reopened ticket (${coldstarts})`);
  } finally { fx.cleanup(); }
}
test('AC38: a retry round re-records the coldstart evidence for the REOPENED ticket text before dispatching again', { timeout: 240_000 }, ac38_retryRefreshesEvidence);

export async function ac72_coldstartClarifyRetiresCleanly() {
  // A coldstart CLARIFY happens after the ticket files were written but before anything dispatched: the run retires (no orphan).
  const fx = await createSequenceFixture({ claudeAnswer: (args) => (args.includes('/usage') ? { type: 'result', result: 'Your subscription\nCurrent session: 5% used\nCurrent week (all models): 5% used\n' } : { type: 'result', result: JSON.stringify({ gaps: [{ what: 'which widget exactly?', why_blocking: 'two widgets exist' }] }) }) });
  try {
    const r = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(r.state, 'clarify', JSON.stringify(r));
    const rec = fx.ctx.records.load(fx.issue);
    assert.notEqual(rec?.state, 'orphan', `the run is retired, never orphaned on its own ticket files: ${JSON.stringify({ state: rec?.state, orphanReason: rec?.orphanReason, lastError: rec?.lastError, detail: rec?.orphanDetail })}`);
    assert.ok(!existsSync(fx.paths.issueWorktree(fx.issue)), 'the issue worktree is gone');
    assert.equal(fx.recorder.filter((x) => x.argv[0] === FAKE.adlc && x.argv[1] === 'fleet').length, 0, 'nothing was dispatched');
  } finally { fx.cleanup(); }
}
test('AC72: a coldstart CLARIFY retires the run cleanly — the autopilot\'s own uncommitted ticket files never orphan a run that has not dispatched', { timeout: 120_000 }, ac72_coldstartClarifyRetiresCleanly);
