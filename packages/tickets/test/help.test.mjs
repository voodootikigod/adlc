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
  assert.match(help, /REQUIRED to --write/, 'the help must state that --write demands the hash');
  assert.match(help, /EXPECT_REQUIRED/, 'and name the error it raises');
  assert.match(help, /--force/, 'and the documented override');
});

test('update and edit help document the authorization flag they actually need', () => {
  // --authorize is inert for `complete` (no protected ids are configured) but
  // load-bearing here: planUpdate throws AUTHORIZATION_REQUIRED for rail
  // narrowing or scope widening. Help that omits it sends an author into a
  // policy error with no documented way out — the exact relearning loop this
  // module exists to end.
  for (const command of ['update', 'edit']) {
    const help = renderCommandHelp(command);
    assert.match(help, /--authorize/, `${command} help must document --authorize`);
    assert.match(help, /narrow/i, `${command} help must name rail narrowing`);
    assert.match(help, /widen/i, `${command} help must name scope widening`);
  }
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
  //
  // BYTE-for-byte, deliberately. This file is a PUBLISHED artifact resolved by
  // its $id, so its bytes are the product; normalizing line endings here would
  // let `npm pack` on a Windows checkout ship a CRLF schema this test still
  // called identical. The separator is pinned at the repository boundary
  // instead — see .gitattributes — so the file is LF on every platform and this
  // comparison can stay exact.
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
  // validating for any editor or CI consumer resolving that same $id.
  //
  // DERIVED, not a hand-written corpus. The first version listed example
  // tickets and missed `body: 7` and `category: 7` — both accepted by the
  // validator, both rejected by the schema — because every entry happened to
  // use a string. Probing each documented field with off-type values closes
  // that by construction, and covers fields added later.
  const PROBES = [7, -1, 0, true, false, null, {}, [], 'text', ['x'], [{ to: 'T2' }]];
  const { properties } = ticketJsonSchema();
  let checked = 0;
  for (const field of TICKET_FIELDS) {
    for (const probe of PROBES) {
      const ticket = { id: 'T1', title: 'probe', [field.name]: probe };
      if (validateTicket(ticket).length > 0) continue; // validator rejects it too — schema may
      checked += 1;
      assert.ok(
        satisfies(probe, properties[field.name]),
        `schema rejects ${field.name}=${JSON.stringify(probe)} which validateTicket accepts`,
      );
    }
  }
  // DENOMINATOR: a probe set the validator rejected wholesale would make every
  // assertion above vacuous.
  assert.ok(checked > 40, `expected the probes to exercise the schema, got ${checked}`);
});

test('the never-reject rule holds for nested edge fields too', () => {
  // The probe above only walks TOP-LEVEL fields, so an over-constrained nested
  // property (edges[].contract) would slip past it. validateTicket checks only
  // that an edge carries a string `to`; everything else on an edge is free.
  const edgeSchema = ticketJsonSchema().properties.edges.items;
  for (const probe of [7, true, null, {}, 'text']) {
    const edge = { to: 'T2', contract: probe };
    assert.deepEqual(validateTicket({ id: 'T1', title: 'x', edges: [edge] }), []);
    assert.ok(
      satisfies(edge, edgeSchema),
      `schema rejects edge contract=${JSON.stringify(probe)} which validateTicket accepts`,
    );
  }
  assert.ok(edgeSchema.additionalProperties, 'an edge must keep carrying unknown keys');
});

test('the edge shape documents contract, the field ticket-sync also recognizes', () => {
  // An author consulting only `create --help` would otherwise write a bare
  // `to` edge and never learn that an edge can pin the interface the dependent
  // ticket consumes — the thing that makes parallel execution safe.
  const summary = TICKET_FIELDS.find((field) => field.name === 'edges').summary;
  assert.match(summary, /contract/, 'the edges summary must document the contract field');
  assert.ok(ticketJsonSchema().properties.edges.items.properties.contract, 'and the schema must describe it');
});

test('the schema still constrains what the validator DOES police', () => {
  // The inverse of the test above: permissiveness must not become vacuous.
  const { properties } = ticketJsonSchema();
  assert.ok(!satisfies(-5, properties.duration), 'duration is policed, so the schema must pin it');
  assert.ok(!satisfies('', properties.title), 'title is policed, so the schema must pin it');
  assert.ok(!satisfies('x', properties.scope), 'scope must be an array');
});

// Declaration parity lives in scripts/test/type-declarations.test.mjs, where
// the root typescript devDependency is available (CONVENTIONS rule 1 keeps it
// out of this package). It compiles a real consumer that imports every runtime
// export, which is the only form that cannot be fooled: the regex version that
// used to live here searched index.d.ts for each name as a bare word, and so
// reported success for `invalid`, `conflict`, `policy` and `operational` —
// none of them declared — because those words appear inside the
// TicketErrorKind union literal.

test('the generated schema keeps its published identity', () => {
  const schema = ticketJsonSchema();
  assert.equal(schema.$id, 'https://adlc.dev/schemas/ticket-v1.json');
  assert.equal(schema.additionalProperties, true);
});
