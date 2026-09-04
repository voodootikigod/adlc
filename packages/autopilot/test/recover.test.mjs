// AC 21 29 42 43 45 58 63 67 70 92 93 104 107 110 + ticket AC2/AC3/AC4 — the
// recovery state machine, ownership-checked retirement, staged creation and
// `reset`, against REAL temporary git repositories with a bare `origin`
// (recover-fixture.mjs). gh is faked (recover-gh.mjs); git is real.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, createAutopilotBranch, saveRecord, recordOf, fileBytes, GIT, TOKEN_A, TOKEN_B } from './helpers/recover-fixture.mjs';
import { fakeGithub, unlabeledEvent } from './helpers/recover-gh.mjs';
import { retireRun, canonicalDeletion, stepL } from '../lib/retire.mjs';
import { recover, rearmRun } from '../lib/recover.mjs';
import { resetCommand } from '../lib/reset.mjs';
import { createIssueWorktree, repairCreation } from '../lib/create.mjs';
import { branchFor, stagingBranchFor } from '../lib/input.mjs';
import { newRecord } from '../lib/records.mjs';

const L = { blocked: 'adlc:autopilot-blocked', stale: 'adlc:autopilot-stale', clarify: 'adlc:needs-clarification' };
const AT = '2026-08-28T11:00:00Z';
const HOUR = 3600_000;
async function withFx(fn, opts) { const fx = createFixture(opts); try { await fn(fx); } finally { fx.cleanup(); } }
const ghWith = (extra = {}) => fakeGithub({ permissions: { alice: 'admin', bob: 'write' }, ...extra });
const unlabel = (gh, issue, label, actor, id = 100 + issue) => { gh.labels[issue] = []; gh.timeline[issue] = [unlabeledEvent({ id, label, actor, at: AT })]; };
const newCommit = (fx, parent) => fx.sh(['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'other']);
const hasForce = (fx) => fx.gitArgvs().some((a) => a.includes('--force') || a.includes('-f'));
const noBranchD = (fx) => !fx.gitArgvs().some((a) => a[0] === 'branch' && (a.includes('-D') || a.includes('-d')));
const isUpdateRefD = (req) => req.argv[0] === GIT && req.argv[1] === 'update-ref' && req.argv[2] === '-d';
const isDeletePush = (req) => req.argv[0] === GIT && req.argv.includes('push') && req.argv.some((a) => a.startsWith(':refs/heads/'));
const isRestorePush = (req) => req.argv[0] === GIT && req.argv.includes('push') && req.argv.some((a) => /^[0-9a-f]{40}:refs\/heads\//.test(a));
const pushedRecord = (fx, issue, state, tip, extra = {}) => saveRecord(fx, { issue, state, tip, extra: { lastPushedOid: tip, lastPushedAt: new Date(fx.ctx.now() - HOUR).toISOString(), ...extra } });
const action = (r, issue) => r.actions.find((a) => a.issue === issue);

export async function ac21_recoveryTableRows() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'blocked', b1.tip); unlabel(gh, 1, L.blocked, 'alice');
    const b2 = createAutopilotBranch(fx, { issue: 2 }); saveRecord(fx, { issue: 2, state: 'blocked', tip: b2.tip }); unlabel(gh, 2, L.blocked, 'alice');
    const b4 = createAutopilotBranch(fx, { issue: 4, marker: false });
    const b5 = createAutopilotBranch(fx, { issue: 5, token: TOKEN_B }); saveRecord(fx, { issue: 5, state: 'blocked', tip: b5.tip });
    const r = await recover({ ctx: fx.ctx });
    // retire whose ls-remote still shows the ref → remote-pending, record kept, ref listed with the command
    assert.equal(action(r, 1).outcome, 'remote-pending'); assert.equal(recordOf(fx, 1).state, 'remote-pending');
    assert.ok(fx.ctx.status.read().remoteRefsLeft.some((e) => e.issue === 1 && e.oid === b1.tip && e.command.includes('--force-with-lease')));
    assert.equal(fx.localOid(b1.branch), null); assert.equal(fx.remoteOid(b1.branch), b1.tip); assert.equal(fx.pushes().length, 0);
    // human removed the label (no PR, never pushed) → worktree removed + branch deleted + record deleted
    assert.equal(action(r, 2).outcome, 'deleted'); assert.equal(recordOf(fx, 2), null); assert.equal(fx.localOid(b2.branch), null); assert.ok(!existsSync(b2.wt));
    // orphans: a branch without a record, a record whose token does not match the marker
    assert.ok(fx.ctx.status.read().orphans.some((o) => o.issue === 4 && o.oid === b4.tip && o.reason === 'no-record'));
    assert.equal(recordOf(fx, 5).state, 'orphan'); assert.equal(fx.localOid(b5.branch), b5.tip);
    // open PR has that head → the branch is NOT deleted
    const b3 = createAutopilotBranch(fx, { issue: 3 }); saveRecord(fx, { issue: 3, state: 'blocked', tip: b3.tip }); gh.prs.push({ number: 30, head: b3.branch, state: 'OPEN' });
    const t = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 3) });
    assert.equal(t.outcome, 'orphan'); assert.equal(t.reason, 'open-pr'); assert.equal(fx.localOid(b3.branch), b3.tip); assert.ok(existsSync(b3.wt));
    // a later iteration with an empty ls-remote deletes the record; the issue is selectable (no record, no branch, no ref)
    fx.sh(['--git-dir', fx.originPath, 'update-ref', '-d', `refs/heads/${b1.branch}`]);
    const r2 = await recover({ ctx: fx.ctx });
    assert.equal(action(r2, 1).outcome, 'deleted'); assert.equal(recordOf(fx, 1), null); assert.equal(fx.ctx.records.tombstone(1).lastPushedOid, b1.tip);
    assert.ok(noBranchD(fx)); assert.equal(fx.pushes().length, 0);
  }, { gh });
}
test('AC21: every §2.1 row — remote-pending keeps the record until ls-remote is empty, an authorized unlabel retires, an open PR blocks deletion, orphans are never deleted', ac21_recoveryTableRows);

