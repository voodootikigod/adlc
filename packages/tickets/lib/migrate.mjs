import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVE_DIRECTORY, ACTIVE_MANIFEST, ARCHIVE_DIRECTORY, ARCHIVE_MANIFEST, LEGACY_ARCHIVE_FILE, LEGACY_FILE, TRANSACTION_DIRECTORY } from './constants.mjs';
import { prettyCanonicalJson, sha256, storeHash } from './canonical.mjs';
import { conflict, operational, policy } from './errors.mjs';
import { ticketFilename } from './filename.mjs';
import { acquireTicketLock, releaseTicketLock } from './lock.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { LegacyTicketStore } from './stores/legacy.mjs';
import { recordTicketEvidence } from './evidence.mjs';
import { validateTickets } from './schema.mjs';
import { durableCopy, durableMkdir, durableRemove, durableRename, durableWrite } from './durability.mjs';
import { validateKeyParam } from './key-contract.mjs';
import { assertSignableTrustRootWrite, assertWriteIsSignable, repoDeclaresRails, storeDeclaresRails } from './trust-root.mjs';

/** A directory store announces itself with this marker file, wherever it lives. */
const STORE_MARKER = '.store.json';

// The tracked surface of `.adlc/` after a migration. `!.adlc/manifest.jsonl` is
// NOT optional: the rails-guard CI migration gate requires hash-bound
// ticket-migrate/apply evidence to exist in a fresh checkout, and without this
// negation the ledger stays ignored, `git add -A` silently omits it, and the
// migration PR the documented command sequence produces is REJECTED for missing
// evidence.
const GITIGNORE_STANZA = [
  '.adlc/*',
  '!.adlc/tickets.json',
  '!.adlc/tickets/',
  '!.adlc/tickets/**',
  '!.adlc/ticket-archive/',
  '!.adlc/ticket-archive/**',
  '!.adlc/specs/',
  '!.adlc/manifest.jsonl',
  '!.adlc/manifest.d/',
  '!.adlc/manifest.d/**',
  '.adlc/manifest.d/.lineage',
  '.adlc/manifest.d/*.lock',
  '.adlc/manifest.d/*.tmp-*',
];

// The blanket rule whose position decides whether any `.adlc/` negation works at
// all: in gitignore, the LAST matching pattern wins, so every negation must sit
// below it.
const ADLC_BLANKET = '.adlc/*';
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function safeJournalPath(root, value, label) {
  if (typeof value !== 'string' || !value) throw operational('INVALID_JOURNAL', `${label} must be a non-empty relative path`);
  const absolute = resolve(root, value);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw operational('UNSAFE_JOURNAL_PATH', `${label} escapes the repository: ${value}`);
  }
  return absolute;
}

