// The executable command sequence (spec AC 30, plus the sequence halves of
// AC 36, 38, 46, 82, 108, 144): one `runIssue` against a REAL temporary
// repository with a bare origin, fake tools on the pinned paths that record
// argv and create the files the real tools would, and assertions on the
// repository, the origin and the recorded argv — never on module internals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
