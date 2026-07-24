// RAIL (t-herdr-7): the executable contract for board row-actions — pure
// selection navigation, row-action resolution, the fixed focus argv, and the
// render highlight. bin/board.mjs stays thin glue over these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSelection, resolveRowAction, focusPaneArgs } from '../lib/board-nav.mjs';
import { renderBoard } from '../lib/board-render.mjs';

// ---- AC1/AC2 selection navigation ----

test('AC1 stepSelection moves within bounds and clamps at both ends', () => {
  assert.equal(stepSelection(0, 'down', 3), 1);
  assert.equal(stepSelection(2, 'up', 3), 1);
  assert.equal(stepSelection(0, 'up', 3), 0);   // clamp at top
  assert.equal(stepSelection(2, 'down', 3), 2); // clamp at bottom
});

test('AC2 stepSelection with no rows returns -1 (nothing selectable), never a valid index', () => {
  assert.equal(stepSelection(0, 'down', 0), -1);
  assert.equal(stepSelection(-1, 'up', 0), -1);
});

test('stepSelection with exactly one row keeps that row selectable (rowCount boundary)', () => {
  // Pins the `rowCount <= 0` guard: with a single row, up/down both stay on 0
  // (a `<= 1` off-by-one would wrongly report nothing selectable).
  assert.equal(stepSelection(0, 'down', 1), 0);
  assert.equal(stepSelection(0, 'up', 1), 0);
});

// ---- AC3/AC4 row-action resolution ----

test('AC3 resolveRowAction returns focus-pane + the mapped paneId', () => {
  const paneRows = [{ paneId: 'w1:p2', ticket: 't-a' }, { paneId: 'w1:p3', ticket: 't-b' }];
  assert.deepEqual(resolveRowAction({ id: 't-b' }, paneRows), { kind: 'focus-pane', paneId: 'w1:p3' });
});

test('AC4 resolveRowAction returns none when the ticket has no mapped pane (nothing to focus)', () => {
  assert.equal(resolveRowAction({ id: 't-x' }, [{ paneId: 'w1:p2', ticket: 't-a' }]).kind, 'none');
  assert.equal(resolveRowAction(null, []).kind, 'none');
});

// ---- AC5 fixed focus argv ----

test('AC5 focusPaneArgs builds exactly the fixed herdr focus argv', () => {
  assert.deepEqual(focusPaneArgs('w1:p2'), ['pane', 'focus', 'w1:p2']);
});

// ---- AC6 render highlight ----

test('AC6 renderBoard marks ONLY the selected ticket row', () => {
  const groups = { ready: [{ id: 't-a', title: 'A' }, { id: 't-b', title: 'B' }], inFlight: [{ id: 't-c', title: 'C' }], blocked: [] };
  const marked = (sel) => renderBoard({ width: 80, repoRoot: '/r', groups, paneRows: [], ledger: [], selected: sel })
    .split('\n').filter((l) => l.includes('> t-'));
  // flat index 1 == the second ready ticket, t-b
  const one = marked(1);
  assert.equal(one.length, 1, 'exactly one row marked');
  assert.ok(one[0].includes('t-b'), 'the marked row is the selected (flat index 1) ticket');
  // flat index 2 crosses into the in-flight section == t-c
  assert.ok(marked(2)[0].includes('t-c'), 'selection indexes the FLAT ticket list across sections');
  // nothing selectable → no marker
  assert.equal(marked(-1).length, 0);
});