// Ensure the migrated store is tracked, WITHOUT stranding negations the repo
// already declares.
//
// The previous implementation stripped its own stanza lines and re-appended the
// whole block at the end of the file. That silently broke any `.adlc/` negation
// it does not itself know about — `!.adlc/tickets.example.json`, `!.adlc/lessons/`,
// a user's own — because relocating `.adlc/*` to the end left those negations
// ABOVE the blanket rule, where the later pattern wins and they become dead. The
// failure is invisible: the file still reads as if the path were tracked.
//
// So: when the blanket rule is already present, leave it where it is and insert
// only the MISSING stanza lines directly after the existing run of `.adlc/`
// negations that follows it. Nothing moves, so no negation can be orphaned by
// construction, and repos that already track extra `.adlc/` paths keep them.
// Only a file with no blanket rule at all gets the whole stanza appended.
function migrationGitignoreText(original) {
  const lines = original.split(/\r?\n/);
  while (lines.at(-1) === '') lines.pop();

  const blanketIndex = lines.lastIndexOf(ADLC_BLANKET);
  if (blanketIndex === -1) {
    // Separate the appended stanza from existing rules. The trailing-blank pop
    // above already guarantees the last line is non-empty, so testing it again
    // would be dead logic.
    if (lines.length) lines.push('');
    lines.push(...GITIGNORE_STANZA);
    return `${lines.join('\n')}\n`;
  }

  // Anything below the blanket rule is already effective; only those count as
  // present. A stanza line sitting above it is dead and must be re-added below.
  const effective = new Set(lines.slice(blanketIndex + 1));
  const missing = GITIGNORE_STANZA.filter((line) => line !== ADLC_BLANKET && !effective.has(line));
  if (missing.length === 0) return original;

  // Append after the contiguous run of `.adlc/` rules following the blanket, so
  // the block stays together instead of splitting around unrelated entries.
  let insertAt = blanketIndex + 1;
  while (insertAt < lines.length && /^!?\.adlc\//.test(lines[insertAt])) insertAt++;
  lines.splice(insertAt, 0, ...missing);
  return `${lines.join('\n')}\n`;
}

function ensureMigrationGitignore(root) {
  const path = join(root, '.gitignore');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = migrationGitignoreText(original);
  if (next !== original) durableWrite(path, next);
  return next !== original;
}

function assertExactMigrationPath(root, value, expected, label) {
  const actual = safeJournalPath(root, value, label);
  if (actual !== resolve(root, expected)) throw operational('INVALID_JOURNAL', `${label} does not match the migration transaction layout`);
  return actual;
}

const HASH = /^[0-9a-f]{64}$/;

function validateMigrationJournal(root, runtime, journal, id) {
  if (!journal || journal.version !== 1 || journal.id !== id || journal.operation !== 'migrate' || journal.state !== 'prepared') {
    throw operational('INVALID_JOURNAL', `${id} is not a supported prepared migration transaction`);
  }
  assertExactMigrationPath(root, journal.source, LEGACY_FILE, 'source');
  assertExactMigrationPath(root, journal.target, ACTIVE_DIRECTORY, 'target');
  assertExactMigrationPath(root, journal.stagedStore, join(runtime, 'tickets'), 'stagedStore');
  assertExactMigrationPath(root, journal.stagedArchive, join(runtime, 'ticket-archive'), 'stagedArchive');
  assertExactMigrationPath(root, journal.backup, join(runtime, 'tickets.json'), 'backup');
  if (journal.archiveExisted !== false || typeof journal.legacyArchiveExisted !== 'boolean' || typeof journal.gitignoreExisted !== 'boolean') {
    throw operational('INVALID_JOURNAL', 'migration journal contains inconsistent pre-migration state');
  }
  if (journal.legacyArchiveExisted) assertExactMigrationPath(root, journal.archiveBackup, join(runtime, 'tickets.archive.json'), 'archiveBackup');
  else if (journal.archiveBackup !== null) throw operational('INVALID_JOURNAL', 'archiveBackup must be null when no legacy archive existed');
  if (journal.gitignoreExisted) assertExactMigrationPath(root, journal.gitignoreBackup, join(runtime, 'gitignore'), 'gitignoreBackup');
  else if (journal.gitignoreBackup !== null) throw operational('INVALID_JOURNAL', 'gitignoreBackup must be null when .gitignore did not exist');
  if (!HASH.test(journal.beforeHash) || journal.afterHash !== journal.beforeHash || !HASH.test(journal.archiveHash) || journal.evidenceRequired !== true) {
    throw operational('INVALID_JOURNAL', 'migration journal hashes or evidence policy are invalid');
  }
  if ((journal.gitignoreBeforeHash !== null && !HASH.test(journal.gitignoreBeforeHash)) || !HASH.test(journal.gitignoreAfterHash)) {
    throw operational('INVALID_JOURNAL', 'migration journal .gitignore hashes are invalid');
  }
  if (journal.gitignoreExisted !== (journal.gitignoreBeforeHash !== null)) {
    throw operational('INVALID_JOURNAL', 'migration journal .gitignore state is inconsistent');
  }
}

function assertGitignoreRecoveryState(root, journal) {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) {
    if (journal.gitignoreExisted) throw conflict('STALE_GITIGNORE', '.gitignore disappeared during interrupted migration');
    return;
  }
  const currentHash = sha256(readFileSync(path));
  if (currentHash !== journal.gitignoreBeforeHash && currentHash !== journal.gitignoreAfterHash) {
    throw conflict('STALE_GITIGNORE', '.gitignore changed after the interrupted migration; refusing to overwrite it');
  }
}

