#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveKeyFromEnv } from '../lib/key-contract.mjs';
import {
  DirectoryTicketStore,
  LegacyTicketStore,
  TRANSACTION_DIRECTORY,
  TicketService,
  TicketStoreError,
  archiveTicket,
  categoryWarning,
  detectTicketStore,
  doctorTicketStore,
  exitCodeFor,
  exportLegacyStore,
  migrateLegacyStore,
  offerLegacyMigration,
  pendingTransactions,
  planEditSession,
  recoverDirectoryTransaction,
  recoverMigration,
  restoreTicket,
  renderCommandHelp,
  renderUsage,
  serializePlan,
  ticketJsonSchema,
} from '../index.mjs';

function parse(argv) {
  const flags = {};
  const positionals = [];
  const boolean = new Set(['write', 'json', 'yes', 'authorize', 'archive', 'complete', 'rollback', 'help', 'force']);
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
  const command = positionals[0];
  // Resolve --help against the command BEFORE anything touches the store, so
  // `create --help` answers "what shape is the input document?" rather than
  // reprinting the generic usage, and answers it in a repo with no store yet.
  if (flags.help || positionals.length === 0) {
    console.log((command && renderCommandHelp(command)) || renderUsage());
    return;
  }
  if (command === 'schema') { emit(ticketJsonSchema(), true); return; }
  const root = resolve(flags.root ?? '.');
  const storeCommand = command === 'store' ? positionals[1] : null;
  if (storeCommand === 'migrate') {
    emit(migrateLegacyStore(root, { write: Boolean(flags.write), yes: Boolean(flags.yes), key: resolveKeyFromEnv() }), flags.json);
    return;
  }
  if (storeCommand === 'recover') {
    const transactions = pendingTransactions(root);
    if (transactions.length !== 1) throw new TicketStoreError('conflict', 'RECOVERY_SELECTION_REQUIRED', `expected one pending transaction, found ${transactions.length}`);
    const direction = flags.complete ? 'complete' : flags.rollback ? 'rollback' : null;
    let journal;
    try { journal = JSON.parse(readFileSync(join(root, TRANSACTION_DIRECTORY, transactions[0], 'journal.json'), 'utf8')); }
    catch (error) { throw new TicketStoreError('invalid', 'INVALID_JOURNAL', `cannot read transaction journal: ${error.message}`); }
    if (journal.operation === 'migrate') emit(recoverMigration(root, transactions[0], { direction, key: resolveKeyFromEnv() }), flags.json);
    else {
      const recoveryStore = detectTicketStore({ root, ticketStore: flags['ticket-store'], legacyTickets: flags.tickets, allowRecovery: true });
      emit(recoverDirectoryTransaction(recoveryStore, transactions[0], { root, direction, key: resolveKeyFromEnv() }), flags.json);
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
    emit(doctorTicketStore(store, { root, archive: Boolean(flags.archive), key: resolveKeyFromEnv() }), flags.json);
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
  const service = new TicketService(store, { root, key: resolveKeyFromEnv() });
  let plan;
  // Set only by the edit command. The draft survives a dry run and is removed
  // after a successful write; anything else prints where it is.
  let editDraftPath = null;
  if (command === 'create') {
    if (!flags.input) throw new TicketStoreError('invalid', 'INPUT_REQUIRED', 'create requires --input');
    const input = await readInput(flags.input);
    // Advisory, never fatal: the store accepts any category and the published
    // schema must stay permissive, but an author who picks a plausible-looking
    // one only finds out when a later sync fails closed on the remote block.
    const warning = categoryWarning(input?.category);
    if (warning) console.error(warning);
    plan = service.planCreate(input);
  } else if (command === 'update') {
    if (!flags.input) throw new TicketStoreError('invalid', 'INPUT_REQUIRED', 'update requires --input');
    // update REPLACES the ticket, so a document exported before someone else's
    // write silently discards their work. Applying that without a hash is
    // last-writer-wins on a trust root, so --write fails closed. Planning is
    // deliberately still open: a dry run is how you inspect a change safely.
    if (flags.write && !flags.expect && !flags.force) {
      throw new TicketStoreError(
        'policy',
        'EXPECT_REQUIRED',
        'update --write requires --expect <ticketHash> so a concurrent write cannot be silently overwritten. '
        + 'Take the hash from `adlc ticket show <id> --json`, or pass --force to replace whatever is there now.',
      );
    }
    const updateInput = await readInput(flags.input);
    const updateWarning = categoryWarning(updateInput?.category);
    if (updateWarning) console.error(updateWarning);
    // --force means "replace whatever is there now", so it must also DROP a
    // hash the caller supplied. Passing it through left the documented override
    // doing nothing: the rerun failed STALE_TICKET on the same stale hash.
    plan = service.planUpdate(positionals[1], updateInput, {
      expect: flags.force ? undefined : flags.expect,
      authorized: Boolean(flags.authorize),
    });
  } else if (command === 'edit') {
    const session = planEditSession(service, positionals[1], {
      authorized: Boolean(flags.authorize),
      editor: process.env.EDITOR || process.env.VISUAL,
      onEdited: (edited) => { const w = categoryWarning(edited?.category); if (w) console.error(w); },
    });
    plan = session.plan;
    editDraftPath = session.draftPath;
  } else if (command === 'discard') plan = service.planDiscard(positionals[1]);
  else if (command === 'complete') plan = service.planComplete(positionals[1], { authorized: Boolean(flags.authorize) });
  else if (command === 'archive' || command === 'restore') {
    if (!(store instanceof DirectoryTicketStore)) throw new TicketStoreError('policy', 'DIRECTORY_STORE_REQUIRED', `${command} requires a directory store`);
    const options = { expectedSnapshotHash: snapshot.hash, reason: flags.reason, sourceRevision: flags.revision, root, authorized: Boolean(flags.authorize), key: resolveKeyFromEnv() };
    if (!flags.write) { emit({ operation: command, ticketId: positionals[1], expectedSnapshotHash: snapshot.hash, evidenceRequired: true, dryRun: true }, flags.json); return; }
    const result = command === 'archive'
      ? archiveTicket(store, join(root, '.adlc/ticket-archive'), positionals[1], options)
      : restoreTicket(store, join(root, '.adlc/ticket-archive'), positionals[1], options);
    emit({ operation: command, applied: true, storeHash: result.active.hash }, flags.json);
    return;
  }
  emit({ ...serializePlan(plan), dryRun: !flags.write }, flags.json);
  if (flags.write) {
    let applied;
    try {
      applied = service.apply(plan);
    } catch (error) {
      // Everything after planEditSession returns is outside its protection, and
      // apply is where a concurrent writer or a held lock actually bites —
      // STALE_SNAPSHOT, LOCK_TIMEOUT, a transaction failure. The draft survives
      // in a randomly named temp directory, so an error that does not name it
      // loses the author's work just as thoroughly as deleting it would.
      if (editDraftPath && error && typeof error.message === 'string') {
        error.message = `${error.message} (your edit is preserved at ${editDraftPath})`;
      }
      throw error;
    }
    emit({ applied: true, storeHash: applied.hash, ticketHash: plan.ticketId ? applied.ticketHashes[plan.ticketId] : null }, flags.json);
    // Applied: the edit is in the store, so the draft has served its purpose.
    if (editDraftPath) rmSync(dirname(editDraftPath), { recursive: true, force: true });
  } else if (editDraftPath) {
    // Dry run — `edit` without --write is the DEFAULT invocation. The plan was
    // only previewed, so the edited document is the author's sole copy; saying
    // where it is turns "my work vanished" into "re-run with --input".
    console.error(`edit not applied (dry run); your edited ticket is at ${editDraftPath}`);
  }
}

main().catch((error) => {
  const structured = error instanceof TicketStoreError ? error : new TicketStoreError('operational', 'UNEXPECTED', error?.message ?? String(error));
  if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, kind: structured.kind, code: structured.code, message: structured.message, details: structured.details }));
  else console.error(`${structured.code}: ${structured.message}`);
  process.exitCode = exitCodeFor(structured);
});