export async function ac29_ownershipCheckedDeletion() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const ok = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'blocked', tip: ok.tip });
    assert.equal((await retireRun({ ctx: fx.ctx, record: recordOf(fx, 1) })).outcome, 'deleted'); assert.equal(fx.localOid(ok.branch), null);
    const cases = [
      ['marker removed', createAutopilotBranch(fx, { issue: 2, marker: false })],
      ['mismatched token', createAutopilotBranch(fx, { issue: 3, token: TOKEN_B })],
      ['open PR', createAutopilotBranch(fx, { issue: 4 })],
    ];
    gh.prs.push({ number: 40, head: cases[2][1].branch, state: 'OPEN' });
    for (const [name, b] of cases) {
      saveRecord(fx, { issue: Number(b.branch.slice(-1)), state: 'blocked', tip: b.tip });
      const r = await retireRun({ ctx: fx.ctx, record: recordOf(fx, Number(b.branch.slice(-1))) });
      assert.equal(r.outcome, 'orphan', name); assert.equal(fx.localOid(b.branch), b.tip, name); assert.ok(existsSync(b.wt), name);
    }
    // history no longer contains baseOid → orphan
    const b5 = createAutopilotBranch(fx, { issue: 5 });
    const root = fx.sh(['commit-tree', `${b5.tip}^{tree}`, '-m', 'root']); fx.sh(['reset', '-q', '--hard', root], b5.wt);
    saveRecord(fx, { issue: 5, state: 'blocked', tip: root });
    const r5 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 5) });
    assert.equal(r5.outcome, 'orphan'); assert.equal(r5.reason, 'ancestry'); assert.equal(fx.localOid(b5.branch), root);
    // reset without --confirm-delete / with the wrong OID → exit 2, nothing deleted
    const b6 = createAutopilotBranch(fx, { issue: 6 }); saveRecord(fx, { issue: 6, state: 'blocked', tip: b6.tip });
    assert.equal((await resetCommand({ ctx: fx.ctx, issue: 6 })).exitCode, 2);
    assert.equal((await resetCommand({ ctx: fx.ctx, issue: 6, confirmDelete: fx.baseOid })).exitCode, 2);
    assert.equal(fx.localOid(b6.branch), b6.tip); assert.ok(existsSync(b6.wt)); assert.ok(noBranchD(fx));
  }, { gh });
}
test('AC29: only marker + record + ancestry + no open PR allows deletion; every other branch is reported orphan and kept; reset needs the exact tip', ac29_ownershipCheckedDeletion);

export async function ac42_remotePendingResettable() {
  const gh = ghWith();
  await withFx(async (fx) => {
    for (const [issue, prState] of [[1, 'CLOSED'], [2, 'MERGED']]) {
      const b = createAutopilotBranch(fx, { issue, push: true }); pushedRecord(fx, issue, 'pr-open', b.tip, { prNumber: issue * 10 });
      gh.prs.push({ number: issue * 10, head: b.branch, state: prState });
      assert.equal((await retireRun({ ctx: fx.ctx, record: recordOf(fx, issue) })).outcome, 'remote-pending', prState);
      const r = await resetCommand({ ctx: fx.ctx, issue, confirmDelete: b.tip, deleteRemote: true, sleep: async () => {} });
      assert.equal(r.exitCode, 0, prState); assert.equal(r.code, 'remote-deleted');
      const push = fx.pushes().at(-1);
      assert.ok(push.argv.includes(`--force-with-lease=refs/heads/${b.branch}:${b.tip}`) && push.argv.includes(`:refs/heads/${b.branch}`), 'lease form with the preserved lastPushedOid');
      assert.equal(fx.remoteOid(b.branch), null); assert.equal(recordOf(fx, issue).state, 'remote-deleted');
      fx.advance(25 * HOUR);
      await recover({ ctx: fx.ctx });
      assert.equal(recordOf(fx, issue), null, `${prState}: record deleted by the canonical rule, issue selectable`);
    }
    const b3 = createAutopilotBranch(fx, { issue: 3, push: true }); pushedRecord(fx, 3, 'blocked', b3.tip);
    const r3 = await resetCommand({ ctx: fx.ctx, issue: 3, confirmDelete: b3.tip, deleteRemote: true, sleep: async () => {} });
    assert.equal(r3.exitCode, 0); assert.equal(fx.remoteOid(b3.branch), null); assert.equal(fx.localOid(b3.branch), null); assert.ok(!existsSync(b3.wt));
    const b4 = createAutopilotBranch(fx, { issue: 4 }); saveRecord(fx, { issue: 4, state: 'blocked', tip: b4.tip });
    const pushesBefore = fx.pushes().length;
    const r4 = await resetCommand({ ctx: fx.ctx, issue: 4, confirmDelete: b4.tip, deleteRemote: true, sleep: async () => {} });
    assert.equal(r4.exitCode, 2); assert.equal(r4.code, 'reset-never-pushed'); assert.equal(fx.pushes().length, pushesBefore); assert.equal(fx.localOid(b4.branch), b4.tip);
  }, { gh });
}
test('AC42: CLOSED/MERGED → remote-pending → reset --delete-remote deletes with the lease form and the record leaves after 24 h; a blocked pushed run too; no lastPushedOid → exit 2', ac42_remotePendingResettable);

