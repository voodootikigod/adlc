import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_DIRECTORY, CURRENT_TICKET_FILE, LOCK_DIRECTORY, TRANSACTION_DIRECTORY } from './constants.mjs';
import { readTicketLock } from './lock.mjs';
import { pendingTransactions } from './store.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';

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
  const currentPath = join(root, CURRENT_TICKET_FILE);
  checks.push({ name: 'current-ticket', ok: true, present: existsSync(currentPath) });
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
