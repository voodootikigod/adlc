#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DirectoryTicketStore,
  LegacyTicketStore,
  TRANSACTION_DIRECTORY,
  TicketService,
  TicketStoreError,
  archiveTicket,
  detectTicketStore,
  doctorTicketStore,
  exitCodeFor,
  exportLegacyStore,
  migrateLegacyStore,
  offerLegacyMigration,
  pendingTransactions,
  recoverDirectoryTransaction,
  recoverMigration,
  restoreTicket,
  serializePlan,
} from '../index.mjs';

function usage() {
  console.log(`adlc ticket <command> [options]

Commands:
  list | show <id>
  create --input <path|-> [--write]
  update <id> --input <path|-> --expect <ticket-hash> [--write]
  edit <id> [--write]
  discard <id> [--write]
  complete <id> [--write --authorize]
  archive <id> [--write --authorize] | restore <id> [--write --authorize]
  doctor [--archive] | store status
  store migrate [--write --yes] | store recover (--complete|--rollback)
  store export --output <path>

All mutations are dry-run by default. New override: --ticket-store/ADLC_TICKET_STORE.
Legacy --tickets/ADLC_TICKETS remains available through 1.x.`);
}

function parse(argv) {
  const flags = {};
  const positionals = [];
  const boolean = new Set(['write', 'json', 'yes', 'authorize', 'archive', 'complete', 'rollback', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (boolean.has(name)) flags[name] = true;
    else {
      if (index + 1 >= argv.length) throw new TicketStoreError('invalid', 'MISSING_FLAG_VALUE', `--${name} requires a value`);
      flags[name] = argv[++index];
    }
  }
  return { flags, positionals };
}

async function readInput(path) {
  const text = path === '-' ? await new Promise((resolveText, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => resolveText(body));
    process.stdin.on('error', reject);
  }) : readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch (error) { throw new TicketStoreError('invalid', 'INVALID_INPUT_JSON', `invalid input JSON: ${error.message}`); }
}

