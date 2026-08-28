// AC 38 / 44 / 46 — reviewed = attested = pushed, the diff size gate, and the
// §6.6 reopen-for-retry (fake `adlc` for the argv/stdin contract, then the
// REAL `adlc ticket` binary against a temporary sharded store).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewRound, attest, completeTicket, reopenTicket, parseLastJson, MANIFEST_PATH_RE } from '../lib/review.mjs';
import { verifyPushVerify } from '../lib/push.mjs';
import { childEnv, spawnIsKeyBearing } from '../lib/keys.mjs';
import { manifestLineSha256 } from '../lib/diffcheck.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, argvsOf, pushes, FAKE, KEY, TOKEN, TICKET } from './helpers/review-ctx.mjs';
import { git, initRepo, commitFile, makeIssueWorktree, bareRemote, bareTip, writeFile, head } from './helpers/review-git.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TICKETS_BIN = join(HERE, '..', '..', 'tickets', 'bin', 'adlc-tickets.mjs');
const BRANCH = 'adlc/autopilot/issue-7';

/** The fake `adlc`: record-cross-model appends a manifest line (and, in `evil` mode, a source file); ticket verbs over an in-memory shard. */
function fakeAdlc() {
  const st = { mode: 'ok', calls: [], seenAt: [], ticket: { id: TICKET, title: 't', body: 'b', scope: ['packages/x/**'], completed: true }, hash: 'H1' };
  const handler = (args, { cwd, env, stdin }) => {
    st.calls.push({ args, env, stdin, cwd });
    if (args[0] === 'prosecute' && args[1] === 'record-cross-model') {
      const dir = args[args.indexOf('--dir') + 1];
      st.seenAt.push({ head: git(cwd, ['rev-parse', 'HEAD']), clean: git(cwd, ['status', '--porcelain']) === '' });
      const revision = `rev-${st.seenAt.length}`;
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      appendFileSync(join(dir, 'manifest.d', 'autopilot.jsonl'), `${JSON.stringify({ gate: 'cross-model', data: { revision } })}\n`);
      if (st.mode === 'evil') writeFileSync(join(cwd, 'src-evil.js'), 'boom\n');
      return { stdout: JSON.stringify({ data: { revision, verdict: 'approve' }, signed: true }) };
    }
    if (args[0] === 'ticket' && args[1] === 'complete') {
      const root = args[args.indexOf('--root') + 1];
      writeFile(root, `.adlc/tickets/${args[2].toLowerCase()}--h.json`, JSON.stringify({ ...st.ticket, completed: true }));
      st.ticket = { ...st.ticket, completed: true }; st.hash = 'H-complete';
      return { stdout: `${JSON.stringify({ plan: true })}\n${JSON.stringify({ applied: true, ticketHash: st.hash })}\n` };
    }
    if (args[0] === 'ticket' && args[1] === 'show') return { stdout: JSON.stringify({ ticket: st.ticket, ticketHash: st.hash, storeHash: 'S' }) };
    if (args[0] === 'ticket' && args[1] === 'update') {
      const root = args[args.indexOf('--root') + 1];
      st.ticket = JSON.parse(stdin); st.hash = 'H2';
      writeFile(root, `.adlc/tickets/${args[2].toLowerCase()}--h.json`, JSON.stringify(st.ticket));
      return { stdout: `${JSON.stringify({ plan: true })}\n${JSON.stringify({ applied: true, ticketHash: st.hash })}\n` };
    }
    return { status: 1, stderr: `unexpected adlc ${args.join(' ')}` };
  };
  return { st, handler };
}
function fakeReviewer() {
  const st = { verdict: 'approve', reviews: [] };
  const handler = (args, { cwd }) => {
    st.reviews.push({ args, cwd, head: git(cwd, ['rev-parse', 'HEAD']) });
    if (st.verdict === 'approve') return { stdout: JSON.stringify({ verdict: 'approve', findings: [] }) };
    return { status: 2, stdout: JSON.stringify({ verdict: 'needs-attention', findings: [{ title: 'Injection in x', severity: 'high', file: 'packages/x/a.js' }] }) };
  };
  return { st, handler };
}
function repo({ withBare = false } = {}) {
  const root = scratch('ap-review'); const bareDir = withBare ? scratch('ap-review-bare') : null;
  const baseOid = initRepo(root);
  const { wt } = makeIssueWorktree({ repoRoot: root, issue: 7, baseOid, token: TOKEN });
  commitFile(wt, 'packages/x/a.js', 'export const a = 1;\n', 'feat(x): a');
  const bare = withBare ? bareRemote(join(bareDir, 'remote.git')) : null;
  return { root, bareDir, baseOid, wt, bare, done: () => { cleanup(root); if (bareDir) cleanup(bareDir); } };
}

