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

/** What selecting a ticket row does: focus its mapped pane, or nothing. The
 *  paneId is taken ONLY from the trusted pane map, never from ticket content. */
export function resolveRowAction(selectedTicket, paneRows) {
  const id = selectedTicket && typeof selectedTicket.id === 'string' ? selectedTicket.id : null;
  if (!id || !Array.isArray(paneRows)) return { kind: 'none', reason: 'no selectable ticket' };
  const row = paneRows.find((r) => r && r.ticket === id && typeof r.paneId === 'string');
  if (!row) return { kind: 'none', reason: 'ticket has no mapped pane' };
  return { kind: 'focus-pane', paneId: row.paneId };
}

/** The fixed herdr argv to focus a pane — paneId is from the trusted pane map. */
export function focusPaneArgs(paneId) {
  return ['pane', 'focus', paneId];
}

/** Flat index of the ticket with `id`, or -1. The board tracks the selection by
 *  stable ticket id and re-derives the index each refresh, so a background
 *  reorder/removal can never leave the selection pointing at a different
 *  ticket (which would confirm an action on the wrong one). */
export function indexOfTicket(rows, id) {
  if (!Array.isArray(rows) || typeof id !== 'string') return -1;
  return rows.findIndex((t) => t && t.id === id);
}
