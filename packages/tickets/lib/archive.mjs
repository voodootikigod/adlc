import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARCHIVE_DIRECTORY, ARCHIVE_MANIFEST } from './constants.mjs';
import { prettyCanonicalJson, sha256, ticketHash } from './canonical.mjs';
import { conflict, invalid, policy } from './errors.mjs';
import { ticketFilename } from './filename.mjs';
import { acquireTicketLock, releaseTicketLock } from './lock.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { applyDirectoryTransaction } from './transaction.mjs';
import { durableMkdir, durableWrite } from './durability.mjs';
import { validateKeyParam } from './key-contract.mjs';

function validateArchivePath(root, path) {
  const expected = resolve(root, ARCHIVE_DIRECTORY);
  if (resolve(path) !== expected) throw invalid('UNSAFE_ARCHIVE_PATH', `archive path must be ${expected}`);
}

function ensureArchive(path) {
  if (!existsSync(path)) {
    durableMkdir(path);
    durableWrite(join(path, '.store.json'), prettyCanonicalJson(ARCHIVE_MANIFEST));
  }
  const store = new DirectoryTicketStore(path, { archive: true });
  store.load();
  return store;
}

export function archiveTicket(activeStore, archivePath, id, { expectedSnapshotHash, reason = 'completed', sourceRevision = null, root = '.', authorized = false, faultInjector = null, key = null } = {}) {
  key = validateKeyParam(key);
  if (!authorized) throw policy('AUTHORIZATION_REQUIRED', 'archiving requires explicit authorization');
  validateArchivePath(root, archivePath);
  const lock = acquireTicketLock(root, { command: 'ticket:archive' });
  try {
    const active = activeStore.load();
    if (expectedSnapshotHash && active.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', 'active store changed before archive');
    const ticket = active.get(id);
    if (!ticket) throw invalid('TICKET_NOT_FOUND', `ticket not found: ${id}`);
    const inbound = active.tickets.filter((item) => item.id !== id && (item.edges ?? []).some((edge) => edge.to === id));
    if (inbound.length) throw policy('ARCHIVE_INBOUND_EDGE', `${id} is referenced by ${inbound.map((item) => item.id).join(', ')}`);
    ensureArchive(archivePath);
    const target = join(archivePath, ticketFilename(id));
    if (existsSync(target)) throw conflict('ARCHIVE_COLLISION', `archive already contains ${id}`);
    const archived = { ...JSON.parse(JSON.stringify(ticket)), _adlcArchive: { version: 1, archivedAt: new Date().toISOString(), reason, ticketHash: ticketHash(ticket), sourceStoreHash: active.hash, sourceRevision } };
    const remaining = active.mutableTickets().filter((item) => item.id !== id);
    const updated = applyDirectoryTransaction(activeStore, remaining, {
      key,
      expectedSnapshotHash: active.hash,
      operation: 'archive',
      evidenceRequired: true,
      ticketId: id,
      root,
      lock,
      faultInjector,
      auxiliaryOperations: [{ action: 'write', path: target, content: prettyCanonicalJson(archived), mustBeAbsent: true }],
      verify: () => {
        const archivedSnapshot = new DirectoryTicketStore(archivePath, { archive: true }).load();
        if (!archivedSnapshot.get(id)) throw invalid('TRANSACTION_VERIFY_FAILED', `archive transaction did not materialize ${id}`);
      },
    });
    return { active: updated, archived };
  } catch (error) {
    // Duplicate-before-removal is a detectable, recoverable failure shape; never remove
    // the archive copy here if the tracked write may have partially applied.
    throw error;
  } finally { releaseTicketLock(lock); }
}

export function restoreTicket(activeStore, archivePath, id, { expectedSnapshotHash, root = '.', authorized = false, faultInjector = null, key = null } = {}) {
  key = validateKeyParam(key);
  if (!authorized) throw policy('AUTHORIZATION_REQUIRED', 'restore requires explicit authorization');
  validateArchivePath(root, archivePath);
  const lock = acquireTicketLock(root, { command: 'ticket:restore' });
  try {
    const active = activeStore.load();
    if (expectedSnapshotHash && active.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', 'active store changed before restore');
    if (active.get(id)) throw conflict('TICKET_EXISTS', `active store already contains ${id}`);
    const archiveStore = new DirectoryTicketStore(archivePath, { archive: true });
    archiveStore.load();
    const source = join(archivePath, ticketFilename(id));
    if (!existsSync(source)) throw invalid('TICKET_NOT_FOUND', `archived ticket not found: ${id}`);
    const sourceText = readFileSync(source, 'utf8');
    const archived = JSON.parse(sourceText);
    const metadata = archived._adlcArchive;
    const ticket = { ...archived };
    delete ticket._adlcArchive;
    if (!metadata || ticketHash(ticket) !== metadata.ticketHash) throw invalid('ARCHIVE_HASH_MISMATCH', `archived ticket ${id} does not match recorded hash`);
    const restored = applyDirectoryTransaction(activeStore, [...active.mutableTickets(), ticket], {
      key,
      expectedSnapshotHash: active.hash,
      operation: 'restore',
      evidenceRequired: true,
      ticketId: id,
      root,
      lock,
      faultInjector,
      auxiliaryOperations: [{ action: 'delete', path: source, mustExist: true, expectedBeforeHash: sha256(sourceText) }],
      verify: () => {
        if (existsSync(source)) throw invalid('TRANSACTION_VERIFY_FAILED', `restore transaction did not remove archived ${id}`);
      },
    });
    return { active: restored, ticket };
  } finally { releaseTicketLock(lock); }
}
