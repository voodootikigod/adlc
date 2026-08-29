// Ticket AC6 / spec AC 4 — terminal label + comment effects: the durable intent
// is written BEFORE either effect, each effect is reconciled INDEPENDENTLY
// against GitHub (comment by sentinel, label read from the target), a gh fake
// failing between comment and label leaves exactly one missing effect that the
// next iteration replays without duplicating anything, and a redaction failure
// withholds the body but still applies the label. Table-driven over the six
// outcomes (clarify, blocked, stale, ci-red, oid-mismatch, pr-closed).

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { applyTerminalEffects, reconcilePendingEffects, pendingEffects, TERMINAL_OUTCOMES } from '../lib/effects.mjs';
import { createRedactor, WITHHELD_BODY } from '../lib/redact.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { makeTriageCtx } from './helpers/triage-ctx.mjs';

const TABLE = [
  { outcome: 'clarify', kind: 'issue', number: 7, state: 'clarify', label: 'adlc:needs-clarification' },
  { outcome: 'blocked', kind: 'issue', number: 7, state: 'blocked', label: 'adlc:autopilot-blocked' },
  { outcome: 'stale', kind: 'pr', number: 9, state: 'stale', label: 'adlc:autopilot-stale' },
  { outcome: 'ci-red', kind: 'pr', number: 9, state: 'ci-red', label: 'adlc:autopilot-ci-red' },
  { outcome: 'oid-mismatch', kind: 'pr', number: 9, state: 'oid-mismatch', label: 'adlc:autopilot-blocked' },
  { outcome: 'pr-closed', kind: 'issue', number: 7, state: 'done', label: 'adlc:autopilot-skip' },
];
const sentinelOf = (row) => `<!-- adlc-autopilot:${row.outcome} ${'c'.repeat(64)} -->`;
const harness = () => makeTriageCtx({ issues: [{ number: 7, title: 't', body: 'b' }], prs: [{ number: 9, title: 'p', body: 'pb' }] });
const targetOf = (h, row) => (row.kind === 'pr' ? h.gh.pr(row.number) : h.gh.issue(row.number));
const isLabelCall = (a) => a[1] === 'edit' && a.includes('--add-label');
const isCommentCall = (a) => a[1] === 'comment';

export async function ac4_terminalEffectsReconcileIndependently() {
  assert.deepEqual(TABLE.map((r) => r.outcome), [...TERMINAL_OUTCOMES], 'the table covers every terminal outcome exactly once');
  for (const row of TABLE) {
    const h = harness();
    try {
      const { ctx, gh } = h;
      const sentinel = sentinelOf(row);
      ctx.records.save({ issue: 7, state: row.state, effects: {} });
      const args = { ctx, outcome: row.outcome, target: { kind: row.kind, number: row.number }, sentinel, body: `reason: ${row.outcome}`, label: row.label };
      // Pass 1: gh fails AFTER the comment and BEFORE the label.
      gh.failWhen(isLabelCall);
      const r1 = await applyTerminalEffects({ ...args, record: ctx.records.load(7) });
      assert.equal(r1.commentPosted, true, row.outcome); assert.equal(r1.labelApplied, false, row.outcome); assert.equal(r1.ok, false);
      assert.equal(r1.error?.label?.code, 'gh-failed', `${row.outcome}: the label failure is reported`);
      const rec = ctx.records.load(7);
      assert.deepEqual({ s: rec.effects[row.outcome].commentSentinel, c: rec.effects[row.outcome].commentPosted, l: rec.effects[row.outcome].labelApplied }, { s: sentinel, c: true, l: false }, `${row.outcome}: the record shows commentPosted:true, labelApplied:false`);
      const t = targetOf(h, row);
      assert.equal(t.comments.filter((c) => c.body.includes(sentinel)).length, 1, `${row.outcome}: one comment carries the sentinel`);
      assert.ok(!t.labels.includes(row.label), `${row.outcome}: the label is absent`);
      assert.deepEqual(pendingEffects(rec).map((p) => p.outcome), [row.outcome]);
      // Pass 2 (next iteration): only the missing effect is replayed.
      gh.clearFail(); gh.resetCounters();
      const r2 = await reconcilePendingEffects(ctx, rec);
      assert.equal(r2.complete, true, `${row.outcome}: reconciliation completes`);
      assert.equal(gh.mutations.filter(isLabelCall).length, 1, `${row.outcome}: exactly one --add-label call`);
      assert.equal(gh.mutations.filter(isCommentCall).length, 0, `${row.outcome}: zero comment calls on replay`);
      assert.equal(t.comments.filter((c) => c.body.includes(sentinel)).length, 1, `${row.outcome}: the comment is not duplicated`);
      assert.ok(t.labels.includes(row.label));
      const done = ctx.records.load(7);
      assert.equal(done.effects[row.outcome].labelApplied, true); assert.equal(done.effects[row.outcome].commentPosted, true);
      assert.deepEqual(pendingEffects(done), []);
      // Pass 3: both effects observed on GitHub → zero mutating calls, from the record AND from a fresh intent.
      gh.resetCounters();
      await reconcilePendingEffects(ctx, done);
      const r3 = await applyTerminalEffects({ ...args, record: { issue: 7, state: row.state, effects: {} } });
      assert.equal(r3.ok, true); assert.equal(gh.mutations.length, 0, `${row.outcome}: zero mutating calls when both effects already exist`);
    } finally { h.cleanup(); }
  }
}
test('AC4: for every terminal outcome a gh fake failing between comment and label leaves commentPosted:true/labelApplied:false in the record, the next iteration replays exactly the label, nothing is duplicated', ac4_terminalEffectsReconcileIndependently);

