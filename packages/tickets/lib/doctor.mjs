import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_DIRECTORY, CURRENT_TICKET_FILE, LOCK_DIRECTORY, TRANSACTION_DIRECTORY } from './constants.mjs';
import { readTicketLock } from './lock.mjs';
import { readActiveTicketPointer, resolveActiveTicketAgainst } from './pointer.mjs';
import { pendingTransactions } from './store.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';

/**
 * Validate `.adlc/current-ticket.json` the way the gates read it.
 *
 * This used to be `{ok: true, present: existsSync(...)}` — presence only, never
 * parsed, resolved, or hash-checked — so a pointer naming already-merged work, or
 * one whose key no reader recognized, passed doctor clean right up until a hook
 * failed closed on it. Doctor now answers the question that matters: would the
 * gates accept this pointer?
 *
 * Read-only and offline, like every other doctor check.
 */
function currentTicketCheck(root, snapshot) {
  const check = { name: 'current-ticket', ok: true, present: existsSync(join(root, CURRENT_TICKET_FILE)) };
  if (!check.present) return check; // absent is inert, not broken
  if (!snapshot) return { ...check, ok: false, code: 'ACTIVE_STORE_UNREADABLE', message: 'cannot validate the pointer: the ticket store did not load' };

  const pointer = readActiveTicketPointer(root);
  if (!pointer.ok) return { ...check, ok: false, code: pointer.code, message: pointer.message };
  if (pointer.value.deprecatedAlias) check.deprecatedAlias = pointer.value.deprecatedAlias;

  // Strict: doctor reports what 2.0 will enforce, so a hash-less pointer that the
  // 1.x bridge still resolves is surfaced here rather than discovered at the cliff.
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env: {}, allowLegacyPointer: false });
  if (!resolved.ok) return { ...check, ok: false, id: pointer.value.id, code: resolved.code, message: resolved.message };

  check.id = resolved.value.id;
  if (resolved.value.warnings.length) check.warnings = resolved.value.warnings;
  return check;
}

export function doctorTicketStore(store, { root = '.', archive = false } = {}) {
  const checks = [];
  let snapshot = null;
  try {
    snapshot = store.load();
    checks.push({ name: 'active-store', ok: true, backend: snapshot.backend, ticketCount: snapshot.tickets.length, storeHash: snapshot.hash });
  } catch (error) {
    checks.push({ name: 'active-store', ok: false, code: error.code ?? 'UNEXPECTED', message: error.message });
  }
  const transactions = pendingTransactions(root);
  checks.push({ name: 'transactions', ok: transactions.length === 0, pending: transactions });
  const lockPath = join(root, LOCK_DIRECTORY);
  checks.push({ name: 'writer-lock', ok: !existsSync(lockPath), present: existsSync(lockPath), metadata: readTicketLock(root) });
  checks.push(currentTicketCheck(root, snapshot));
  if (archive) {
    const path = join(root, ARCHIVE_DIRECTORY);
    if (!existsSync(path)) checks.push({ name: 'archive', ok: true, present: false, ticketCount: 0 });
    else {
      try {
        const archived = new DirectoryTicketStore(path, { archive: true }).load();
        const collisions = snapshot ? archived.tickets.filter((ticket) => snapshot.get(ticket.id)).map((ticket) => ticket.id) : [];
        checks.push({ name: 'archive', ok: collisions.length === 0, present: true, ticketCount: archived.tickets.length, collisions });
      } catch (error) { checks.push({ name: 'archive', ok: false, code: error.code ?? 'UNEXPECTED', message: error.message }); }
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
