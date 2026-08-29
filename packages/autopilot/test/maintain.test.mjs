// AC 7 / 48 / 61 / 62 — open-PR maintenance: the record-state selector and
// provenance/preconditions (zero mutations otherwise), the rebase paths
// (carry-forward on an unchanged patch-id — proven against a REAL repository
// — a full retry round when the patch-id changed, one conflict-fix round, then
// stale), the open-PR cap, and the MERGED/CLOSED lifecycle.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maintainOpenPrs, activePrCount, capAllows, remoteDeleteCommand } from '../lib/maintain.mjs';
import { attest } from '../lib/review.mjs';
import { manifestLineSha256 } from '../lib/diffcheck.mjs';
import { STATES, MAINTENANCE_STATES } from '../lib/records.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, argvsOf, ghMutations, pushes, FAKE, OID, TOKEN, TICKET } from './helpers/review-ctx.mjs';
import { git, initRepo, commitFile, makeIssueWorktree, bareRemote, bareTip } from './helpers/review-git.mjs';

const BRANCH = 'adlc/autopilot/issue-7';
const MARKER = `branch.${BRANCH}.adlcAutopilotToken`;
const noDeps = { retireRun: null, actualDiffCheck: null, applyTerminalEffects: null };

/** A fake git covering the maintenance verbs from a mutable state. */
function maintainGit({ head = OID.b, rebaseStatus = 0, remote = OID.b, pid = 'same' } = {}) {
  const st = { head, rebaseStatus, remote, pid, verbs: [] };
  const handler = (args) => {
    const verb = args.find((a) => !a.startsWith('-') && !/^user\.|^commit\./.test(a));
    st.verbs.push(verb);
    switch (verb) {
      case 'rev-parse': return { stdout: `${st.head}\n` };
      case 'status': return { stdout: '' };
      case 'rebase': return st.rebaseStatus && !args.includes('--abort') ? { status: st.rebaseStatus, stdout: 'CONFLICT (content): Merge conflict in packages/x/a.js\n' } : { stdout: '' };
      case 'diff': return args.includes('--name-only') ? { stdout: '.adlc/manifest.d/autopilot.jsonl\n' } : args.includes('--unified=0') ? { stdout: '+{"x":1}\n' } : { stdout: 'diff --git a/x b/x\n' };
      case 'patch-id': return { stdout: `${(typeof st.pid === 'function' ? st.pid() : st.pid).padEnd(40, '0')} ${'0'.repeat(40)}\n` };
      case 'push': return { stdout: '' };
      case 'ls-remote': return { stdout: st.remote ? `${st.remote}\trefs/heads/${BRANCH}\n` : '' };
      default: return { stdout: '' };
    }
  };
  return { st, handler };
}
function maintainGh({ prState = 'OPEN', headRefName = BRANCH, headRefOid = OID.b, base = 'main', merge = 'BEHIND', notFound = false } = {}) {
  const st = { prState, headRefName, headRefOid, base, merge, notFound, comments: [] };
  const handler = (args, { stdin }) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      if (st.notFound) return { status: 1, stderr: 'GraphQL: Could not resolve to a PullRequest' };
      const fields = args[args.indexOf('--json') + 1];
      return { stdout: JSON.stringify(fields.includes('mergeStateStatus') ? { mergeStateStatus: st.merge, headRefOid: st.headRefOid } : { headRefName: st.headRefName, headRefOid: st.headRefOid, state: st.prState, baseRefName: st.base }) };
    }
    if (args[0] === 'issue' && args[1] === 'view') return { stdout: JSON.stringify({ labels: [] }) };
    if (args[0] === 'issue' && args[1] === 'comment') { st.comments.push(stdin); return { stdout: 'ok' }; }
    if (args[0] === 'api') return { stdout: '[]' };
    return { stdout: '{}' };
  };
  return { st, handler };
}
function fakeAdlc() {
  const st = { calls: [] };
  const handler = (args, { cwd }) => {
    st.calls.push(args);
    if (args[0] === 'prosecute' && args[1] === 'record-cross-model') {
      const dir = args[args.indexOf('--dir') + 1]; mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      appendFileSync(join(dir, 'manifest.d', 'autopilot.jsonl'), `${JSON.stringify({ data: { revision: `rev-${st.calls.length}` } })}\n`);
      return { stdout: JSON.stringify({ data: { revision: `rev-${st.calls.length}`, verdict: 'approve' } }) };
    }
    return { status: 1, stderr: `unexpected ${args.join(' ')} in ${cwd}` };
  };
  return { st, handler };
}
const carryForwards = (adlc) => adlc.st.calls.filter((a) => a.includes('--carry-forward'));
const freshAttests = (adlc) => adlc.st.calls.filter((a) => a[1] === 'record-cross-model' && !a.includes('--carry-forward'));
function fakeHarness({ git: g = {}, gh = {}, marker = TOKEN } = {}) {
  const root = scratch('ap-maint');
  const G = maintainGit(g); const H = maintainGh(gh); const A = fakeAdlc();
  const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: G.handler, [FAKE.gh]: H.handler, [FAKE.adlc]: A.handler }, observations: { [MARKER]: marker } });
  mkdirSync(join(ctx.paths.issueWorktree(7), '.adlc', 'manifest.d'), { recursive: true });
  const mutations = () => ({ git: ctx.recorder.filter((r) => r.argv[0] === FAKE.git && r.argv.some((a) => ['rebase', 'push', 'commit', 'worktree', 'update-ref'].includes(a))).length, gh: ghMutations(ctx).length });
  // This iteration's BASE_OID (OID.d) differs from the records' baseOid (OID.base): main has moved.
  return { root, ctx, G, H, A, mutations, run: (extra = {}) => maintainOpenPrs({ ctx, baseOid: OID.d, deps: { ...noDeps, actualDiffCheck: async () => ({ ok: true }), ...extra } }) };
}

