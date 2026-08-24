import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { detectTicketStore } from './store.mjs';
import { LegacyTicketStore } from './stores/legacy.mjs';
import { migrateLegacyStore, migrationPlan } from './migrate.mjs';

/** True only for a human-facing legacy mutation where asking is safe. */
export function shouldOfferLegacyMigration(store, flags = {}, { input = stdin, output = stdout } = {}) {
  return store instanceof LegacyTicketStore && !flags.json && input.isTTY === true && output.isTTY === true;
}

/**
 * Offer the representation-only migration before an interactive legacy write.
 * Dependencies are injectable so the approval policy can be tested without a TTY
 * or filesystem mutation.
 */
/**
 * `key`/`allowUnsigned` are threaded to the migration, not defaulted here: a
 * legacy store that declares rails is a frozen trust root, so migrating it is an
 * audited override that migrateLegacyStore refuses unless it can be signed.
 * Dropping the resolved key at this boundary would refuse the interactive
 * migration of exactly the operator who HAS a key — the accept path answering
 * "yes" and then failing for a reason the prompt never mentioned.
 */
export async function offerLegacyMigration(store, root, flags = {}, {
  input = stdin,
  output = stdout,
  emit = (value) => output.write(`${JSON.stringify(value, null, 2)}\n`),
  ask,
  plan = migrationPlan,
  migrate = migrateLegacyStore,
  detect = detectTicketStore,
  key = null,
  allowUnsigned = false,
} = {}) {
  if (!shouldOfferLegacyMigration(store, flags, { input, output })) return store;
  emit({ warning: 'Legacy .adlc/tickets.json is active. ADLC can migrate it to independently mergeable shards.' });
  emit(plan(root));
  let answer;
  if (ask) answer = await ask('Apply migration? [y/N] ');
  else {
    const readline = createInterface({ input, output });
    try { answer = await readline.question('Apply migration? [y/N] '); }
    finally { readline.close(); }
  }
  if (!/^y(?:es)?$/i.test(String(answer ?? '').trim())) return store;
  migrate(root, { write: true, yes: true, key, allowUnsigned });
  return detect({ root, ticketStore: flags['ticket-store'], legacyTickets: flags.tickets });
}
