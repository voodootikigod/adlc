import { resolveActiveTicketAgainst } from './pointer.mjs';
import { conflict, invalid, operational } from './errors.mjs';

/**
 * Adapt pointer.mjs's discriminated result into the domain's throwing contract.
 * pointer.mjs stays free of the error classes so the generator can copy it into
 * harnesses verbatim; the mapping back to TicketStoreError lives here.
 */
function raise(result) {
  const make = result.kind === 'conflict' ? conflict : result.kind === 'operational' ? operational : invalid;
  throw make(result.code, result.message);
}

export function resolveActiveTicket(snapshot, { root = '.', env = process.env, allowLegacyPointer = false } = {}) {
  const result = resolveActiveTicketAgainst(snapshot, { root, env, allowLegacyPointer });
  if (!result.ok) raise(result);
  if (result.value === null) return null;
  const { id, ticket, ticketHash, storeHash } = result.value;
  return { id, ticket, ticketHash, storeHash };
}

export function verifyEvidenceBinding(evidence, snapshot) {
  if (!evidence || !['ticket', 'store'].includes(evidence.bindingScope)) throw invalid('INVALID_BINDING_SCOPE', 'evidence bindingScope must be ticket or store');
  if (evidence.storeHash !== snapshot.hash && evidence.bindingScope === 'store') throw conflict('STALE_STORE_EVIDENCE', 'store-scoped evidence no longer matches the active store');
  if (evidence.bindingScope === 'ticket') {
    if (!evidence.ticket || !snapshot.get(evidence.ticket)) throw conflict('STALE_TICKET_EVIDENCE', 'evidence ticket is absent');
    if (evidence.ticketHash !== snapshot.ticketHashes[evidence.ticket]) throw conflict('STALE_TICKET_EVIDENCE', 'ticket-scoped evidence no longer matches its ticket');
  }
  return true;
}
