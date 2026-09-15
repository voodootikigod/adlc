// floor.test.mjs — the autonomy floor (spec §3.7): AC5, AC6, AC18, AC24.
//
// The floor is the last thing standing between a reviewer's approve and a
// closed issue, so these tests care less about the happy path than about the
// ways the floor can be made to disappear: a typo, an omitted key, a widened
// working copy, or a new entry point that forgot to ask.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_CLASSES,
  DEFAULT_AUTONOMY_FLOOR,
  assertFloor,
  floorWidening,
  assertFloorNotWidened,
  blockedByFloor,
  frozenPathsRemoved,
  assertFrozenPathsNotNarrowed,
} from '../lib/floor.mjs';
import { DEFAULT_PROFILE } from '../lib/profile.mjs';

/** Capture a thrown error — `assert.throws` returns undefined, not the error. */
function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}


// ---- AC5: defaults, unknown classes, and the explicit empty floor -----------

test('AC5: an omitted autonomyFloor yields the conservative default', () => {
  // The profile parser owns the defaulting; the floor owns what the value means.
  // Asserting against DEFAULT_PROFILE rather than a literal keeps the two from
  // drifting into disagreement about what "omitted" produces.
  assert.deepEqual(DEFAULT_PROFILE.autonomyFloor, ['close']);
  assert.deepEqual(DEFAULT_AUTONOMY_FLOOR, ['close']);
  assert.deepEqual(assertFloor(DEFAULT_PROFILE.autonomyFloor), ['close']);
});

test('AC5: an unknown class is an operational error naming the class', () => {
  // The whole point of failing closed: "clsoe" must not quietly leave closing
  // unguarded. The message has to name the offender or the operator is hunting
  // a typo in a file that looks right.
  const err = thrown(() => assertFloor(['clsoe']));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /clsoe/);
  for (const known of ACTION_CLASSES) assert.match(err.message, new RegExp(known));
});

test('AC5: an explicitly empty floor is accepted', () => {
  // Legal, but only when written deliberately — which is exactly why the parser
  // defaults an OMITTED key instead of letting absence mean "[]".
  assert.deepEqual(assertFloor([]), []);
});

test('AC5: a non-array floor is an operational error, not a coerced one', () => {
  for (const bad of ['close', null, 7, {}]) {
    const err = thrown(() => assertFloor(bad));
    assert.equal(err.isOpError, true);
  }
});

test('AC5: duplicate classes are rejected rather than silently deduped', () => {
  // A floor listing "close" twice is a file someone edited without reading. It
  // is harmless to dedupe and harmful to hide: the same carelessness produces
  // the typo case above, which is not harmless.
  const err = thrown(() => assertFloor(['close', 'close']));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /close/);
});

test('the action-class set is pinned — dropping one silently unguards it', () => {
  // ACTION_CLASSES is the universe blockedByFloor fails closed against, so a
  // class quietly removed from it stops being blockable AND stops being a
  // recognised action at all. Pinned exactly, not by length.
  assert.deepEqual([...ACTION_CLASSES], ['close', 'relabel', 'duplicate-link', 'comment']);
});

test('every pinned class is actually blockable', () => {
  for (const cls of ACTION_CLASSES) assert.equal(blockedByFloor(cls, [cls]), true);
});

// ---- blockedByFloor: the actual decision -----------------------------------

test('a class on the floor blocks its action regardless of any approval', () => {
  assert.equal(blockedByFloor('close', ['close']), true);
  assert.equal(blockedByFloor('relabel', ['close']), false);
});

test('an unknown action class is blocked, never allowed through', () => {
  // Fail closed on the QUERY as well as on the config. An action class the floor
  // has never heard of is not "not on the floor" — it is unrecognised, and
  // treating unrecognised as permitted is how a new action ships unguarded.
  assert.equal(blockedByFloor('deploy', []), true);
  assert.equal(blockedByFloor(undefined, []), true);
});

// ---- AC18 / AC24: widening is privileged, and measured against the base -----

test('AC18: narrowing the floor is an ordinary change', () => {
  // base allows relabel; head adds it to the floor. More restrictive: fine.
  assert.deepEqual(floorWidening(['close'], ['close', 'relabel']), []);
  assert.doesNotThrow(() => assertFloorNotWidened({ base: ['close'], head: ['close', 'relabel'] }));
});

test('AC18: an identical floor is not a widening', () => {
  assert.deepEqual(floorWidening(['close'], ['close']), []);
});

test('AC18: removing a class is a widening and is refused without authorization', () => {
  assert.deepEqual(floorWidening(['close', 'relabel'], ['close']), ['relabel']);
  const err = thrown(() => assertFloorNotWidened({ base: ['close', 'relabel'], head: ['close'] }));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /relabel/);
});

