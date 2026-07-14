import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DirectoryTicketStore,
  LegacyTicketStore,
  migrateLegacyStore,
  pendingTransactions,
  recoverMigration,
} from '../index.mjs';
import { ticket, writeLegacy } from './helpers.mjs';

function interruptedMigration(point) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-migration-recovery-'));
  writeLegacy(root, [ticket('A'), ticket('B')]);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  const before = new LegacyTicketStore(join(root, '.adlc/tickets.json')).load();
  assert.throws(() => migrateLegacyStore(root, {
    write: true,
    yes: true,
    requireClean: false,
    faultInjector(name) { if (name === point) throw new Error(`fault:${point}`); },
  }), new RegExp(`fault:${point}`));
  const [id] = pendingTransactions(root);
  assert.ok(id);
  return { root, id, before };
}

function interruptedMigrationWithArchive(point) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-migration-archive-recovery-'));
  const archived = [ticket('ARCHIVED', { status: 'done' })];
  writeLegacy(root, [ticket('ACTIVE')]);
  writeFileSync(join(root, '.adlc/tickets.archive.json'), `${JSON.stringify({ tickets: archived }, null, 2)}\n`);
  assert.throws(() => migrateLegacyStore(root, {
    write: true,
    yes: true,
    requireClean: false,
    faultInjector(name) { if (name === point) throw new Error(`fault:${point}`); },
  }), new RegExp(`fault:${point}`));
  const [id] = pendingTransactions(root);
  assert.ok(id);
  return { root, id, archived };
}

test('a failure before journal persistence removes staging and leaves no recovery tombstone', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-migration-prejournal-'));
  try {
    writeLegacy(root, [ticket('A')]);
    assert.throws(() => migrateLegacyStore(root, {
      write: true,
      yes: true,
      requireClean: false,
      faultInjector(name) { if (name === 'before-journal') throw new Error('fault:before-journal'); },
    }), /fault:before-journal/);
    assert.deepEqual(pendingTransactions(root), []);
    assert.equal(new LegacyTicketStore(join(root, '.adlc/tickets.json')).load().get('A').id, 'A');
    assert.equal(existsSync(join(root, '.adlc/tickets')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted migration rolls back to the exact legacy representation', () => {
  const { root, id, before } = interruptedMigration('directory-renamed');
  try {
    const restored = recoverMigration(root, id, { direction: 'rollback' });
    assert.equal(restored.hash, before.hash);
    assert.equal(existsSync(join(root, '.adlc/tickets')), false);
    assert.equal(existsSync(join(root, '.adlc/ticket-archive')), false);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
    assert.deepEqual(pendingTransactions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted migration completes from the durable journal and updates tracking rules', () => {
  const { root, id, before } = interruptedMigration('legacy-removed');
  try {
    const completed = recoverMigration(root, id, { direction: 'complete' });
    assert.equal(completed.hash, before.hash);
    assert.equal(new DirectoryTicketStore(join(root, '.adlc/tickets')).load().hash, before.hash);
    assert.equal(existsSync(join(root, '.adlc/tickets.json')), false);
    assert.equal(existsSync(join(root, '.adlc/ticket-archive/.store.json')), true);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(ignore, /^\.adlc\/\*$/m);
    assert.match(ignore, /^!\.adlc\/tickets\/\*\*$/m);
    const actions = readFileSync(join(root, '.adlc/manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((entry) => entry.data.action);
    assert.deepEqual(actions, ['apply', 'recover-complete']);
    assert.deepEqual(pendingTransactions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('completion recovery after the apply append does not duplicate canonical migration evidence', () => {
  const { root, id } = interruptedMigration('gitignore-updated');
  try {
    recoverMigration(root, id, { direction: 'complete' });
    const actions = readFileSync(join(root, '.adlc/manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((entry) => entry.data.action);
    assert.deepEqual(actions, ['apply', 'recover-complete']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration imports the legacy archive without changing its logical contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-migration-archive-'));
  const archived = [ticket('ARCHIVED', { status: 'done' })];
  try {
    writeLegacy(root, [ticket('ACTIVE')]);
    writeFileSync(join(root, '.adlc/tickets.archive.json'), `${JSON.stringify({ tickets: archived }, null, 2)}\n`);
    const plan = migrateLegacyStore(root);
    assert.equal(plan.archivedTicketCount, 1);
    migrateLegacyStore(root, { write: true, yes: true, requireClean: false });
    assert.deepEqual(
      new DirectoryTicketStore(join(root, '.adlc/ticket-archive'), { archive: true }).load().mutableTickets(),
      archived,
    );
    assert.equal(existsSync(join(root, '.adlc/tickets.archive.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rollback restores the exact legacy archive and removes its staged directory', () => {
  const { root, id, archived } = interruptedMigrationWithArchive('directory-renamed');
  try {
    recoverMigration(root, id, { direction: 'rollback' });
    assert.equal(existsSync(join(root, '.adlc/ticket-archive')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.adlc/tickets.archive.json'), 'utf8')).tickets, archived);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('completion removes the legacy archive only after verifying the directory archive', () => {
  const { root, id, archived } = interruptedMigrationWithArchive('legacy-removed');
  try {
    recoverMigration(root, id, { direction: 'complete' });
    assert.equal(existsSync(join(root, '.adlc/tickets.archive.json')), false);
    assert.deepEqual(
      new DirectoryTicketStore(join(root, '.adlc/ticket-archive'), { archive: true }).load().mutableTickets(),
      archived,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration recovery rejects journal paths that escape the repository', () => {
  const { root, id } = interruptedMigration('journal-prepared');
  const escaped = join(root, '..', `adlc-migration-escaped-${process.pid}`);
  try {
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.target = `../${basename(escaped)}`;
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverMigration(root, id, { direction: 'complete' }), (error) => error.code === 'UNSAFE_JOURNAL_PATH');
    assert.equal(existsSync(escaped), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(escaped, { recursive: true, force: true });
  }
});

test('migration recovery rejects journal paths redirected within the repository', () => {
  const { root, id } = interruptedMigration('journal-prepared');
  try {
    const victim = join(root, 'preserve.json');
    writeFileSync(victim, '{"preserve":true}\n');
    const path = join(root, '.adlc/ticket-transactions', id, 'journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    journal.target = 'preserve.json';
    writeFileSync(path, JSON.stringify(journal));
    assert.throws(() => recoverMigration(root, id, { direction: 'complete' }), (error) => error.code === 'INVALID_JOURNAL');
    assert.equal(readFileSync(victim, 'utf8'), '{"preserve":true}\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration rollback refuses to overwrite a post-crash .gitignore edit', () => {
  const { root, id } = interruptedMigration('gitignore-updated');
  try {
    writeFileSync(join(root, '.gitignore'), 'user-added-after-crash/\n');
    assert.throws(
      () => recoverMigration(root, id, { direction: 'rollback' }),
      (error) => error.code === 'STALE_GITIGNORE',
    );
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'user-added-after-crash/\n');
    assert.equal(existsSync(join(root, '.adlc/tickets')), true, 'preflight rejects before removing the directory store');
    assert.equal(existsSync(join(root, '.adlc/tickets.json')), false, 'preflight rejects before restoring the legacy store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
