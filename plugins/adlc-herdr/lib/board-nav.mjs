// Pure board row-action logic (plan §5.2), pinned by test/board-actions.test.mjs.
// bin/board.mjs owns the screen and input; this module owns the DECISIONS —
// where the selection moves, what a selected row does, and the fixed argv to do
// it. No I/O here, and nothing derived from untrusted ticket content is executed.

/** Move the selection by a key within [0, rowCount-1]. Down = +1, up = -1, both
 *  clamped; any other key leaves it unchanged. With no rows the selection is -1
 *  (nothing selectable) — never a valid index. */
export function stepSelection(current, key, rowCount) {
  if (!Number.isInteger(rowCount) || rowCount <= 0) return -1;
  const delta = key === 'down' ? 1 : key === 'up' ? -1 : 0;
  const base = Number.isInteger(current) ? current : 0;
  const next = base + delta;
  if (next < 0) return 0;
  if (next > rowCount - 1) return rowCount - 1;
  return next;
}

// A pane id must be a plain token (no leading hyphen): it becomes the value of
// the `--pane` flag, and a hyphen-leading value could be mis-parsed as a flag.
const PANE_ID_RE = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;

/** What selecting a ticket row does: focus its mapped pane, or nothing. The
 *  paneId is taken ONLY from the trusted pane map, and is still validated as a
 *  plain token before it can reach an argv. */
export function resolveRowAction(selectedTicket, paneRows) {
  const id = selectedTicket && typeof selectedTicket.id === 'string' ? selectedTicket.id : null;
  if (!id || !Array.isArray(paneRows)) return { kind: 'none', reason: 'no selectable ticket' };
  const row = paneRows.find((r) => r && r.ticket === id && typeof r.paneId === 'string');
  if (!row) return { kind: 'none', reason: 'ticket has no mapped pane' };
  if (!PANE_ID_RE.test(row.paneId)) return { kind: 'none', reason: 'pane id fails validation' };
  return { kind: 'focus-pane', paneId: row.paneId };
}

/** The fixed herdr argv to focus a specific pane. `herdr pane focus` takes the
 *  id as the VALUE of `--pane` (not a positional), which also keeps the
 *  validated paneId out of positional/flag ambiguity. */
export function focusPaneArgs(paneId) {
  return ['pane', 'focus', '--pane', paneId];
}

/** Flat index of the ticket with `id`, or -1. The board tracks the selection by
 *  stable ticket id and re-derives the index each refresh, so a background
 *  reorder/removal can never leave the selection pointing at a different
 *  ticket (which would confirm an action on the wrong one). */
export function indexOfTicket(rows, id) {
  if (!Array.isArray(rows) || typeof id !== 'string') return -1;
  return rows.findIndex((t) => t && t.id === id);
}

/** The flat ticket list in the SAME order renderBoard shows it (ready, then
 *  in-flight, then blocked). Kept here so the glue and the renderer can't drift. */
export function flattenGroups(groups) {
  return [...(groups?.ready ?? []), ...(groups?.inFlight ?? []), ...(groups?.blocked ?? [])];
}

/** New selected ticket id after a nav key — resolve the current index from the
 *  id, step it, map back to an id (null when nothing is selectable). */
export function nextSelectedId(selectedId, direction, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const next = stepSelection(indexOfTicket(list, selectedId), direction, list.length);
  return list[next]?.id ?? null;
}

/** The herdr argv to focus the selected ticket's mapped pane, or null when the
 *  ticket has no pane (or nothing is selected). */
export function focusCommandFor(selectedId, rows, paneRows) {
  const list = Array.isArray(rows) ? rows : [];
  const action = resolveRowAction(list[indexOfTicket(list, selectedId)], paneRows);
  return action.kind === 'focus-pane' ? focusPaneArgs(action.paneId) : null;
}

/** Focus the selected ticket's pane by invoking `run(argv)` — only when there is
 *  a command to run. `run` (the herdr shim) is injected so the "run only when a
 *  command exists" decision is unit-testable rather than buried in the glue. */
export function focusSelected({ selectedId, groups, paneRows, run }) {
  const cmd = focusCommandFor(selectedId, flattenGroups(groups), paneRows);
  if (cmd) run(cmd);
}

/** Draw the board for the current selection, but ONLY once a frame has loaded.
 *  A keypress before the first gather completes must not wipe the "loading…"
 *  screen with a render built from absent state. `render`/`draw` are injected so
 *  the "not before the first frame" guard is unit-testable, not untested glue. */
export function redrawBoard({ props, selectedId, render, draw }) {
  if (!props) return;
  draw(render({ ...props, selected: indexOfTicket(flattenGroups(props.groups), selectedId) }));
}

/** Classify a raw keypress into a board command. `str` is the character, `key`
 *  is readline's parsed descriptor ({name, ctrl}). Keeps the input routing pure
 *  and testable; the glue only fires the returned command. */
export function classifyKey(str, key) {
  const k = key || {};
  if (str === 'q' || str === 'Q' || (k.ctrl && k.name === 'c')) return 'quit';
  if (k.name === 'up' || str === 'k') return 'up';
  if (k.name === 'down' || str === 'j') return 'down';
  if (k.name === 'return') return 'focus';
  return 'none';
}