export async function ac43_rearmVsRetire() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'stale', b1.tip, { prNumber: 10, roundsUsed: 4, wallClockUsedMs: 5000, ciRoundsUsed: 1 });
    gh.prs.push({ number: 10, head: b1.branch, state: 'OPEN' }); unlabel(gh, 1, L.stale, 'alice');
    const b2 = createAutopilotBranch(fx, { issue: 2 }); saveRecord(fx, { issue: 2, state: 'blocked', tip: b2.tip }); unlabel(gh, 2, L.blocked, 'alice');
    const b3 = createAutopilotBranch(fx, { issue: 3, push: true }); pushedRecord(fx, 3, 'oid-mismatch', b3.tip, { prNumber: 30 }); gh.prs.push({ number: 30, head: b3.branch, state: 'OPEN' }); gh.labels[3] = [L.blocked];
    const r = await recover({ ctx: fx.ctx });
    const rec1 = recordOf(fx, 1);
    assert.equal(action(r, 1).action, 're-arm'); assert.equal(rec1.state, 'pr-open');
    assert.deepEqual([rec1.roundsUsed, rec1.wallClockUsedMs, rec1.ciRoundsUsed], [0, 0, 0]);
    assert.equal(fx.localOid(b1.branch), b1.tip); assert.equal(fx.remoteOid(b1.branch), b1.tip); assert.equal(gh.mutations().length, 0, 'PR untouched');
    assert.ok(recordOf(fx, 1), 'record kept → the issue is NOT selectable while its PR is open');
    assert.equal(action(r, 2).action, 'retire'); assert.equal(recordOf(fx, 2), null); assert.equal(fx.localOid(b2.branch), null);
    assert.equal(action(r, 3).action, 'quarantined'); assert.equal(recordOf(fx, 3).state, 'oid-mismatch', 'skipped by maintenance until its label is removed');
  }, { gh });
}
test('AC43: removing the stale label on an open-PR run re-arms (counters 0, pr-open, branch+PR untouched); removing blocked on a PR-less run retires; oid-mismatch stays quarantined while labeled', ac43_rearmVsRetire);

export async function ac45_orphanResetAuthorization() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1 });
    const r1 = await resetCommand({ ctx: fx.ctx, issue: 1, confirmDelete: b1.tip });
    assert.equal(r1.exitCode, 0); assert.equal(fx.localOid(b1.branch), null); assert.ok(!existsSync(b1.wt)); assert.equal(fx.marker(b1.branch), null);
    const b2 = createAutopilotBranch(fx, { issue: 2, marker: false });
    const b3 = createAutopilotBranch(fx, { issue: 3 });
    const b4 = createAutopilotBranch(fx, { issue: 4 }); gh.prs.push({ number: 40, head: b4.branch, state: 'OPEN' });
    for (const [b, oid, code] of [[b2, b2.tip, 'reset-not-owned'], [b3, fx.baseOid, 'reset-oid-mismatch'], [b4, b4.tip, 'reset-open-pr']]) {
      const r = await resetCommand({ ctx: fx.ctx, issue: Number(b.branch.slice(-1)), confirmDelete: oid });
      assert.equal(r.exitCode, 2, code); assert.equal(r.code, code); assert.equal(fx.localOid(b.branch), b.tip, code); assert.ok(existsSync(b.wt), code);
    }
    assert.ok(noBranchD(fx)); assert.equal(fx.pushes().length, 0);
  }, { gh });
}
test('AC45: reset deletes a marker-bearing recordless branch at its tip; no marker, wrong OID or an open PR → exit 2 and nothing deleted', ac45_orphanResetAuthorization);

export async function ac58_oidMismatchWithoutPr() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'oid-mismatch', tip: b1.tip }); unlabel(gh, 1, L.blocked, 'alice');
    const b2 = createAutopilotBranch(fx, { issue: 2, push: true }); pushedRecord(fx, 2, 'oid-mismatch', b2.tip); unlabel(gh, 2, L.blocked, 'alice');
    const b3 = createAutopilotBranch(fx, { issue: 3, push: true }); pushedRecord(fx, 3, 'oid-mismatch', b3.tip, { prNumber: 30, roundsUsed: 3 }); gh.prs.push({ number: 30, head: b3.branch, state: 'OPEN' }); unlabel(gh, 3, L.blocked, 'alice');
    const r = await recover({ ctx: fx.ctx });
    assert.equal(action(r, 1).action, 'retire'); assert.equal(recordOf(fx, 1), null); assert.equal(fx.localOid(b1.branch), null);
    assert.equal(action(r, 2).outcome, 'remote-pending'); assert.equal(recordOf(fx, 2).state, 'remote-pending');
    assert.ok(fx.ctx.status.read().remoteRefsLeft.some((e) => e.issue === 2 && e.ref === `refs/heads/${b2.branch}`)); assert.equal(fx.remoteOid(b2.branch), b2.tip);
    assert.equal(fx.pushes().length, 0, 'zero git push argv of any kind');
    assert.equal(action(r, 3).action, 're-arm'); assert.equal(recordOf(fx, 3).state, 'pr-open'); assert.equal(recordOf(fx, 3).roundsUsed, 0);
    assert.equal(fx.localOid(b3.branch), b3.tip); assert.equal(fx.remoteOid(b3.branch), b3.tip);
  }, { gh });
}
test('AC58: oid-mismatch label removed → Step L only (zero push; a pushed run → remote-pending listed under remoteRefsLeft); with an open PR → re-arm with branch and PR untouched', ac58_oidMismatchWithoutPr);