test('AC18: emptying the floor is a widening and is refused', () => {
  assert.deepEqual(floorWidening(['close'], []), ['close']);
  const err = thrown(() => assertFloorNotWidened({ base: ['close'], head: [] }));
  assert.equal(err.isOpError, true);
});

test('AC18: an explicit authorization permits the widening', () => {
  assert.doesNotThrow(() => assertFloorNotWidened({ base: ['close'], head: [], authorized: true }));
});

test('AC24: the comparison is against the merge base, not the working copy', () => {
  // The working copy is exactly what someone widening the floor controls, so a
  // check that reads only the working copy validates the attacker's own claim.
  // Here the working copy says "[] is fine" and the base says otherwise; the
  // base wins.
  const err = thrown(() =>
    assertFloorNotWidened({ base: ['close', 'comment'], head: [], authorized: false })
  );
  assert.ok(err, 'expected an operational error');
  assert.equal(err.isOpError, true);
  assert.match(err.message, /close/);
  assert.match(err.message, /comment/);
});

test('AC24: an unreadable merge-base floor fails closed, it does not assume empty', () => {
  // If the base floor cannot be read, the tool cannot know whether the head
  // floor is a widening. Treating "unknown" as "nothing was there" would make
  // deleting the profile at the base the easiest possible widening.
  const err = thrown(() => assertFloorNotWidened({ base: null, head: ['close'] }));
  assert.equal(err.isOpError, true);
  assert.match(err.message, /merge base/i);
});

// ---- AC6: one validator, structurally, not by enumerating today's callers ---

test('AC6: every write entry point is declared and routes through the guard', async () => {
  // The weak form of this criterion enumerates the two entry points that exist
  // today, which says nothing about the third one someone adds next year. The
  // structural form: every exported FUNCTION of the execute module must be
  // classified, either as a guarded entry point or as a declared pure helper.
  // A new export that is neither fails here, which is the only version of this
  // check that keeps working after the author who wrote it has moved on.
  const execute = await import('../lib/execute.mjs');
  const exportedFns = Object.entries(execute)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k);

  const declared = new Set([...execute.WRITE_ENTRY_POINTS, ...execute.PURE_HELPERS]);
  for (const name of exportedFns) {
    assert.ok(
      declared.has(name),
      `${name} is exported from execute.mjs but is neither a declared write entry point nor a declared pure helper — classify it`
    );
  }
  assert.ok(execute.WRITE_ENTRY_POINTS.length > 0, 'there must be at least one declared write entry point');
});

test('AC6: a declared write entry point refuses a floored action', async () => {
  const { executeActions, WRITE_ENTRY_POINTS } = await import('../lib/execute.mjs');
  assert.ok(WRITE_ENTRY_POINTS.includes('executeActions'));

  const writes = [];
  const gh = { comment: (...a) => writes.push(['comment', ...a]), apply: (...a) => writes.push(['apply', ...a]) };
  const result = executeActions({
    actions: [{ number: 1, action: 'close', contentHash: 'h', evidence: 'e', gate: { verdict: 'approve' } }],
    floor: ['close'],
    baseFloor: ['close'],
    gh,
  });

  assert.equal(writes.length, 0, 'a floored action must not reach the writer at all');
  assert.equal(result.executed.length, 0);
  assert.equal(result.demoted[0].reason, 'floor');
});

// ---- frozenPaths gets the same asymmetry as the floor -----------------------

test('unfreezing a path is a widening and is refused', () => {
  // Guarding the floor while leaving frozenPaths editable just moves the
  // escalation one key down the same file.
  assert.deepEqual(frozenPathsRemoved(['a/**', 'b/**'], ['a/**']), ['b/**']);
  const err = thrown(() => assertFrozenPathsNotNarrowed({ base: ['a/**', 'b/**'], head: ['a/**'] }));
  assert.ok(err);
  assert.equal(err.isOpError, true);
  assert.match(err.message, /b\/\*\*/);
});

test('freezing MORE paths is an ordinary change', () => {
  assert.deepEqual(frozenPathsRemoved(['a/**'], ['a/**', 'b/**']), []);
  assert.doesNotThrow(() => assertFrozenPathsNotNarrowed({ base: ['a/**'], head: ['a/**', 'b/**'] }));
});

test('an explicit authorization permits unfreezing', () => {
  assert.doesNotThrow(() => assertFrozenPathsNotNarrowed({ base: ['a/**'], head: [], authorized: true }));
});

test('an unreadable base frozenPaths fails closed', () => {
  const err = thrown(() => assertFrozenPathsNotNarrowed({ base: null, head: [] }));
  assert.ok(err);
  assert.equal(err.isOpError, true);
});
