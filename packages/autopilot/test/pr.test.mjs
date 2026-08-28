// AC 6 / 57 — the PR upsert is keyed by head branch (a second run edits,
// never creates twice), its body carries `Closes #<n>`, the ticket id and the
// evidence block, and it is head-bound on both sides: an ls-remote that moves
// between the post-push check and the upsert → zero gh mutations; a PR whose
// head differs right after creation → oid-mismatch naming the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushAndUpsert, prBody, prTitle, evidenceBlock } from '../lib/push.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, ghMutations, FAKE, OID, TICKET } from './helpers/review-ctx.mjs';
import { fakeGit } from './helpers/review-fakegit.mjs';

const BRANCH = 'adlc/autopilot/issue-7';

/** A fake gh with one PR store. */
function fakePrs({ viewHead = () => OID.b } = {}) {
  const st = { prs: [], created: 0, edits: 0, viewHead, bodies: [] };
  const handler = (args, { stdin }) => {
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: JSON.stringify(st.prs.filter((p) => p.head === args[args.indexOf('--head') + 1]).map((p) => ({ number: p.number }))) };
    if (args[0] === 'pr' && args[1] === 'create') { st.created++; const number = 41; st.prs.push({ number, head: args[args.indexOf('--head') + 1], title: args[args.indexOf('--title') + 1], body: stdin }); st.bodies.push(stdin); return { stdout: `https://github.com/o/r/pull/${number}\n` }; }
    if (args[0] === 'pr' && args[1] === 'edit') { st.edits++; const pr = st.prs.find((p) => p.number === Number(args[2])); if (pr) pr.body = stdin; st.bodies.push(stdin); return { stdout: `https://github.com/o/r/pull/${args[2]}\n` }; }
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ headRefOid: st.viewHead(Number(args[2])) }) };
    return { stdout: '{}' };
  };
  return { st, handler };
}
const adlcAttest = (args) => (args[0] === 'gate-manifest' && args[1] === 'attest' ? { stdout: `## Evidence for ${args[3]}\n- EVIDENCE BLOCK\n` } : { status: 1, stderr: 'unexpected' });

export async function ac6_prUpsertEditsOnSecondRun() {
  const root = scratch('ap-pr');
  try {
    const g = fakeGit(); const prs = fakePrs();
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: g.handler, [FAKE.gh]: prs.handler, [FAKE.adlc]: adlcAttest } });
    ctx.records.save(prOpenRecord({ issue: 7, state: 'attested', attestedHead: OID.b, lastPushedOid: null, prNumber: null }));
    const evidence = await evidenceBlock({ ctx, cwd: ctx.paths.issueWorktree(7), ticketId: TICKET });
    const body = prBody({ issue: 7, ticketId: TICKET, attest: { attestedHead: OID.b, revision: 'rev-1' }, review: { verdict: 'approve' }, quota: { windows: { fiveHour: 12, sevenDay: 30 } }, baseOid: OID.base, evidence, rounds: 1 });
    const title = prTitle({ issue: 7, ticket: { category: 'bug', scope: ['packages/x/**'], title: 'Fix the thing' } });
    assert.equal(title, 'fix(x): Fix the thing (#7)');
    const first = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b, title, body });
    assert.equal(first.ok, true); assert.equal(first.created, true); assert.equal(first.prNumber, 41);
    assert.equal(prs.st.created, 1); assert.equal(prs.st.edits, 0);
    const posted = prs.st.prs[0].body;
    assert.ok(posted.includes('Closes #7'), 'Closes #<n>'); assert.ok(posted.includes(TICKET), 'ticket id'); assert.ok(posted.includes('EVIDENCE BLOCK'), 'evidence block'); assert.ok(posted.includes(`base-oid: ${OID.base}`));
    assert.equal(ctx.records.load(7).state, 'pr-open'); assert.equal(ctx.records.load(7).prNumber, 41);
    // Second successful run for the same issue: a new attested head → edit, never a second create.
    g.st.head = OID.c; g.st.remote = OID.c; prs.st.viewHead = () => OID.c;
    ctx.records.update(7, { state: 'attested', attestedHead: OID.c });
    const second = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.c, title, body: `${body}\nround 2` });
    assert.equal(second.ok, true); assert.equal(second.created, false); assert.equal(second.prNumber, 41);
    assert.equal(prs.st.created, 1, 'never a second gh pr create'); assert.equal(prs.st.edits, 1, 'gh pr edit');
    const edit = ghMutations(ctx).find((a) => a[1] === 'edit');
    assert.deepEqual(edit.slice(0, 5), ['pr', 'edit', '41', '--body-file', '-']);
    assert.ok(prs.st.prs[0].body.includes('round 2') && prs.st.prs[0].body.includes('Closes #7'));
    await withMutation('push.alwaysCreate', async () => {
      g.st.head = OID.d; g.st.remote = OID.d; prs.st.viewHead = () => OID.d; ctx.records.update(7, { state: 'attested', attestedHead: OID.d });
      await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.d, title, body });
      assert.equal(prs.st.created, 2, 'seam: a second create');
    });
  } finally { cleanup(root); }
}
test('AC6: a second successful run for the same issue performs gh pr edit and never a second gh pr create; the body contains Closes #<n>, the ticket id and the evidence block', ac6_prUpsertEditsOnSecondRun);

