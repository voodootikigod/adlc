// completion.mjs — the TICKET-DONE / TICKET-BLOCKED completion-protocol listener
// (spec 4.2). The ADLC doctrine instructs the model to end with `TICKET-DONE`
// when it believes a ticket is complete (or `TICKET-BLOCKED: <reason>` when it
// cannot proceed). Nothing listened for it until now — this closes that loop.
//
// On `message_end`, when the finalized ASSISTANT message ENDS with the exact
// token `TICKET-DONE` (trailing whitespace tolerated), we nudge the model to run
// `adlc_prosecute` before claiming completion (a followUp message) and record a
// `ticket-done-claimed` evidence entry. A line beginning `TICKET-BLOCKED:`
// records `ticket-blocked` with the reason. Each fires AT MOST ONCE per turn and
// NEVER rewrites the message (we return nothing from the handler).

/**
 * Concatenate the assistant-authored text of a finalized message. Tolerant of
 * the shapes pi/pi-ai use: content may be a string, or an array of parts where
 * text parts carry `.text` (and `.type === 'text'`). Non-assistant messages
 * yield '' so the caller no-ops on them.
 */
export function extractAssistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

/**
 * Classify a completion protocol token in the assistant text.
 * - DONE: the message ENDS with the exact token `TICKET-DONE` (trailing
 *   whitespace tolerated). A message merely CONTAINING it mid-text is ignored.
 * - BLOCKED: a line begins with `TICKET-BLOCKED:`; the rest of that line is the
 *   reason. DONE is checked first (end-anchored) so a trailing DONE wins.
 *
 * @returns {{kind: 'done'} | {kind: 'blocked', reason: string} | null}
 */
export function detectCompletion(text) {
  if (typeof text !== 'string' || text === '') return null;
  // End-anchored, token-bounded: start-of-string or whitespace before the token,
  // only whitespace after it.
  if (/(^|\s)TICKET-DONE\s*$/.test(text)) return { kind: 'done' };
  const blocked = /(^|\n)[ \t]*TICKET-BLOCKED:[ \t]*(.*)/.exec(text);
  if (blocked) return { kind: 'blocked', reason: (blocked[2] ?? '').trim() };
  return null;
}

/**
 * Build the message_end listener + a per-turn reset.
 *
 * @param {object} deps
 * @param {object} deps.pi                     ExtensionAPI (sendMessage)
 * @param {() => {ticketId: string|null}} deps.getActive
 * @param {(evt: {ctx: object, type: string, detail: object}) => void} deps.note
 *   the extension's noteGate choke point (evidence + widget refresh).
 * @returns {{ onMessageEnd: Function, resetTurn: Function }}
 */
export function makeCompletionListener({ pi, getActive, note } = {}) {
  let firedThisTurn = false;

  function resetTurn() {
    firedThisTurn = false;
  }

  async function onMessageEnd(event, ctx) {
    if (firedThisTurn) return undefined;
    const det = detectCompletion(extractAssistantText(event?.message));
    if (!det) return undefined;
    firedThisTurn = true; // at most once per turn, regardless of kind

    const active = getActive?.() ?? { ticketId: null };
    const ticketId = active?.ticketId ?? null;

    if (det.kind === 'done') {
      try {
        ctx?.ui?.notify?.(
          `ADLC: TICKET-DONE detected${ticketId ? ` for ${ticketId}` : ''}. Run adlc_prosecute (P5) before claiming completion.`,
          'info'
        );
      } catch { /* notify is best-effort */ }
      try {
        pi?.sendMessage?.(
          {
            customType: 'adlc-ticket-done',
            content:
              'You signaled TICKET-DONE. Before claiming completion, call the adlc_prosecute ' +
              'tool to run the P5 prosecution loop over your change and address any confirmed findings.',
            display: true,
            details: { ticketId },
          },
          { deliverAs: 'followUp' }
        );
      } catch { /* the nudge is advisory — never fail the turn on it */ }
      try { note?.({ ctx, type: 'ticket-done-claimed', detail: { ticketId } }); } catch { /* best-effort */ }
      return undefined;
    }

    // blocked
    try {
      ctx?.ui?.notify?.(
        `ADLC: TICKET-BLOCKED${ticketId ? ` on ${ticketId}` : ''}: ${det.reason || '(no reason given)'}`,
        'warning'
      );
    } catch { /* best-effort */ }
    try { note?.({ ctx, type: 'ticket-blocked', detail: { ticketId, reason: det.reason } }); } catch { /* best-effort */ }
    return undefined;
  }

  return { onMessageEnd, resetTurn };
}
