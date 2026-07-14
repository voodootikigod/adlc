import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_MANIFEST, ARCHIVE_MANIFEST, prettyCanonicalJson, ticketFilename } from '../index.mjs';

export const ticket = (id, extra = {}) => ({ id, title: `Ticket ${id}`, scope: [], rails: [], edges: [], ...extra });

export function writeLegacy(root, tickets) {
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets }, null, 2)}\n`);
}

export function writeDirectory(root, tickets, { archive = false } = {}) {
  const path = join(root, '.adlc', archive ? 'ticket-archive' : 'tickets');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.store.json'), prettyCanonicalJson(archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST));
  for (const item of tickets) writeFileSync(join(path, ticketFilename(item.id)), prettyCanonicalJson(item));
  return path;
}
