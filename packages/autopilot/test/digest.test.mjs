// AC 69 — the digest protocol: intent first (`digestPosted:false`), the
// sentinel is searched before posting, `digestPosted:true` only after gh
// confirms; a closed cached log issue is replaced; two open ones → the lowest
// + `digest-issue-ambiguous`.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { postDigest, locateLogIssue, runSentinel, LOG_LABEL } from '../lib/digest.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { buildCtx, scratch, cleanup, prOpenRecord, FAKE } from './helpers/review-ctx.mjs';

/** An in-memory GitHub: issues { number: { state } }, comments per issue, and an optional post-failure. */
function fakeGithub({ issues = {}, failAfterPost = 0 } = {}) {
  const state = { issues: { ...issues }, comments: {}, next: 100, failAfterPost, posts: 0, creates: 0 };
  const handler = (args, { stdin }) => {
    const [a, b] = args;
    if (a === 'issue' && b === 'list') {
      const open = Object.entries(state.issues).filter(([, v]) => v.state === 'OPEN' && v.labels?.includes(LOG_LABEL)).map(([n]) => ({ number: Number(n) }));
      return { stdout: JSON.stringify(open) };
    }
    if (a === 'issue' && b === 'view') { const n = Number(args[2]); const i = state.issues[n]; return i ? { stdout: JSON.stringify({ number: n, state: i.state }) } : { status: 1, stderr: 'not found' }; }
    if (a === 'issue' && b === 'create') { const n = state.next++; state.issues[n] = { state: 'OPEN', labels: [LOG_LABEL] }; state.creates++; return { stdout: `https://github.com/o/r/issues/${n}\n` }; }
    if (a === 'api' && /issues\/(\d+)\/comments/.test(args[1])) { const n = Number(/issues\/(\d+)\/comments/.exec(args[1])[1]); return { stdout: JSON.stringify((state.comments[n] ?? []).map((body) => ({ body }))) }; }
    if (a === 'issue' && b === 'comment') {
      const n = Number(args[2]); state.comments[n] ??= []; state.posts++;
      const sentinel = stdin.split('\n')[0];
      if (!state.comments[n].some((c) => c.startsWith(sentinel))) state.comments[n].push(stdin);
      if (state.failAfterPost > 0) { state.failAfterPost--; return { status: 1, stderr: 'connection reset after POST' }; }
      return { stdout: `https://github.com/o/r/issues/${n}#issuecomment-1\n` };
    }
    return { stdout: '{}' };
  };
  return { state, handler };
}

