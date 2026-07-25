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
import { renderCommandHelp, TICKET_FIELDS } from '../../packages/tickets/lib/help.mjs';
import { validateTicket } from '../../packages/tickets/lib/schema.mjs';
import { CATEGORIES } from '../../packages/ticket-sync/lib/schema.mjs';

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

test('the category field documents every value ticket-sync accepts', () => {
  // Naming the set in the help is what stops the next author reaching for a
  // plausible-but-unsyncable label. If ticket-sync adds one, say so here too.
  const summary = TICKET_FIELDS.find((field) => field.name === 'category').summary;
  const missing = CATEGORIES.filter((value) => !summary.includes(value));
  assert.deepEqual(missing, [], 'lib/help.mjs must list every ticket-sync category');
});
