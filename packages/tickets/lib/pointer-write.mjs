// Writing the active-ticket pointer.
//
// Deliberately NOT part of pointer.mjs: that module is generated verbatim into
// every harness, and generated loaders never write (spec §14). Keeping the writer
// here is what lets the reader be copied into a hook without carrying a write path
// along with it.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CURRENT_TICKET_FILE } from './pointer.mjs';

let sequence = 0;

/**
 * Point the worktree at `id`, atomically.
 *
 * Every hook re-reads the pointer on each tool call, so a plain writeFileSync
 * exposes a torn read to whatever is gating concurrently. Writing a temp file in
 * the same directory and renaming it into place makes the swap atomic on POSIX
 * and Windows: a concurrent reader sees the old pointer or the new one.
 *
 * Always emits the canonical `{id, ticketHash}` — never a deprecated alias.
 *
 * @param {string} root - worktree root
 * @param {{id: string, ticketHash: string}} pointer
 * @returns {string} the path written
 */
export function writeActiveTicket(root, { id, ticketHash } = {}) {
  const cleanId = typeof id === 'string' ? id.trim() : '';
  const cleanHash = typeof ticketHash === 'string' ? ticketHash.trim() : '';
  // Refuse to write a pointer our own strict reader would reject.
  if (!cleanId) throw new TypeError('writeActiveTicket requires a non-empty string id');
  if (!cleanHash) throw new TypeError('writeActiveTicket requires a non-empty string ticketHash');

  const path = join(root, CURRENT_TICKET_FILE);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  sequence += 1;
  const temp = join(directory, `current-ticket.json.${process.pid}.${sequence}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ id: cleanId, ticketHash: cleanHash }, null, 2)}\n`);
  renameSync(temp, path);
  return path;
}
