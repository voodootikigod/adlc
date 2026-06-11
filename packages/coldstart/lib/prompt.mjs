// Prompt construction for the coldstart gate.
// Pure functions — no I/O, no side effects.

export const SYSTEM_PROMPT =
  'You are a senior engineer auditing a ticket for executability. ' +
  'You will be given a ticket in JSON form. Your task is to identify every gap ' +
  'that would force a fresh agent to ask a *human* a question before it could begin executing. ' +
  'Information that is derivable by reading the repository does NOT count as missing. ' +
  'Do not invent hypothetical concerns — only flag genuine blockers.\n\n' +
  'Output exactly one JSON object with the schema:\n' +
  '{"gaps": [{"what": "<brief label>", "why_blocking": "<one sentence>"}]}\n' +
  'Use an empty array when the ticket is fully executable. Output nothing outside the JSON object.';

/**
 * Serialize a ticket to the compact text that is embedded in the user prompt.
 * Only ticket-defined fields are included (title, body, scope, rails, edges).
 */
export function ticketToText(ticket) {
  const payload = {
    id: ticket.id,
    title: ticket.title,
    ...(ticket.body ? { body: ticket.body } : {}),
    ...(ticket.scope?.length ? { scope: ticket.scope } : {}),
    ...(ticket.rails?.length ? { rails: ticket.rails } : {}),
    ...(ticket.edges?.length ? { edges: ticket.edges } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Build the full user-turn prompt for a single ticket.
 *
 * The spec says:
 *   "Ticket text sent = title + body + scope + rails + edges (JSON)"
 */
export function buildPrompt(ticket) {
  return (
    'You are a fresh agent handed this ticket with NO conversation context. ' +
    'The repo IS available to you, so information derivable by reading the repo ' +
    'does not count as missing.\n\n' +
    'Ticket:\n' +
    ticketToText(ticket) +
    '\n\n' +
    'List everything missing from the ticket that would force you to ask a HUMAN a question ' +
    'before executing: data shapes referenced but not embedded, contracts named but absent, ' +
    'acceptance criteria with no check, vague scope ("improve", "clean up"), unstated target ' +
    'files when not inferable.\n\n' +
    'Output JSON {gaps: [{what: string, why_blocking: string}]} — empty array if fully executable.'
  );
}
