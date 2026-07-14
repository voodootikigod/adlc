import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVE_MANIFEST, ARCHIVE_DIRECTORY, ARCHIVE_MANIFEST, LEGACY_FILE, TRANSACTION_DIRECTORY } from './constants.mjs';
import { prettyCanonicalJson, sha256, storeHash, ticketHash } from './canonical.mjs';
import { conflict, invalid, operational } from './errors.mjs';
import { ticketFilename } from './filename.mjs';
import { acquireTicketLock, releaseTicketLock } from './lock.mjs';
import { validateTickets } from './schema.mjs';
import { recordTicketEvidence } from './evidence.mjs';
import { durableCopy, durableMkdir, durableRemove, durableRename, durableWrite } from './durability.mjs';

const fileHash = (path) => sha256(readFileSync(path));
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

function safeJournalPath(root, value, label, { permittedExternalTarget = null, permittedExternalRoot = null } = {}) {
  if (typeof value !== 'string' || !value) throw invalid('INVALID_JOURNAL', `${label} must be a non-empty relative path`);
  const absolute = resolve(root, value);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    if (permittedExternalTarget && absolute === resolve(permittedExternalTarget)) return absolute;
    if (permittedExternalRoot && isWithin(permittedExternalRoot, absolute)) return absolute;
    throw invalid('UNSAFE_JOURNAL_PATH', `${label} escapes the repository: ${value}`);
  }
  return absolute;
}

function journalPath(root, path) {
  const absolute = resolve(path);
  const rel = relative(resolve(root), absolute);
  return rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel) ? rel : absolute;
}

const SHARD_FILENAME = /^[a-z0-9][a-z0-9-]*--[0-9a-f]{64}\.json$/;

function assertExactJournalPath(actual, expected, label) {
  if (resolve(actual) !== resolve(expected)) throw invalid('INVALID_JOURNAL', `${label} does not match the transaction layout`);
}

function validateRecoveryOperation({ root, store, transactionRoot, journal, item, index, target }) {
  const directoryStore = store.archive !== undefined;
  const role = item.role ?? (directoryStore && dirname(target) === resolve(store.path) ? 'ticket' : directoryStore ? 'auxiliary' : 'legacy-store');
  let key;

  if (role === 'legacy-store') {
    if (directoryStore || journal.operations.length !== 1 || item.action !== 'write') {
      throw invalid('INVALID_JOURNAL', 'legacy recovery must contain exactly one store write');
    }
    assertExactJournalPath(target, store.path, 'legacy operation target');
    key = basename(store.path);
  } else if (role === 'ticket') {
    if (!directoryStore || dirname(target) !== resolve(store.path) || basename(target) !== item.filename || !SHARD_FILENAME.test(item.filename)) {
      throw invalid('INVALID_JOURNAL', 'ticket recovery target is not a shard in the configured store');
    }
    key = item.filename;
  } else if (role === 'auxiliary') {
    const expectedAction = journal.operation === 'archive' ? 'write' : journal.operation === 'restore' ? 'delete' : null;
    if (!directoryStore || !expectedAction || item.action !== expectedAction || typeof journal.ticketId !== 'string') {
      throw invalid('INVALID_JOURNAL', 'auxiliary recovery is only valid for archive or restore');
    }
    assertExactJournalPath(target, join(root, ARCHIVE_DIRECTORY, ticketFilename(journal.ticketId)), 'archive operation target');
    const priorAuxiliaryCount = journal.operations.slice(0, index).filter((operation) => operation?.role === 'auxiliary').length;
    key = `aux-${priorAuxiliaryCount}`;
  } else {
    throw invalid('INVALID_JOURNAL', `unsupported recovery operation role: ${role}`);
  }

  if (item.action === 'write') {
    const stage = safeJournalPath(root, item.stage, 'operation stage');
    assertExactJournalPath(stage, join(transactionRoot, 'stage', key), 'operation stage');
  } else if (item.stage !== null && item.stage !== undefined) {
    throw invalid('INVALID_JOURNAL', 'delete recovery operation must not contain a stage');
  }
  if (item.backup) {
    const backup = safeJournalPath(root, item.backup, 'operation backup');
    assertExactJournalPath(backup, join(transactionRoot, 'backup', key), 'operation backup');
  }
}

