// Pure board rendering (plan §5.2). Data strings are untrusted (ticket
// titles, ledger gate names) — each is sanitized before composition, every
// line is truncated to the pane width, and the only ANSI this module emits is
// its own SGR styling (never clears or cursor movement — the glue owns the
// screen).
import { sanitizeToken } from './sanitize.mjs';
import {
  ambiguousWideFromEnv,
  bounded,
  displayWidth as rawDisplayWidth,
  tailToWidth as rawTailToWidth,
  truncateToWidth as rawTruncateToWidth,
} from './display-width.mjs';

/**
 * Read once: whether ambiguous-width characters occupy two cells is a terminal
 * configuration, fixed for the life of the process. Every measurement in this
 * module goes through these wrappers so the mode cannot be applied to some
 * budgets and forgotten on others — which is precisely how the separator got
 * fixed while the header, rows and footer kept overflowing.
 */
const WIDTH_OPTS = { ambiguousWide: ambiguousWideFromEnv(process.env) };
const displayWidth = (text) => rawDisplayWidth(text, WIDTH_OPTS);
const truncateToWidth = (text, max) => rawTruncateToWidth(text, max, WIDTH_OPTS);
const tailToWidth = (text, max) => rawTailToWidth(text, max, WIDTH_OPTS);

/**
 * Truncate a row as if ambiguous-width characters were WIDE, whatever the
 * declared mode.
 *
 * For a row the renderer knows contains an ambiguous glyph it cannot replace —
 * today only the fleet separator, pinned by a frozen rail. Over-counting costs
 * at most one character of content and can never overflow; under-counting wraps
 * the row and corrupts every later cursor-home redraw.
 */
const cutAmbiguousSafe = (text, max) => rawTruncateToWidth(text, max, { ambiguousWide: true });

/**
 * ASCII ONLY for renderer-owned text — separators, ellipses, key hints.
 *
 * U+2500, U+00B7, U+2026 and the arrow glyphs are all East_Asian_Width
 * =AMBIGUOUS: a terminal configured for East Asian text renders each in TWO
 * cells, so chrome measured at the pane width physically overflows it and the
 * frame wraps. Counting every ambiguous character as wide would shrink every
 * row for the majority who are not on such a terminal (see the Ambiguous test
 * in display-width.test.mjs), so the rule is narrower: text the renderer
 * CHOOSES is unambiguous, and untrusted DATA is measured as narrow.
 *
 * Residual, deliberate: a ticket title full of ambiguous characters can still
 * overflow on an ambiguous-wide terminal. Width there is a terminal
 * CONFIGURATION, not a property of the text, so no measurement is correct for
 * both setups — this trade keeps the chrome exact everywhere and the data
 * exact for the common configuration — and exact for BOTH once
 * ADLC_HERDR_AMBIGUOUS_WIDTH=wide is declared, which is the only way to know.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Layout width: floored at 20 so the arithmetic below never degenerates. */
const clampWidth = (width) => Math.max(20, Math.min(Number.isFinite(width) ? width : 80, 400));

/**
 * Emission width: what may actually be WRITTEN, which is the real pane and has
 * no floor.
 *
 * The layout floor was being used for both, so a pane narrower than 20 columns
 * got 20-cell rows and an 18-cell footer — wrapping every one of them, which is
 * the corruption the clamping exists to prevent. A floor is a reasonable way to
 * keep layout math sane; it is never a licence to write past the terminal.
 */
const emitWidth = (width) => (Number.isFinite(width) && width > 0
  ? Math.min(Math.floor(width), clampWidth(width))
  : clampWidth(width));

/** Shortest elided root worth rendering: the ellipsis plus a few leaf chars.
 *  Narrower than this, a root says nothing and is dropped entirely rather than
 *  being allowed to push the ticket off the line. */
const MIN_ROOT = 6;

