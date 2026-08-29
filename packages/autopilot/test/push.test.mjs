// AC 36 / 110 / 144 — verify-then-push: the lease carries the previously
// recorded remote OID, HEAD ≠ attestedHead / a lease failure / a post-push
// mismatch all quarantine as `oid-mismatch` with no upsert; every network
// argv names the pinned URL (never `origin`); and — against real temporary
// repositories with a local bare remote — the push source is the attested OID
// from NET_GIT, which has no refs/heads before or after.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPushVerify, pushAndUpsert, pushAttested } from '../lib/push.mjs';
import { maintainOpenPrs } from '../lib/maintain.mjs';
import { MAINTENANCE_STATES } from '../lib/records.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, pushes, argvsOf, FAKE, OID, TOKEN } from './helpers/review-ctx.mjs';
import { initRepo, commitFile, makeIssueWorktree, bareRemote, bareTip } from './helpers/review-git.mjs';
import { fakeGit } from './helpers/review-fakegit.mjs';

const BRANCH = 'adlc/autopilot/issue-7';
const URL = 'git@github.com:o/r.git';

const attestedRecord = (extra = {}) => prOpenRecord({ issue: 7, state: 'attested', attestedHead: OID.b, lastPushedOid: OID.a, prNumber: null, extra });

export async function ac36_verifyThenPush() {
  const root = scratch('ap-push');
  try {
    const g = fakeGit();
    const prView = (args) => (args[0] === 'pr' && args[1] === 'view' ? { stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: OID.b, state: 'OPEN', baseRefName: 'main', mergeStateStatus: 'CLEAN' }) } : { stdout: '[]' });
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: g.handler, [FAKE.gh]: prView }, observations: { [`branch.${BRANCH}.adlcAutopilotToken`]: TOKEN } });
    ctx.records.save(attestedRecord());
    const ok = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.argv, ['push', `--force-with-lease=refs/heads/${BRANCH}:${OID.a}`, URL, `${OID.b}:refs/heads/${BRANCH}`], 'the lease carries the previously recorded remote OID');
    const rec = ctx.records.load(7);
    assert.equal(rec.state, 'pushed'); assert.equal(rec.lastPushedOid, OID.b); assert.ok(rec.lastPushedAt, 'lastPushedOid + lastPushedAt in one write with the state');
    // HEAD ≠ attestedHead → no push, oid-mismatch.
    g.st.head = OID.c; g.st.pushes.length = 0;
    ctx.records.save(attestedRecord());
    const moved = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
    assert.equal(moved.ok, false); assert.equal(moved.code, 'oid-mismatch'); assert.equal(g.st.pushes.length, 0, 'no push'); assert.equal(ctx.records.load(7).state, 'oid-mismatch');
    // Lease failure → no PR upsert, oid-mismatch, never retried.
    g.st.head = OID.b; g.st.pushStatus = 1; ctx.records.save(attestedRecord());
    const ghBefore = argvsOf(ctx, FAKE.gh).length;
    const lease = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b, title: 't', body: 'b' });
    assert.equal(lease.ok, false); assert.equal(lease.leaseFailed, true); assert.equal(lease.state, 'oid-mismatch');
    assert.equal(g.st.pushes.length, 1, 'exactly one push attempt — a lease failure is never retried');
    assert.equal(argvsOf(ctx, FAKE.gh).length, ghBefore, 'zero gh calls after a lease failure');
    // Post-push ls-remote mismatch → no upsert.
    g.st.pushStatus = 0; g.st.remote = OID.c; ctx.records.save(attestedRecord());
    const post = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b, title: 't', body: 'b' });
    assert.equal(post.ok, false); assert.equal(post.code, 'oid-mismatch'); assert.equal(post.observed, OID.c);
    assert.equal(argvsOf(ctx, FAKE.gh).length, ghBefore, 'zero gh calls after a post-push mismatch');
    // Recovery/maintenance never auto-resume an oid-mismatch run.
    assert.ok(!MAINTENANCE_STATES.includes('oid-mismatch'));
    ctx.records.save(prOpenRecord({ issue: 7, state: 'oid-mismatch', prNumber: 41 }));
    const before = pushes(ctx).length;
    await maintainOpenPrs({ ctx, baseOid: OID.base, deps: { retireRun: null, actualDiffCheck: null, applyTerminalEffects: null } });
    assert.equal(pushes(ctx).length, before, 'maintenance pushes nothing for an oid-mismatch record'); assert.equal(ctx.records.load(7).state, 'oid-mismatch');
    await withMutation('push.skipLease', async () => {
      g.st.remote = OID.b; ctx.records.save(attestedRecord());
      const r = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
      assert.ok(!r.argv.some((a) => a.startsWith('--force-with-lease')), 'seam: the push carries no lease');
    });
  } finally { cleanup(root); }
}
test('AC36: the push argv carries --force-with-lease=refs/heads/…:<previous OID>; HEAD ≠ attestedHead → no push + oid-mismatch; a lease failure → no upsert, never retried; a post-push ls-remote mismatch → no upsert; oid-mismatch is never auto-resumed', ac36_verifyThenPush);

