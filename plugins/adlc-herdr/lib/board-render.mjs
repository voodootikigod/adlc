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

/** Shortest elided root worth rendering: the ellipsis plus a few leaf chars.
 *  Below this the pane is too narrow for a root to say anything, so the header
 *  falls back to a plain truncation of the whole line. */
const MIN_ROOT = 6;

/**
 * Fit the header's three parts into `width`, sacrificing the repo root first.
 *
 * The root is static context; the ticket id and phase are the fields that
 * change, so truncating the composed line left-to-right drops exactly the wrong
 * ones. The root is elided from the FRONT because a path's tail (the repo's own
 * directory) identifies it and `/var/folders/...` does not.
 */
function headerText(repoRoot, ticketLabel, phase, width) {
  const prefix = 'ADLC board · repo ';
  const suffix = ` · ticket ${ticketLabel}${phase ? ` · ${phase}` : ''}`;
  // Sanitize before measuring: escape stripping changes length, and a root that
  // measured short only because its escapes had not been removed yet would let
  // the composed line overflow back past the width. The cap bounds the root's
  // OWN length — capping at `width` would clip the front here and leave the
  // elision below keeping the middle of the path instead of the leaf.
  const raw = String(repoRoot ?? '');
  const root = sanitizeToken(raw, Math.max(raw.length, 1));
  const budget = width - prefix.length - suffix.length;
  if (budget >= root.length) return `${prefix}${root}${suffix}`;
  if (budget < MIN_ROOT) return `${prefix}${root}${suffix}`; // too narrow to help; cut() clamps it
  return `${prefix}…${root.slice(root.length - (budget - 1))}${suffix}`;
}

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
export function renderBoard({ width, height, repoRoot, active, phase, groups, paneRows, ledger, selected }) {
  const w = clampWidth(width);
  const cut = (text) => sanitizeToken(String(text), w);
  const lines = [];
  // `selected` is the flat index of the highlighted ticket row across all three
  // sections (t-herdr-7); a non-integer or out-of-range value marks nothing.
  let ti = 0;

  const ticketLabel = active?.state === 'active' ? active.id : 'none';
  lines.push(`${BOLD}${cut(headerText(repoRoot, ticketLabel, phase, w))}${RESET}`);
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

  if (Number.isFinite(height) && height > 0 && lines.length > height) {
    const hidden = lines.length - height;
    const kept = lines.slice(0, Math.max(1, height - 1));
    kept.push(`${DIM}${cut(`  …${hidden + 1} more (resize to see all)`)}${RESET}`);
    return kept.join('\n');
  }
  return lines.join('\n');
}
