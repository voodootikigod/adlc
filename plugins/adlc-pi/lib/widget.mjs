// widget.mjs — pure widget line rendering (spec Phase 3.2). No pi imports.
//
// renderWidgetLines(state) turns the live enforcement state into 1–3 short,
// theme-agnostic plain-text lines for ctx.ui.setWidget('adlc', …). Kept pure
// and free of ANSI so line length is honest (the ≤80-char truncation counts
// visible characters) and so it can be unit-tested without a TUI. The status
// pill keeps its color; the widget conveys state through words, not escapes.

/** Max visible characters per widget line. */
export const WIDGET_MAX_LINE = 80;

const ELLIPSIS = '…';

function truncate(text, max = WIDGET_MAX_LINE) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + ELLIPSIS;
}

/**
 * @param {object} state
 * @param {string|null} [state.ticketId]
 * @param {string|null} [state.ticketTitle]
 * @param {'active'|'error'|'inert'} [state.enforcement]
 * @param {number|null} [state.contextPercent] - percent (0–100) or null/absent
 * @param {boolean} [state.degraded]
 * @param {{ type:string, summary?:string }|null} [state.lastGateEvent]
 * @returns {string[]} 0 lines (no ticket) up to 3 short lines
 */
export function renderWidgetLines(state = {}) {
  const { ticketId, ticketTitle, enforcement, contextPercent, degraded, lastGateEvent } = state;

  // The widget exists only while a ticket is resolved; the caller passes the
  // empty result to setWidget as `undefined` to clear it.
  if (typeof ticketId !== 'string' || ticketId.trim() === '') return [];

  const label = enforcement === 'error' ? 'error' : enforcement === 'inert' ? 'inert' : 'active';
  let head = `ADLC ▸ ${ticketId} (${label})`;
  // Missing/NaN percent is omitted entirely — never rendered as 'NaN%'.
  if (typeof contextPercent === 'number' && Number.isFinite(contextPercent)) {
    head += ` · ctx ${Math.round(contextPercent)}%`;
  }
  if (degraded) head += ' · degraded';

  const lines = [truncate(head)];

  if (typeof ticketTitle === 'string' && ticketTitle.trim() !== '') {
    lines.push(truncate(ticketTitle.trim()));
  }

  if (lastGateEvent && typeof lastGateEvent.type === 'string') {
    const summary = typeof lastGateEvent.summary === 'string' && lastGateEvent.summary !== ''
      ? ` ${lastGateEvent.summary}`
      : '';
    lines.push(truncate(`last gate: ${lastGateEvent.type}${summary}`));
  }

  return lines;
}