function loadMigrationJournal(root, id) {
  if (!TRANSACTION_ID.test(id)) throw operational('INVALID_TRANSACTION_ID', `invalid transaction id: ${id}`);
  const runtime = join(root, TRANSACTION_DIRECTORY, id);
  let journal;
  try { journal = JSON.parse(readFileSync(join(runtime, 'journal.json'), 'utf8')); }
  catch (error) { throw operational('INVALID_JOURNAL', `cannot read migration transaction ${id}: ${error.message}`); }
  validateMigrationJournal(root, runtime, journal, id);
  return { runtime, journal };
}

function loadLegacyArchive(root, path = join(root, LEGACY_ARCHIVE_FILE)) {
  if (!existsSync(path)) return { exists: false, tickets: [], hash: storeHash([]) };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw operational('INVALID_LEGACY_ARCHIVE', `cannot parse ${LEGACY_ARCHIVE_FILE}: ${error.message}`); }
  if (!parsed || !Array.isArray(parsed.tickets)) throw operational('INVALID_LEGACY_ARCHIVE', `${LEGACY_ARCHIVE_FILE} must contain a tickets array`);
  validateTickets(parsed.tickets, { archive: true, validateGraph: false });
  return { exists: true, tickets: parsed.tickets, hash: storeHash(parsed.tickets) };
}

export function migrationPlan(root = '.') {
  const legacy = new LegacyTicketStore(join(root, LEGACY_FILE));
  const directoryPath = join(root, ACTIVE_DIRECTORY);
  if (!legacy.exists()) throw operational('LEGACY_STORE_NOT_FOUND', `legacy store not found: ${legacy.path}`);
  if (existsSync(directoryPath)) throw conflict('AMBIGUOUS_STORE', 'directory store already exists');
  if (existsSync(join(root, ARCHIVE_DIRECTORY))) throw conflict('AMBIGUOUS_ARCHIVE', 'archive directory already exists beside a legacy active store');
  const before = legacy.load();
  const archived = loadLegacyArchive(root);
  const activeIds = new Set(before.tickets.map((ticket) => ticket.id));
  const collisions = archived.tickets.filter((ticket) => activeIds.has(ticket.id)).map((ticket) => ticket.id);
  if (collisions.length) throw conflict('ARCHIVE_COLLISION', `legacy archive collides with active ticket(s): ${collisions.join(', ')}`);
  return { version: 1, operation: 'migrate', source: LEGACY_FILE, target: ACTIVE_DIRECTORY, ticketCount: before.tickets.length, archivedTicketCount: archived.tickets.length, beforeHash: before.hash, afterHash: before.hash, archiveHash: archived.hash, files: [...before.tickets.map((ticket) => join(ACTIVE_DIRECTORY, ticketFilename(ticket.id))), ...archived.tickets.map((ticket) => join(ARCHIVE_DIRECTORY, ticketFilename(ticket.id)))] };
}