/** Elision marker. ASCII (see the note above), so it costs THREE cells where
 *  the ambiguous-width ellipsis cost one, so a three-character marker would
 *  eat two cells of ticket id at narrow widths. '<' is one cell, unambiguous,
 *  and reads correctly for an elision that keeps the TAIL. Budgets subtract
 *  ELLIPSIS_W rather than a hard-coded 1, so changing it stays safe. */
const ELLIPSIS = '<';
const ELLIPSIS_W = ELLIPSIS.length;

/** Shortest elided ticket id worth rendering, same reasoning as MIN_ROOT. */
const MIN_ID = 6;

/** The same floor once the `ticket ` label is gone. Lower on purpose: there is
 *  no seven-cell noun left to pay for, and two id characters beside a phase are
 *  worth more than seven id characters with the phase dropped. */
const MIN_BARE_ID = 3;

/** Ceiling on any single untrusted field before width work. The widest pane
 *  clampWidth allows is 400 cells, so this is ~20x more than can ever show. */
const FIELD_CAP = 8192;

/**
 * Strip escapes and collapse whitespace WITHOUT truncating.
 *
 * sanitizeToken's own cap counts code units and cuts from the FRONT, which is
 * wrong twice over here: every budget below is in terminal cells, and the
 * elisions keep tails. Escapes must still be stripped before anything is
 * MEASURED, or a value that only looked long distorts the fit.
 */
function clean(value) {
  // Bound BEFORE sanitizing. Ticket titles, branch names and ledger gate names
  // are untrusted and unbounded, and this runs on every redraw; a multi-megabyte
  // field would otherwise be escape-scanned and segmented in full to produce a
  // line no wider than a pane. FIELD_CAP is far above any real value and far
  // above what the widest supported pane can show.
  const raw = bounded(String(value ?? ''), FIELD_CAP);
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
  const suffix = `ticket ${label}${phaseText ? ` | ${phaseText}` : ''}`;
  const withRoot = (rootText) => `ADLC board | repo ${rootText} | ${suffix}`;

  const full = withRoot(root);
  if (displayWidth(full) <= width) return full;

  // Cells, not code units: a CJK path measured 80 by .length occupied ~160.
  const budget = width - displayWidth(withRoot('')); // room the root itself may take
  if (budget >= MIN_ROOT) return withRoot(`${ELLIPSIS}${tailToWidth(root, budget - ELLIPSIS_W)}`);

  // No root fits. Drop it, then the banner.
  const banner = `ADLC board | ${suffix}`;
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
  const tail = shown ? ` | ${shown}` : '';
  const room = width - 'ticket '.length - displayWidth(tail);
  if (room >= MIN_ID) return `ticket ${ELLIPSIS}${tailToWidth(label, room - ELLIPSIS_W)}${tail}`;

  // Drop the LABEL before dropping a field. Below about thirteen cells the word
  // "ticket " costs seven of them — more than the id it introduces — and
  // returning the labelled suffix here handed cut() a string it rendered as
  // "ticket " alone: the whole pane spent on a noun, with the id and phase it
  // was meant to introduce both gone.
  const bare = phaseText ? `${label} | ${phaseText}` : label;
  if (displayWidth(bare) <= width) return bare;

  // Elide the id but KEEP the phase, mirroring the labelled tier above. The
  // previous version went straight from "both fit whole" to an id-only elision,
  // throwing away the phase it had already truncated — so a canonical 28-char
  // ULID lost P4 at every width from 8 to 17, the exact narrow regime this tier
  // exists to serve. `<R7 | P4` fits in eight cells.
  if (shown) {
    const bareTail = ` | ${shown}`;
    const bareRoom = width - displayWidth(bareTail);
    // A lower floor than MIN_ID: with the label gone there is no 7-cell noun to
    // pay for, and two id characters beside a phase beat seven characters of id
    // with no phase at all.
    if (bareRoom >= MIN_BARE_ID) return `${ELLIPSIS}${tailToWidth(label, bareRoom - ELLIPSIS_W)}${bareTail}`;
  }
  if (displayWidth(label) <= width) return label;
  return `${ELLIPSIS}${tailToWidth(label, width - ELLIPSIS_W)}`;
}