function evidenceBinding(before, tickets, ticketId, beforeTicketId = null) {
  const priorId = beforeTicketId ?? ticketId;
  const desired = ticketId ? tickets.find((ticket) => ticket.id === ticketId) : null;
  const logicalTicketHash = desired ? ticketHash(desired) : null;
  return {
    beforeTicketId: priorId,
    beforeTicketHash: priorId ? before.ticketHashes[priorId] ?? (priorId === ticketId ? logicalTicketHash : null) : null,
    afterTicketHash: ticketId ? logicalTicketHash ?? before.ticketHashes[priorId] ?? null : null,
  };
}

export function applyDirectoryTransaction(store, tickets, { expectedSnapshotHash, operation = 'update', evidenceRequired = false, ticketId = null, beforeTicketId = null, root = '.', faultInjector = null, lock: existingLock = null, auxiliaryOperations = [], verify = null } = {}) {
  validateTickets(tickets);
  const transactionId = randomUUID();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const byFilename = new Map(tickets.map((ticket) => [ticketFilename(ticket.id), ticket]));
    const currentFilenames = new Set(before.tickets.map((ticket) => ticketFilename(ticket.id)));
    durableMkdir(join(transactionRoot, 'stage'));
    durableMkdir(join(transactionRoot, 'backup'));
    const operations = [];
    for (const [filename, ticket] of byFilename) {
      const target = join(store.path, filename);
      const stage = join(transactionRoot, 'stage', filename);
      const nextText = prettyCanonicalJson(ticket);
      if (existsSync(target) && readFileSync(target, 'utf8') === nextText) continue;
      durableWrite(stage, nextText);
      let backup = null;
      let beforeHash = null;
      if (existsSync(target)) {
        backup = join(transactionRoot, 'backup', filename);
        durableCopy(target, backup);
        beforeHash = fileHash(backup);
      }
      operations.push({ role: 'ticket', action: 'write', filename, target: journalPath(root, target), stage: relative(root, stage), backup: backup && relative(root, backup), beforeHash, afterHash: sha256(nextText) });
    }
    for (const filename of currentFilenames) {
      if (byFilename.has(filename)) continue;
      const target = join(store.path, filename);
      const backup = join(transactionRoot, 'backup', filename);
      durableCopy(target, backup);
      operations.push({ role: 'ticket', action: 'delete', filename, target: journalPath(root, target), stage: null, backup: relative(root, backup), beforeHash: fileHash(backup), afterHash: null });
    }
    for (const [index, auxiliary] of auxiliaryOperations.entries()) {
      if (!['write', 'delete'].includes(auxiliary.action)) throw invalid('INVALID_AUXILIARY_OPERATION', `unsupported auxiliary action: ${auxiliary.action}`);
      const absoluteTarget = resolve(isAbsolute(auxiliary.path) ? auxiliary.path : join(root, auxiliary.path));
      const relativeTarget = relative(resolve(root), absoluteTarget);
      if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeTarget)) {
        throw invalid('UNSAFE_TRANSACTION_PATH', `auxiliary target escapes the repository: ${auxiliary.path}`);
      }
      const exists = existsSync(absoluteTarget);
      if (auxiliary.mustBeAbsent && exists) throw conflict('AUXILIARY_TARGET_EXISTS', `auxiliary target already exists: ${relativeTarget}`);
      if (auxiliary.mustExist && !exists) throw conflict('AUXILIARY_TARGET_MISSING', `auxiliary target is missing: ${relativeTarget}`);
      const currentHash = exists ? fileHash(absoluteTarget) : null;
      if (auxiliary.expectedBeforeHash && currentHash !== auxiliary.expectedBeforeHash) throw conflict('STALE_AUXILIARY_TARGET', `auxiliary target changed: ${relativeTarget}`);
      const key = `aux-${index}`;
      let backup = null;
      if (exists) {
        backup = join(transactionRoot, 'backup', key);
        durableCopy(absoluteTarget, backup);
      }
      if (auxiliary.action === 'write') {
        const stage = join(transactionRoot, 'stage', key);
        durableWrite(stage, auxiliary.content);
        operations.push({ role: 'auxiliary', action: 'write', filename: relativeTarget, target: relativeTarget, stage: relative(root, stage), backup: backup && relative(root, backup), beforeHash: currentHash, afterHash: sha256(auxiliary.content) });
      } else {
        operations.push({ role: 'auxiliary', action: 'delete', filename: relativeTarget, target: relativeTarget, stage: null, backup: backup && relative(root, backup), beforeHash: currentHash, afterHash: null });
      }
    }
    const afterHash = storeHash(tickets);
    const binding = evidenceBinding(before, tickets, ticketId, beforeTicketId);
    const journal = { version: 1, id: transactionId, operation, state: 'prepared', beforeHash: before.hash, afterHash, evidenceRequired, ticketId, ...binding, storePath: relative(root, store.path), operations };
    durableWrite(join(transactionRoot, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    faultInjector?.('journal-prepared', { transactionId, operations: operations.length });
    let applied = 0;
    for (const item of operations) {
      const target = resolve(root, item.target);
      if (item.action === 'write') {
        const temporary = `${target}.txn-${transactionId}`;
        durableCopy(resolve(root, item.stage), temporary);
        durableRename(temporary, target);
      } else if (existsSync(target)) {
        durableRemove(target);
      }
      applied += 1;
      faultInjector?.(`operation-applied:${applied}`, { transactionId, operation: item });
    }
    faultInjector?.('before-final-verify', { transactionId });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid('TRANSACTION_VERIFY_FAILED', `transaction produced ${after.hash}, expected ${afterHash}`);
    verify?.(after);
    if (evidenceRequired) recordTicketEvidence(root, {
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
    });
    journal.state = 'complete';
    durableWrite(join(transactionRoot, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync(join(transactionRoot, 'journal.json')) && existsSync(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}

export function applyLegacyTransaction(store, tickets, { expectedSnapshotHash, operation = 'update', evidenceRequired = false, ticketId = null, beforeTicketId = null, root = '.', faultInjector = null, lock: existingLock = null } = {}) {
  validateTickets(tickets);
  const transactionId = randomUUID();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', `expected ${expectedSnapshotHash}, found ${before.hash}`);
    // The configured store is the trust anchor. It may intentionally be outside the
    // repository during the 1.x compatibility window; recovery later requires the
    // journal target to match this exact configured path.
    const target = resolve(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join(transactionRoot, 'stage', basename(store.path));
    const backup = join(transactionRoot, 'backup', basename(store.path));
    durableMkdir(dirname(stage));
    durableMkdir(dirname(backup));
    durableWrite(stage, prettyCanonicalJson({ tickets }));
    durableCopy(target, backup);
    const afterHash = storeHash(tickets);
    const binding = evidenceBinding(before, tickets, ticketId, beforeTicketId);
    const journal = {
      version: 1,
      id: transactionId,
      operation,
      state: 'prepared',
      beforeHash: before.hash,
      afterHash,
      evidenceRequired,
      ticketId,
      ...binding,
      storePath: recordedTarget,
      operations: [{
        role: 'legacy-store',
        action: 'write',
        filename: recordedTarget,
        target: recordedTarget,
        stage: relative(root, stage),
        backup: relative(root, backup),
        beforeHash: fileHash(backup),
        afterHash: fileHash(stage),
      }],
    };
    durableWrite(join(transactionRoot, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    faultInjector?.('journal-prepared', { transactionId, operations: 1 });
    const temporary = `${target}.txn-${transactionId}`;
    durableCopy(stage, temporary);
    durableRename(temporary, target);
    faultInjector?.('operation-applied:1', { transactionId, operation: journal.operations[0] });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid('TRANSACTION_VERIFY_FAILED', `transaction produced ${after.hash}, expected ${afterHash}`);
    if (evidenceRequired) recordTicketEvidence(root, {
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
    });
    journal.state = 'complete';
    durableWrite(join(transactionRoot, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync(join(transactionRoot, 'journal.json')) && existsSync(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}

function loadJournal(root, transactionId) {
  if (!TRANSACTION_ID.test(transactionId)) throw invalid('INVALID_TRANSACTION_ID', `invalid transaction id: ${transactionId}`);
  const transactionRoot = join(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const journal = JSON.parse(readFileSync(join(transactionRoot, 'journal.json'), 'utf8'));
    if (!journal || journal.version !== 1 || journal.operation === 'migrate' || !Array.isArray(journal.operations)) throw new Error('unsupported journal shape');
    return { transactionRoot, journal };
  }
  catch (error) { throw invalid('INVALID_JOURNAL', `cannot read transaction ${transactionId}: ${error.message}`); }
}

export function recoverDirectoryTransaction(store, transactionId, { root = '.', direction } = {}) {
  if (!['complete', 'rollback'].includes(direction)) throw invalid('RECOVERY_DIRECTION_REQUIRED', 'choose complete or rollback');
  const { transactionRoot, journal } = loadJournal(root, transactionId);
  const lock = acquireTicketLock(root, { transactionId, command: `ticket:recover:${direction}` });
  try {
    let permittedExternalTarget = null;
    let permittedExternalRoot = null;
    if (store.path && journal.storePath) {
      const configuredStorePath = resolve(store.path);
      const recordedStorePath = resolve(root, journal.storePath);
      if (recordedStorePath !== configuredStorePath) throw invalid('INVALID_JOURNAL', 'journal store path does not match the configured recovery store');
      const rel = relative(resolve(root), configuredStorePath);
      if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
        if (store.archive === undefined) permittedExternalTarget = configuredStorePath;
        else permittedExternalRoot = configuredStorePath;
      }
    }
    for (const [index, item] of journal.operations.entries()) {
      if (!item || !['write', 'delete'].includes(item.action)) throw invalid('INVALID_JOURNAL', 'journal contains an unsupported operation');
      const target = safeJournalPath(root, item.target, 'operation target', { permittedExternalTarget, permittedExternalRoot });
      validateRecoveryOperation({ root, store, transactionRoot, journal, item, index, target });
      if (direction === 'complete') {
        if (item.action === 'delete') {
          if (existsSync(target)) durableRemove(target);
          continue;
        }
        const stage = safeJournalPath(root, item.stage, 'operation stage');
        if (!existsSync(stage) || fileHash(stage) !== item.afterHash) throw invalid('CORRUPT_STAGE', `cannot verify staged ${item.filename}`);
        const temporary = `${target}.recovery-${transactionId}`;
        durableCopy(stage, temporary);
        durableRename(temporary, target);
      } else if (item.backup) {
        const backup = safeJournalPath(root, item.backup, 'operation backup');
        if (!existsSync(backup) || fileHash(backup) !== item.beforeHash) throw invalid('CORRUPT_BACKUP', `cannot verify backup ${item.filename}`);
        const temporary = `${target}.rollback-${transactionId}`;
        durableCopy(backup, temporary);
        durableRename(temporary, target);
      } else if (existsSync(target)) {
        durableRemove(target);
      }
    }
    const snapshot = store.load();
    const expected = direction === 'complete' ? journal.afterHash : journal.beforeHash;
    if (snapshot.hash !== expected) throw invalid('RECOVERY_VERIFY_FAILED', `recovery produced ${snapshot.hash}, expected ${expected}`);
    if (journal.evidenceRequired) {
      const recoveredTicketId = direction === 'rollback' ? journal.beforeTicketId ?? journal.ticketId : journal.ticketId;
      const recordedTicketHash = direction === 'rollback' ? journal.beforeTicketHash : journal.afterTicketHash;
      const recoveredTicketHash = recoveredTicketId ? snapshot.ticketHashes[recoveredTicketId] ?? recordedTicketHash ?? null : null;
      if (recoveredTicketId && !recoveredTicketHash) throw invalid('RECOVERY_EVIDENCE_UNBOUND', `cannot bind recovery evidence to ticket ${recoveredTicketId}`);
      recordTicketEvidence(root, {
        transactionId,
        operation: journal.operation,
        action: `recover-${direction}`,
        ticketId: recoveredTicketId,
        ticketHash: recoveredTicketHash,
        storeHash: snapshot.hash,
      });
    }
    durableRemove(transactionRoot, { recursive: true, force: true });
    return snapshot;
  } finally {
    releaseTicketLock(lock);
  }
}

export function initializeDirectoryStore(path) {
  if (existsSync(path)) throw conflict('STORE_EXISTS', `store already exists: ${path}`);
  durableMkdir(path);
  durableWrite(join(path, '.store.json'), prettyCanonicalJson(ACTIVE_MANIFEST));
}

export function initializeTicketStores(root = '.') {
  const legacyPath = join(root, LEGACY_FILE);
  const activePath = join(root, '.adlc/tickets');
  const archivePath = join(root, '.adlc/ticket-archive');
  if (existsSync(legacyPath) && existsSync(activePath)) throw conflict('AMBIGUOUS_STORE', 'both legacy and directory ticket stores exist');
  if (existsSync(legacyPath)) return { backend: 'legacy', created: false, legacyMigrationAvailable: true };
  let activeCreated = false;
  let archiveCreated = false;
  if (!existsSync(activePath)) { initializeDirectoryStore(activePath); activeCreated = true; }
  if (!existsSync(archivePath)) {
    durableMkdir(archivePath);
    durableWrite(join(archivePath, '.store.json'), prettyCanonicalJson(ARCHIVE_MANIFEST));
    archiveCreated = true;
  }
  return { backend: 'directory', created: activeCreated || archiveCreated, activeCreated, archiveCreated, legacyMigrationAvailable: false };
}
