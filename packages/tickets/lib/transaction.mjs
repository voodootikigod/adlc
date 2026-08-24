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
import { validateKeyParam } from './key-contract.mjs';
import { assertSignableTrustRootWrite, assertWriteIsSignable, repoDeclaresRails, storeDeclaresRails } from './trust-root.mjs';

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

/**
 * Does this transaction actually change anything?
 *
 * Computed from the LOGICAL content, before any filesystem work, so a converged
 * transaction can be recognised without side effects. A no-op must not be audited:
 * demanding a key to apply nothing would break ordinary idempotent syncing, and
 * recording an entry whose storeHashBefore equals its storeHashAfter would claim a
 * mutation that never happened — scheduled pulls would grow the append-only
 * manifest forever with records of nothing. Auxiliary operations count as change:
 * archive and restore move a shard between stores, which is the whole point of them
 * even when the active set's hash is unaffected.
 */
function transactionChangesAnything(before, tickets, auxiliaryOperations) {
  return storeHash(tickets) !== before.hash || auxiliaryOperations.length > 0;
}

/**
 * Decide how this mutation must be audited, and REFUSE it here if it cannot be.
 *
 * T-01M0122WMF8EJTB7ERHTEG8HMJ. Once a ticket declares a rail the store is a frozen
 * trust root: the rail hook already denies a structured edit to it unless the
 * override is recorded to the gate-manifest, and the ticket-authoring flow tells
 * operators that editing the ticket set while rails are frozen is "a deliberate,
 * audited action". Reaching the same bytes through the CLI is the same act, so it
 * carries the same audit — enforced HERE, in the one function every door goes
 * through, rather than in a bin that a different caller can route around.
 *
 * Returns null when the store is not a trust root (a pre-bootstrap repo keeps
 * zero-ceremony authoring), otherwise the gate and before-hash the audit entry
 * needs.
 *
 * ONE ENTRY PER MUTATION. A sensitive mutation (rail narrowing, completion,
 * reassignment) already records a `ticket-<operation>` entry; it keeps that gate
 * and gains the audit fields, so auditing the override never turns one mutation
 * into two manifest lines. Everything else records under `ticket-mutation`.
 *
 * The key rule follows #370: recording is a SIGNING operation, so with no key it
 * cannot do its job, and an unsigned entry proves nothing about who made the
 * change. Refusing BEFORE the journal is written (rather than warning after) is
 * what makes the store byte-identical on refusal — the manifest is append-only, so
 * an entry written in error is permanent, and a mutation applied without one is a
 * hole that cannot be closed after the fact.
 */
function bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) {
  if (!assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root })) return null;
  return { gate: evidenceRequired ? `ticket-${operation}` : 'ticket-mutation', storeHashBefore: before.hash };
}

export function applyDirectoryTransaction(store, tickets, { expectedSnapshotHash, operation = 'update', evidenceRequired = false, ticketId = null, beforeTicketId = null, root = '.', faultInjector = null, lock: existingLock = null, auxiliaryOperations = [], verify = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key); // before ANY journal/lock/mutation — an invalid key must be side-effect-free
  validateTickets(tickets);
  const transactionId = randomUUID();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', `expected ${expectedSnapshotHash}, found ${before.hash}`);
    // Before ANY journal or staging directory exists, so a refusal leaves the
    // repository exactly as it found it — no store change, no pending transaction.
    const bypassAudit = transactionChangesAnything(before, tickets, auxiliaryOperations)
      ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root })
      : null;
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
    const journal = { version: 1, id: transactionId, operation, state: 'prepared', beforeHash: before.hash, afterHash, evidenceRequired, bypassAudit: bypassAudit !== null, ticketId, ...binding, storePath: relative(root, store.path), operations };
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
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...(bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}),
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

export function applyLegacyTransaction(store, tickets, { expectedSnapshotHash, operation = 'update', evidenceRequired = false, ticketId = null, beforeTicketId = null, root = '.', faultInjector = null, lock: existingLock = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  validateTickets(tickets);
  const transactionId = randomUUID();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict('STALE_SNAPSHOT', `expected ${expectedSnapshotHash}, found ${before.hash}`);
    // Same placement as the directory path: before any staging directory exists.
    const bypassAudit = transactionChangesAnything(before, tickets, [])
      ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root })
      : null;
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
      bypassAudit: bypassAudit !== null,
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
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...(bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}),
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

