// RAIL (t-herdr-7): the executable contract for board row-actions — pure
// selection navigation, row-action resolution, the fixed focus argv, and the
// render highlight. bin/board.mjs stays thin glue over these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepSelection, resolveRowAction, focusPaneArgs, indexOfTicket,
  flattenGroups, nextSelectedId, focusCommandFor, focusSelected, classifyKey, redrawBoard,
} from '../lib/board-nav.mjs';
import { renderBoard, boardFooter } from '../lib/board-render.mjs';

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

test('resolveRowAction refuses a pane id that fails validation (leading-hyphen guard)', () => {
  assert.equal(resolveRowAction({ id: 't-a' }, [{ paneId: '-x', ticket: 't-a' }]).kind, 'none');
});

test('indexOfTicket re-derives the selection index from a stable ticket id', () => {
  const rows = [{ id: 't-a' }, { id: 't-b' }, { id: 't-c' }];
  assert.equal(indexOfTicket(rows, 't-b'), 1);
  assert.equal(indexOfTicket(rows, 'gone'), -1); // removed by a refresh → caller snaps
  assert.equal(indexOfTicket(null, 't-a'), -1);
});

// ---- extracted glue decisions (thin-glue discipline: bin/board.mjs only wires) ----

test('flattenGroups concatenates ready, then in-flight, then blocked (renderBoard order)', () => {
  const groups = { ready: [{ id: 'a' }], inFlight: [{ id: 'b' }], blocked: [{ id: 'c' }] };
  assert.deepEqual(flattenGroups(groups).map((t) => t.id), ['a', 'b', 'c']);
  assert.deepEqual(flattenGroups(undefined), []);
});

test('nextSelectedId steps by stable id, clamps, and snaps a removed selection', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextSelectedId(null, 'down', rows), 'a');    // from nothing → first
  assert.equal(nextSelectedId('a', 'down', rows), 'b');
  assert.equal(nextSelectedId('c', 'down', rows), 'c');     // clamp at end
  assert.equal(nextSelectedId('a', 'up', rows), 'a');       // clamp at top
  assert.equal(nextSelectedId('gone', 'down', rows), 'a');  // vanished on refresh → snap to first
  assert.equal(nextSelectedId('a', 'down', []), null);      // nothing selectable
});

test('focusCommandFor returns the fixed focus argv, or null when nothing to focus', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  const paneRows = [{ paneId: 'w1:p2', ticket: 'b' }];
  assert.deepEqual(focusCommandFor('b', rows, paneRows), ['pane', 'focus', '--pane', 'w1:p2']);
  assert.equal(focusCommandFor('a', rows, paneRows), null); // ticket with no mapped pane
  assert.equal(focusCommandFor(null, rows, paneRows), null); // nothing selected
});

test('focusSelected invokes run with the focus argv ONLY when a pane exists', () => {
  const groups = { ready: [{ id: 'a' }, { id: 'b' }], inFlight: [], blocked: [] };
  const paneRows = [{ paneId: 'w1:p2', ticket: 'b' }];
  const calls = [];
  const run = (argv) => calls.push(argv);
  focusSelected({ selectedId: 'b', groups, paneRows, run });
  assert.deepEqual(calls, [['pane', 'focus', '--pane', 'w1:p2']]);
  focusSelected({ selectedId: 'a', groups, paneRows, run }); // ticket 'a' has no mapped pane
  assert.equal(calls.length, 1, 'nothing is run when there is no pane to focus');
});

test('classifyKey routes each key to its board command', () => {
  assert.equal(classifyKey('q', {}), 'quit');
  assert.equal(classifyKey('Q', {}), 'quit');
  assert.equal(classifyKey('', { ctrl: true, name: 'c' }), 'quit');
  assert.equal(classifyKey('', { name: 'up' }), 'up');
  assert.equal(classifyKey('k', {}), 'up');
  assert.equal(classifyKey('', { name: 'down' }), 'down');
  assert.equal(classifyKey('j', {}), 'down');
  assert.equal(classifyKey('', { name: 'return' }), 'focus');
  assert.equal(classifyKey('x', {}), 'none');
});

test('boardFooter shows the refresh interval in whole seconds', () => {
  assert.ok(boardFooter(3000).includes('every 3s'), boardFooter(3000));
  assert.ok(boardFooter(5000).includes('every 5s'));
});

test('redrawBoard draws ONLY after the first frame loads (no early wipe of the loading screen)', () => {
  const draws = [];
  const render = (args) => args; // identity, so we can inspect the props
  const draw = (x) => draws.push(x);
  redrawBoard({ props: null, selectedId: null, render, draw }); // keypress before the first gather
  assert.equal(draws.length, 0, 'nothing is drawn before the first frame');
  const props = { groups: { ready: [{ id: 'a' }, { id: 'b' }], inFlight: [], blocked: [] } };
  redrawBoard({ props, selectedId: 'b', render, draw });
  assert.equal(draws.length, 1);
  assert.equal(draws[0].selected, 1, 're-derives the render index from the selected id');
});

// ---- AC5 fixed focus argv ----

test('AC5 focusPaneArgs builds exactly the fixed herdr focus argv', () => {
  assert.deepEqual(focusPaneArgs('w1:p2'), ['pane', 'focus', '--pane', 'w1:p2']);
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