export async function ac61_ownershipAndSelector() {
  const h = fakeHarness();
  try {
    for (const state of STATES.filter((s) => !MAINTENANCE_STATES.includes(s))) {
      h.ctx.records.save(prOpenRecord({ issue: 7, state, prNumber: 41 }));
      const before = h.mutations();
      const { actions } = await h.run();
      assert.deepEqual(h.mutations(), before, `${state}: zero git/gh mutating calls`);
      assert.ok(['skip', 'observed'].includes(actions[0].action), `${state}: ${actions[0].action}`);
      assert.equal(h.ctx.records.load(7).state, state, `${state}: state untouched`);
    }
    const cases = [
      ['token mismatch', () => { h.ctx.observations[MARKER] = 'e'.repeat(64); }, 'orphan'],
      ['PR head name differs', () => { h.H.st.headRefName = 'feature/other'; }, 'orphan'],
      ['PR base not main', () => { h.H.st.base = 'develop'; }, 'orphan'],
      ['ls-remote differs from last pushed', () => { h.G.st.remote = OID.c; }, 'orphan'],
      ['headRefOid != attestedHead', () => { h.H.st.headRefOid = OID.c; }, 'oid-mismatch'],
    ];
    for (const [name, arrange, expected] of cases) {
      h.ctx.observations[MARKER] = TOKEN; h.H.st.headRefName = BRANCH; h.H.st.base = 'main'; h.G.st.remote = OID.b; h.H.st.headRefOid = OID.b;
      arrange();
      h.ctx.records.save(prOpenRecord({ issue: 7 }));
      const before = h.mutations();
      const { actions } = await h.run();
      assert.equal(actions[0].action, expected, name); assert.equal(h.ctx.records.load(7).state, expected, name);
      assert.deepEqual(h.mutations(), before, `${name}: zero mutations`);
    }
    h.ctx.observations[MARKER] = TOKEN; h.H.st.headRefName = BRANCH; h.H.st.base = 'main'; h.G.st.remote = OID.b; h.H.st.headRefOid = OID.b;
    h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const { actions } = await h.run();
    assert.equal(actions[0].action, 'rebased', 'all preconditions met → the rebase path runs');
    assert.ok(h.G.st.verbs.includes('rebase'));
    await withMutation('maintain.skipProvenance', async () => {
      h.ctx.observations[MARKER] = 'e'.repeat(64); h.ctx.records.save(prOpenRecord({ issue: 7 }));
      const r = await h.run();
      assert.notEqual(r.actions[0].action, 'orphan', 'seam: a token mismatch is not noticed');
    });
  } finally { cleanup(h.root); }
}
test('AC61: every non-candidate state (incl. oid-mismatch with an OPEN PR and blocked) → zero git/gh mutations; token/head-name/base/ls-remote mismatches → orphan with zero mutations; headRefOid ≠ attestedHead → oid-mismatch; all met → the rebase path runs', ac61_ownershipAndSelector);

