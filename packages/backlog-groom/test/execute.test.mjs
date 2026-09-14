// execute.test.mjs — comment-first, idempotent execution (spec §3.8): AC9, AC15.
//
// The two writes are not atomic, so most of what follows is about the state
// between them: a comment that landed and an action that did not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marker, parseMarker, planAction, executeActions } from '../lib/execute.mjs';

const approved = (over = {}) => ({
  number: 7,
  action: 'close',
  contentHash: 'abc123',
  evidence: 'every cited line is gone as of 1c0d5a7',
  gate: { verdict: 'approve' },
  ...over,
});

/** A writer that records calls and can be told to fail at a chosen step. */
function fakeGh({ failOn = null, existingComments = [] } = {}) {
  const calls = [];
  return {
    calls,
    comments: () => existingComments,
    comment: (number, body) => {
      calls.push(['comment', number, body]);
      if (failOn === 'comment') throw new Error('rate limited');
      return { ok: true };
    },
    apply: (number, action) => {
      calls.push(['apply', number, action]);
      if (failOn === 'apply') throw new Error('rate limited');
      return { ok: true };
    },
  };
}

// ---- the marker ------------------------------------------------------------

test('the marker names the issue and the revision it was written for', () => {
  const m = marker(7, 'abc123');
  assert.match(m, /backlog-groom/);
  assert.match(m, /7/);
  assert.match(m, /abc123/);
  assert.deepEqual(parseMarker(m), { number: 7, contentHash: 'abc123' });
});

test('a marker for a different revision does not match this one', () => {
  // The marker is per-(issue, revision), not per-issue. An issue re-groomed
  // after its code changed is a NEW decision and deserves its own comment.
  assert.notEqual(marker(7, 'abc123'), marker(7, 'def456'));
});

// ---- AC9: comment first, and a failed comment stops the action -------------

test('AC9: the comment carrying the evidence precedes the action', () => {
  const gh = fakeGh();
  executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
  assert.match(gh.calls[0][2], /every cited line is gone/);
});

test('AC9: an action whose comment write fails does not proceed', () => {
  // The trail must be on the issue BEFORE it goes quiet. If the trail could not
  // be written, the issue does not go quiet.
  const gh = fakeGh({ failOn: 'comment' });
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment']);
  assert.equal(result.executed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /rate limited/);
});

test('AC9: the comment body carries the marker', () => {
  const gh = fakeGh();
  executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.ok(gh.calls[0][2].includes(marker(7, 'abc123')));
});

// ---- AC7 boundary: only gate-approved actions reach the writer --------------

test('an action without an approve never reaches the writer', () => {
  const gh = fakeGh();
  const result = executeActions({
    actions: [approved({ gate: { verdict: 'demote', reason: 'the reviewer raised a material finding' } })],
    floor: [],
    baseFloor: [],
    gh,
  });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.executed.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

test('an action with a MISSING gate verdict is demoted, not assumed approved', () => {
  // Absence of a refusal is not an approval.
  const gh = fakeGh();
  const result = executeActions({ actions: [approved({ gate: undefined })], floor: [], baseFloor: [], gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

// ---- AC15: resume, do not re-comment ---------------------------------------

test('AC15: a re-run after comment-succeeded/action-failed resumes at the action', () => {
  // The exact interrupted state: the marker is already on the issue, the action
  // never landed. Re-commenting would stack a second identical rationale, and
  // every retry would add another.
  const gh = fakeGh({ existingComments: [`prior body\n${marker(7, 'abc123')}`] });
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['apply'], 'the comment must not be repeated');
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].resumed, true);
});

test('AC15: a marker for a DIFFERENT revision does not suppress the comment', () => {
  // Stale evidence from an older revision is not this decision's trail.
  const gh = fakeGh({ existingComments: [`older\n${marker(7, 'oldhash')}`] });
  executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
});

test('AC15: a mid-sweep failure leaves the remaining actions untouched and resumable', () => {
  // Not "half applied and compounded by a retry": the failure is recorded, the
  // run continues, and nothing about the failed action is left ambiguous.
  const gh = fakeGh({ failOn: 'apply' });
  const result = executeActions({
    actions: [approved(), approved({ number: 9, contentHash: 'zzz' })],
    floor: [],
    baseFloor: [],
    gh,
  });
  assert.equal(result.executed.length, 0);
  assert.equal(result.failed.length, 2);
  // Both got their comment first, so both are resumable at the action on a re-run.
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply', 'comment', 'apply']);
});

// ---- the floor is consulted before anything is written ---------------------

test('the floor blocks before the comment, not after it', () => {
  // A floored action must leave no trace at all: a "closing because…" comment on
  // an issue that will never be closed is worse than silence.
  const gh = fakeGh();
  const result = executeActions({ actions: [approved()], floor: ['close'], baseFloor: ['close'], gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'floor');
});

test('a widened floor refuses the whole run before any write', () => {
  // AC24's enforcement point: the run does not get to apply the first action and
  // discover the policy problem on the second.
  const gh = fakeGh();
  assert.throws(
    () => executeActions({ actions: [approved()], floor: [], baseFloor: ['close'], gh }),
    (err) => err.isOpError === true
  );
  assert.equal(gh.calls.length, 0);
});

// ---- planAction: the pure decision, testable without a writer ---------------

test('planAction is pure and explains every refusal', () => {
  assert.equal(planAction(approved(), { floor: [] }).do, true);
  assert.equal(planAction(approved(), { floor: ['close'] }).do, false);
  assert.equal(planAction(approved(), { floor: ['close'] }).reason, 'floor');
  assert.equal(planAction(approved({ gate: { verdict: 'demote' } }), { floor: [] }).reason, 'gate');
});
