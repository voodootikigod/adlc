// ticket-help-contract.test.mjs — the `adlc ticket create --help` example is
// advertised as executable, so it is a producer whose output crosses a package
// boundary. This gate lives in scripts/test/ (like flag-consistency.test.mjs)
// because it asserts a contract BETWEEN packages: @adlc/tickets must not import
// @adlc/ticket-sync (CONVENTIONS rule 1), so neither package's own suite can
// see the disagreement.
//
// The disagreement was real: the example shipped `category: 'security'`, which
// the store accepts and ticket-sync's enum does not. A user copying the example
// verbatim gets a ticket that writes locally, pushes to a remote provider, and
// then fails closed on the next sync with an issue needing manual repair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommandHelp, renderUsage, TICKET_FIELDS } from '../../packages/tickets/lib/help.mjs';
import { validateTicket } from '../../packages/tickets/lib/schema.mjs';
import { CATEGORIES } from '../../packages/ticket-sync/lib/schema.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const ADLC = join(ROOT, 'packages/cli/bin/adlc.mjs');

const example = () => {
  const help = renderCommandHelp('create');
  return JSON.parse(help.slice(help.indexOf('{'), help.lastIndexOf('}') + 1));
};

test('the create example is a valid ticket for the store', () => {
  assert.deepEqual(validateTicket({ ...example(), id: 'T1' }), []);
});

test('the create example uses a category ticket-sync can round-trip', () => {
  const { category } = example();
  assert.ok(
    CATEGORIES.includes(category),
    `create --help offers category '${category}', which ticket-sync rejects. Accepted: ${CATEGORIES.join(', ')}`,
  );
});

test('`adlc ticket <command> --help` works for every command the usage advertises', () => {
  // The package suites invoke bin/adlc-tickets.mjs directly, so they cannot see
  // that the PUBLIC dispatcher routes pull/push/sync/doctor to @adlc/ticket-sync
  // (packages/cli/lib/dispatch.mjs). Its flag parser rejected --help outright,
  // so the instruction printed by `adlc ticket --help` was a dead end for four
  // of the commands it names — `adlc ticket doctor --help` exited 1 with
  // "unknown flag: --help".
  const advertised = ['list', 'show', 'create', 'update', 'edit', 'discard', 'complete', 'archive', 'restore', 'doctor', 'schema'];
  for (const command of advertised) {
    const result = spawnSync(process.execPath, [ADLC, 'ticket', command, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `\`adlc ticket ${command} --help\` exited ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.trim().length > 0, `\`adlc ticket ${command} --help\` printed nothing`);
  }
});

test('the routed-away commands are the ones ticket-sync documents', () => {
  // doctor/pull/push/sync answer from ticket-sync's usage, not the tickets bin.
  // Both are legitimate; what matters is that neither errors and each describes
  // the command the dispatcher actually runs.
  for (const command of ['doctor', 'pull', 'push', 'sync']) {
    const result = spawnSync(process.execPath, [ADLC, 'ticket', command, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`), `help must describe ${command}`);
  }
});

test('the top-level usage only points at per-command help that resolves', () => {
  assert.match(renderUsage(), /adlc ticket <command> --help/);
  assert.ok(renderCommandHelp('doctor'), 'doctor help must exist for the direct binary too');
});

test('the category field documents every value ticket-sync accepts', () => {
  // Naming the set in the help is what stops the next author reaching for a
  // plausible-but-unsyncable label. If ticket-sync adds one, say so here too.
  const summary = TICKET_FIELDS.find((field) => field.name === 'category').summary;
  const missing = CATEGORIES.filter((value) => !summary.includes(value));
  assert.deepEqual(missing, [], 'lib/help.mjs must list every ticket-sync category');
});
