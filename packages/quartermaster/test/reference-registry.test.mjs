// The registry the DOCS tell an operator to copy must actually load (#396).
//
// The transport-serving rule defaults to "serves none", which makes it a flag
// day: an adapter shipped without a declaration silently stops loading every
// seat bound to it. A unit test over hand-written fixtures cannot catch that —
// the fixtures get fixed alongside the rule. This reads the real annotated
// example out of docs/integrations/quartermaster-registry.md and validates it,
// so the documented copy-paste path is covered by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapterCatalog } from '../../fleet/lib/adapters/index.mjs';
import { validateRegistry } from '../lib/registry.mjs';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'integrations', 'quartermaster-registry.md');

/**
 * Pull the annotated ```jsonc example out of the page and strip its comments.
 *
 * Deliberately NOT a copy of the registry: a copy would drift from the page the
 * moment someone edits one and not the other, and the whole point is to test
 * what an operator actually reads.
 */
function referenceRegistry() {
  const md = readFileSync(DOC, 'utf8');
  const block = md.match(/```jsonc\n([\s\S]*?)```/);
  assert.ok(block, 'the page must still carry a ```jsonc registry example');
  const withoutComments = block[1]
    .split('\n')
    .map((line) => line.replace(/\s*\/\/.*$/, ''))
    .join('\n');
  return JSON.parse(withoutComments);
}

test('the documented reference registry parses', () => {
  const registry = referenceRegistry();
  assert.ok(registry.channels, 'it has channels');
  assert.ok(registry.reviewerGroups, 'it has reviewer groups');
});

test('the documented reference registry VALIDATES against the real adapter catalog', () => {
  // If this fails after an adapter change, the page is telling operators to
  // write a file the loader rejects — fix the adapter declaration or the page,
  // never this assertion.
  assert.doesNotThrow(() => validateRegistry(referenceRegistry(), { adapters: adapterCatalog() }));
});

test('every transport in the documented registry is one its adapter declares', () => {
  // The same property one level down, so a failure says WHICH seat is wrong
  // instead of just "the registry is invalid".
  const registry = referenceRegistry();
  const adapters = adapterCatalog();
  const seats = [
    ...Object.entries(registry.channels).map(([name, s]) => [`channels.${name}`, s]),
    ...Object.entries(registry.reviewerGroups).flatMap(([g, group]) =>
      (group.members ?? []).map((m, i) => [`reviewerGroups.${g}.members[${i}]`, m])),
  ];
  assert.ok(seats.length > 0, 'the example actually contains seats');
  for (const [label, seat] of seats) {
    const klass = String(seat.transport).split(':')[0];
    const declared = Object.keys(adapters[seat.adapter]?.transports ?? {});
    assert.ok(
      declared.includes(klass),
      `${label}: adapter "${seat.adapter}" does not declare "${klass}" (declares: ${declared.join(', ') || 'none'})`,
    );
  }
});
