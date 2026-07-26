// Pure board rendering (plan §5.2). Data strings are untrusted (ticket
// titles, ledger gate names) — each is sanitized before composition, every
// line is truncated to the pane width, and the only ANSI this module emits is
// its own SGR styling (never clears or cursor movement — the glue owns the
// screen).
import { sanitizeToken } from './sanitize.mjs';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const clampWidth = (width) => Math.max(20, Math.min(Number.isFinite(width) ? width : 80, 400));

/** The board's footer hint line (with its own SGR). Pure so the refresh-seconds
 *  arithmetic is testable rather than buried in the stdout glue. */
export function boardFooter(refreshMs) {
  return `${DIM}↑↓/jk select · ↵ focus pane · q quit · refreshes every ${refreshMs / 1000}s${RESET}`;
}

/** Render the full board frame as a string of newline-joined rows. When
 *  `height` is given, the output is clamped to that many lines — the redraw
 *  uses cursor-home (not an alternate screen), so a frame taller than the pane
 *  would scroll and duplicate every refresh. A truncated frame ends with a
 *  "…N more" marker. */
export function renderBoard({ width, height, repoRoot, active, phase, groups, paneRows, ledger, selected, fleetRows }) {
  const w = clampWidth(width);
  const cut = (text) => sanitizeToken(String(text), w);
  const lines = [];
  // `selected` is the flat index of the highlighted ticket row across all three
  // sections (t-herdr-7); a non-integer or out-of-range value marks nothing.
  let ti = 0;

  const ticketLabel = active?.state === 'active' ? active.id : 'none';
  lines.push(`${BOLD}${cut(`ADLC board · repo ${repoRoot} · ticket ${ticketLabel}${phase ? ` · ${phase}` : ''}`)}${RESET}`);
  lines.push(`${DIM}${'─'.repeat(Math.min(w, 80))}${RESET}`);

  const sections = [
    ['ready', groups?.ready ?? []],
    ['in-flight', groups?.inFlight ?? []],
    ['blocked', groups?.blocked ?? []],
  ];
  const total = sections.reduce((n, [, list]) => n + list.length, 0);
  if (total === 0) {
    lines.push(cut('no tickets'));
  } else {
    for (const [name, list] of sections) {
      lines.push(`${BOLD}${cut(`${name} (${list.length})`)}${RESET}`);
      for (const ticket of list) {
        const isSel = Number.isInteger(selected) && ti === selected;
        const line = cut(`${isSel ? '> ' : '  '}${ticket.id} · ${ticket.title ?? ''}`);
        lines.push(isSel ? `${BOLD}${line}${RESET}` : line);
        ti += 1;
      }
    }
  }

  lines.push(`${BOLD}${cut('panes')}${RESET}`);
  if (!Array.isArray(paneRows) || paneRows.length === 0) {
    lines.push(`${DIM}${cut('  (no mapped panes)')}${RESET}`);
  } else {
    for (const row of paneRows) {
      lines.push(cut(`  ${row.paneId} · ${row.agent ?? '?'} · ${row.agentStatus ?? '?'} · ${row.ticket ?? '-'}`));
    }
  }

  lines.push(`${BOLD}${cut('gate ledger')}${RESET}`);
  if (!Array.isArray(ledger) || ledger.length === 0) {
    lines.push(`${DIM}${cut('  (no records)')}${RESET}`);
  } else {
    for (const record of ledger) {
      lines.push(cut(`  #${record.seq ?? '?'} ${record.gate ?? '?'} · ${record.ticket ?? ''}`));
    }
  }

  // Fleet run summary (t-herdr-9): terminal fleet tickets collapse to one row
  // each. Only shown while a run is present (fleetRows non-empty).
  if (Array.isArray(fleetRows) && fleetRows.length > 0) {
    lines.push(`${BOLD}${cut('fleet')}${RESET}`);
    for (const row of fleetRows) {
      lines.push(cut(`  ${row.ticketId} · ${row.state}`));
    }
  }

  if (Number.isFinite(height) && height > 0 && lines.length > height) {
    const hidden = lines.length - height;
    const kept = lines.slice(0, Math.max(1, height - 1));
    kept.push(`${DIM}${cut(`  …${hidden + 1} more (resize to see all)`)}${RESET}`);
    return kept.join('\n');
  }
  return lines.join('\n');
}