function emit(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { flags, positionals } = parse(process.argv.slice(2));
  if (flags.help || positionals.length === 0) { usage(); return; }
  const root = resolve(flags.root ?? '.');
  const command = positionals[0];
  const storeCommand = command === 'store' ? positionals[1] : null;
  if (storeCommand === 'migrate') {
    emit(migrateLegacyStore(root, { write: Boolean(flags.write), yes: Boolean(flags.yes) }), flags.json);
    return;
  }
  if (storeCommand === 'recover') {
    const transactions = pendingTransactions(root);
    if (transactions.length !== 1) throw new TicketStoreError('conflict', 'RECOVERY_SELECTION_REQUIRED', `expected one pending transaction, found ${transactions.length}`);
    const direction = flags.complete ? 'complete' : flags.rollback ? 'rollback' : null;
    let journal;
    try { journal = JSON.parse(readFileSync(join(root, TRANSACTION_DIRECTORY, transactions[0], 'journal.json'), 'utf8')); }
    catch (error) { throw new TicketStoreError('invalid', 'INVALID_JOURNAL', `cannot read transaction journal: ${error.message}`); }
    if (journal.operation === 'migrate') emit(recoverMigration(root, transactions[0], { direction }), flags.json);
    else {
      const recoveryStore = detectTicketStore({ root, ticketStore: flags['ticket-store'], legacyTickets: flags.tickets, allowRecovery: true });
      emit(recoverDirectoryTransaction(recoveryStore, transactions[0], { root, direction }), flags.json);
    }
    return;
  }
  let store = detectTicketStore({ root, ticketStore: flags['ticket-store'], legacyTickets: flags.tickets, allowRecovery: command === 'doctor' });
  if (storeCommand === 'status') {
    const snapshot = store.load();
    emit({ backend: snapshot.backend, formatVersion: snapshot.formatVersion, tickets: snapshot.tickets.length, storeHash: snapshot.hash, pendingTransactions: pendingTransactions(root) }, flags.json);
    return;
  }
  if (storeCommand === 'export') {
    if (!flags.output) throw new TicketStoreError('invalid', 'OUTPUT_REQUIRED', 'store export requires --output');
    const exported = exportLegacyStore(store, resolve(root, flags.output));
    emit({ output: flags.output, tickets: exported.tickets.length, storeHash: exported.hash }, flags.json);
    return;
  }
  if (command === 'doctor') {
    emit(doctorTicketStore(store, { root, archive: Boolean(flags.archive) }), flags.json);
    return;
  }
  const snapshot = store.load();
  if (command === 'list') {
    emit(snapshot.tickets.map((ticket) => ({ id: ticket.id, title: ticket.title, ticketHash: snapshot.ticketHashes[ticket.id] })), flags.json);
    if (store instanceof LegacyTicketStore && !flags.json) console.error('warning: legacy ticket store active; run `adlc ticket store migrate` to preview migration');
    return;
  }
  if (command === 'show') {
    const ticket = snapshot.get(positionals[1]);
    if (!ticket) throw new TicketStoreError('invalid', 'TICKET_NOT_FOUND', `ticket not found: ${positionals[1]}`);
    emit({ ticket, ticketHash: snapshot.ticketHashes[ticket.id], storeHash: snapshot.hash }, flags.json);
    return;
  }
  const mutationCommands = new Set(['create', 'update', 'edit', 'discard', 'complete', 'archive', 'restore']);
  if (!mutationCommands.has(command)) throw new TicketStoreError('invalid', 'UNKNOWN_COMMAND', `unknown ticket command: ${command}`);
  store = await offerLegacyMigration(store, root, flags, { emit: (value) => emit(value, false) });
  const service = new TicketService(store, { root });
  let plan;
  if (command === 'create') {
    if (!flags.input) throw new TicketStoreError('invalid', 'INPUT_REQUIRED', 'create requires --input');
    plan = service.planCreate(await readInput(flags.input));
  } else if (command === 'update') {
    if (!flags.input) throw new TicketStoreError('invalid', 'INPUT_REQUIRED', 'update requires --input');
    plan = service.planUpdate(positionals[1], await readInput(flags.input), { expect: flags.expect, authorized: Boolean(flags.authorize) });
  } else if (command === 'edit') {
    const ticket = service.snapshot().get(positionals[1]);
    if (!ticket) throw new TicketStoreError('invalid', 'TICKET_NOT_FOUND', `ticket not found: ${positionals[1]}`);
    const directory = mkdtempSync(join(tmpdir(), 'adlc-ticket-edit-'));
    const path = join(directory, `${basename(positionals[1])}.json`);
    try {
      writeFileSync(path, `${JSON.stringify(ticket, null, 2)}\n`);
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (!editor) throw new TicketStoreError('operational', 'EDITOR_NOT_SET', 'set $EDITOR or $VISUAL');
      execFileSync(editor, [path], { stdio: 'inherit' });
      plan = service.planUpdate(ticket.id, JSON.parse(readFileSync(path, 'utf8')), { expect: service.snapshot().ticketHashes[ticket.id], authorized: Boolean(flags.authorize) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } else if (command === 'discard') plan = service.planDiscard(positionals[1]);
  else if (command === 'complete') plan = service.planComplete(positionals[1], { authorized: Boolean(flags.authorize) });
  else if (command === 'archive' || command === 'restore') {
    if (!(store instanceof DirectoryTicketStore)) throw new TicketStoreError('policy', 'DIRECTORY_STORE_REQUIRED', `${command} requires a directory store`);
    const options = { expectedSnapshotHash: snapshot.hash, reason: flags.reason, sourceRevision: flags.revision, root, authorized: Boolean(flags.authorize) };
    if (!flags.write) { emit({ operation: command, ticketId: positionals[1], expectedSnapshotHash: snapshot.hash, evidenceRequired: true, dryRun: true }, flags.json); return; }
    const result = command === 'archive'
      ? archiveTicket(store, join(root, '.adlc/ticket-archive'), positionals[1], options)
      : restoreTicket(store, join(root, '.adlc/ticket-archive'), positionals[1], options);
    emit({ operation: command, applied: true, storeHash: result.active.hash }, flags.json);
    return;
  }
  emit({ ...serializePlan(plan), dryRun: !flags.write }, flags.json);
  if (flags.write) {
    const applied = service.apply(plan);
    emit({ applied: true, storeHash: applied.hash, ticketHash: plan.ticketId ? applied.ticketHashes[plan.ticketId] : null }, flags.json);
  }
}

main().catch((error) => {
  const structured = error instanceof TicketStoreError ? error : new TicketStoreError('operational', 'UNEXPECTED', error?.message ?? String(error));
  if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, kind: structured.kind, code: structured.code, message: structured.message, details: structured.details }));
  else console.error(`${structured.code}: ${structured.message}`);
  process.exitCode = exitCodeFor(structured);
});