export async function ac69_digestProtocol() {
  const root = scratch('ap-digest');
  try {
    // (1) gh fails after the comment landed → intent stays false; next iteration finds the sentinel and posts nothing.
    const gh1 = fakeGithub({ issues: { 20: { state: 'OPEN', labels: [LOG_LABEL] } }, failAfterPost: 4 });
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.gh]: gh1.handler } });
    ctx.records.save(prOpenRecord({ issue: 7, extra: { runId: 'run-7-a', wallClockUsedMs: 120_000 } }));
    const r1 = await postDigest({ ctx, record: ctx.records.load(7), outcome: 'pr-open' });
    assert.equal(r1.ok, false, 'the failed gh call is reported');
    assert.equal(ctx.records.load(7).digestPosted, false, 'the intent is persisted BEFORE the post and left false on failure');
    assert.equal(ctx.records.load(7).digestRunId, 'run-7-a');
    assert.equal(gh1.state.comments[20].length, 1, 'the comment did land on GitHub');
    // A HARDCODED literal, never derived from the live runSentinel import — that binding is
    // exactly what a mutant changes, which would make a derived expectation blind to it
    // (2026-08-31 mutation-gate finding, same class as the LIFECYCLE_OBSERVED_STATES bug).
    assert.equal(runSentinel('run-7-a'), '<!-- adlc-autopilot:run run-7-a -->');
    assert.ok(gh1.state.comments[20][0].startsWith('<!-- adlc-autopilot:run run-7-a -->'), 'the comment starts with the run sentinel');
    assert.ok(gh1.state.comments[20][0].includes('issue #7') && gh1.state.comments[20][0].includes('rounds: 0'), 'digest body names issue, rounds');
    const postsBefore = gh1.state.posts;
    const r2 = await postDigest({ ctx, record: ctx.records.load(7), outcome: 'pr-open' });
    assert.equal(r2.ok, true); assert.equal(r2.posted, false, 'the sentinel was found → nothing posted');
    assert.equal(gh1.state.posts, postsBefore, 'zero comment posts on the second iteration');
    assert.equal(ctx.records.load(7).digestPosted, true, 'digestPosted:true only after gh confirms');
    assert.equal((await postDigest({ ctx, record: ctx.records.load(7), outcome: 'pr-open' })).reason, 'already-posted');
    // (2) a cached log issue that is CLOSED → a new issue is created and cached.
    const gh2 = fakeGithub({ issues: { 5: { state: 'CLOSED', labels: [LOG_LABEL] } } });
    const ctx2 = buildCtx({ repoRoot: scratch('ap-digest2'), handlers: { [FAKE.gh]: gh2.handler } });
    ctx2.status.write({ digestIssue: 5 });
    ctx2.records.save(prOpenRecord({ issue: 8, extra: { runId: 'run-8' } }));
    const r3 = await postDigest({ ctx: ctx2, record: ctx2.records.load(8), outcome: 'done' });
    assert.equal(r3.ok, true); assert.equal(r3.created, true); assert.equal(r3.logIssue, 100, 'a new log issue was created');
    assert.equal(gh2.state.creates, 1); assert.equal(ctx2.status.read().digestIssue, 100, 'the new number is cached');
    assert.equal(gh2.state.comments[100].length, 1); assert.equal(gh2.state.comments[5], undefined, 'the closed issue is never reopened or commented');
    cleanup(ctx2.repoRoot);
    // (3) two open log issues → the lowest is used and digest-issue-ambiguous is reported.
    const gh3 = fakeGithub({ issues: { 12: { state: 'OPEN', labels: [LOG_LABEL] }, 10: { state: 'OPEN', labels: [LOG_LABEL] } } });
    const ctx3 = buildCtx({ repoRoot: scratch('ap-digest3'), handlers: { [FAKE.gh]: gh3.handler } });
    const loc = await locateLogIssue({ ctx: ctx3 });
    assert.equal(loc.number, 10); assert.equal(loc.ambiguous, true); assert.deepEqual(loc.reported, ['digest-issue-ambiguous']);
    ctx3.records.save(prOpenRecord({ issue: 9, extra: { runId: 'run-9' } }));
    assert.equal(ctx3.status.read().digestIssue, 10, 'the located number is cached');
    ctx3.status.write({ digestIssue: null }); // a fresh process: the cache is empty and the label search reports the ambiguity again
    const r4 = await postDigest({ ctx: ctx3, record: ctx3.records.load(9), outcome: 'blocked' });
    assert.equal(r4.logIssue, 10); assert.deepEqual(r4.reported, ['digest-issue-ambiguous']); assert.equal(gh3.state.comments[12], undefined);
    cleanup(ctx3.repoRoot);
    // The seam the coverage gate injects: without the sentinel search the second iteration posts again.
    const gh4 = fakeGithub({ issues: { 20: { state: 'OPEN', labels: [LOG_LABEL] } }, failAfterPost: 4 });
    const ctx4 = buildCtx({ repoRoot: scratch('ap-digest4'), handlers: { [FAKE.gh]: gh4.handler } });
    ctx4.records.save(prOpenRecord({ issue: 7, extra: { runId: 'run-7-a' } }));
    await postDigest({ ctx: ctx4, record: ctx4.records.load(7), outcome: 'pr-open' });
    await withMutation('digest.skipSentinelSearch', async () => {
      const before = gh4.state.posts;
      await postDigest({ ctx: ctx4, record: ctx4.records.load(7), outcome: 'pr-open' });
      assert.equal(gh4.state.posts, before + 1, 'seam: a second post is attempted');
    });
    cleanup(ctx4.repoRoot);
  } finally { cleanup(root); }
}
test('AC69: a gh failure after the post leaves digestPosted:false and the next iteration finds the sentinel and posts nothing; a closed log issue is replaced and cached; two open → lowest + digest-issue-ambiguous', ac69_digestProtocol);

export async function ac69_digestSurvivesANullRecord() {
  // A run dropped before its record existed still gets a digest; nothing dereferences the missing record.
  const root = scratch('ap-digest-null');
  try {
    const gh = fakeGithub({ issues: { 20: { state: 'OPEN', labels: [LOG_LABEL] } } });
    const ctx = buildCtx({ repoRoot: root, handlers: { [FAKE.gh]: gh.handler } });
    const r = await postDigest({ ctx, record: null, issue: 7, outcome: { state: 'dropped', reason: 'revalidation-changed', detail: 'issue-updated' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.posted, true, 'the summary was posted');
    assert.ok(Object.values(gh.state.comments).flat().some((c) => /dropped/.test(c)), 'the digest names the outcome');
    assert.equal(ctx.records.load(7), null, 'no record was conjured');
  } finally { cleanup(root); }
}
test('AC69: the digest is posted for a run dropped BEFORE its record existed (null record) — the summary is never lost to a crash', ac69_digestSurvivesANullRecord);
