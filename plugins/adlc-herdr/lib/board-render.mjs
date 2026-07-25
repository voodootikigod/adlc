// Pure board rendering (plan §5.2). Data strings are untrusted (ticket
// titles, ledger gate names) — each is sanitized before composition, every
// line is truncated to the pane width, and the only ANSI this module emits is
// its own SGR styling (never clears or cursor movement — the glue owns the
// screen).
import { sanitizeToken } from './sanitize.mjs';
import { displayWidth, tailToWidth, truncateToWidth } from './display-width.mjs';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const clampWidth = (width) => Math.max(20, Math.min(Number.isFinite(width) ? width : 80, 400));

/** Shortest elided root worth rendering: the ellipsis plus a few leaf chars.
 *  Narrower than this, a root says nothing and is dropped entirely rather than
 *  being allowed to push the ticket off the line. */
const MIN_ROOT = 6;

/** Shortest elided ticket id worth rendering, same reasoning as MIN_ROOT. */
const MIN_ID = 6;

/**
 * Strip escapes and collapse whitespace WITHOUT truncating.
 *
 * sanitizeToken's own cap counts code units and cuts from the FRONT, which is
 * wrong twice over here: every budget below is in terminal cells, and the
 * elisions keep tails. Escapes must still be stripped before anything is
 * MEASURED, or a value that only looked long distorts the fit.
 */
function clean(value) {
  const raw = String(value ?? '');
  return sanitizeToken(raw, Math.max(raw.length, 1));
}

/**
 * Fit the header into `width` by degrading the repo root, never the ticket.
 *
 * The root is static context; the ticket id and phase are the only fields on
 * this line that ever change, so composing left-to-right and truncating drops
 * exactly the wrong ones — at 40 columns under a deep root it rendered nothing
 * but a path. The tiers below always sacrifice the root first, and the root is
 * elided from the FRONT because a path's tail names the repo and
 * `/var/folders/...` does not.
 */
function headerText(repoRoot, ticketLabel, phase, width) {
  const root = clean(repoRoot);
  const label = clean(ticketLabel);
  const phaseText = phase ? clean(phase) : '';
  const suffix = `ticket ${label}${phaseText ? ` · ${phaseText}` : ''}`;
  const withRoot = (rootText) => `ADLC board · repo ${rootText} · ${suffix}`;

  const full = withRoot(root);
  if (displayWidth(full) <= width) return full;

  // Cells, not code units: a CJK path measured 80 by .length occupied ~160.
  const budget = width - displayWidth(withRoot('')); // room the root itself may take
  if (budget >= MIN_ROOT) return withRoot(`…${tailToWidth(root, budget - 1)}`);

  // No root fits. Drop it, then the banner.
  const banner = `ADLC board · ${suffix}`;
  if (displayWidth(banner) <= width) return banner;
  if (displayWidth(suffix) <= width) return suffix;

  // Even the bare suffix overflows — a canonical 28-char generated id does this
  // below 40 columns. Elide the ID rather than let cut() take the phase off the
  // end: a ULID's entropy is in its tail, so the tail is what distinguishes two
  // tickets, and the phase says where the work stands.
  //
  // `phase` is an unrestricted string from the manifest, so it gets bounded
  // here too. A long one would otherwise leave less than MIN_ID for the id and
  // drop BOTH fields — the failure this whole ladder exists to prevent. The id
  // keeps its tail, the phase keeps its head.
  const shown = phaseText
    ? truncateToWidth(phaseText, Math.max(2, width - 'ticket '.length - MIN_ID - 3))
    : '';
  const tail = shown ? ` · ${shown}` : '';
  const room = width - 'ticket '.length - displayWidth(tail);
  if (room < MIN_ID) return suffix; // pane too narrow for anything legible; cut() clamps
  return `ticket …${tailToWidth(label, room - 1)}${tail}`;
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
  // Truncate by terminal CELLS. sanitizeToken's cap is code units, so a row of
  // CJK text passed its check at `w` characters and then occupied 2w columns.
  const cut = (text) => truncateToWidth(clean(text), w);
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