export async function ac38_reviewedEqualsAttestedEqualsPushed() {
  const r = repo({ withBare: true });
  try {
    const adlc = fakeAdlc(); const ar = fakeReviewer();
    const ctx = buildCtx({ repoRoot: r.root, realGit: true, netGit: true, remote: { remoteFetchUrl: r.bare, remotePushUrl: r.bare }, handlers: { [FAKE.adlc]: adlc.handler, [FAKE['adversarial-review']]: ar.handler } });
    ctx.records.save(prOpenRecord({ issue: 7, state: 'built', prNumber: null, lastPushedOid: null, baseOid: r.baseOid }));
    const completion = await completeTicket({ ctx, cwd: r.wt, ticketId: TICKET });
    assert.equal(git(r.wt, ['log', '-1', '--format=%s']), `chore(ticket): complete ${TICKET}`);
    const review = await reviewRound({ ctx, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx.records.load(7) });
    assert.equal(review.ok, true);
    assert.equal(ar.st.reviews[0].cwd, r.wt, 'the reviewer runs in ISSUE_WT');
    assert.equal(ar.st.reviews[0].args[ar.st.reviews[0].args.indexOf('--base') + 1], r.baseOid, '--base <baseOid>');
    assert.equal(ar.st.reviews[0].head, completion.head, 'reviewed AFTER the completion commit'); assert.equal(review.reviewedHead, completion.head);
    const att = await attest({ ctx, cwd: r.wt, ticketId: TICKET, baseOid: r.baseOid, reviewedHead: review.reviewedHead });
    assert.deepEqual(adlc.st.seenAt[0], { head: review.reviewedHead, clean: true }, 'record-cross-model ran while HEAD == reviewedHead and the tree was clean');
    const manifestDiff = git(r.wt, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n');
    assert.ok(manifestDiff.length > 0 && manifestDiff.every((p) => MANIFEST_PATH_RE.test(p)), `manifest commit names only .adlc/manifest.d/*.jsonl: ${manifestDiff}`);
    assert.equal(att.attestedHead, head(r.wt)); assert.equal(att.revision, 'rev-1'); assert.equal(att.manifestLineHashes.length, 1);
    const appended = git(r.wt, ['show', 'HEAD:.adlc/manifest.d/autopilot.jsonl']).split('\n').filter(Boolean);
    assert.deepEqual(ctx.records.load(7).manifestLinesWritten, appended.map(manifestLineSha256), 'record.manifestLinesWritten carries manifestLineSha256 of every appended line (S5 convention)');
    ctx.records.update(7, { state: 'attested' });
    const push = await verifyPushVerify({ ctx, issue: 7, record: ctx.records.load(7), attestedHead: att.attestedHead });
    assert.equal(push.ok, true, JSON.stringify(push)); assert.equal(bareTip(r.bare, BRANCH), att.attestedHead, 'the pushed OID equals attestedHead');
    // A recorder fake that writes a source file between 7a and 7b → oid-mismatch, no push.
    const pushesBefore = pushes(ctx).length;
    adlc.st.mode = 'evil';
    const review2 = await reviewRound({ ctx, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx.records.load(7) });
    await assert.rejects(attest({ ctx, cwd: r.wt, ticketId: TICKET, baseOid: r.baseOid, reviewedHead: review2.reviewedHead }), (e) => e.code === 'oid-mismatch');
    assert.equal(pushes(ctx).length, pushesBefore, 'nothing pushed');
    rmSync(join(r.wt, 'src-evil.js'), { force: true }); git(r.wt, ['reset', '-q', '--hard', review2.reviewedHead]); adlc.st.mode = 'ok';
    // needs-attention → round failure with the findings as dead-end material.
    ar.st.verdict = 'needs-attention';
    const na = await reviewRound({ ctx, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx.records.load(7) });
    assert.equal(na.ok, false); assert.equal(na.code, 'needs-attention'); assert.equal(na.findings.length, 1); assert.ok(na.deadEnd.includes('Injection in x'), 'findings become --dead-end-file content');
    await withMutation('review.attestWithoutHeadCheck', async () => {
      adlc.st.mode = 'evil'; ar.st.verdict = 'approve';
      const rv = await reviewRound({ ctx, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx.records.load(7) });
      const bad = await attest({ ctx, cwd: r.wt, ticketId: TICKET, baseOid: r.baseOid, reviewedHead: rv.reviewedHead });
      assert.ok(bad.attestedHead, 'seam: the dirty tree is attested anyway');
    });
  } finally { r.done(); }
}
test('AC38: the final adversarial-review runs with --base <baseOid> in ISSUE_WT after the completion commit; record-cross-model runs at HEAD == reviewedHead on a clean tree; the manifest commit names only .adlc/manifest.d/*.jsonl; a fake writing a source file between 7a and 7b → oid-mismatch and no push; pushed OID == attestedHead; needs-attention → retry with findings as dead-end', ac38_reviewedEqualsAttestedEqualsPushed);

export async function ac44_diffSizeGate() {
  const r = repo();
  try {
    const ar = fakeReviewer();
    const ctx = buildCtx({ repoRoot: r.root, realGit: true, handlers: { [FAKE['adversarial-review']]: ar.handler } });
    ctx.records.save(prOpenRecord({ issue: 7, state: 'built', prNumber: null, baseOid: r.baseOid }));
    for (let i = 0; i < 2; i++) assert.equal((await reviewRound({ ctx, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx.records.load(7) })).ok, true);
    for (const rv of ar.st.reviews) {
      assert.equal(rv.args[rv.args.indexOf('--max-bytes') + 1], '262144', '--max-bytes 262144');
      assert.ok(!rv.args.includes('--allow-summary-review'), 'never --allow-summary-review');
      assert.deepEqual(rv.args.slice(0, 8), ['--base', r.baseOid, '--provider', 'codex', '--json', '--fail-on', 'medium', '--max-bytes']);
      assert.equal(rv.args[rv.args.indexOf('--findings-ledger') + 1], ctx.paths.findingsLedger(7));
    }
    const diffBytes = Buffer.byteLength(git(r.wt, ['diff', `${r.baseOid}...HEAD`]) + '\n', 'utf8');
    const ctx2 = buildCtx({ repoRoot: r.root, realGit: true, config: { reviewMaxBytes: diffBytes - 1 }, handlers: { [FAKE['adversarial-review']]: ar.handler } });
    ctx2.records.save(prOpenRecord({ issue: 7, state: 'built', prNumber: null, baseOid: r.baseOid }));
    const one = await reviewRound({ ctx: ctx2, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx2.records.load(7) });
    assert.equal(one.ok, false); assert.equal(one.code, 'diff-too-large'); assert.equal(one.size.bytes, diffBytes, 'the diff is reviewMaxBytes + 1');
    assert.ok(one.deadEnd.includes('packages/x/a.js'), 'largest paths as dead-end material');
    assert.equal(argvsOf(ctx2, FAKE['adversarial-review']).length, 0, 'zero adversarial-review calls');
    const two = await reviewRound({ ctx: ctx2, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx2.records.load(7) });
    assert.equal(two.code, 'blocked', 'two consecutive diff-too-large → blocked'); assert.equal(two.streak, 2);
    assert.equal(argvsOf(ctx2, FAKE['adversarial-review']).length, 0);
    await withMutation('review.skipSizeGate', async () => {
      await reviewRound({ ctx: ctx2, issue: 7, cwd: r.wt, baseOid: r.baseOid, record: ctx2.records.load(7) });
      assert.equal(argvsOf(ctx2, FAKE['adversarial-review']).length, 1, 'seam: the oversize diff reaches the reviewer');
    });
  } finally { r.done(); }
}
test('AC44: a diff of reviewMaxBytes + 1 bytes → round failure diff-too-large with zero adversarial-review calls; two consecutive → blocked; reviewer argvs carry --max-bytes 262144 and never --allow-summary-review', ac44_diffSizeGate);

export async function ac46_reopenForRetry() {
  // (a) The argv/stdin contract against a fake adlc.
  const r = repo();
  try {
    const adlc = fakeAdlc();
    const ctx = buildCtx({ repoRoot: r.root, realGit: true, handlers: { [FAKE.adlc]: adlc.handler } });
    writeFile(r.wt, `.adlc/tickets/${TICKET.toLowerCase()}--h.json`, JSON.stringify(adlc.st.ticket)); git(r.wt, ['add', '-A']); git(r.wt, ['commit', '-q', '-m', 'shard']);
    const before = { ...adlc.st.ticket };
    const out = await reopenTicket({ ctx, cwd: r.wt, ticketId: TICKET, round: 2 });
    assert.equal(out.reopened, true); assert.equal(out.ticketHash, 'H2');
    const update = adlc.st.calls.find((c) => c.args[1] === 'update');
    assert.deepEqual(update.args, ['ticket', 'update', TICKET, '--input', '-', '--expect', 'H1', '--authorize', '--write', '--root', r.wt, '--json']);
    assert.deepEqual(JSON.parse(update.stdin), { ...before, completed: false }, 'stdin is the FULL document from the preceding show with only completed changed');
    assert.equal(update.env.ADLC_MANIFEST_KEY, KEY, 'the reopen update is key-bearing');
    assert.equal(adlc.st.calls.find((c) => c.args[1] === 'show').env.ADLC_MANIFEST_KEY, undefined, 'show is not');
    const rec = ctx.recorder.find((s) => s.argv[0] === FAKE.adlc && s.argv[2] === 'update');
    assert.equal(spawnIsKeyBearing(rec.argv, ctx.pinned), true, 'the reopen call is in the key-bearing set of AC 12');
    assert.equal(git(r.wt, ['log', '-1', '--format=%s']), `chore(ticket): reopen ${TICKET} for retry round 2`);
    assert.equal(git(r.wt, ['status', '--porcelain']), '', 'committed before the next fleet invocation');
    assert.equal(JSON.parse(git(r.wt, ['show', `HEAD:.adlc/tickets/${TICKET.toLowerCase()}--h.json`])).completed, false);
    await withMutation('review.reopenWithoutAuthorize', async () => {
      await completeTicket({ ctx, cwd: r.wt, ticketId: TICKET }); adlc.st.hash = 'H3';
      await reopenTicket({ ctx, cwd: r.wt, ticketId: TICKET, round: 3 });
      assert.ok(!adlc.st.calls.at(-2).args.includes('--authorize'), 'seam: --authorize is dropped');
    });
  } finally { r.done(); }
  // (b) reopen-cli: the REAL `adlc ticket` binary against a temporary sharded store.
  const r2 = repo(); const binDir = scratch('ap-review-bin');
  try {
    const shim = join(binDir, 'adlc');
    writeFileSync(shim, `#!/bin/sh\nshift\nexec '${process.execPath}' '${TICKETS_BIN}' "$@"\n`, { mode: 0o755 });
    const ctx = buildCtx({ repoRoot: r2.root, realGit: true, pinned: { adlc: shim }, realExes: [shim] });
    writeFile(r2.wt, '.adlc/tickets/.store.json', '{"format":"adlc-ticket-directory","version":1}\n'); git(r2.wt, ['add', '-A']); git(r2.wt, ['commit', '-q', '-m', 'store']);
    const created = await ctx.spawn({ argv: [shim, 'ticket', 'create', '--input', '-', '--write', '--root', r2.wt, '--json'], cwd: r2.wt, env: childEnv(ctx.env.base), stdinBytes: JSON.stringify({ title: 'Reopen probe', body: 'body', scope: ['packages/x/**'] }), deadlineMs: 60_000, label: 'create' });
    assert.equal(created.status, 0, created.stderr);
    // `--write --json` prints the plan (with ticketId) and then the applied result; the id is in the plan.
    const id = /"ticketId":\s*"(T-[0-9A-Z]{26})"/.exec(created.stdout)?.[1];
    assert.equal(typeof parseLastJson(created.stdout).applied, 'boolean', 'the last document is the applied result');
    assert.match(id, /^T-[0-9A-HJKMNP-TV-Z]{26}$/);
    git(r2.wt, ['add', '-A']); git(r2.wt, ['commit', '-q', '-m', 'ticket']);
    const show = async () => parseLastJson((await ctx.spawn({ argv: [shim, 'ticket', 'show', id, '--json', '--root', r2.wt], cwd: r2.wt, env: childEnv(ctx.env.base), deadlineMs: 60_000, label: 'show' })).stdout);
    const done = await completeTicket({ ctx, cwd: r2.wt, ticketId: id });
    assert.ok(done.head); assert.equal((await show()).ticket.completed, true);
    const reopened = await reopenTicket({ ctx, cwd: r2.wt, ticketId: id, round: 2 });
    assert.equal(reopened.reopened, true);
    assert.equal(ctx.recorder.filter((s) => s.argv[0] === shim && s.argv[2] === 'update').at(-1).result.status, 0, 'the authorized update exits 0');
    assert.equal((await show()).ticket.completed, false, 'completed:false after the reopen');
    assert.equal(git(r2.wt, ['log', '-1', '--format=%s']), `chore(ticket): reopen ${id} for retry round 2`);
    await completeTicket({ ctx, cwd: r2.wt, ticketId: id });
    await withMutation('review.reopenWithoutAuthorize', async () => {
      await assert.rejects(reopenTicket({ ctx, cwd: r2.wt, ticketId: id, round: 3 }), (e) => e.code === 'reopen-failed' && e.cliCode === 'AUTHORIZATION_REQUIRED');
      assert.equal(ctx.recorder.filter((s) => s.argv[0] === shim && s.argv[2] === 'update').at(-1).result.status, 2, 'without --authorize the real CLI exits 2');
      assert.equal((await show()).ticket.completed, true, 'nothing written');
    });
  } finally { r2.done(); cleanup(binDir); }
}
test('AC46: reopen-for-retry issues one adlc ticket update <ULID> --input - --expect <hash> --authorize --write with the FULL document (completed:false) on stdin, commits chore(ticket): reopen … before the next fleet call, is key-bearing; reopen-cli: the REAL binary exits 0 and completed:false, and without --authorize exits 2 AUTHORIZATION_REQUIRED', ac46_reopenForRetry);
