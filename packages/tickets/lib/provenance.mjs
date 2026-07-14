import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_TICKET_FILE } from './constants.mjs';
import { conflict, invalid } from './errors.mjs';

export function resolveActiveTicket(snapshot, { root = '.', env = process.env, allowLegacyPointer = false } = {}) {
  const envId = (env.ADLC_TICKET ?? '').trim() || null;
  const path = join(root, CURRENT_TICKET_FILE);
  let pointer = null;
  if (existsSync(path)) {
    try { pointer = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw invalid('INVALID_CURRENT_TICKET', `cannot parse ${CURRENT_TICKET_FILE}: ${error.message}`); }
  }
  const fileId = typeof pointer === 'string' ? pointer : (pointer?.id ?? pointer?.ticket ?? null);
  if (envId && fileId && envId !== fileId) throw conflict('ACTIVE_TICKET_CONFLICT', 'ADLC_TICKET conflicts with current-ticket.json');
  const id = envId ?? fileId;
  if (!id) return null;
  const ticket = snapshot.get(id);
  if (!ticket) throw invalid('ACTIVE_TICKET_MISSING', `active ticket not found: ${id}`);
  if (pointer && typeof pointer === 'object') {
    if (!pointer.ticketHash && !allowLegacyPointer) throw invalid('ACTIVE_TICKET_HASH_MISSING', 'current-ticket.json must pin ticketHash');
    if (pointer.ticketHash && pointer.ticketHash !== snapshot.ticketHashes[id]) throw conflict('ACTIVE_TICKET_STALE', `active ticket ${id} changed after selection`);
  } else if (pointer && !allowLegacyPointer) {
    throw invalid('ACTIVE_TICKET_HASH_MISSING', 'legacy string current-ticket pointer does not pin ticketHash');
  }
  return { id, ticket, ticketHash: snapshot.ticketHashes[id], storeHash: snapshot.hash };
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
