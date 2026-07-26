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
import { categoryWarning, renderCommandHelp, renderUsage, SYNC_CATEGORIES, TICKET_FIELDS } from '../../packages/tickets/lib/help.mjs';
import { validateTicket } from '../../packages/tickets/lib/schema.mjs';
import { CATEGORIES } from '../../packages/ticket-sync/lib/schema.mjs';
import { orderLocalByDependency } from '../../packages/ticket-sync/lib/push.mjs';
import { generateTicketId, isGeneratedTicketId } from '../../packages/tickets/index.mjs';

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

test('the duplicated sync-category list matches ticket-sync exactly', () => {
  // @adlc/tickets cannot import @adlc/ticket-sync (CONVENTIONS rule 1), so the
  // list is copied. This is the gate that keeps the copy honest — in both
  // directions, so a category added to ticket-sync and not here fails too.
  assert.deepEqual([...SYNC_CATEGORIES].sort(), [...CATEGORIES].sort());
});

test('create warns about a sync-unsafe category without failing', () => {
  // The published schema stays permissive by design (constraining a field
  // validateTicket ignores would narrow v1 under a fixed $id), so the signal
  // has to arrive at authoring time instead.
  assert.equal(categoryWarning('feature'), null);
  // Only UNDEFINED is absent: ticket-sync treats the property as present
  // whenever it is not undefined, so '' and null reach the remote block and
  // fail its enum exactly like an unknown name.
  assert.equal(categoryWarning(undefined), null, 'only an omitted category is absent');
  assert.ok(categoryWarning(''), 'an empty string is present and unacceptable');
  assert.ok(categoryWarning(null), 'so is null');
  const warning = categoryWarning('security');
  assert.match(warning, /security/, 'the warning names the offending value');
  assert.match(warning, /feature/, 'and lists what is accepted');
});

test('ticket-sync recognizes exactly the ids @adlc/tickets generates', () => {
  // ticket-sync duplicates the generated-id pattern (CONVENTIONS rule 1 keeps it
  // free of cross-package runtime deps), so this is the gate that keeps the copy
  // honest — in both directions. A drift here means `push` silently skips the
  // tickets the authoring help tells people to create.
  const samples = [
    generateTicketId(1_750_000_000_000, Buffer.alloc(10, 7)),
    generateTicketId(0, Buffer.alloc(10, 0)),
    generateTicketId(1, Buffer.alloc(10, 255)),
  ];
  for (const id of samples) {
    assert.ok(isGeneratedTicketId(id), `@adlc/tickets must recognize its own id ${id}`);
    assert.deepEqual(
      orderLocalByDependency([{ id, title: 'x', edges: [] }]).map((t) => t.id),
      [id],
      `ticket-sync must treat ${id} as a local ticket`,
    );
  }
});