export async function ac110_pinnedRemoteUrl() {
  const root = scratch('ap-push');
  try {
    const g = fakeGit();
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: g.handler, [FAKE.gh]: () => ({ stdout: '[]' }) }, observations: { 'remote.origin.url': URL } });
    ctx.remote.observedFetchUrl = URL;
    ctx.records.save(attestedRecord());
    assert.equal((await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b })).ok, true);
    const network = ctx.recorder.filter((r) => r.argv[0] === FAKE.git && r.argv.some((a) => ['ls-remote', 'fetch', 'push'].includes(a)));
    assert.ok(network.length >= 2, 'a push and an ls-remote were recorded');
    for (const r of network) {
      assert.ok(r.argv.includes(URL), `${r.argv.join(' ')}: carries the pinned URL literal`);
      assert.ok(!r.argv.includes('origin'), `${r.argv.join(' ')}: never the word origin`);
      assert.ok(r.argv[1].startsWith('--git-dir='), 'network operations run through NET_GIT');
    }
    // remote.origin.url observed differently than at preflight → remote-url-changed, zero pushes, orphan.
    g.st.pushes.length = 0; ctx.observations['remote.origin.url'] = 'git@github.com:evil/r.git';
    ctx.records.save(attestedRecord());
    const changed = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
    assert.equal(changed.ok, false); assert.equal(changed.code, 'remote-url-changed'); assert.equal(g.st.pushes.length, 0); assert.equal(ctx.records.load(7).state, 'orphan');
    await withMutation('push.useOriginName', async () => {
      ctx.observations['remote.origin.url'] = URL; ctx.records.save(attestedRecord());
      const r = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
      assert.ok(r.argv.includes('origin'), 'seam: the push names origin');
    });
  } finally { cleanup(root); }
}
test('AC110: every recorded ls-remote/fetch/push argv carries the pinned URL literal and never `origin`; a remote.origin.url that changed since preflight → remote-url-changed, zero pushes, state orphan', ac110_pinnedRemoteUrl);