export async function ac7_rebasePaths() {
  const h = fakeHarness();
  try {
    let fixRounds = 0; let retries = 0;
    const deps = { conflictFixRound: async ({ ctx, record }) => { fixRounds++; const a = await attest({ ctx, cwd: ctx.paths.issueWorktree(record.issue), ticketId: TICKET, baseOid: OID.base, reviewedHead: OID.b }); return { ok: true, attestedHead: a.attestedHead }; }, retryRound: async () => { retries++; return { ok: true }; } };
    h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const behind = await h.run(deps);
    assert.equal(behind.actions[0].action, 'rebased');
    assert.equal(carryForwards(h.A).length, 1, 'one --carry-forward call'); assert.deepEqual(carryForwards(h.A)[0].slice(0, 6), ['prosecute', 'record-cross-model', '--ticket', TICKET, '--carry-forward', 'rev-1']);
    assert.ok(pushes(h.ctx).some((a) => a.some((x) => x.startsWith('--force-with-lease='))), '--force-with-lease push');
    assert.equal(fixRounds + retries, 0, 'zero worker dispatches'); assert.equal(h.ctx.records.load(7).state, 'ci-watch');
    // DIRTY → exactly one conflict-fix dispatch, then a fresh record-cross-model without --carry-forward.
    h.H.st.merge = 'DIRTY'; h.G.st.rebaseStatus = 1; h.A.st.calls.length = 0;
    h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const dirty = await h.run(deps);
    assert.equal(dirty.actions[0].action, 'conflict-fixed'); assert.equal(fixRounds, 1);
    assert.equal(carryForwards(h.A).length, 0); assert.equal(freshAttests(h.A).length, 1, 'fresh record-cross-model without --carry-forward');
    assert.ok(h.G.st.verbs.includes('rebase')); assert.equal(h.ctx.records.load(7).roundsUsed, 1, 'charged to roundsUsed'); assert.equal(h.ctx.records.load(7).state, 'ci-watch');
    // Failure → adlc:autopilot-stale.
    h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const failed = await h.run({ ...deps, conflictFixRound: async () => ({ ok: false, code: 'strikes-exhausted' }) });
    assert.equal(failed.actions[0].action, 'stale'); assert.equal(failed.actions[0].label, 'adlc:autopilot-stale'); assert.equal(h.ctx.records.load(7).state, 'stale');
    // The cap: 5 stale + 0 active → dispatch proceeds; 5 open pr-open → refused.
    const stale = Array.from({ length: 5 }, (_, i) => prOpenRecord({ issue: 10 + i, state: 'stale', prNumber: 50 + i }));
    assert.equal(activePrCount(stale), 0); assert.equal(capAllows(stale, 5), true, '5 stale + 0 active → dispatch proceeds');
    const open = Array.from({ length: 5 }, (_, i) => prOpenRecord({ issue: 10 + i, state: i % 2 ? 'ci-watch' : 'pr-open', prNumber: 50 + i }));
    assert.equal(activePrCount(open), 5); assert.equal(capAllows(open, 5), false);
    assert.equal(activePrCount([prOpenRecord({ issue: 1, state: 'oid-mismatch' })]), 1, 'a quarantined OPEN PR still counts');
    await withMutation('maintain.countStaleTowardCap', () => { assert.equal(capAllows(stale, 5), false, 'seam: stale PRs fill the cap'); });
  } finally { cleanup(h.root); }
}
test('AC7: BEHIND + clean → --carry-forward argv + --force-with-lease push with zero worker dispatches; DIRTY → exactly one conflict-fix dispatch then fresh record-cross-model (no --carry-forward); failure → adlc:autopilot-stale; 5 stale + 0 active → dispatch proceeds', ac7_rebasePaths);