export async function ac57_upsertHeadBinding() {
  const root = scratch('ap-pr');
  try {
    // (a) ls-remote changes between the post-push check (call 1) and the upsert (call 2).
    const g = fakeGit({ remote: (call) => (call === 1 ? OID.b : OID.c) }); const prs = fakePrs();
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.git]: g.handler, [FAKE.gh]: prs.handler } });
    ctx.records.save(prOpenRecord({ issue: 7, state: 'attested', attestedHead: OID.b, lastPushedOid: null, prNumber: null }));
    const r = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b, title: 't', body: 'b' });
    assert.equal(r.ok, false); assert.equal(r.code, 'oid-mismatch'); assert.equal(r.observed, OID.c);
    assert.equal(ghMutations(ctx).length, 0, 'zero gh pr mutating calls'); assert.equal(prs.st.created + prs.st.edits, 0);
    assert.equal(ctx.records.load(7).state, 'oid-mismatch');
    // (b) gh pr view returns a different headRefOid right after gh pr create.
    const g2 = fakeGit(); const prs2 = fakePrs({ viewHead: () => OID.c });
    const ctx2 = buildCtx({ repoRoot: scratch('ap-pr2'), handlers: { [FAKE.git]: g2.handler, [FAKE.gh]: prs2.handler } });
    ctx2.records.save(prOpenRecord({ issue: 7, state: 'attested', attestedHead: OID.b, lastPushedOid: null, prNumber: null }));
    const r2 = await pushAndUpsert({ ctx: ctx2, issue: 7, record: ctx2.records.load(7), attestedHead: OID.b, title: 't', body: 'b' });
    assert.equal(r2.ok, false); assert.equal(r2.code, 'oid-mismatch'); assert.equal(r2.prNumber, 41);
    assert.ok(r2.comment.includes('#41'), 'the comment names the PR'); assert.ok(r2.comment.includes(OID.c) && r2.comment.includes(OID.b), 'expected/observed OIDs');
    assert.equal(ctx2.records.load(7).state, 'oid-mismatch'); assert.equal(ctx2.records.load(7).prNumber, 41, 'the PR created in between is left as-is and recorded');
    cleanup(ctx2.repoRoot);
    await withMutation('push.upsertWithoutHeadBinding', async () => {
      g.st.remote = (call) => (call === 1 ? OID.b : OID.c); g.st.lsCalls = 0; ctx.records.save(prOpenRecord({ issue: 7, state: 'attested', attestedHead: OID.b, lastPushedOid: null, prNumber: null }));
      const s = await pushAndUpsert({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: OID.b, title: 't', body: 'b' });
      assert.equal(s.ok, true, 'seam: the moved remote is not noticed'); assert.equal(prs.st.created, 1);
    });
  } finally { cleanup(root); }
}
test('AC57: an ls-remote that changes between the post-push check and the upsert → zero gh pr mutating calls + oid-mismatch; a gh pr view headRefOid differing right after gh pr create → oid-mismatch naming the PR number', ac57_upsertHeadBinding);