export async function ac63_leaseGuardedRemoteDeleteIsOperatorOnly() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const quiet = async () => {};
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'blocked', b1.tip); unlabel(gh, 1, L.blocked, 'alice');
    await recover({ ctx: fx.ctx });
    assert.equal(fx.pushes().length, 0); assert.ok(fx.ctx.status.read().remoteRefsLeft.some((e) => e.issue === 1));
    const b2 = createAutopilotBranch(fx, { issue: 2, push: true }); pushedRecord(fx, 2, 'blocked', b2.tip);
    const r2 = await resetCommand({ ctx: fx.ctx, issue: 2, confirmDelete: b2.tip, deleteRemote: true, sleep: quiet });
    assert.equal(r2.exitCode, 0); assert.ok(fx.pushes().at(-1).argv.includes(`--force-with-lease=refs/heads/${b2.branch}:${b2.tip}`)); assert.equal(fx.remoteOid(b2.branch), null);
    // remote tip advanced by another push between ls-remote and the delete → lease fails, ref survives, orphan
    const b3 = createAutopilotBranch(fx, { issue: 3, push: true }); pushedRecord(fx, 3, 'blocked', b3.tip);
    const other3 = newCommit(fx, b3.tip);
    fx.hooks.push((req) => { if (isDeletePush(req) && req.argv.includes(`:refs/heads/${b3.branch}`)) fx.sh(['push', '-q', fx.originPath, `${other3}:refs/heads/${b3.branch}`]); });
    const r3 = await resetCommand({ ctx: fx.ctx, issue: 3, confirmDelete: b3.tip, deleteRemote: true, sleep: quiet });
    assert.equal(r3.code, 'lease-failed'); assert.equal(fx.remoteOid(b3.branch), other3); assert.equal(recordOf(fx, 3).state, 'orphan'); assert.equal(fx.localOid(b3.branch), b3.tip);
    // freshness: 5 minutes old, or no lastPushedAt → ref-too-fresh, zero pushes
    const before = fx.pushes().length;
    const b4 = createAutopilotBranch(fx, { issue: 4, push: true }); pushedRecord(fx, 4, 'blocked', b4.tip, { lastPushedAt: new Date(fx.ctx.now() - 5 * 60_000).toISOString() });
    const b7 = createAutopilotBranch(fx, { issue: 7, push: true }); pushedRecord(fx, 7, 'blocked', b7.tip, { lastPushedAt: null });
    for (const [issue, b] of [[4, b4], [7, b7]]) {
      const r = await resetCommand({ ctx: fx.ctx, issue, confirmDelete: b.tip, deleteRemote: true, sleep: quiet });
      assert.equal(r.code, 'ref-too-fresh', String(issue)); assert.equal(r.exitCode, 2); assert.equal(fx.remoteOid(b.branch), b.tip);
    }
    assert.equal(fx.pushes().length, before);
    // a PR that appears right after a successful delete → restored at the recorded OID with a lease expecting absence
    const b5 = createAutopilotBranch(fx, { issue: 5, push: true }); pushedRecord(fx, 5, 'blocked', b5.tip);
    fx.hooks.push((req) => { if (isDeletePush(req) && req.argv.includes(`:refs/heads/${b5.branch}`)) gh.prs.push({ number: 55, head: b5.branch, state: 'OPEN' }); });
    const r5 = await resetCommand({ ctx: fx.ctx, issue: 5, confirmDelete: b5.tip, deleteRemote: true, sleep: quiet });
    assert.equal(r5.report, 'pr-after-delete-restored: 55'); assert.equal(fx.remoteOid(b5.branch), b5.tip);
    assert.ok(fx.pushes().at(-1).argv.includes(`--force-with-lease=refs/heads/${b5.branch}:`)); assert.ok(gh.labels[5].includes('adlc:needs-human')); assert.ok(recordOf(fx, 5));
    // the ref re-created at another OID before the restore → the restore's lease fails, the foreign ref survives
    const b6 = createAutopilotBranch(fx, { issue: 6, push: true }); pushedRecord(fx, 6, 'blocked', b6.tip);
    const other6 = newCommit(fx, b6.tip);
    fx.hooks.push((req) => {
      if (isDeletePush(req) && req.argv.includes(`:refs/heads/${b6.branch}`)) gh.prs.push({ number: 66, head: b6.branch, state: 'OPEN' });
      if (isRestorePush(req) && req.argv.includes(`${b6.tip}:refs/heads/${b6.branch}`)) fx.sh(['push', '-q', fx.originPath, `${other6}:refs/heads/${b6.branch}`]);
    });
    const r6 = await resetCommand({ ctx: fx.ctx, issue: 6, confirmDelete: b6.tip, deleteRemote: true, sleep: quiet });
    assert.equal(r6.code, 'pr-after-delete-unrestored'); assert.equal(fx.remoteOid(b6.branch), other6);
    // a PR that appears only at the 120 s re-query
    const b8 = createAutopilotBranch(fx, { issue: 8, push: true }); pushedRecord(fx, 8, 'blocked', b8.tip);
    const slept = [];
    const r8 = await resetCommand({ ctx: fx.ctx, issue: 8, confirmDelete: b8.tip, deleteRemote: true, sleep: async (ms) => { slept.push(ms); if (ms === 120_000) gh.prs.push({ number: 88, head: b8.branch, state: 'OPEN' }); } });
    assert.deepEqual(slept, [30_000, 120_000]); assert.equal(r8.code, 'pr-after-delete-restored'); assert.equal(fx.remoteOid(b8.branch), b8.tip);
    // remote-deleted for 2 h whose next recovery pass finds a PR → restored; older than 24 h with none → deleted
    const b9 = createAutopilotBranch(fx, { issue: 9, push: true, worktree: false }); fx.sh(['--git-dir', fx.originPath, 'update-ref', '-d', `refs/heads/${b9.branch}`]); fx.sh(['update-ref', '-d', `refs/heads/${b9.branch}`]);
    pushedRecord(fx, 9, 'remote-deleted', b9.tip, { remoteDeletedAt: new Date(fx.ctx.now() - 2 * HOUR).toISOString() }); gh.prs.push({ number: 99, head: b9.branch, state: 'CLOSED' });
    const b10 = createAutopilotBranch(fx, { issue: 10, push: true, worktree: false }); fx.sh(['--git-dir', fx.originPath, 'update-ref', '-d', `refs/heads/${b10.branch}`]); fx.sh(['update-ref', '-d', `refs/heads/${b10.branch}`]);
    pushedRecord(fx, 10, 'remote-deleted', b10.tip, { remoteDeletedAt: new Date(fx.ctx.now() - 25 * HOUR).toISOString() });
    const r = await recover({ ctx: fx.ctx });
    assert.equal(action(r, 9).action, 'pr-after-delete-restored'); assert.equal(fx.remoteOid(b9.branch), b9.tip); assert.ok(recordOf(fx, 9));
    assert.equal(action(r, 10).outcome, 'deleted'); assert.equal(recordOf(fx, 10), null);
  }, { gh });
}
test('AC63: automatic retirement never pushes; reset --delete-remote uses --force-with-lease=<ref>:<oid>, fails closed on a moved tip or a fresh push, and restores the ref (lease expecting absence) when a PR appears at any re-query', ac63_leaseGuardedRemoteDeleteIsOperatorOnly);