/**
 * The board's footer hint line (with its own SGR). Pure so the refresh-seconds
 * arithmetic is testable rather than buried in the stdout glue.
 *
 * Width-aware, because draw() appends this to the clamped body and gather()
 * reserves exactly two rows for it. A fixed 57-cell line wrapped to three rows
 * in a 20-column pane, so every cursor-home redraw wrote more physical rows
 * than were reserved and the pane scrolled — the frame corruption the body
 * clamping exists to prevent, reintroduced one line below it.
 *
 * Hints drop in order of how recoverable their absence is; quitting is last to
 * go, because a user who cannot read the footer most needs the way out.
 */
export function boardFooter(refreshMs, width = 80) {
  const w = emitWidth(width);
  const tiers = [
    `up/down jk select | enter focus pane | q quit | refreshes every ${refreshMs / 1000}s`,
    'up/down select | enter focus | q quit',
    'up/down select | q quit',
    'q quit',
  ];
  const hint = tiers.find((tier) => displayWidth(tier) <= w) ?? truncateToWidth('q quit', w);
  return `${DIM}${hint}${RESET}`;
}

/**
 * The exact bytes a redraw writes: cursor-home, every row erase-to-EOL, then
 * erase-below.
 *
 * There is deliberately NO trailing newline. gather() reserves exactly two rows
 * for the blank line and footer, so on a height-clamped frame the footer lands
 * on the terminal's LAST row — and a line feed from the bottom row scrolls the
 * viewport before erase-below ever runs. That scroll happened on every refresh
 * and displaced the frame, which is the corruption the height clamp and the
 * bounded footer exist to prevent.
 *
 * Pure so the invariant is pinned here rather than in the stdout glue.
 */
/**
 * Re-stamp cached frame data with the terminal's CURRENT geometry.
 *
 * gather() captures width/height alongside the data it fetches, and that fetch
 * is async (herdr subprocesses plus an `adlc ticket store export`). A keypress
 * redraw during a resize therefore rendered the cached 80-column body into a
 * 20-column pane, which wraps and scrolls until a later gather succeeds — and
 * gather can fail, holding the stale geometry indefinitely. Data may be stale;
 * geometry never should be, because only geometry decides what fits.
 */
/** Pane width assumed when the terminal reports none (stdout is not a TTY). */
const DEFAULT_COLUMNS = 80;
/** Rows composeFrame appends after the body: one blank separator + the footer. */
const CHROME_ROWS = 2;

/**
 * The geometry a frame is built for, derived from the terminal.
 *
 * ONE definition. This arithmetic previously existed twice — here and inline in
 * bin/board.mjs — with subtly different fallbacks (`?? 80` there, `props.width`
 * here). The bin copy is thin TUI glue with no tests, which is exactly where two
 * mutants survived the mutation gate: the row floor and the column default could
 * each be altered and nothing noticed. Duplicated logic in an untested file is
 * how a guard stays correct and unverified at the same time.
 */
export function frameGeometry({ columns, rows } = {}) {
  return {
    width: Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS,
    // Reserve the chrome rows, but never ask for less than one row of body: a
    // pane shorter than the chrome still shows the header, because composeFrame
    // sheds the blank and the footer itself rather than losing content.
    height: Number.isFinite(rows) && rows > 0 ? Math.max(1, rows - CHROME_ROWS) : null,
  };
}

export function withCurrentGeometry(props, { columns, rows } = {}) {
  if (!props) return props;
  const current = frameGeometry({ columns, rows });
  return {
    ...props,
    // Keep the cached value when the terminal reports nothing, rather than
    // stamping the default over a geometry gather() already resolved.
    width: Number.isFinite(columns) && columns > 0 ? current.width : props.width,
    height: Number.isFinite(rows) && rows > 0 ? current.height : props.height,
  };
}

