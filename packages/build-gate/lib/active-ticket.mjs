// active-ticket.mjs — resolve which ticket is "in flight" for the current build
// (issue #48).
//
// This is now a thin ADAPTER over @adlc/tickets' canonical pointer contract, not
// a second implementation. It used to hand-roll its own resolver, which is how it
// came to accept only `id`/`ticket` and never verify `ticketHash` while other
// harnesses accepted `ticketId` and did check it — so the same pointer file
// enforced in one harness and silently disabled enforcement in another. The
// canonical contract and its vector table live in
// packages/tickets/lib/pointer.mjs and packages/tickets/test/pointer.test.mjs.

import { resolveActiveTicketId as resolveCanonical } from '@adlc/tickets';

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] - project root holding .adlc/current-ticket.json (default '.')
 * @param {NodeJS.ProcessEnv} [opts.env] - env to read ADLC_TICKET from (default process.env)
 * @returns {{ id: string|null, conflict: boolean, code?: string, message?: string }}
 *
 * `conflict: true` means FAIL CLOSED — the caller must not proceed. It covers
 * every state where the active ticket cannot be trusted, not only an
 * ADLC_TICKET-vs-pointer disagreement: an unparseable pointer, and (the hole this
 * closes) a pointer object whose id key we do not recognize. Such a pointer used
 * to read as `{id: null, conflict: false}` — "no active ticket" — which ALLOWED
 * the build. `code`/`message` carry the canonical reason for the denial.
 */
export function resolveActiveTicketId({ dir = '.', env = process.env } = {}) {
  const result = resolveCanonical({ root: dir, env });
  if (!result.ok) return { id: null, conflict: true, code: result.code, message: result.message };
  if (result.value === null) return { id: null, conflict: false };
  return { id: result.value.id, conflict: false };
}