export async function ac67_authorizedUnlabel() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'stale', b1.tip, { prNumber: 10 }); gh.prs.push({ number: 10, head: b1.branch, state: 'OPEN' }); unlabel(gh, 1, L.stale, 'bob', 501);
    const b2 = createAutopilotBranch(fx, { issue: 2, push: true }); pushedRecord(fx, 2, 'stale', b2.tip, { prNumber: 20 }); gh.prs.push({ number: 20, head: b2.branch, state: 'OPEN' }); unlabel(gh, 2, L.stale, 'alice', 502);
    const r = await recover({ ctx: fx.ctx });
    assert.equal(action(r, 1).action, 'unauthorized-unlabel'); assert.equal(recordOf(fx, 1).state, 'stale');
    assert.ok(gh.labels[1].includes(L.stale), 'label re-applied'); assert.ok(fx.ctx.status.read().unauthorizedUnlabels.some((u) => u.issue === 1 && u.actor === 'bob'));
    assert.equal(action(r, 2).action, 're-arm'); assert.equal(recordOf(fx, 2).state, 'pr-open'); assert.equal(recordOf(fx, 2).unlabeledEventId, 502);
    fx.ctx.records.update(2, { state: 'stale' });                                   // the same event id must not be acted on again
    const r2 = await recover({ ctx: fx.ctx });
    assert.equal(action(r2, 2).action, 'already-acted'); assert.equal(recordOf(fx, 2).state, 'stale');
  }, { gh });
}
test('AC67: an unlabel by a write-permission actor is ignored (label re-applied, unauthorized-unlabel); by an admin it transitions once — the event id is never acted on twice', ac67_authorizedUnlabel);

export async function ac70_localDeletionRevalidation() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'blocked', tip: b1.tip });
    writeFileSync(join(b1.wt, 'later.txt'), 'later\n'); fx.sh(['add', '-A'], b1.wt); fx.sh(['commit', '-q', '-m', 'later'], b1.wt); const moved = fx.sh(['rev-parse', 'HEAD'], b1.wt);
    const r1 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 1) });
    assert.equal(r1.outcome, 'orphan'); assert.equal(r1.reason, 'tip-moved'); assert.equal(fx.localOid(b1.branch), moved); assert.ok(existsSync(b1.wt));
    const b2 = createAutopilotBranch(fx, { issue: 2 }); saveRecord(fx, { issue: 2, state: 'blocked', tip: b2.tip }); writeFileSync(join(b2.wt, 'dirty.txt'), 'x');
    const r2 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 2) });
    assert.equal(r2.outcome, 'orphan'); assert.equal(r2.reason, 'dirty'); assert.ok(existsSync(join(b2.wt, 'dirty.txt'))); assert.equal(fx.localOid(b2.branch), b2.tip);
    assert.ok(!hasForce(fx), 'the worktree removal is never forced');
    // a ref that moves BETWEEN L2 and L3 → update-ref -d fails, the worktree is moved back, both artifacts survive byte-identical
    const b3 = createAutopilotBranch(fx, { issue: 3 }); saveRecord(fx, { issue: 3, state: 'blocked', tip: b3.tip });
    const bytes = fileBytes(join(b3.wt, 'work-3.txt')); const other = newCommit(fx, b3.tip);
    fx.hooks.push((req) => { if (isUpdateRefD(req) && req.argv[3] === `refs/heads/${b3.branch}`) fx.sh(['update-ref', `refs/heads/${b3.branch}`, other]); });
    const r3 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 3) });
    assert.equal(r3.outcome, 'orphan'); assert.equal(r3.reason, 'ref-moved'); assert.equal(fx.localOid(b3.branch), other);
    assert.ok(existsSync(b3.wt)); assert.ok(!existsSync(fx.paths.retiringWorktree(3, TOKEN_A))); assert.deepEqual(fileBytes(join(b3.wt, 'work-3.txt')), bytes);
    // a record is deleted only when ls-remote is empty and no local branch/worktree exists — every row ending in deletion
    const rows = [
      ['blocked, never pushed, label removed', async () => { const b = createAutopilotBranch(fx, { issue: 4 }); saveRecord(fx, { issue: 4, state: 'blocked', tip: b.tip }); unlabel(gh, 4, L.blocked, 'alice'); return 4; }],
      ['clarify, label removed', async () => { saveRecord(fx, { issue: 5, state: 'clarify', tip: null }); unlabel(gh, 5, L.clarify, 'alice'); return 5; }],
      ['remote-pending after the operator deleted the ref', async () => { const b = createAutopilotBranch(fx, { issue: 6, push: true, worktree: false }); fx.sh(['update-ref', '-d', `refs/heads/${b.branch}`]); pushedRecord(fx, 6, 'remote-pending', b.tip); fx.sh(['--git-dir', fx.originPath, 'update-ref', '-d', `refs/heads/${b.branch}`]); return 6; }],
    ];
    for (const [name, build] of rows) {
      const issue = await build(); const n = fx.gitArgvs().length;
      const r = await recover({ ctx: fx.ctx });
      assert.equal(action(r, issue).outcome, 'deleted', name); assert.equal(recordOf(fx, issue), null, name);
      assert.ok(fx.gitArgvs().slice(n).some((a) => a[0] === 'ls-remote' && a[1] === fx.originPath && a[2] === `refs/heads/${branchFor(issue)}`), `${name}: ls-remote consulted`);
      assert.equal(fx.localOid(branchFor(issue)), null, name); assert.ok(!existsSync(fx.paths.issueWorktree(issue)), name);
    }
  }, { gh });
}
test('AC70: a moved tip or a dirty worktree performs no deletion (never --force); a ref moving between L2 and L3 fails the conditional delete and the worktree is moved back; records are deleted only by the canonical rule', ac70_localDeletionRevalidation);