export function composeFrame(body, footer, terminalRows) {
  const bodyLines = String(body ?? '').split('\n');
  let lines = [...bodyLines, '', footer];

  // A pane can be shorter than the chrome. gather() floors the body at four
  // rows and composeFrame adds two, so a 1-5 row pane received six lines and
  // scrolled on every redraw. Shed the chrome before shedding content: the
  // blank separator first, then the footer, then the body itself.
  if (Number.isFinite(terminalRows) && terminalRows > 0) {
    const limit = Math.floor(terminalRows);
    if (lines.length > limit) lines = [...bodyLines, footer];
    if (lines.length > limit) lines = [...bodyLines];
    if (lines.length > limit) lines = lines.slice(0, limit);
  }

  const rows = lines.map((line) => `${line}\x1b[K`).join('\n');
  return `\x1b[H${rows}\x1b[0J`;
}

/** Render the full board frame as a string of newline-joined rows. When
 *  `height` is given, the output is clamped to that many lines — the redraw
 *  uses cursor-home (not an alternate screen), so a frame taller than the pane
 *  would scroll and duplicate every refresh. A truncated frame ends with a
 *  "...N more" marker. */
export function renderBoard({ width, height, repoRoot, active, phase, groups, paneRows, ledger, selected, fleetRows }) {
  const emit = emitWidth(width); // never write past the real pane, floor or not
  // Truncate by terminal CELLS. sanitizeToken's cap is code units, so a row of
  // CJK text passed its check at `w` characters and then occupied 2w columns.
  const cut = (text) => truncateToWidth(clean(text), emit);
  const lines = [];
  // `selected` is the flat index of the highlighted ticket row across all three
  // sections (t-herdr-7); a non-integer or out-of-range value marks nothing.
  let ti = 0;

  /**
   * Stop FORMATTING once the pane is full, rather than formatting everything and
   * slicing at the end.
   *
   * Every row is sanitized, segmented and measured in cells. Doing that for all
   * of a store's tickets to display a handful cost about a second per redraw at
   * ten thousand tickets — and the board redraws every three seconds, so a large
   * valid store kept the process CPU-bound and input laggy. Ticket count and
   * title length are both untrusted; the per-field cap bounds each row but says
   * nothing about their number.
   */
  const budget = Number.isFinite(height) && height > 0 ? Math.floor(height) : Infinity;
  const push = (line) => {
    if (lines.length >= budget) return false;
    lines.push(line);
    return true;
  };

  const ticketLabel = active?.state === 'active' ? active.id : 'none';
  push(`${BOLD}${cut(headerText(repoRoot, ticketLabel, phase, emit))}${RESET}`);
  // ASCII separator, deliberately. U+2500 is East_Asian_Width=AMBIGUOUS, which
  // a terminal configured for East Asian text renders in TWO cells — one glyph
  // per column then occupies double the pane and wraps the row. Counting all
  // ambiguous characters as wide would shrink every row for everyone (see the
  // Ambiguous test in display-width.test.mjs); the separator is the one
  // character the renderer CHOOSES, so it can simply be unambiguous.
  push(`${DIM}${'-'.repeat(Math.min(emit, 80))}${RESET}`);

  const sections = [
    ['ready', groups?.ready ?? []],
    ['in-flight', groups?.inFlight ?? []],
    ['blocked', groups?.blocked ?? []],
  ];
  const total = sections.reduce((n, [, list]) => n + list.length, 0);
  if (total === 0) {
    push(cut('no tickets'));
  } else {
    for (const [name, list] of sections) {
      if (!push(`${BOLD}${cut(`${name} (${list.length})`)}${RESET}`)) break;
      for (const ticket of list) {
        const isSel = Number.isInteger(selected) && ti === selected;
        const line = cut(`${isSel ? '> ' : '  '}${ticket.id} | ${ticket.title ?? ''}`);
        if (!push(isSel ? `${BOLD}${line}${RESET}` : line)) break;
        ti += 1;
      }
    }
  }

  push(`${BOLD}${cut('panes')}${RESET}`);
  if (!Array.isArray(paneRows) || paneRows.length === 0) {
    push(`${DIM}${cut('  (no mapped panes)')}${RESET}`);
  } else {
    for (const row of paneRows) {
      if (!push(cut(`  ${row.paneId} | ${row.agent ?? '?'} | ${row.agentStatus ?? '?'} | ${row.ticket ?? '-'}`))) break;
    }
  }

  push(`${BOLD}${cut('gate ledger')}${RESET}`);
  if (!Array.isArray(ledger) || ledger.length === 0) {
    push(`${DIM}${cut('  (no records)')}${RESET}`);
  } else {
    for (const record of ledger) {
      if (!push(cut(`  #${record.seq ?? '?'} ${record.gate ?? '?'} | ${record.ticket ?? ''}`))) break;
    }
  }

  // Fleet run summary (t-herdr-9): terminal fleet tickets collapse to one row
  // each, shown only while a run is present. Routed through push()/cut() like
  // every other section rather than pushed directly — otherwise it would
  // reintroduce exactly what this branch removed: unbounded formatting past the
  // height budget, code-unit truncation, and an ambiguous-width separator that
  // wraps on an East Asian terminal.
  const fleet = Array.isArray(fleetRows) ? fleetRows : [];
  if (fleet.length > 0) {
    push(`${BOLD}${cut('fleet')}${RESET}`);
    for (const row of fleet) {
      // `·` here, not the ASCII `|` used everywhere else in this module: the
      // separator is pinned by test/fleet-bridge.test.mjs, a FROZEN RAIL
      // (t-herdr-9) asserting /t-b · failed/. A rail outranks a policy this
      // branch introduced, and amending one is a CODEOWNERS-gated ceremony that
      // belongs to its owner, not to this change.
      //
      // So the row is MEASURED conservatively instead: U+00B7 is
      // ambiguous-width, and budgeting it as one cell let a row that nominally
      // filled the pane occupy one physical cell more and wrap (37 nominal, 38
      // real, at 37 columns). Counting ambiguous as wide for this row costs at
      // most a character of a ticket id and cannot overflow on either terminal
      // — the safe direction, and narrower than applying it to every row, which
      // would shrink the whole board for the majority who do not need it.
      if (!push(cutAmbiguousSafe(clean(`  ${row.ticketId} · ${row.state}`), emit))) break;
    }
  }

  // How many rows the frame WOULD have had. Derived from section lengths rather
  // than measured from `lines`, because construction now stops at the budget and
  // never builds the hidden rows — which is the whole point.
  const plannedRows = 2 // header + separator
    + (total === 0 ? 1 : sections.length + total)
    + 1 + Math.max(1, Array.isArray(paneRows) ? paneRows.length : 0)
    + 1 + Math.max(1, Array.isArray(ledger) ? ledger.length : 0)
    + (fleet.length > 0 ? 1 + fleet.length : 0); // fleet header + its rows

  if (budget !== Infinity && plannedRows > budget) {
    // height 1 has no room for both a kept line and the marker; slicing to
    // max(1, height-1) and then pushing produced TWO rows for a one-row budget.
    // One row: keep the HEADER, not a "resize me" marker. gather reserves two
    // chrome rows, so a 1-3 row pane lands here — and a marker spent the only
    // row available on telling the operator the board is small, which they can
    // already see, while discarding the active ticket and phase. composeFrame
    // sheds chrome afterwards but cannot recover a body line already thrown
    // away, so the choice has to be made here.
    if (budget === 1) return lines[0];
    // Overwrite the last BUILT row with the marker: `lines` already holds
    // exactly `budget` rows, so replacing rather than appending keeps the count.
    const hidden = plannedRows - budget + 1;
    lines[budget - 1] = `${DIM}${cut(`  ...${hidden} more (resize to see all)`)}${RESET}`;
  }
  return lines.join('\n');
}