export async function ac62_prLifecycle() {
  const h = fakeHarness({ gh: { prState: 'MERGED' }, git: { remote: null } });
  try {
    const retired = [];
    const retireRun = async ({ ctx, record }) => { retired.push({ issue: record.issue, stateAtRetire: ctx.records.load(record.issue).state }); return { ok: true, retired: true }; };
    h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const merged = await h.run({ retireRun });
    assert.equal(merged.actions[0].action, 'merged'); assert.deepEqual(retired, [{ issue: 7, stateAtRetire: 'done' }], 'done is written before the local retire');
    assert.equal(h.ctx.records.load(7), null, 'record deleted when ls-remote shows the ref gone'); assert.ok(existsSync(h.ctx.paths.tombstone(7)));
    assert.equal(pushes(h.ctx).length, 0, 'zero git push calls');
    h.G.st.remote = OID.b; h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const pending = await h.run({ retireRun });
    assert.equal(pending.actions[0].state, 'remote-pending'); assert.equal(h.ctx.records.load(7).state, 'remote-pending'); assert.equal(pushes(h.ctx).length, 0);
    // CLOSED (not merged) → local retire, remote-pending while the ref exists, skip label + comment with the exact command.
    h.H.st.prState = 'CLOSED'; h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const closed = await h.run({ retireRun });
    assert.equal(closed.actions[0].action, 'closed'); assert.equal(retired.length, 3); assert.equal(pushes(h.ctx).length, 0);
    assert.equal(h.ctx.records.load(7).state, 'remote-pending');
    const cmd = remoteDeleteCommand(h.ctx, prOpenRecord({ issue: 7 }));
    assert.equal(cmd, `git --git-dir=${h.ctx.paths.netGit} push --force-with-lease=refs/heads/${BRANCH}:${OID.b} git@github.com:o/r.git :refs/heads/${BRANCH}`);
    assert.ok(ghMutations(h.ctx).some((a) => a.includes('--add-label') && a.includes('adlc:autopilot-skip')), 'adlc:autopilot-skip applied to the issue');
    assert.ok(h.H.st.comments.some((c) => c.includes(cmd) && c.includes('#41')), 'the comment names the closed PR and the exact remote-deletion command');
    // PR not found → orphan.
    h.H.st.notFound = true; h.ctx.records.save(prOpenRecord({ issue: 7 }));
    const gone = await h.run({ retireRun });
    assert.equal(gone.actions[0].action, 'orphan'); assert.equal(h.ctx.records.load(7).state, 'orphan');
    await withMutation('maintain.deleteRecordWithRemoteRef', async () => {
      h.H.st.notFound = false; h.H.st.prState = 'MERGED'; h.ctx.records.save(prOpenRecord({ issue: 7 }));
      await h.run({ retireRun });
      assert.equal(h.ctx.records.load(7), null, 'seam: deleted despite the remote ref');
    });
  } finally { cleanup(h.root); }
}
test('AC62: MERGED → done, local retire, zero git push, record deleted only when ls-remote shows the ref gone else remote-pending; CLOSED → local retire, remote-pending, adlc:autopilot-skip + comment naming the exact remote-deletion command; PR not found → orphan', ac62_prLifecycle);