export async function ac92_detachBeforeRefDelete() {
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'blocked', tip: b1.tip });
    const ret = fx.paths.retiringWorktree(1, TOKEN_A); const seen = {};
    fx.hooks.push((req) => {
      if (isUpdateRefD(req) && req.argv[3] === `refs/heads/${b1.branch}`) seen.beforeL3 = { exists: existsSync(ret), head: fx.sh(['rev-parse', 'HEAD'], ret), detached: (() => { try { fx.sh(['symbolic-ref', '-q', 'HEAD'], ret); return false; } catch { return true; } })() };
      if (req.argv[0] === GIT && req.argv[1] === 'worktree' && req.argv[2] === 'remove') seen.atL4 = { exists: existsSync(ret), branch: fx.localOid(b1.branch), head: fx.sh(['rev-parse', 'HEAD'], ret) };
    });
    const r = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 1) });
    assert.equal(r.outcome, 'deleted');
    assert.deepEqual(seen.beforeL3, { exists: true, head: b1.tip, detached: true }, 'after L2 the quarantined worktree is detached at localHead');
    assert.deepEqual(seen.atL4, { exists: true, branch: null, head: b1.tip }, 'L3 succeeded while the worktree still existed; L4 sees HEAD == localHead');
    assert.ok(!existsSync(ret) && !existsSync(b1.wt));
    // a worktree whose HEAD was moved by hand between L2 and L4 → L4 aborts, orphan, the quarantined directory survives
    const b2 = createAutopilotBranch(fx, { issue: 2, token: TOKEN_B }); saveRecord(fx, { issue: 2, token: TOKEN_B, state: 'blocked', tip: b2.tip });
    const ret2 = fx.paths.retiringWorktree(2, TOKEN_B);
    fx.hooks.push((req) => { if (isUpdateRefD(req) && req.argv[3] === `refs/heads/${b2.branch}`) fx.sh(['checkout', '-q', '--detach', fx.baseOid], ret2); });
    const r2 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 2) });
    assert.equal(r2.outcome, 'orphan'); assert.equal(r2.reason, 'quarantined-worktree-moved'); assert.ok(existsSync(ret2)); assert.ok(!hasForce(fx));
  });
}
test('AC92: L2 detaches the quarantined worktree at localHead before L3 deletes the ref while it still exists; a HEAD moved by hand between L2 and L4 aborts L4 as orphan', ac92_detachBeforeRefDelete);

/** A per-issue token: real tokens are unique per run, so staging names never collide across issues. */
const tokenFor = (issue) => issue.toString(16).padStart(64, '0');
function creatingRecord(fx, { issue, token = tokenFor(issue), phase }) {
  const rec = newRecord({ issue, token, baseOid: fx.baseOid, branch: branchFor(issue), stagingBranch: stagingBranchFor(token), stagingPath: fx.paths.stagingWorktree(issue, token), finalPath: fx.paths.issueWorktree(issue) });
  return fx.ctx.records.save({ ...rec, creationPhase: phase });
}
/** Leave the half-done state of a crash right AFTER the git command of `phase`. */
function crashAfter(fx, issue, phase, token = tokenFor(issue)) {
  const rec = creatingRecord(fx, { issue, token, phase });
  if (phase === 'recorded') return rec;
  fx.sh(['worktree', 'add', '-q', rec.stagingPath, '-b', rec.stagingBranch, fx.baseOid]);
  if (phase === 'staged') return rec;
  fx.sh(['config', `branch.${rec.stagingBranch}.adlcAutopilotToken`, token]);
  if (phase === 'marked') return rec;
  fx.sh(['branch', '-m', rec.stagingBranch, rec.finalBranch]);
  if (phase === 'renamed') return rec;
  fx.sh(['worktree', 'move', rec.stagingPath, rec.finalPath]);
  return rec;
}
const assertShaped = (fx, issue, token = tokenFor(issue)) => {
  const rec = recordOf(fx, issue);
  assert.equal(rec.state, 'shaped'); assert.equal(fx.localOid(branchFor(issue)), fx.baseOid); assert.equal(fx.marker(branchFor(issue)), token);
  assert.ok(existsSync(fx.paths.issueWorktree(issue))); assert.ok(!existsSync(fx.paths.stagingWorktree(issue, token))); assert.equal(fx.localOid(stagingBranchFor(token)), null);
};

export async function ac93_crashSafeCreation() {
  await withFx(async (fx) => {
    crashAfter(fx, 1, 'staged');
    const r1 = await repairCreation({ ctx: fx.ctx, record: recordOf(fx, 1) });
    assert.equal(r1.outcome, 'repaired'); assertShaped(fx, 1);
    const rec2 = crashAfter(fx, 2, 'staged'); writeFileSync(join(rec2.stagingPath, 'x.txt'), 'x'); fx.sh(['add', '-A'], rec2.stagingPath); fx.sh(['commit', '-q', '-m', 'moved'], rec2.stagingPath);
    const r2 = await repairCreation({ ctx: fx.ctx, record: recordOf(fx, 2) });
    assert.equal(r2.outcome, 'orphan'); assert.equal(recordOf(fx, 2).state, 'orphan'); assert.ok(existsSync(rec2.stagingPath)); assert.notEqual(fx.localOid(rec2.stagingBranch), null);
    const rec3 = crashAfter(fx, 3, 'recorded'); mkdirSync(rec3.finalPath, { recursive: true });
    const r3 = await recover({ ctx: fx.ctx });
    assert.equal(action(r3, 3).outcome, 'deleted'); assert.equal(recordOf(fx, 3), null); assert.ok(!existsSync(rec3.finalPath));
    // the record is on disk BEFORE the `git worktree add` argv
    let observed = null;
    fx.hooks.push((req) => { if (req.argv[0] === GIT && req.argv[1] === 'worktree' && req.argv[2] === 'add') observed = recordOf(fx, 4); });
    await createIssueWorktree({ ctx: fx.ctx, issue: 4, baseOid: fx.baseOid });
    assert.equal(observed?.state, 'creating'); assert.equal(observed?.creationPhase, 'staged');
  });
}
test('AC93: a creating record with a markerless staging branch at baseOid gets its marker and completes; a moved tip → orphan; no branch → record and empty ISSUE_WT removed; the record precedes worktree add', ac93_crashSafeCreation);

