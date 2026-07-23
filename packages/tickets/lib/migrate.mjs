import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVE_DIRECTORY, ACTIVE_MANIFEST, ARCHIVE_DIRECTORY, ARCHIVE_MANIFEST, LEGACY_ARCHIVE_FILE, LEGACY_FILE, TRANSACTION_DIRECTORY } from './constants.mjs';
import { prettyCanonicalJson, sha256, storeHash } from './canonical.mjs';
import { conflict, operational } from './errors.mjs';
import { ticketFilename } from './filename.mjs';
import { acquireTicketLock, releaseTicketLock } from './lock.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { LegacyTicketStore } from './stores/legacy.mjs';
import { recordTicketEvidence } from './evidence.mjs';
import { validateTickets } from './schema.mjs';
import { durableCopy, durableMkdir, durableRemove, durableRename, durableWrite } from './durability.mjs';

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

export function migrateLegacyStore(root = '.', { write = false, yes = false, requireClean = true, faultInjector = null } = {}) {
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
    recordTicketEvidence(root, { transactionId: id, operation: 'migrate', storeHash: directory.load().hash, archiveHash: legacyArchive.hash });
    faultInjector?.('gitignore-updated', { id });
    durableRemove(runtime, { recursive: true, force: true });
    return { ...plan, applied: true };
  } catch (error) {
    if (!existsSync(join(runtime, 'journal.json')) && existsSync(runtime)) durableRemove(runtime, { recursive: true, force: true });
    throw error;
  } finally { releaseTicketLock(lock); }
}

export function recoverMigration(root, id, { direction } = {}) {
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
      // whether the crash happened before or after the original append.
      recordTicketEvidence(root, { transactionId: id, operation: 'migrate', storeHash: directory.hash, archiveHash: journal.archiveHash });
      recordTicketEvidence(root, { transactionId: id, operation: 'migrate', action: 'recover-complete', storeHash: directory.hash, archiveHash: journal.archiveHash });
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
    recordTicketEvidence(root, { transactionId: id, operation: 'migrate', action: 'recover-rollback', storeHash: journal.beforeHash, archiveHash: journal.archiveHash });
    durableRemove(runtime, { recursive: true, force: true });
    return new LegacyTicketStore(legacyPath).load();
  } finally { releaseTicketLock(lock); }
}

export function exportLegacyStore(store, outputPath) {
  const snapshot = store.load();
  const temporary = `${outputPath}.tmp.${process.pid}`;
  durableMkdir(dirname(outputPath));
  durableWrite(temporary, prettyCanonicalJson({ tickets: snapshot.mutableTickets() }));
  durableRename(temporary, outputPath);
  const exported = new LegacyTicketStore(outputPath).load();
  if (exported.hash !== snapshot.hash) throw conflict('EXPORT_HASH_MISMATCH', 'legacy export changed logical store hash');
  return exported;
}