const LINES = (edits = {}) => `${Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? String(i + 1)).join('\n')}\n`;
async function realRebase(kind) {
  const root = scratch('ap-maint-real'); const bareDir = scratch('ap-maint-bare');
  try {
    const baseOid = initRepo(root, { 'f.txt': LINES(), 'other.txt': 'o\n' });
    const bare = bareRemote(join(bareDir, 'remote.git'));
    const { wt } = makeIssueWorktree({ repoRoot: root, issue: 7, baseOid, token: TOKEN });
    const issueHead = commitFile(wt, 'f.txt', LINES({ 10: 'ten' }), 'feat: ten');
    git(wt, ['push', '-q', bare, `HEAD:refs/heads/${BRANCH}`]);
    const newBase = kind === 'unrelated' ? commitFile(root, 'other.txt', 'o2\n', 'chore: other') : commitFile(root, 'f.txt', LINES({ 12: 'twelve' }), 'chore: context drift');
    const A = fakeAdlc(); const H = maintainGh({ headRefOid: issueHead });
    const ctx = buildCtx({ repoRoot: root, realGit: true, netGit: true, remote: { remoteFetchUrl: bare, remotePushUrl: bare }, handlers: { [FAKE.adlc]: A.handler, [FAKE.gh]: H.handler }, observations: { [MARKER]: TOKEN } });
    ctx.records.save(prOpenRecord({ issue: 7, attestedHead: issueHead, lastPushedOid: issueHead, baseOid }));
    let retries = 0;
    const { actions } = await maintainOpenPrs({ ctx, baseOid: newBase, deps: { ...noDeps, actualDiffCheck: async () => ({ ok: true }), retryRound: async () => { retries++; return { ok: true }; } } });
    const record = ctx.records.load(7);
    const segment = join(wt, '.adlc', 'manifest.d', 'autopilot.jsonl');
    const appended = existsSync(segment) ? readFileSync(segment, 'utf8').split('\n').filter(Boolean) : [];
    const linesRecorded = appended.length > 0 && appended.every((l) => (record.manifestLinesWritten ?? []).includes(manifestLineSha256(l)));
    return { action: actions[0], carry: carryForwards(A).length, retries, record, tip: bareTip(bare, BRANCH), newBase, wt, linesRecorded };
  } finally { cleanup(root); cleanup(bareDir); }
}

export async function ac48_carryForwardEquivalence() {
  const same = await realRebase('unrelated');
  assert.equal(same.action.action, 'rebased', JSON.stringify(same.action));
  assert.equal(same.carry, 1, 'a clean rebase with an unchanged patch-id → one --carry-forward call');
  assert.equal(same.retries, 0); assert.equal(same.record.state, 'ci-watch', 're-entry to ci-watch');
  assert.equal(same.record.baseOid, same.newBase); assert.equal(same.tip, same.record.attestedHead, 'the carried-forward head is pushed');
  assert.equal(same.linesRecorded, true, 'the carried-forward manifest line is in record.manifestLinesWritten (S5 convention)');
  const drift = await realRebase('context');
  assert.equal(drift.action.action, 'retry-round'); assert.equal(drift.action.reason, 'patch-id-changed');
  assert.equal(drift.carry, 0, 'context drift in the same hunk → zero --carry-forward calls'); assert.equal(drift.retries, 1, 'a full retry round');
  await withMutation('maintain.carryForwardWithoutPatchId', async () => {
    const r = await realRebase('context');
    assert.equal(r.carry, 1, 'seam: the changed patch is carried forward');
  });
}
test('AC48: real repository — a clean rebase whose patch-id is unchanged → one --carry-forward call and re-entry to ci-watch; a clean rebase whose patch-id changed (context drift in the same hunk) → zero --carry-forward calls and a full retry round', ac48_carryForwardEquivalence);
