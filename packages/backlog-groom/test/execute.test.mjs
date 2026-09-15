// execute.test.mjs — comment-first, idempotent execution (spec §3.8): AC9, AC15.
//
// The two writes are not atomic, so most of what follows is about the state
// between them: a comment that landed and an action that did not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marker, parseMarker, planAction, executeActions } from '../lib/execute.mjs';
import { gateKey } from '../lib/gate.mjs';

/** A ledger holding a real approve bound to this action's revision. */
function ledgerFor(action, verdict = 'approve') {
  return { [gateKey(action)]: { verdict, contentHash: action.contentHash, number: action.number, action: action.action } };
}

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

test('the marker names the issue, the action and the revision', () => {
  const m = marker(7, 'abc123', 'close');
  assert.match(m, /backlog-groom/);
  assert.match(m, /7/);
  assert.match(m, /abc123/);
  assert.deepEqual(parseMarker(m), { number: 7, action: 'close', contentHash: 'abc123' });
});

test('a close and a relabel on one issue and revision get DIFFERENT markers', () => {
  // Same reason the gate key carries the action: they are different decisions,
  // and a shared marker would let the first one's comment suppress the second
  // one's evidence.
  assert.notEqual(marker(7, 'abc123', 'close'), marker(7, 'abc123', 'relabel'));
});

test('a marker for a different revision does not match this one', () => {
  // The marker is per-(issue, revision), not per-issue. An issue re-groomed
  // after its code changed is a NEW decision and deserves its own comment.
  assert.notEqual(marker(7, 'abc123'), marker(7, 'def456'));
});

// ---- AC9: comment first, and a failed comment stops the action -------------

test('AC9: the comment carrying the evidence precedes the action', () => {
  const gh = fakeGh();
  executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
  assert.match(gh.calls[0][2], /every cited line is gone/);
});

test('AC9: an action whose comment write fails does not proceed', () => {
  // The trail must be on the issue BEFORE it goes quiet. If the trail could not
  // be written, the issue does not go quiet.
  const gh = fakeGh({ failOn: 'comment' });
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment']);
  assert.equal(result.executed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /rate limited/);
});

test('AC9: the comment body carries the marker', () => {
  const gh = fakeGh();
  executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh });
  assert.ok(gh.calls[0][2].includes(marker(7, 'abc123')));
});

// ---- AC7 boundary: only gate-approved actions reach the writer --------------

test('an action without an approve never reaches the writer', () => {
  const gh = fakeGh();
  const a = approved();
  const result = executeActions({ actions: [a], floor: [], baseFloor: [], ledger: ledgerFor(a, 'demote'), gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.executed.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

test('an action with a MISSING gate verdict is demoted, not assumed approved', () => {
  // Absence of a refusal is not an approval.
  const gh = fakeGh();
  const result = executeActions({ actions: [approved({ gate: undefined })], floor: [], baseFloor: [], ledger: {}, gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

// ---- AC15: resume, do not re-comment ---------------------------------------

test('AC15: a re-run after comment-succeeded/action-failed resumes at the action', () => {
  // The exact interrupted state: the marker is already on the issue, the action
  // never landed. Re-commenting would stack a second identical rationale, and
  // every retry would add another.
  const gh = fakeGh({ existingComments: [{ body: `prior body\n${marker(7, 'abc123')}`, author: 'me' }] });
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh, self: 'me' });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['apply'], 'the comment must not be repeated');
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].resumed, true);
});

test('AC15: a marker for a DIFFERENT revision does not suppress the comment', () => {
  // Stale evidence from an older revision is not this decision's trail.
  const gh = fakeGh({ existingComments: [{ body: `older\n${marker(7, 'oldhash')}`, author: 'me' }] });
  executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh, self: 'me' });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
});

test('AC15: a mid-sweep failure leaves the remaining actions untouched and resumable', () => {
  // Not "half applied and compounded by a retry": the failure is recorded, the
  // run continues, and nothing about the failed action is left ambiguous.
  const gh = fakeGh({ failOn: 'apply' });
  const a = approved();
  const b = approved({ number: 9, contentHash: 'zzz' });
  const result = executeActions({ actions: [a, b], floor: [], baseFloor: [], ledger: { ...ledgerFor(a), ...ledgerFor(b) }, gh });
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
  const result = executeActions({ actions: [approved()], floor: ['close'], baseFloor: ['close'], ledger: ledgerFor(approved()), gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'floor');
});

test('a widened floor refuses the whole run before any write', () => {
  // AC24's enforcement point: the run does not get to apply the first action and
  // discover the policy problem on the second.
  const gh = fakeGh();
  assert.throws(
    () => executeActions({ actions: [approved()], floor: [], baseFloor: ['close'], ledger: ledgerFor(approved()), gh }),
    (err) => err.isOpError === true
  );
  assert.equal(gh.calls.length, 0);
});

// ---- planAction: the pure decision, testable without a writer ---------------

test('planAction is pure and explains every refusal', () => {
  const a = approved();
  assert.equal(planAction(a, { floor: [], ledger: ledgerFor(a) }).do, true);
  assert.equal(planAction(a, { floor: ['close'], ledger: ledgerFor(a) }).do, false);
  assert.equal(planAction(a, { floor: ['close'], ledger: ledgerFor(a) }).reason, 'floor');
  assert.equal(planAction(a, { floor: [], ledger: ledgerFor(a, 'demote') }).reason, 'gate');
});

// ---- the ledger is the authority, not the caller's claim -------------------

test('a FORGED approval on the action is refused — the ledger decides', () => {
  // The whole gate sits behind this. A library caller can construct
  // `gate: { verdict: 'approve' }` trivially; if that were authorization, the
  // reviewer could be skipped entirely by anyone importing the module.
  const gh = fakeGh();
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: {}, gh });
  assert.equal(gh.calls.length, 0, 'a forged approval must not reach the writer');
  assert.equal(result.demoted[0].reason, 'gate');
});

