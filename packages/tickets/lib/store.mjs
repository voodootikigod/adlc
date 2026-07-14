import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ACTIVE_DIRECTORY, LEGACY_FILE, TRANSACTION_DIRECTORY } from './constants.mjs';
import { conflict, operational } from './errors.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { LegacyTicketStore } from './stores/legacy.mjs';

const rooted = (root, path) => isAbsolute(path) ? path : join(root, path);

export function pendingTransactions(root = '.') {
  const path = join(root, TRANSACTION_DIRECTORY);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict('RECOVERY_REQUIRED', `${path} is not a safe transaction directory`);
  return readdirSync(path).filter((entry) => !entry.startsWith('.')).sort();
}

export function resolveStoreOverride({ root = '.', ticketStore, legacyTickets, env = process.env } = {}) {
  const modern = ticketStore ?? env.ADLC_TICKET_STORE;
  const legacy = legacyTickets ?? env.ADLC_TICKETS;
  if (modern && legacy && resolve(rooted(root, modern)) !== resolve(rooted(root, legacy))) {
    throw conflict('CONFLICTING_STORE_OVERRIDE', 'ADLC_TICKET_STORE/--ticket-store conflicts with ADLC_TICKETS/--tickets');
  }
  return modern ?? legacy ?? null;
}

export function detectTicketStore(options = {}) {
  const { root = '.', allowRecovery = false } = options;
  if (!allowRecovery) {
    const pending = pendingTransactions(root);
    if (pending.length) throw conflict('RECOVERY_REQUIRED', `unfinished ticket transaction(s): ${pending.join(', ')}`);
  }
  const override = resolveStoreOverride(options);
  if (override) {
    const path = rooted(root, override);
    if (path.endsWith('.json')) return new LegacyTicketStore(path);
    return new DirectoryTicketStore(path);
  }
  const legacy = new LegacyTicketStore(join(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join(root, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict('AMBIGUOUS_STORE', 'both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration');
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational('STORE_NOT_FOUND', `no ticket store found under ${resolve(root)}`);
}

export const loadTicketSnapshot = (options = {}) => detectTicketStore(options).load();