export async function ac104_stagedCreation() {
  await withFx(async (fx) => {
    mkdirSync(fx.paths.issueWorktree(1), { recursive: true });
    await assert.rejects(createIssueWorktree({ ctx: fx.ctx, issue: 1, baseOid: fx.baseOid }), (e) => e.code === 'orphan-dir');
    assert.equal(fx.gitArgvs().length, 0, 'zero git calls');
    const c = await createIssueWorktree({ ctx: fx.ctx, issue: 2, baseOid: fx.baseOid });
    const argvs = fx.gitArgvs();
    const add = argvs.findIndex((a) => a[0] === 'worktree' && a[1] === 'add');
    assert.deepEqual(argvs[add].slice(2), [fx.paths.stagingWorktree(2, c.token), '-b', stagingBranchFor(c.token), fx.baseOid], 'creation goes through the token-named staging names');
    const mark = argvs.findIndex((a) => a[0] === 'config' && a[1] === `branch.${stagingBranchFor(c.token)}.adlcAutopilotToken`);
    const move = argvs.findIndex((a) => a[0] === 'worktree' && a[1] === 'move');
    assert.ok(add < mark && mark < move, 'moved only after the marker exists'); assertShaped(fx, 2, c.token);
    // a creating record whose staging path belongs to a DIFFERENT token → nothing deleted, orphan
    const foreign = crashAfter(fx, 3, 'marked', TOKEN_B);
    fx.ctx.records.save({ ...foreign, token: TOKEN_A });
    const r = await recover({ ctx: fx.ctx });
    assert.equal(action(r, 3).outcome, 'orphan'); assert.ok(existsSync(foreign.stagingPath)); assert.equal(fx.localOid(foreign.stagingBranch), fx.baseOid); assert.equal(fx.marker(foreign.stagingBranch), TOKEN_B);
    crashAfter(fx, 4, 'staged');
    assert.equal(action(await recover({ ctx: fx.ctx }), 4).outcome, 'repaired'); assertShaped(fx, 4);
  });
}
test('AC104: a pre-existing ISSUE_WT → orphan-dir with zero git calls; creation uses <ISSUE_WT>.creating-<token> and moves only after the marker; a foreign-token staging path is never touched', ac104_stagedCreation);

export async function ac107_creationPhasesJournaled() {
  await withFx(async (fx) => {
    const phases = ['recorded', 'staged', 'marked', 'renamed', 'moved'];
    for (const [i, phase] of phases.entries()) {
      const issue = i + 1; const rec = crashAfter(fx, issue, phase);
      const r = await recover({ ctx: fx.ctx });
      if (phase === 'recorded') { assert.equal(action(r, issue).outcome, 'deleted', phase); continue; }
      assert.equal(action(r, issue).outcome, 'repaired', phase); assertShaped(fx, issue);
      assert.ok(!existsSync(rec.stagingPath), `${phase}: no dangling staging path`);
    }
    // the record carries the NEXT phase on disk BEFORE each git argv
    const seen = [];
    fx.hooks.push((req) => { if (req.argv[0] === GIT) seen.push([req.argv.slice(1, 3).join(' '), recordOf(fx, 9)?.creationPhase ?? null]); });
    await createIssueWorktree({ ctx: fx.ctx, issue: 9, baseOid: fx.baseOid });
    const at = (verb) => seen.find(([v]) => v.startsWith(verb))?.[1];
    assert.deepEqual([at('worktree add'), at('config branch'), at('branch -m'), at('worktree move')], ['staged', 'marked', 'renamed', 'moved']);
    // never deleted while a marker-bearing final branch exists
    const rec = crashAfter(fx, 10, 'moved'); fx.sh(['worktree', 'remove', rec.finalPath]);
    const r = await recover({ ctx: fx.ctx });
    assert.equal(action(r, 10).outcome, 'orphan'); assert.ok(recordOf(fx, 10)); assert.equal(fx.localOid(branchFor(10)), fx.baseOid);
  });
}
test('AC107: every creationPhase crash is finished by recovery, the next phase is on disk before each git argv, a renamed crash leaves no staging path, and a marker-bearing final branch keeps its record', ac107_creationPhasesJournaled);

export async function ac110_pinnedRemoteUrl() {
  const gh = ghWith();
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'blocked', b1.tip); unlabel(gh, 1, L.blocked, 'alice');
    await recover({ ctx: fx.ctx });
    await resetCommand({ ctx: fx.ctx, issue: 1, confirmDelete: b1.tip, deleteRemote: true, sleep: async () => {} });
    const net = fx.recorder.filter((r) => r.argv[0] === GIT && ['ls-remote', 'fetch', 'push'].some((v) => r.argv.includes(v)));
    assert.ok(net.length >= 2);
    for (const r of net) { assert.ok(r.argv.includes(fx.originPath), 'pinned URL literal'); assert.ok(!r.argv.includes('origin'), 'never the word origin'); assert.ok(r.argv[1] === `--git-dir=${fx.paths.netGit}`, 'network ops run in NET_GIT'); }
    const b2 = createAutopilotBranch(fx, { issue: 2, push: true }); pushedRecord(fx, 2, 'blocked', b2.tip);
    fx.sh(['remote', 'set-url', 'origin', join(fx.root, 'elsewhere.git')]);
    const before = fx.pushes().length;
    const r2 = await resetCommand({ ctx: fx.ctx, issue: 2, confirmDelete: b2.tip, deleteRemote: true, sleep: async () => {} });
    assert.equal(r2.code, 'remote-url-changed'); assert.equal(fx.pushes().length, before); assert.equal(recordOf(fx, 2).state, 'orphan'); assert.equal(fx.remoteOid(b2.branch), b2.tip);
  }, { gh });
}
test('AC110: every ls-remote/push argv carries the pinned URL literal in NET_GIT, never `origin`; an origin URL that changed before a push → remote-url-changed, zero pushes, orphan', ac110_pinnedRemoteUrl);

export async function ticketAc2_remoteRefPreservesRecord() {
  await withFx(async (fx) => {
    const b = createAutopilotBranch(fx, { issue: 1, push: true }); pushedRecord(fx, 1, 'pushed', b.tip);
    const r = await recover({ ctx: fx.ctx });
    assert.deepEqual(action(r, 1), { action: 'upsert-pr', issue: 1, prNumber: null, remoteOid: b.tip, lastPushedOid: b.tip });
    assert.equal(recordOf(fx, 1).state, 'pushed', 'the record survives for the next iteration to upsert the PR');
    assert.ok(fx.gitArgvs().some((a) => a[0] === 'ls-remote' && a[2] === `refs/heads/${b.branch}`), 'ls-remote consulted before any deletion decision');
    assert.equal(fx.remoteOid(b.branch), b.tip); assert.equal(fx.localOid(b.branch), b.tip);
  });
}
test('ticket-AC2: a crash after push with no PR — the remote ref is found, the record survives in `pushed` and the next iteration upserts the PR', ticketAc2_remoteRefPreservesRecord);

