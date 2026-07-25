import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TICKET_FIELDS,
  renderCommandHelp,
  renderUsage,
  serializeTicketJsonSchema,
  ticketJsonSchema,
} from '../lib/help.mjs';
import { validateTicket } from '../lib/schema.mjs';

const PACKAGE = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fieldNames = () => TICKET_FIELDS.map((field) => field.name);

test('the field table documents every field the validator polices', () => {
  // Drift defense. `validateTicket` is the real authority on the input document;
  // help that omits a field it polices sends the author back to reading an
  // existing ticket, which is the relearning cost this module exists to remove.
  const policed = ['id', 'title', 'scope', 'rails', 'edges', 'duration'];
  for (const name of policed) {
    assert.ok(fieldNames().includes(name), `TICKET_FIELDS must document ${name}`);
  }
});

test('a field the validator starts policing cannot go undocumented', () => {
  // The list above is static, so on its own it would never notice a NEW rule.
  // Read the validator's source for the fields it actually reaches into: adding
  // validation for a field without documenting it fails here.
  const source = readFileSync(join(PACKAGE, 'lib/schema.mjs'), 'utf8');
  const reached = new Set(
    [...source.matchAll(/\bticket\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1]),
  );
  reached.delete('length'); // string/array probes on a field, not a field itself
  const documented = new Set(fieldNames());
  const undocumented = [...reached].filter((name) => !documented.has(name) && !name.startsWith('_'));
  assert.deepEqual(undocumented, [], 'lib/help.mjs must document every field lib/schema.mjs validates');
});

test('every documented field carries a type and a summary', () => {
  for (const field of TICKET_FIELDS) {
    assert.equal(typeof field.name, 'string');
    assert.equal(typeof field.type, 'string');
    assert.ok(field.summary.length > 0, `${field.name} needs a summary`);
    assert.equal(typeof field.required, 'boolean');
  }
});

test('title is the only field an author must supply', () => {
  // `id` is deliberately NOT required: the service mints a ULID when it is
  // absent (lib/service.mjs planCreate). Documenting it as required is what
  // sends authors off to derive a "next free T<n>" that nothing asks for.
  assert.deepEqual(TICKET_FIELDS.filter((field) => field.required).map((field) => field.name), ['title']);
});

test('create help states that an omitted id is generated', () => {
  const help = renderCommandHelp('create');
  assert.match(help, /ULID/);
  assert.match(help, /omit/i);
});

test('create help documents every field by name', () => {
  const help = renderCommandHelp('create');
  for (const name of fieldNames()) {
    assert.match(help, new RegExp(`\\b${name}\\b`), `create help must document ${name}`);
  }
});

test('create help names the categories that force a frontier model', () => {
  // ticket.category is not a free-form label: model-router routes
  // contract/spec/architecture to a frontier tier (lib/assign.mjs).
  const help = renderCommandHelp('create');
  for (const category of ['contract', 'spec', 'architecture']) {
    assert.match(help, new RegExp(category), `create help must name the ${category} routing category`);
  }
});

test('create help carries a worked example that is a valid ticket', () => {
  const help = renderCommandHelp('create');
  const example = help.slice(help.indexOf('{'), help.lastIndexOf('}') + 1);
  const parsed = JSON.parse(example);
  assert.ok(!('id' in parsed), 'the example must demonstrate the omitted-id path');
  assert.deepEqual(validateTicket({ ...parsed, id: 'T1' }), []);
});

test('update help states the compare-and-swap requirement', () => {
  const help = renderCommandHelp('update');
  assert.match(help, /--expect/);
  assert.match(help, /ticketHash/);
});

test('update help does not claim a guard the CLI does not enforce', () => {
  // bin/adlc-tickets.mjs requires only --input, and planUpdate checks the hash
  // only when it is truthy — so an update WITHOUT --expect is last-writer-wins.
  // Help that reads as though the guard is unconditional is worse than none:
  // it invites a scripted caller to omit the flag and assume it is still safe.
  const help = renderCommandHelp('update');
  assert.match(help, /optional/i, 'the help must say --expect is optional');
  assert.match(help, /last-writer-wins/i, 'the help must name what omitting it costs');
});