/**
 * Every shard this transaction WROTE — added or replaced.
 *
 * All of them carry the transaction's own effects, so none is evidence about the
 * store as it stood BEFORE. Added shards did not exist; replaced ones now hold
 * post-change content, which is why excluding only the additions was not enough —
 * an update that adds the first rail to an existing rails-free ticket left that
 * ticket looking railed and made a keyless recovery impossible.
 *
 * Nothing is lost by excluding them: the PRE-transaction content of every replaced
 * or deleted shard lives in the journal's backups, which journalBackupsDeclareRails
 * reads directly.
 */
function writtenShardFilenames(journal) {
  const written = new Set();
  for (const operation of journal.operations ?? []) {
    if (operation?.action === 'write' && typeof operation.filename === 'string') {
      written.add(operation.filename);
    }
  }
  return written;
}

/**
 * Whether any shard this transaction was about to replace or delete declared a
 * rail — read from the journal's own backup copies (ticket shards, the legacy store
 * envelope, and archive shards alike), which hold the PRE-transaction content. This is how a recovery can still tell that it is touching a trust root
 * after the transaction being recovered removed the last rail from the store.
 *
 * Fails closed on a backup that is present but unreadable.
 */
function journalBackupsDeclareRails(root, journal) {
  for (const operation of journal.operations ?? []) {
    // AUXILIARY backups are included, not skipped. A restore represents the removal
    // of the archived shard as an auxiliary delete, and that backup holds the
    // archived TICKET — which, when it was the last railed one anywhere, is the only
    // surviving proof the repo used rails at all. Skipping it left a keyless
    // completion of exactly that recovery.
    if (!operation?.backup) continue;
    try {
      const path = resolve(root, operation.backup);
      // VERIFY BEFORE TRUSTING. The journal records each backup's pre-transaction
      // hash and recovery already checks it on the rollback path; checking it here
      // too means a backup swapped for a rails-free one is caught rather than
      // believed. It does not make the journal authenticated — an attacker who
      // rewrites `beforeHash` alongside the file defeats it, which is why the
      // append-only manifest marker is the tamper-resistant floor — but it closes
      // the cheaper half of the attack, where only the backup is replaced.
      if (typeof operation.beforeHash === 'string' && fileHash(path) !== operation.beforeHash) return true;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      // A legacy-store backup is the whole `{ tickets: [...] }` envelope; a shard
      // backup is one ticket.
      if (storeDeclaresRails(Array.isArray(parsed?.tickets) ? parsed.tickets : [parsed])) return true;
    } catch { return true; }
  }
  return false;
}