export async function ticketAc3_atomicLocalDeletion() {
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'blocked', tip: b1.tip }); const other = newCommit(fx, b1.tip);
    fx.hooks.push((req) => { if (isUpdateRefD(req) && req.argv[3] === `refs/heads/${b1.branch}`) fx.sh(['update-ref', `refs/heads/${b1.branch}`, other]); });
    const r1 = await retireRun({ ctx: fx.ctx, record: recordOf(fx, 1) });
    assert.equal(r1.outcome, 'orphan'); assert.equal(fx.localOid(b1.branch), other); assert.ok(existsSync(b1.wt)); assert.equal(recordOf(fx, 1).state, 'orphan');
    const del = fx.gitArgvs().filter((a) => a[0] === 'update-ref' && a[1] === '-d');
    assert.ok(del.length === 1 && del[0][3] === b1.tip, 'the only ref delete is the conditional form with the expected OID'); assert.ok(noBranchD(fx));
    const b2 = createAutopilotBranch(fx, { issue: 2 }); saveRecord(fx, { issue: 2, state: 'blocked', tip: b2.tip }); writeFileSync(join(b2.wt, 'work-2.txt'), 'edited\n');
    const r2 = await stepL({ ctx: fx.ctx, record: recordOf(fx, 2) });
    assert.equal(r2.outcome, 'orphan'); assert.equal(r2.reason, 'dirty'); assert.ok(existsSync(b2.wt)); assert.equal(fx.localOid(b2.branch), b2.tip);
    assert.ok(!hasForce(fx), 'worktree removal never --force');
  });
}
test('ticket-AC3: the branch delete is `update-ref -d <ref> <expectedOid>` (a tip advanced between check and delete deletes nothing), the worktree is verified clean and removed without --force, failures mark orphan', ticketAc3_atomicLocalDeletion);

export async function ticketAc4_recordlessResetIsNonDestructiveToTheRemote() {
  await withFx(async (fx) => {
    const b1 = createAutopilotBranch(fx, { issue: 1, push: true });
    const r1 = await resetCommand({ ctx: fx.ctx, issue: 1, confirmDelete: b1.tip, deleteRemote: true, sleep: async () => {} });
    assert.equal(r1.exitCode, 2); assert.equal(r1.code, 'reset-recordless-remote');
    assert.deepEqual(r1.printed, [`git push --force-with-lease=refs/heads/${b1.branch}:${b1.tip} ${fx.originPath} :refs/heads/${b1.branch}`]);
    assert.equal(fx.pushes().length, 0, 'zero git push argv'); assert.equal(fx.remoteOid(b1.branch), b1.tip);
    assert.equal(fx.localOid(b1.branch), null); assert.ok(!existsSync(b1.wt)); assert.equal(fx.marker(b1.branch), null, 'local artifacts deleted');
    const b2 = createAutopilotBranch(fx, { issue: 2, push: true }); pushedRecord(fx, 2, 'blocked', b2.tip);
    const r2 = await resetCommand({ ctx: fx.ctx, issue: 2, confirmDelete: b2.tip, deleteRemote: true, sleep: async () => {} });
    assert.equal(r2.exitCode, 0); assert.equal(fx.pushes().length, 1); assert.equal(fx.remoteOid(b2.branch), null);
  });
}
test('ticket-AC4: reset --delete-remote on a recordless branch deletes local artifacts only, exits 2 with the exact push command and zero push argv; a record-bearing run gets the lease-guarded delete', ticketAc4_recordlessResetIsNonDestructiveToTheRemote);

export async function rearmHelperResetsCounters() {
  await withFx(async (fx) => {
    const b = createAutopilotBranch(fx, { issue: 1 }); saveRecord(fx, { issue: 1, state: 'stale', tip: b.tip, extra: { roundsUsed: 2 } });
    assert.equal(rearmRun({ ctx: fx.ctx, record: recordOf(fx, 1) }).state, 'pr-open'); assert.equal(recordOf(fx, 1).roundsUsed, 0);
    assert.equal((await canonicalDeletion({ ctx: fx.ctx, record: recordOf(fx, 1) })).outcome, 'local-present');
  });
}
test('rearmRun resets counters to pr-open; the canonical rule refuses while local artifacts exist', rearmHelperResetsCounters);

export async function ac29_unlabelEventRecordedAfterTheEffect() {
  // The rearm throws (a crash between the decision and the effect): the event is NOT marked acted-on, so the next recovery retries it.
  const gh = ghWith();
  await withFx(async (fx) => {
    const b = createAutopilotBranch(fx, { issue: 7, push: true }); pushedRecord(fx, 7, 'blocked', b.tip); unlabel(gh, 7, L.blocked, 'alice');
    const { recover } = await import('../lib/recover.mjs');
    const realUpdate = fx.ctx.records.update.bind(fx.ctx.records);
    fx.ctx.records.update = (n, patch) => { if (n === 7 && patch.state && patch.state !== 'blocked') throw new Error('crash mid-rearm'); return realUpdate(n, patch); };
    const r = await recover({ ctx: fx.ctx });
    const a = action(r, 7);
    assert.ok(a && (a.action === 'error' || /crash/.test(String(a.message ?? ''))), `the rearm failure surfaces: ${JSON.stringify(a)}`);
    const rec = fx.ctx.records.load(7);
    assert.ok(rec?.unlabeledEventId == null, `the event is not recorded as acted-on when its effect failed: ${JSON.stringify(rec?.unlabeledEventId)}`);
  }, { gh });
}
test('AC29: an authorized unlabel is recorded as acted-on only AFTER its effect — a crash mid-rearm leaves the event for the next recovery instead of stranding the run as already-acted', ac29_unlabelEventRecordedAfterTheEffect);