export function migrateLegacyStore(root = '.', { write = false, yes = false, requireClean = true, faultInjector = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  const plan = migrationPlan(root);
  if (!write) return plan;
  if (!yes) throw conflict('CONFIRMATION_REQUIRED', 'migration write requires --yes');
  if (requireClean) {
    let status;
    try { status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }); }
    catch (error) { throw operational('GIT_STATUS_FAILED', `cannot verify clean worktree: ${error.message}`); }
    if (status.trim()) throw conflict('DIRTY_WORKTREE', 'migration requires a clean worktree');
  }
  const legacyPath = join(root, LEGACY_FILE);
  const legacy = new LegacyTicketStore(legacyPath);
  const before = legacy.load();
  const id = randomUUID();
  const runtime = join(root, TRANSACTION_DIRECTORY, id);
  const stagedStore = join(runtime, 'tickets');
  const stagedArchive = join(runtime, 'ticket-archive');
  const backup = join(runtime, 'tickets.json');
  const archiveBackup = join(runtime, 'tickets.archive.json');
  const gitignorePath = join(root, '.gitignore');
  const gitignoreBackup = join(runtime, 'gitignore');
  const lock = acquireTicketLock(root, { transactionId: id, command: 'ticket:store:migrate' });
  try {
    if (legacy.load().hash !== before.hash) throw conflict('STALE_SNAPSHOT', 'legacy store changed during migration planning');
    // A migration REWRITES the whole store, so if that store is a frozen trust root
    // it is the largest trust-root write there is, and it already records evidence —
    // it just never required that evidence to be signable.
    //
    // Asked HERE, under the lock and against `before` — the very snapshot this
    // migration is about to rewrite. An earlier revision asked it before the lock,
    // off its own separate read: a writer that added the first rail between that read
    // and `before` produced a store whose two guarded reads agreed with each other,
    // so the staleness check saw nothing, and the migration rewrote a now-frozen
    // store while believing it was not one. Still ahead of any staging below, so a
    // refusal leaves nothing behind.
    const migratesTrustRoot = assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root });
    if (existsSync(join(root, ACTIVE_DIRECTORY))) throw conflict('AMBIGUOUS_STORE', 'directory store appeared during migration planning');
    if (existsSync(join(root, ARCHIVE_DIRECTORY))) throw conflict('AMBIGUOUS_ARCHIVE', 'archive directory appeared during migration planning');
    const legacyArchive = loadLegacyArchive(root);
    if (legacyArchive.hash !== plan.archiveHash) throw conflict('STALE_SNAPSHOT', 'legacy archive changed during migration planning');
    durableMkdir(stagedStore);
    durableMkdir(stagedArchive);
    durableWrite(join(stagedStore, '.store.json'), prettyCanonicalJson(ACTIVE_MANIFEST));
    durableWrite(join(stagedArchive, '.store.json'), prettyCanonicalJson(ARCHIVE_MANIFEST));
    for (const ticket of before.tickets) durableWrite(join(stagedStore, ticketFilename(ticket.id)), prettyCanonicalJson(ticket));
    for (const ticket of legacyArchive.tickets) durableWrite(join(stagedArchive, ticketFilename(ticket.id)), prettyCanonicalJson(ticket));
    durableCopy(legacyPath, backup);
    if (legacyArchive.exists) durableCopy(join(root, LEGACY_ARCHIVE_FILE), archiveBackup);
    const gitignoreExisted = existsSync(gitignorePath);
    const gitignoreBefore = gitignoreExisted ? readFileSync(gitignorePath, 'utf8') : '';
    if (gitignoreExisted) durableCopy(gitignorePath, gitignoreBackup);
    const gitignoreAfter = migrationGitignoreText(gitignoreBefore);
    faultInjector?.('before-journal', { id });
    durableWrite(join(runtime, 'journal.json'), `${JSON.stringify({
      version: 1,
      id,
      operation: 'migrate',
      state: 'prepared',
      beforeHash: before.hash,
      afterHash: before.hash,
      source: LEGACY_FILE,
      target: ACTIVE_DIRECTORY,
      stagedStore: join(TRANSACTION_DIRECTORY, id, 'tickets'),
      stagedArchive: join(TRANSACTION_DIRECTORY, id, 'ticket-archive'),
      backup: join(TRANSACTION_DIRECTORY, id, 'tickets.json'),
      archiveBackup: legacyArchive.exists ? join(TRANSACTION_DIRECTORY, id, 'tickets.archive.json') : null,
      legacyArchiveExisted: legacyArchive.exists,
      archiveHash: legacyArchive.hash,
      gitignoreBackup: gitignoreExisted ? join(TRANSACTION_DIRECTORY, id, 'gitignore') : null,
      gitignoreExisted,
      gitignoreBeforeHash: gitignoreExisted ? sha256(gitignoreBefore) : null,
      gitignoreAfterHash: sha256(gitignoreAfter),
      archiveExisted: false,
      evidenceRequired: true,
    }, null, 2)}\n`);
    faultInjector?.('journal-prepared', { id });
    durableMkdir(dirname(join(root, ACTIVE_DIRECTORY)));
    durableRename(stagedStore, join(root, ACTIVE_DIRECTORY));
    durableRename(stagedArchive, join(root, ARCHIVE_DIRECTORY));
    faultInjector?.('directory-renamed', { id });
    const directory = new DirectoryTicketStore(join(root, ACTIVE_DIRECTORY));
    if (directory.load().hash !== before.hash) throw conflict('MIGRATION_HASH_MISMATCH', 'directory representation changed logical store hash');
    if (new DirectoryTicketStore(join(root, ARCHIVE_DIRECTORY), { archive: true }).load().hash !== legacyArchive.hash) throw conflict('MIGRATION_HASH_MISMATCH', 'archive representation changed logical store hash');
    durableRemove(legacyPath);
    if (legacyArchive.exists) durableRemove(join(root, LEGACY_ARCHIVE_FILE));
    faultInjector?.('legacy-removed', { id });
    ensureMigrationGitignore(root);
    // The audit fields ride on the migration's OWN gate rather than a second
    // `ticket-mutation` entry: one mutation, one entry, exactly as the ticket-store
    // transactions do. `migratesTrustRoot` is the same predicate the refusal above
    // used, so an entry carries `bypass` when and only when a refusal was possible.
    recordTicketEvidence(root, {
      key, transactionId: id, operation: 'migrate',
      storeHash: directory.load().hash, archiveHash: legacyArchive.hash,
      ...(migratesTrustRoot ? { bypass: true, storeHashBefore: before.hash } : {}),
    });
    faultInjector?.('gitignore-updated', { id });
    durableRemove(runtime, { recursive: true, force: true });
    return { ...plan, applied: true };
  } catch (error) {
    if (!existsSync(join(runtime, 'journal.json')) && existsSync(runtime)) durableRemove(runtime, { recursive: true, force: true });
    throw error;
  } finally { releaseTicketLock(lock); }
}