test('complete/archive help describe the real authorization policy', () => {
  // The CLI constructs TicketService with no protectedIds, so --authorize gates
  // nothing by default; planComplete only enforces it for a protected id.
  const help = renderCommandHelp('complete');
  assert.match(help, /protected/i, 'the help must scope --authorize to protected ids');
  assert.doesNotMatch(help, /without it the write is refused/i, 'that claim is false by default');
});

test('every command the CLI dispatches has dedicated help', () => {
  const commands = [
    'list', 'show', 'create', 'update', 'edit', 'discard', 'complete',
    'archive', 'restore', 'doctor', 'schema', 'store',
  ];
  for (const command of commands) {
    const help = renderCommandHelp(command);
    assert.ok(help && help.length > 0, `${command} needs dedicated help`);
    assert.match(help, new RegExp(`^adlc ticket ${command}\\b`), `${command} help must open with its own usage line`);
  }
});

test('renderCommandHelp returns null for an unknown command', () => {
  assert.equal(renderCommandHelp('nope'), null);
  assert.equal(renderCommandHelp(undefined), null);
});

test('the top-level usage advertises the discovery commands', () => {
  const usage = renderUsage();
  assert.match(usage, /schema/);
  assert.match(usage, /<command> --help/);
});

test('the JSON schema is built from the same field table as the help', () => {
  const schema = ticketJsonSchema();
  assert.deepEqual(Object.keys(schema.properties).sort(), fieldNames().sort());
  assert.deepEqual(schema.required, ['id', 'title']);
  for (const field of TICKET_FIELDS) {
    assert.equal(schema.properties[field.name].description, field.summary);
  }
});

test('the committed schema file matches the generated one', () => {
  // The published schema and the CLI help must never disagree; if they can
  // drift, the file becomes another thing an author has to double-check.
  const committed = readFileSync(join(PACKAGE, 'schemas/ticket.schema.json'), 'utf8');
  assert.equal(committed, serializeTicketJsonSchema());
});

/** Minimal checker for the only keywords ticketJsonSchema() emits. */
function satisfies(value, schema) {
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'number' && typeof value !== 'number') return false;
  if (schema.type === 'array' && !Array.isArray(value)) return false;
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (schema.minLength !== undefined && String(value).length < schema.minLength) return false;
  if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) return false;
  if (schema.items) return value.every((item) => satisfies(item, schema.items));
  if (schema.required) return schema.required.every((key) => key in value);
  return true;
}

test('the schema never rejects a ticket the validator accepts', () => {
  // The published schema carries a fixed $id, so constraining a field the store
  // does not police silently narrows v1: a store that loads fine stops
  // validating for any editor or CI consumer that resolves that same $id.
  // `budget` is the live case — model-router ignores a non-positive or
  // non-numeric budget rather than rejecting it, and neither does validateTicket.
  const corpus = [
    { id: 'T1', title: 'minimal' },
    { id: 'T1', title: 'loose budget', budget: 'cheap' },
    { id: 'T1', title: 'negative budget', budget: -5 },
    { id: 'T1', title: 'free-form category', category: 'anything-at-all' },
    { id: 'T1', title: 'empty collections', body: '', scope: [], rails: [], edges: [], duration: 1 },
    { id: 'T1', title: 'edges', edges: [{ to: 'T2', note: 'extra' }] },
  ];
  const { properties } = ticketJsonSchema();
  for (const ticket of corpus) {
    assert.deepEqual(validateTicket(ticket), [], `corpus entry must be valid: ${ticket.title}`);
    for (const [field, value] of Object.entries(ticket)) {
      assert.ok(
        satisfies(value, properties[field]),
        `schema rejects ${field}=${JSON.stringify(value)} which validateTicket accepts`,
      );
    }
  }
});

test('the schema still constrains what the validator DOES police', () => {
  // The inverse of the test above: permissiveness must not become vacuous.
  const { properties } = ticketJsonSchema();
  assert.ok(!satisfies(-5, properties.duration), 'duration is policed, so the schema must pin it');
  assert.ok(!satisfies('', properties.title), 'title is policed, so the schema must pin it');
  assert.ok(!satisfies('x', properties.scope), 'scope must be an array');
});

test('the generated schema keeps its published identity', () => {
  const schema = ticketJsonSchema();
  assert.equal(schema.$id, 'https://adlc.dev/schemas/ticket-v1.json');
  assert.equal(schema.additionalProperties, true);
});