export function recoverDirectoryTransaction(store, transactionId, { root = '.', direction, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!['complete', 'rollback'].includes(direction)) throw invalid('RECOVERY_DIRECTION_REQUIRED', 'choose complete or rollback');
  const { transactionRoot, journal } = loadJournal(root, transactionId);
  const lock = acquireTicketLock(root, { transactionId, command: `ticket:recover:${direction}` });
  try {
    // Recovery drives the store to a new state in BOTH directions, so it is a
    // trust-root write like any other and is held to the same rule — checked here,
    // before the first operation is applied.
    //
    // Whether an audit is owed is answered by the STORE, and the journal may only
    // ADD to that answer — never subtract from it.
    //
    // The journal is ordinary filesystem state, not authenticated evidence. Taking
    // `bypassAudit` as authoritative whenever it is a boolean would mean flipping
    // that one field from true to false in a text editor turns off both the
    // missing-key refusal and the audit itself. Deriving the predicate from the
    // tickets on disk cannot be switched off that way. Three sources, OR-ed, none
    // of which the journal's own claim can subtract from:
    //
    //   1. the repo as it stood BEFORE this transaction — the current store minus
    //      every shard this transaction wrote, plus the archive and the manifest.
    //      Subtracting them matters: a create (or an update) that introduces the
    //      FIRST rail leaves a store that looks frozen the moment its shard lands,
    //      and reading it whole would demand a key to recover a mutation that
    //      legitimately needed none — a deadlock in both directions for ordinary
    //      keyless authoring. Their pre-transaction content is not lost; it is in
    //      the backups, read next;
    //   2. the journal's BACKUPS — the pre-transaction copy of every shard this
    //      transaction replaced or deleted. That is what catches the case the store
    //      can no longer answer: a transaction that removed or un-railed the last
    //      railed ticket leaves an unrailed store behind, so recovering it would
    //      look ordinary. The backups are hash-verified against the journal further
    //      down, and an unreadable one fails closed here;
    //   3. the journal's own flag, which can only ADD.
    let storeIsTrustRoot;
    let preRecoveryHash = null;
    try {
      const current = store.load();
      // A LEGACY journal names one envelope target (.adlc/tickets.json), not shard
      // filenames, so the shard filter below would match nothing and leave the whole
      // post-change store in the reconstruction — deadlocking the keyless recovery
      // of a legacy write that introduced the first rail. That write replaced the
      // entire envelope, so none of the current tickets is evidence about the
      // pre-state; the backup is, and journalBackupsDeclareRails reads it.
      const wholeStoreReplaced = (journal.operations ?? []).some((operation) => operation?.role === 'legacy-store');
      const written = writtenShardFilenames(journal);
      const preTransaction = wholeStoreReplaced
        ? []
        : current.tickets.filter((item) => !written.has(ticketFilename(item.id)));
      storeIsTrustRoot = repoDeclaresRails(root, preTransaction);
      preRecoveryHash = current.hash;
    } catch { storeIsTrustRoot = true; }
    const recoveryIsTrustRootWrite = storeIsTrustRoot
      || journalBackupsDeclareRails(root, journal)
      || journal.bypassAudit === true;
    if (recoveryIsTrustRootWrite) assertWriteIsSignable({ key, allowUnsigned });
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
    // A recovered transaction leaves the store in a state it was driven to, so it
    // is audited on exactly the terms the original mutation was. The gate and the
    // before-hash are RECOMPUTED from the journal's own trusted fields rather than
    // read back out of `bypassAudit`, so a hand-edited journal cannot choose the
    // gate an entry is filed under.
    // storeHashBefore is the hash the store ACTUALLY held when this recovery
    // started, read above, not the journal's record of where the interrupted
    // transaction began. A crash can leave the store part-way between the two, and
    // on a rollback especially, naming journal.beforeHash would claim a transition
    // that did not happen: the audit would bind the wrong pair of hashes and the
    // real intermediate state would go unrecorded. The journal's value is the
    // fallback for a store that would not load at all.
    const recoveryAudit = recoveryIsTrustRootWrite
      ? {
        gate: journal.evidenceRequired ? `ticket-${journal.operation}` : 'ticket-mutation',
        storeHashBefore: preRecoveryHash ?? journal.beforeHash,
      }
      : null;
    if (journal.evidenceRequired || recoveryAudit) {
      const recoveredTicketId = direction === 'rollback' ? journal.beforeTicketId ?? journal.ticketId : journal.ticketId;
      const recordedTicketHash = direction === 'rollback' ? journal.beforeTicketHash : journal.afterTicketHash;
      const recoveredTicketHash = recoveredTicketId ? snapshot.ticketHashes[recoveredTicketId] ?? recordedTicketHash ?? null : null;
      if (recoveredTicketId && !recoveredTicketHash) throw invalid('RECOVERY_EVIDENCE_UNBOUND', `cannot bind recovery evidence to ticket ${recoveredTicketId}`);
      // COMPLETING a recovery finishes the ORIGINAL mutation, so the ledger must
      // carry that transition too — beforeHash → afterHash — and not only the
      // recovery's own step. A crash between applying the shards and appending the
      // evidence would otherwise leave the recover-complete entry as the sole
      // record, bound from the already-applied after-state to itself: the real
      // before → after mutation of a trust root would appear nowhere, and removing
      // the journal below takes the last trace of it with it.
      //
      // Idempotent per transactionId/action, so when the original apply DID record
      // before the crash this is a no-op. acceptLegacyMatch covers the journal that
      // predates the audit payload, whose entry can never grow one.
      // Rollback records no apply entry: that transition was undone, not completed.
      if (direction === 'complete' && recoveryAudit) {
        recordTicketEvidence(root, {
          key,
          transactionId,
          operation: journal.operation,
          ticketId: journal.ticketId,
          ticketHash: journal.afterTicketHash,
          storeHash: journal.afterHash,
          gate: recoveryAudit.gate,
          bypass: true,
          storeHashBefore: journal.beforeHash,
          acceptLegacyMatch: true,
        });
      }
      recordTicketEvidence(root, {
        key,
        transactionId,
        operation: journal.operation,
        action: `recover-${direction}`,
        ticketId: recoveredTicketId,
        ticketHash: recoveredTicketHash,
        storeHash: snapshot.hash,
        // On a rollback the store is back at `beforeHash`, so before and after
        // hashes match — which is precisely what the audit should say happened.
        ...(recoveryAudit ? { gate: recoveryAudit.gate, bypass: true, storeHashBefore: recoveryAudit.storeHashBefore } : {}),
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