export function recoverMigration(root, id, { direction, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  if (!['complete', 'rollback'].includes(direction)) throw conflict('RECOVERY_DIRECTION_REQUIRED', 'choose complete or rollback');
  const { runtime, journal } = loadMigrationJournal(root, id);
  const legacyPath = safeJournalPath(root, journal.source, 'source');
  const directoryPath = safeJournalPath(root, journal.target, 'target');
  const stagedStore = safeJournalPath(root, journal.stagedStore, 'stagedStore');
  const stagedArchive = safeJournalPath(root, journal.stagedArchive, 'stagedArchive');
  const backup = safeJournalPath(root, journal.backup, 'backup');
  const lock = acquireTicketLock(root, { transactionId: id, command: `ticket:migrate:recover:${direction}` });
  try {
    const backupSnapshot = new LegacyTicketStore(backup).load();
    if (backupSnapshot.hash !== journal.beforeHash) throw conflict('CORRUPT_BACKUP', 'migration backup does not match its recorded hash');
    // Where the filesystem ACTUALLY is right now, which is not necessarily the
    // journal's beforeHash: a crash after the directory rename leaves the repo at
    // the migrated state, and recording beforeHash on both ends of a rollback
    // would describe a no-op transition that never happened. Falls back to the
    // journal's value when neither store loads.
    let preRecoveryHash = journal.beforeHash;
    for (const candidate of [
      () => new DirectoryTicketStore(directoryPath).load().hash,
      () => new LegacyTicketStore(legacyPath).load().hash,
    ]) {
      try { preRecoveryHash = candidate(); break; } catch { /* try the next shape */ }
    }
    const archivePath = join(root, ARCHIVE_DIRECTORY);
    const legacyArchivePath = join(root, LEGACY_ARCHIVE_FILE);
    const gitignorePath = join(root, '.gitignore');
    const archiveBackup = journal.legacyArchiveExisted ? safeJournalPath(root, journal.archiveBackup, 'archiveBackup') : null;
    const gitignoreBackup = journal.gitignoreExisted ? safeJournalPath(root, journal.gitignoreBackup, 'gitignoreBackup') : null;
    if (archiveBackup && loadLegacyArchive(root, archiveBackup).hash !== journal.archiveHash) {
      throw conflict('CORRUPT_BACKUP', 'migration archive backup does not match its recorded hash');
    }
    if (gitignoreBackup && sha256(readFileSync(gitignoreBackup)) !== journal.gitignoreBeforeHash) {
      throw conflict('CORRUPT_BACKUP', 'migration .gitignore backup does not match its recorded hash');
    }

    // Both backups are hash-verified above, so they are the trustworthy record of
    // the pre-migration repo — which is what decides whether this recovery touches
    // a trust root, in BOTH directions, without believing anything the journal
    // merely asserts. The archive backup matters on its own: a rollback removes the
    // directory archive BEFORE restoring the legacy archive, so a crash in that
    // window leaves a repo where neither the active store nor any visible archive
    // declares a rail, and a keyless retry would sail through. Refusing here, ahead
    // of the first mutation, keeps an unsignable recovery from being the way a
    // trust root changes unaudited. An unreadable backup fails closed.
    const archiveBackupDeclaresRails = () => {
      if (!archiveBackup) return false;
      try { return storeDeclaresRails(loadLegacyArchive(root, archiveBackup).tickets); }
      catch { return true; }
    };
    const recoversTrustRoot = repoDeclaresRails(root, backupSnapshot.tickets) || archiveBackupDeclaresRails();
    if (recoversTrustRoot) assertWriteIsSignable({ key, allowUnsigned });

    if (direction === 'complete') {
      // Validate every source and destination before the first mutation. Recovery
      // may be retried, but stale human edits must never be discovered only after
      // another representation has already been removed.
      if (!existsSync(directoryPath)) {
        const staged = new DirectoryTicketStore(stagedStore).load();
        if (staged.hash !== journal.afterHash) throw conflict('CORRUPT_STAGE', 'staged migration store does not match its recorded hash');
      } else if (new DirectoryTicketStore(directoryPath).load().hash !== journal.afterHash) {
        throw conflict('RECOVERY_VERIFY_FAILED', 'migrated directory does not match its recorded hash');
      }
      if (!existsSync(archivePath)) {
        const staged = new DirectoryTicketStore(stagedArchive, { archive: true }).load();
        if (staged.hash !== journal.archiveHash) throw conflict('CORRUPT_STAGE', 'staged migration archive does not match its recorded hash');
      } else if (new DirectoryTicketStore(archivePath, { archive: true }).load().hash !== journal.archiveHash) {
        throw conflict('RECOVERY_VERIFY_FAILED', 'migrated archive does not match its recorded hash');
      }
      if (existsSync(legacyPath)) {
        if (new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) throw conflict('RECOVERY_VERIFY_FAILED', 'legacy source changed during interrupted migration');
      }
      if (existsSync(legacyArchivePath)) {
        if (loadLegacyArchive(root).hash !== journal.archiveHash) throw conflict('RECOVERY_VERIFY_FAILED', 'legacy archive changed during interrupted migration');
      }
      assertGitignoreRecoveryState(root, journal);

      if (!existsSync(directoryPath)) durableRename(stagedStore, directoryPath);
      if (!existsSync(archivePath)) durableRename(stagedArchive, archivePath);
      if (existsSync(legacyPath)) durableRemove(legacyPath);
      if (existsSync(legacyArchivePath)) durableRemove(legacyArchivePath);
      ensureMigrationGitignore(root);
      const directory = new DirectoryTicketStore(directoryPath).load();
      // Recovery must establish the same canonical apply binding as the uninterrupted
      // path. recordTicketEvidence is transaction/action-idempotent, so this is safe
      // whether the crash happened before or after the original append — but only if
      // the replay is BYTE-FOR-BYTE what the original run would have written. The
      // apply entry describes the MIGRATION's transition and so keeps the journal's
      // beforeHash; using the recovery's own starting hash here would differ from an
      // already-recorded entry and turn a resumable recovery into a permanent
      // EVIDENCE_IDEMPOTENCY_CONFLICT. The recover-complete entry, which describes
      // the RECOVERY's transition, is the one that carries preRecoveryHash.
      const applyAudit = recoversTrustRoot ? { bypass: true, storeHashBefore: journal.beforeHash } : {};
      const recoveryAudit = recoversTrustRoot ? { bypass: true, storeHashBefore: preRecoveryHash } : {};
      // acceptLegacyMatch: a migration interrupted before this feature existed left
      // an apply entry with no audit payload, and it can never grow one.
      recordTicketEvidence(root, { key, transactionId: id, operation: 'migrate', storeHash: directory.hash, archiveHash: journal.archiveHash, ...applyAudit, acceptLegacyMatch: true });
      recordTicketEvidence(root, { key, transactionId: id, operation: 'migrate', action: 'recover-complete', storeHash: directory.hash, archiveHash: journal.archiveHash, ...recoveryAudit });
      durableRemove(runtime, { recursive: true, force: true });
      return new DirectoryTicketStore(directoryPath).load();
    }

    // Rollback preflight: verify every object that might be removed or replaced
    // before changing any of them.
    if (existsSync(directoryPath)) {
      if (new DirectoryTicketStore(directoryPath).load().hash !== journal.afterHash) throw conflict('RECOVERY_VERIFY_FAILED', 'partial directory changed; refusing rollback');
    }
    if (existsSync(legacyPath) && new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) {
      throw conflict('RECOVERY_VERIFY_FAILED', 'legacy source changed during interrupted migration; refusing rollback');
    }
    assertGitignoreRecoveryState(root, journal);
    if (existsSync(archivePath) && new DirectoryTicketStore(archivePath, { archive: true }).load().hash !== journal.archiveHash) {
      throw conflict('RECOVERY_VERIFY_FAILED', 'partial archive changed; refusing rollback');
    }
    if (existsSync(legacyArchivePath) && loadLegacyArchive(root).hash !== journal.archiveHash) {
      throw conflict('RECOVERY_VERIFY_FAILED', 'legacy archive changed during interrupted migration; refusing rollback');
    }

    if (existsSync(directoryPath)) durableRemove(directoryPath, { recursive: true });
    const temporary = `${legacyPath}.rollback-${id}`;
    durableCopy(backup, temporary);
    durableRename(temporary, legacyPath);
    if (new LegacyTicketStore(legacyPath).load().hash !== journal.beforeHash) throw conflict('RECOVERY_VERIFY_FAILED', 'restored legacy store does not match its recorded hash');
    if (journal.gitignoreExisted) {
      durableCopy(gitignoreBackup, `${gitignorePath}.rollback-${id}`);
      durableRename(`${gitignorePath}.rollback-${id}`, gitignorePath);
    } else if (existsSync(gitignorePath)) durableRemove(gitignorePath, { force: true });
    if (!journal.archiveExisted && existsSync(archivePath)) {
      durableRemove(archivePath, { recursive: true });
    }
    if (journal.legacyArchiveExisted) {
      const temporaryArchive = `${legacyArchivePath}.rollback-${id}`;
      durableCopy(archiveBackup, temporaryArchive);
      durableRename(temporaryArchive, legacyArchivePath);
      if (loadLegacyArchive(root).hash !== journal.archiveHash) throw conflict('RECOVERY_VERIFY_FAILED', 'restored legacy archive does not match its recorded hash');
    } else if (existsSync(legacyArchivePath)) durableRemove(legacyArchivePath, { force: true });
    recordTicketEvidence(root, {
      key, transactionId: id, operation: 'migrate', action: 'recover-rollback',
      storeHash: journal.beforeHash, archiveHash: journal.archiveHash,
      ...(recoversTrustRoot ? { bypass: true, storeHashBefore: preRecoveryHash } : {}),
    });
    durableRemove(runtime, { recursive: true, force: true });
    return new LegacyTicketStore(legacyPath).load();
  } finally { releaseTicketLock(lock); }
}

/**
 * `root` is what makes the output-path guard below meaningful; it defaults to cwd
 * so existing callers keep working.
 */
export function exportLegacyStore(store, outputPath, { root = '.' } = {}) {
  // Export is a REPORTING command: it writes a legacy-shaped snapshot wherever the
  // caller points it. Pointed at a ticket store, it becomes an unaudited writer to
  // the trust root — and with a `--ticket-store` source it would overwrite the
  // canonical store with a DIFFERENT ticket set, rails included, leaving no
  // evidence. Refused outright rather than gated on a key: overwriting the store
  // is not something export should do even with one.
  //
  // The path checked below is the SAME one written further down, and both the
  // lexical and symlink-resolved forms are checked — a guard that validates one
  // path while the write uses another is not a guard, and a symlinked parent
  // directory would otherwise redirect the rename straight into the store.
  const target = resolve(root, outputPath);
  // Resolve through the DEEPEST EXISTING ancestor and re-append the tail that does
  // not exist yet. Resolving only the immediate parent is not enough: given
  // `reports/link/new/out.json` where `reports/link` is a symlink into the store,
  // the immediate parent does not exist, the lexical fallback applies, the guard
  // sees an innocent path — and the recursive mkdir below then follows the link and
  // writes inside the canonical store.
  const symlinkResolved = (path) => {
    const tail = [basename(path)];
    let dir = dirname(path);
    for (;;) {
      try { return join(realpathSync(dir), ...[...tail].reverse()); }
      catch {
        const parent = dirname(dir);
        if (parent === dir) return path; // nothing along the way exists
        tail.push(basename(dir));
        dir = parent;
      }
    }
  };
  const candidates = [target, symlinkResolved(target)];
  // The whole of `.adlc` PLUS the store actually being read.
  //
  // Naming individual files inside `.adlc` invites the next gap: the first version
  // of this guard reserved the four canonical store paths and left
  // `.adlc/manifest.jsonl` and `.adlc/manifest.d/` open, so an export could
  // overwrite the append-only evidence ledger itself. `.adlc` is the runtime and
  // evidence area; a snapshot written for inspection has no business anywhere in it.
  // The source store is listed separately because --ticket-store /
  // ADLC_TICKET_STORE can point outside `.adlc` entirely.
  const reserved = [
    resolve(root, '.adlc'),
    ...(typeof store?.path === 'string' && store.path ? [resolve(root, store.path)] : []),
  ].flatMap((absolute) => {
    let real = absolute;
    try { real = realpathSync(absolute); } catch { /* may not exist */ }
    return real === absolute ? [absolute] : [absolute, real];
  });
  const insideStore = (dir) => candidates.some((candidate) => {
    const rel = relative(dir, candidate);
    return rel === '' || (Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel));
  });
  // ANY directory store, not just the one being read.
  //
  // `reserved` above names this repo's `.adlc` and the SOURCE store. But
  // --ticket-store / ADLC_TICKET_STORE exist precisely so a store can live
  // somewhere else, so a repo can have OTHER stores that are trust roots too — and
  // they are exactly as destroyable: written onto the marker, it becomes a legacy
  // `{ tickets }` envelope and the store stops loading as what it is; written
  // beside the shards, a foreign envelope joins the set the store enumerates.
  // Reserving only the store being read protects the wrong half. A directory store
  // is identified by its marker, so walk up from the destination and refuse if it
  // lands inside one.
  const insideSomeDirectoryStore = (candidate) => {
    let dir = dirname(candidate);
    for (;;) {
      if (existsSync(join(dir, STORE_MARKER))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  };
  // Same argument for the OTHER store shape: a `.adlc` anywhere is some repo's
  // runtime and evidence area, holding its legacy store, archive and ledger. The
  // reservation above only knows about this root's.
  const insideSomeAdlcDirectory = (candidate) => candidate.split(sep).includes('.adlc');
  // RESIDUAL — this is a check, and the write below is a separate act. The mkdir,
  // temp write and rename address the destination by PATH, so a local writer who can
  // rename a parent directory of the destination can swap it for a symlink after
  // these checks pass and redirect the export into a store, archive or ledger. The
  // window is not closed here: Node has no openat/O_NOFOLLOW for the mkdir+rename
  // sequence, so there is no directory handle to pin the checked path to.
  //
  // What bounds it: the attacker needs write access to a PARENT of the operator's
  // chosen destination AND has to win the race. Anyone with write access to the repo
  // can write .adlc directly and needs no race at all, so this guard was never the
  // boundary in that case; the residual case is a nested destination under a
  // world-writable directory, where a sticky bit already blocks renaming another
  // user's directory. Tracked for closure by ticket
  // T-01M0WNX6ZA0D94HW2VQKZAPGQ2.
  if (reserved.some(insideStore)
    || candidates.some(insideSomeDirectoryStore)
    || candidates.some(insideSomeAdlcDirectory)) {
    throw policy(
      'UNSAFE_EXPORT_TARGET',
      `refusing to export onto ADLC runtime state: ${outputPath}. Export writes a snapshot for ` +
      'inspection; writing it into any .adlc/, into any directory ticket store, or over the source ' +
      'store would replace a ticket set — rails included — or the append-only evidence ledger, with ' +
      'no record that it happened. Choose a path outside .adlc/ and outside every ticket store.',
    );
  }
  const snapshot = store.load();
  const temporary = `${target}.tmp.${process.pid}`;
  durableMkdir(dirname(target));
  durableWrite(temporary, prettyCanonicalJson({ tickets: snapshot.mutableTickets() }));
  durableRename(temporary, target);
  const exported = new LegacyTicketStore(target).load();
  if (exported.hash !== snapshot.hash) throw conflict('EXPORT_HASH_MISMATCH', 'legacy export changed logical store hash');
  return exported;
}