export async function ac144_pushSourceIsTheAttestedOid() {
  const root = scratch('ap-push-real'); const bareDir = scratch('ap-push-bare');
  try {
    const baseOid = initRepo(root);
    const bare = bareRemote(join(bareDir, 'remote.git'));
    const { wt } = makeIssueWorktree({ repoRoot: root, issue: 7, baseOid, token: TOKEN });
    const attested = commitFile(wt, 'packages/x/a.js', 'export const a = 1;\n', 'feat(x): a');
    const ctx = buildCtx({ repoRoot: root, realGit: true, netGit: true, remote: { remoteFetchUrl: bare, remotePushUrl: bare } });
    const netHeads = join(ctx.paths.netGit, 'refs', 'heads');
    const noHeads = () => !existsSync(netHeads) || readdirSync(netHeads).length === 0;
    assert.ok(noHeads(), 'NET_GIT has no refs/heads before');
    ctx.records.save(prOpenRecord({ issue: 7, state: 'attested', attestedHead: attested, lastPushedOid: null, prNumber: null, baseOid }));
    const res = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: attested });
    assert.equal(res.ok, true, JSON.stringify(res));
    const push = ctx.recorder.find((r) => r.argv.includes('push'));
    assert.deepEqual(push.argv, ['/usr/bin/git', `--git-dir=${ctx.paths.netGit}`, 'push', `--force-with-lease=refs/heads/${BRANCH}:`, bare, `${attested}:refs/heads/${BRANCH}`]);
    assert.ok(noHeads(), 'NET_GIT has no refs/heads after');
    assert.equal(bareTip(bare, BRANCH), attested, "the bare remote's branch equals attestedHead");
    assert.equal(ctx.records.load(7).lastPushedOid, attested);
    // Move ISSUE_WT's branch after attestation: what is pushed is still the attested OID.
    const moved = commitFile(wt, 'packages/x/b.js', 'export const b = 2;\n', 'feat(x): b');
    assert.notEqual(moved, attested);
    const again = await pushAttested({ ctx, issue: 7, attestedHead: attested, expectedRemoteOid: attested });
    assert.equal(again.ok, true, again.result?.stderr);
    assert.equal(bareTip(bare, BRANCH), attested, 'the moved branch tip is NOT what was pushed');
    const refused = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: attested });
    assert.equal(refused.code, 'oid-mismatch', 'the full step refuses because HEAD moved'); assert.equal(bareTip(bare, BRANCH), attested);
    await withMutation('push.sourceIsBranchName', async () => {
      // NET_GIT holds no branch refs, so a branch-name source cannot even be resolved there: the seam turns the push into a failure.
      const r = await pushAttested({ ctx, issue: 7, attestedHead: attested, expectedRemoteOid: attested });
      assert.equal(r.ok, false, 'seam: refs/heads/<b> does not exist in NET_GIT'); assert.ok(r.argv[r.argv.length - 1].startsWith(`refs/heads/${BRANCH}:`));
      assert.equal(bareTip(bare, BRANCH), attested);
    });
  } finally { cleanup(root); cleanup(bareDir); }
}
test('AC144: real repos — the push argv is --git-dir=<NET_GIT> push --force-with-lease=… <pushUrl> <attestedHead>:refs/heads/…; NET_GIT has no refs/heads before or after; the bare branch equals attestedHead; moving ISSUE_WT does not change what is pushed', ac144_pushSourceIsTheAttestedOid);

export async function ac36_transientPushFailureIsNotAQuarantine() {
  const root = scratch('ap-push-transient');
  try {
    const g = fakeGit();
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: g.handler, [FAKE.gh]: () => ({ stdout: '[]' }) }, observations: { [`branch.${BRANCH}.adlcAutopilotToken`]: TOKEN } });
    ctx.records.save(attestedRecord());
    g.st.pushStatus = 128; g.st.pushStderr = 'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.';
    const r = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
    assert.equal(r.ok, false); assert.equal(r.code, 'push-failed'); assert.equal(r.transient, true);
    assert.equal(ctx.records.load(7).state, 'attested', 'a transient transport failure keeps the run attested (recovery retries the push), never oid-mismatch');
    assert.equal(g.st.pushes.length, 1, 'one attempt here; the retry is recovery\'s');
    // A lease rejection is still the quarantine.
    ctx.records.save(attestedRecord()); g.st.pushes.length = 0;
    g.st.pushStatus = 1; g.st.pushStderr = ' ! [rejected] adlc/autopilot/issue-7 -> adlc/autopilot/issue-7 (stale info)';
    const lease = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b });
    assert.equal(lease.ok, false); assert.equal(lease.code, 'oid-mismatch'); assert.equal(ctx.records.load(7).state, 'oid-mismatch');
  } finally { cleanup(root); }
}
test('AC36: a TRANSIENT push failure (name resolution, connection, ssh handshake) is a failed round the recovery retries — never an oid-mismatch quarantine; a lease rejection still is', ac36_transientPushFailureIsNotAQuarantine);