export async function ac4_intentPersistedBeforeEffects() {
  for (const row of TABLE) {
    const h = harness();
    try {
      const { ctx, gh } = h;
      const sentinel = sentinelOf(row);
      ctx.records.save({ issue: 7, state: row.state, effects: {} });
      // The COMMENT fails: the intent must already be durable and the label is still reconciled independently.
      gh.failWhen(isCommentCall);
      const r = await applyTerminalEffects({ ctx, record: ctx.records.load(7), outcome: row.outcome, target: { kind: row.kind, number: row.number }, sentinel, body: 'x', label: row.label });
      assert.equal(r.commentPosted, false, row.outcome); assert.equal(r.labelApplied, true, `${row.outcome}: a comment failure does not block the label`);
      const rec = ctx.records.load(7);
      assert.deepEqual({ s: rec.effects[row.outcome].commentSentinel, c: rec.effects[row.outcome].commentPosted, l: rec.effects[row.outcome].labelApplied }, { s: sentinel, c: false, l: true });
      assert.equal(targetOf(h, row).comments.length, 0);
      gh.clearFail(); gh.resetCounters();
      const r2 = await reconcilePendingEffects(ctx, rec);
      assert.equal(r2.complete, true);
      assert.equal(gh.mutations.filter(isCommentCall).length, 1, `${row.outcome}: exactly one comment on replay`);
      assert.equal(gh.mutations.filter(isLabelCall).length, 0, `${row.outcome}: the label is not re-added`);
    } finally { h.cleanup(); }
  }
  // The seam: with `effects.skipIntent` nothing durable exists after the failure.
  const h = harness();
  try {
    h.gh.failWhen(isLabelCall);
    h.ctx.records.save({ issue: 7, state: 'blocked', effects: {} });
    await withMutation('effects.skipIntent', () => applyTerminalEffects({ ctx: h.ctx, record: h.ctx.records.load(7), outcome: 'blocked', target: { kind: 'issue', number: 7 }, sentinel: sentinelOf(TABLE[1]), body: 'x', label: 'adlc:autopilot-blocked' }));
    assert.equal(h.ctx.records.load(7).effects.blocked, undefined, 'mutation fixture: no intent survives the crash');
  } finally { h.cleanup(); }
}
test('AC4: the intent {commentSentinel, commentPosted:false, labelApplied:false} is durable before either effect; a failing comment still applies the label and only the comment is replayed', ac4_intentPersistedBeforeEffects);

export async function ac4_redactionFailureWithholdsBodyKeepsLabel() {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8S9t0';
  const leaky = createRedactor({ impl: (t) => t }); // residual match → fail closed
  const h = makeTriageCtx({ issues: [{ number: 7, title: 't', body: 'b' }], redactor: leaky });
  try {
    const { ctx, gh } = h;
    ctx.records.save({ issue: 7, state: 'blocked', effects: {} });
    const r = await applyTerminalEffects({ ctx, record: ctx.records.load(7), outcome: 'blocked', target: { kind: 'issue', number: 7 }, sentinel: sentinelOf(TABLE[1]), body: `findings mention ${token}`, label: 'adlc:autopilot-blocked' });
    assert.equal(r.ok, true);
    const posted = gh.issue(7).comments[0].body;
    assert.ok(posted.includes(WITHHELD_BODY), 'the body is the withheld sentinel');
    assert.ok(!posted.includes(token), 'the secret never leaves the process');
    assert.ok(gh.issue(7).labels.includes('adlc:autopilot-blocked'), 'the label is still applied');
    assert.ok(!JSON.stringify(ctx.records.load(7)).includes(token), 'the record never stores the raw body');
    assert.equal(ctx.records.load(7).effects.blocked.redactionFailed, true);
  } finally { h.cleanup(); }
}
test('AC4: a redaction failure posts only the withheld-body sentinel, keeps the secret out of the record, and still applies the label', ac4_redactionFailureWithholdsBodyKeepsLabel);

export async function ac4_labelOnGithubAbsentFromRecord() {
  const h = harness();
  try {
    const { ctx, gh } = h;
    gh.issue(7).labels.push('adlc:autopilot-blocked');
    gh.issue(7).comments.push({ body: `${sentinelOf(TABLE[1])}\nold` });
    ctx.records.save({ issue: 7, state: 'blocked', effects: {} });
    const r = await applyTerminalEffects({ ctx, record: ctx.records.load(7), outcome: 'blocked', target: { kind: 'issue', number: 7 }, sentinel: sentinelOf(TABLE[1]), body: 'x', label: 'adlc:autopilot-blocked' });
    assert.equal(r.ok, true);
    assert.equal(gh.mutations.filter(isLabelCall).length, 0, 'zero --add-label calls: GitHub, not the record, is consulted');
    assert.equal(gh.mutations.filter(isCommentCall).length, 0, 'zero comment calls');
    assert.equal(ctx.records.load(7).effects.blocked.labelApplied, true, 'the record catches up with GitHub');
    // The seam: trusting the record re-applies the label GitHub already shows.
    gh.resetCounters();
    await withMutation('effects.trustRecord', () => applyTerminalEffects({ ctx, record: { issue: 7, state: 'blocked', effects: {} }, outcome: 'blocked', target: { kind: 'issue', number: 7 }, sentinel: sentinelOf(TABLE[1]), body: 'x', label: 'adlc:autopilot-blocked' }));
    assert.equal(gh.mutations.filter(isLabelCall).length, 1, 'mutation fixture: the record-trusting variant mutates');
  } finally { h.cleanup(); }
}
test('AC4: a label already present on GitHub but absent from the record yields zero --add-label calls', ac4_labelOnGithubAbsentFromRecord);