test('an approval bound to a DIFFERENT revision does not license this one', () => {
  const gh = fakeGh();
  const a = approved();
  const stale = { [gateKey(a)]: { verdict: 'approve', contentHash: 'someotherhash', number: a.number, action: a.action } };
  const result = executeActions({ actions: [a], floor: [], baseFloor: [], ledger: stale, gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

test('an approval bound to a DIFFERENT issue does not license this one', () => {
  // A ledger edited to move an approval between issues must not pass.
  const gh = fakeGh();
  const a = approved();
  const moved = { [gateKey(a)]: { verdict: 'approve', contentHash: a.contentHash, number: 999, action: a.action } };
  const result = executeActions({ actions: [a], floor: [], baseFloor: [], ledger: moved, gh });
  assert.equal(gh.calls.length, 0);
});

test('no ledger at all means no authorization', () => {
  const gh = fakeGh();
  const result = executeActions({ actions: [approved()], floor: [], baseFloor: [], gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.demoted[0].reason, 'gate');
});

// ---- the marker is forgeable, so authorship decides ------------------------

test('a marker posted by SOMEONE ELSE does not suppress the evidence comment', () => {
  // The marker is derived from the issue number and a content hash, both of
  // which anyone can compute. If a third party's comment counted, anyone could
  // silence the trail and let the tool act unexplained.
  const gh = fakeGh({ existingComments: [{ body: `nice try\n${marker(7, 'abc123')}`, author: 'someone-else' }] });
  executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh, self: 'me' });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply'], 'the trail must be written');
});

test('with an UNKNOWN identity no comment counts as ours', () => {
  // Fail toward writing the evidence again. A duplicate rationale is noise; a
  // missing one is an issue that went quiet with no explanation.
  const gh = fakeGh({ existingComments: [{ body: marker(7, 'abc123'), author: 'me' }] });
  executeActions({ actions: [approved()], floor: [], baseFloor: [], ledger: ledgerFor(approved()), gh, self: null });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
});

// ---- a completed action is not repeated ------------------------------------

test('an action already marked applied is not performed again', () => {
  // The crash window: the action landed, the ledger write did not. A retry must
  // not close an issue twice or re-comment on it.
  const gh = fakeGh();
  const a = approved();
  const ledger = ledgerFor(a);
  ledger[gateKey(a)].applied = true;
  const result = executeActions({ actions: [a], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.executed[0].alreadyApplied, true);
});

test('a successful action is marked applied so the next run skips it', () => {
  const gh = fakeGh();
  const a = approved();
  const ledger = ledgerFor(a);
  executeActions({ actions: [a], floor: [], baseFloor: [], ledger, gh, self: 'me' });
  assert.equal(ledger[gateKey(a)].applied, true);
});

test('a failed applied-checkpoint stops the run rather than continuing', () => {
  // The action landed on GitHub. If the ledger cannot record that, the next run
  // will repeat it — and continuing to further actions would compound the
  // problem across several issues rather than one.
  const gh = fakeGh();
  const a = approved();
  const b = approved({ number: 9, contentHash: 'zzz' });
  const ledger = { ...ledgerFor(a), ...ledgerFor(b) };
  assert.throws(
    () =>
      executeActions({
        actions: [a, b],
        floor: [],
        baseFloor: [],
        ledger,
        gh,
        self: 'me',
        onApplied: () => { throw new Error('EACCES'); },
      }),
    (err) => err.isOpError === true
  );
  // Only the first action was attempted; the second never reached the writer.
  assert.equal(gh.calls.filter((c) => c[0] === 'apply').length, 1);
});

test('an issue that changed between validation and the write is not actioned', () => {
  // The TOCTOU window: a long review or a slow sweep leaves time for the issue
  // to be edited, fixed by someone else, or closed. The last thing before the
  // mutation is a fresh look rather than a memory of one.
  const gh = fakeGh();
  const a = approved();
  const result = executeActions({
    actions: [a],
    floor: [],
    baseFloor: [],
    ledger: ledgerFor(a),
    gh,
    self: 'me',
    recheck: () => ({ ok: false, reason: 'issue #7 changed since the set was generated' }),
  });
  assert.equal(gh.calls.length, 0, 'nothing may be written once the facts have moved');
  assert.equal(result.demoted[0].reason, 'changed');
});

test('a passing recheck lets the action through', () => {
  const gh = fakeGh();
  const a = approved();
  executeActions({ actions: [a], floor: [], baseFloor: [], ledger: ledgerFor(a), gh, self: 'me', recheck: () => ({ ok: true }) });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
});
