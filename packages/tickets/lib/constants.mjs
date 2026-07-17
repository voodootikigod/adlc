export const ACTIVE_MANIFEST = Object.freeze({ format: 'adlc-ticket-directory', version: 1 });
export const ARCHIVE_MANIFEST = Object.freeze({ format: 'adlc-ticket-archive', version: 1 });
export const ACTIVE_DIRECTORY = '.adlc/tickets';
export const ARCHIVE_DIRECTORY = '.adlc/ticket-archive';
export const LEGACY_FILE = '.adlc/tickets.json';
export const LEGACY_ARCHIVE_FILE = '.adlc/tickets.archive.json';
export const LOCK_DIRECTORY = '.adlc/tickets.lock';
export const TRANSACTION_DIRECTORY = '.adlc/ticket-transactions';
// Re-exported, not redefined: pointer.mjs owns the pointer contract and is the
// file the generator copies into harnesses, so the path must have one definition.
export { CURRENT_TICKET_FILE } from './pointer.mjs';
export const TICKET_HASH_DOMAIN = 'adlc:ticket:v1\0';
export const STORE_HASH_DOMAIN = 'adlc:active-store:v1\0';
