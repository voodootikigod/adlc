// widget.mjs — pure widget line rendering. No pi imports.
//
// renderWidgetLines(state) turns the live enforcement state into 1–3 short,
// theme-agnostic plain-text lines for ctx.ui.setWidget('adlc', …). Kept pure
// and free of ANSI so line length is honest (the ≤80-char truncation counts
// visible characters) and so it can be unit-tested without a TUI. The status
// pill keeps its color; the widget conveys state through words, not escapes.
//
// Third-line priority (#927/#936): pendingAcceptance from the shutdown/evidence
// scan beats the P7 staleness hint, which beats the last-gate-event line.
// Nothing here re-ranks on its own; the extension thread the signals in.

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
 * @param {boolean} [state.pendingAcceptance] - P6 done-claim without accept
 *   (#927); rendered ahead of P7-stale and last-gate on the third line
 * @param {number|null} [state.p7StaleDays] - days since the latest
 *   lesson-foundry/skill-rot evidence (#936); rendered when pendingAcceptance
 *   is absent, ahead of last-gate on the third line
 * @returns {string[]} 0 lines (no ticket) up to 3 short lines
 */
export function renderWidgetLines(state = {}) {
  const { ticketId, ticketTitle, enforcement, contextPercent, degraded, lastGateEvent, pendingAcceptance, p7StaleDays } = state;

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

  // Third line (at most): pendingAcceptance (#927) > P7 staleness (#936) >
  // last gate event. The signals are mutually exclusive per the ticket's
  // priority rule; the extension thread passes them through and the widget
  // only renders the winner, so line count never exceeds 3.
  const p7Stale = typeof p7StaleDays === 'number' && Number.isFinite(p7StaleDays) && p7StaleDays > 0;
  let third = null;
  if (pendingAcceptance === true) {
    third = 'P6 pending: run /adlc-accept';
  } else if (p7Stale) {
    third = `P7 stale: lesson-foundry/skill-rot ${Math.trunc(p7StaleDays)}d ago`;
  } else if (lastGateEvent && typeof lastGateEvent.type === 'string') {
    const summary = typeof lastGateEvent.summary === 'string' && lastGateEvent.summary !== ''
      ? ` ${lastGateEvent.summary}`
      : '';
    third = `last gate: ${lastGateEvent.type}${summary}`;
  }
  if (third) lines.push(truncate(third));

  return lines;
}
