/**
 * Self-describing help for `adlc ticket`.
 *
 * The input document a ticket mutation takes used to be discoverable only by
 * reading an existing ticket out of the store, so every author re-derived the
 * same field set — and re-derived it wrong, because `id` looks required and is
 * not. `TICKET_FIELDS` is the one place that shape is written down: the CLI
 * help, the published JSON Schema, and the drift test in test/help.test.mjs all
 * read from it, so none of them can disagree.
 *
 * Prose here must not contain a `{` before the worked example — the example is
 * extracted by brace span so it can be piped straight into `create --input -`,
 * and both test/help.test.mjs and test/cli-help.test.mjs execute it.
 */

export const SCHEMA_ID = 'https://adlc.dev/schemas/ticket-v1.json';

/**
 * The categories @adlc/ticket-sync will round-trip.
 *
 * Duplicated rather than imported: CONVENTIONS rule 1 keeps this package free
 * of cross-package runtime deps. scripts/test/ticket-help-contract.test.mjs
 * asserts this list equals ticket-sync's enum exactly, so the copy cannot
 * drift silently.
 *
 * The published SCHEMA deliberately does NOT enforce these — constraining a
 * field validateTicket ignores would narrow v1 under a fixed $id. The check
 * belongs at authoring time, which is where the choice is actually made.
 */
export const SYNC_CATEGORIES = Object.freeze([
  'feature', 'bug', 'bugfix', 'refactor', 'docs', 'chore', 'test',
  'spec', 'contract', 'architecture',
]);

/** A warning for a category ticket-sync would reject, or null. */
export function categoryWarning(category) {
  // Only UNDEFINED counts as absent. ticket-sync treats the property as present
  // whenever it is not undefined and validates it as an enum string, so null,
  // the empty string and a number are all serialized into the remote block and
  // rejected by the next pull exactly like an unknown name.
  if (category === undefined) return null;
  if (SYNC_CATEGORIES.includes(category)) return null;
  return `warning: category ${JSON.stringify(category)} is not one ticket-sync accepts, so a synced ticket cannot converge. `
    + `Use one of: ${SYNC_CATEGORIES.join(", ")}.`;
}

/**
 * `required` is author-facing: the only field a create input must carry.
 * The JSON Schema below additionally requires `id`, because it describes a
 * *stored* ticket — the service mints the id on the way in.
 *
 * `type` is guidance for an author; `schema` is what the store ENFORCES, and the
 * two are deliberately not the same. The emitted schema publishes a fixed $id,
 * so a constraint on a field `validateTicket` does not police would narrow v1
 * without a version bump: a store this package loads happily would start
 * failing for any editor or CI consumer resolving that identity. Fields left
 * `{}` here are exactly the ones the validator ignores. test/help.test.mjs
 * derives this rule by probing rather than trusting the comment.
 */
export const TICKET_FIELDS = [
  {
    name: 'id',
    type: 'string',
    required: false,
    summary: 'Ticket id. Omit it on create and the store mints a ULID (T-01K...); supply one only to keep an existing T<n> id.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    name: 'title',
    type: 'string',
    required: true,
    summary: 'One imperative line naming the work.',
    schema: { type: 'string', minLength: 1 },
  },
  {
    name: 'body',
    type: 'string',
    required: false,
    summary: 'The self-contained ticket text: what to build, the acceptance criteria, and the concrete command that verifies each one. A fresh agent sees only this — never the conversation that produced it. coldstart audits it for gaps.',
    schema: {}, // unpoliced by validateTicket — see the `schema` note below
  },
  {
    name: 'category',
    type: 'string',
    required: false,
    // The store accepts any string, so the schema must too — but ticket-sync's
    // rich validator pins an enum, and a category outside it round-trips to a
    // remote provider and then fails closed on the next sync. Name the set here
    // so the choice is made once, at authoring time.
    summary: 'Routing hint, not a free-form label. model-router sends contract, spec, and architecture to a frontier model and routes the rest from empirical priors. Keep to the set ticket-sync accepts or a synced ticket cannot converge: feature, bug, bugfix, refactor, docs, chore, test, spec, contract, architecture.',
    schema: {}, // unpoliced by validateTicket — see the `schema` note below
  },
  {
    name: 'duration',
    type: 'number > 0',
    required: false,
    summary: 'Relative build-time estimate used to order the ticket DAG. Defaults to 1.',
    schema: { type: 'number', exclusiveMinimum: 0 },
  },
  {
    name: 'budget',
    type: 'number > 0',
    required: false,
    // NOT constrained in the schema: the store does not police budget, and
    // model-router ignores a non-positive or non-numeric one rather than
    // rejecting it. Pinning it here would narrow v1 under an unchanged $id and
    // make the published schema reject stores that load fine.
    summary: 'Optional token ceiling. model-router and flail-detector honour a positive number and ignore anything else; the store does not validate it. Omit it to take the tier default.',
    schema: {},
  },
  {
    name: 'scope',
    type: 'string[]',
    required: false,
    summary: 'Path globs this ticket may touch, e.g. src/auth/**.',
    schema: { type: 'array', items: { type: 'string' } },
  },
  {
    name: 'rails',
    type: 'string[]',
    required: false,
    summary: 'Path globs frozen for the duration of the build; rails-guard denies edits to them. Once any ticket declares rails the ticket store itself becomes a frozen trust root, so later ticket writes need ADLC_RAILS_BYPASS=1.',
    schema: { type: 'array', items: { type: 'string' } },
  },
  {
    name: 'completed',
    type: 'boolean',
    required: false,
    // Written by planComplete, not by an author — but it lives on a stored
    // ticket, so an update rebuilt from this table without it silently retires
    // the flag and downstream tooling schedules the work again.
    summary: 'Lifecycle state, set by `adlc ticket complete` rather than authored by hand. It is part of the stored document, so an update that omits it REMOVES it — build updates from `show <id> --json`, not from scratch.',
    schema: {},
  },
  {
    name: 'edges',
    type: 'array of "to" objects',
    required: false,
    summary: 'Ordering constraints, prerequisite to dependent. An edge with "to": "TX" on THIS ticket means this ticket must complete before TX — so making this ticket depend on an existing one is an edge added to that existing ticket, never a reversed edge here. An edge may also carry "contract": a path to the interface it guarantees TX can consume, which is what lets the two be built in parallel; ticket-sync recognizes it and nothing else on an edge.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'string', minLength: 1, description: 'Id of the dependent ticket, which must not start before this one completes.' },
          // Unconstrained for the same reason as body/category: validateTicket
          // checks only that an edge carries a string `to`.
          contract: { description: 'Path to the interface this edge guarantees the dependent ticket can consume.' },
        },
        additionalProperties: true,
      },
    },
  },
];

const CREATE_EXAMPLE = {
  title: 'Reject unsigned webhook deliveries',
  body: 'Verify the HMAC signature on every inbound webhook before dispatch.\n\nAcceptance criteria:\n1. An unsigned delivery is rejected with 401. Verify: node --test test/webhook.test.mjs\n2. A delivery signed with a stale secret is rejected. Verify: node --test test/webhook.test.mjs',
  category: 'feature',
  duration: 2,
  scope: ['src/webhook/**', 'test/webhook.test.mjs'],
  rails: [],
  edges: [],
};

const FIELD_INDENT = '  ';

/** Greedy word wrap; every emitted line carries `indent`. */
function wrap(text, width, indent) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) { lines.push(indent + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}

function fieldTable() {
  const width = Math.max(...TICKET_FIELDS.map((field) => field.name.length));
  const body = FIELD_INDENT.repeat(3);
  const lines = [];
  for (const field of TICKET_FIELDS) {
    lines.push(`${FIELD_INDENT}${field.name.padEnd(width)}  ${field.type}${field.required ? ' (required)' : ''}`);
    lines.push(...wrap(field.summary, 92 - body.length, body));
  }
  return lines;
}

/** The worked example, exactly as `create --help` prints it. */
const createExampleJson = () => JSON.stringify(CREATE_EXAMPLE, null, 2);

const INPUT_DOCUMENT = [
  'Input document (--input <path> or - for stdin; see `adlc ticket schema`):',
  '',
  ...fieldTable(),
  '',
  'Unknown fields are preserved as-is; the store never strips them.',
];

/** Shared by update and edit: the one flag whose absence turns a legitimate
 *  edit into a policy error, with no hint in the error about which flag. */
const AUTHORIZE_NOTE = [
  '--authorize is REQUIRED for a change the service treats as sensitive, and',
  'there are exactly three: narrowing rails (dropping a path the ticket froze),',
  'widening scope (adding a path it may touch), and changing `completed` — which',
  'belongs to `adlc ticket complete`, where it carries lifecycle evidence. Any of',
  'them without the flag fails AUTHORIZATION_REQUIRED and writes nothing.',
  'Everything else — title, body, category, duration, budget, edges — needs no',
  'authorization.',
];

const COMMAND_HELP = {
  create: () => [
    'adlc ticket create --input <path|-> [--write] [--json]',
    '',
    'Plan a new ticket. Dry-run by default: the plan, validation, graph effects,',
    'file operations, and resulting hashes print, and nothing is written until',
    '--write. The command never stages or commits.',
    '',
    ...INPUT_DOCUMENT,
    '',
    'Example (pipe it straight in: `adlc ticket create --input - < ticket.json`):',
    '',
    createExampleJson(),
  ],
  update: () => [
    'adlc ticket update <id> --input <path|-> --expect <ticketHash> [--authorize] [--force] [--write] [--json]',
    '',
    'Replace a ticket in place. This is a REPLACEMENT, not a merge: any field',
    'absent from the input is dropped, including `completed`, so building an',
    'update from the field table below quietly retires lifecycle state it never',
    'meant to touch. Start from the stored ticket instead.',
    '',
    '`adlc ticket edit <id>` is the path that gets this right for you: it opens',
    'the stored ticket and supplies the expected hash. Scripting it by hand takes',
    'the ticket OUT of the show envelope first — `show --json` returns',
    'ticket/ticketHash/storeHash, and feeding that envelope straight back in',
    'fails IDENTITY_CHANGE_REQUIRES_REASSIGN because the id sits one level down:',
    '',
    '  adlc ticket show T1 --json > T1.envelope.json   # capture ONCE',
    '  jq .ticket T1.envelope.json > T1.json           # edit this',
    '  adlc ticket update T1 --input T1.json --write \\',
    '    --expect "$(jq -r .ticketHash T1.envelope.json)"',
    '',
    'Both the document and the hash come from the SAME capture. Reading them',
    'with two separate `show` calls defeats the guard entirely: a write landing',
    'between the two hands you a current hash paired with a stale document, so',
    'the compare-and-swap passes and silently reverts the other author.',
    '',
    'The input must carry the same id. Changing a ticket\'s identity is a',
    'library-only operation (TicketService.planReassign) — this CLI exposes no',
    'reassign verb, so discard-and-recreate is the supported route here.',
    '',
    ...AUTHORIZE_NOTE,
    '',
    '--expect is REQUIRED to --write. Give it the current ticketHash from',
    '`adlc ticket show <id> --json` or `adlc ticket list --json`; the write is',
    'then a compare-and-swap that fails STALE_TICKET if the ticket moved',
    'underneath you. Because update REPLACES, applying a document exported',
    'before someone else\'s write would otherwise discard their work in silence,',
    'so --write without it fails EXPECT_REQUIRED. Pass --force to replace',
    'whatever is there now. Planning needs no hash — a dry run is unrestricted.',
    '',
    ...INPUT_DOCUMENT,
  ],
  edit: () => [
    'adlc ticket edit <id> [--authorize] [--write] [--json]',
    '',
    'Open the ticket in $EDITOR (or $VISUAL) and plan the result as an update.',
    'The expected hash is supplied for you. Dry-run by default.',
    '',
    ...AUTHORIZE_NOTE,
    '',
    ...INPUT_DOCUMENT,
  ],
  discard: () => [
    'adlc ticket discard <id> [--write] [--json]',
    '',
    'Remove a ticket that was never built. Dry-run by default. Use archive to',
    'retire a ticket whose history must be kept.',
  ],
  complete: () => [
    'adlc ticket complete <id> [--write --authorize] [--json]',
    '',
    'Mark a ticket complete. The plan is recorded as a lifecycle change and',
    'carries evidence either way.',
    '',
    '--authorize records that a human approved the change. It is ENFORCED only',
    'for a protected id, and this CLI configures no protected ids — so by',
    'default `complete <id> --write` applies without it.',
  ],
  archive: () => [
    'adlc ticket archive <id> [--write --authorize] [--json]',
    '',
    'Move a ticket into .adlc/ticket-archive with evidence. Requires a directory',
    'store. `adlc ticket restore <id>` is the inverse.',
  ],
  restore: () => [
    'adlc ticket restore <id> [--write --authorize] [--json]',
    '',
    'Move an archived ticket back into the active store. Requires a directory',
    'store.',
  ],
  list: () => [
    'adlc ticket list [--json]',
    '',
    'Print every active ticket as id, title, and ticketHash. The hash is what',
    '`update --expect` takes.',
  ],
  show: () => [
    'adlc ticket show <id> [--json]',
    '',
    'Print one ticket with its ticketHash and the store hash.',
  ],
  doctor: () => [
    'adlc ticket doctor [--archive] [--json]',
    '',
    'Diagnose the store: manifest, shard integrity, the active-ticket pointer,',
    'and any pending transaction awaiting recovery.',
  ],
  schema: () => [
    'adlc ticket schema [--json]',
    '',
    'Print the JSON Schema for a stored ticket. It describes the same fields',
    '`create --help` documents; `id` is required there because the service has',
    'already minted it by the time a ticket is stored.',
  ],
  store: () => [
    'adlc ticket store <status|migrate|recover|export> [options]',
    '',
    '  status                       backend, format version, ticket count, hashes',
    '  migrate [--write --yes]      preview or apply the legacy -> sharded migration',
    '  recover (--complete|--rollback)  finish or undo an interrupted transaction',
    '  export --output <path>       write a legacy-shaped snapshot',
  ],
};

/** Per-command help text, or null when the command has none. */
export function renderCommandHelp(command) {
  const render = COMMAND_HELP[command];
  return render ? render().join('\n') : null;
}

export function renderUsage() {
  return [
    'adlc ticket <command> [options]',
    '',
    'Commands:',
    '  list | show <id>',
    '  create --input <path|-> [--write]',
    '  update <id> --input <path|-> [--expect <ticket-hash>] [--write]',
    '  edit <id> [--write]',
    '  discard <id> [--write]',
    '  complete <id> [--write --authorize]',
    '  archive <id> [--write --authorize] | restore <id> [--write --authorize]',
    '  doctor [--archive] | schema | store status',
    '  store migrate [--write --yes] | store recover (--complete|--rollback)',
    '  store export --output <path>',
    '',
    'Run `adlc ticket <command> --help` for the flags and input document of one',
    'command, or `adlc ticket schema` for the ticket JSON Schema.',
    '',
    'All mutations are dry-run by default. New override: --ticket-store/ADLC_TICKET_STORE.',
    'Legacy --tickets/ADLC_TICKETS remains available through 1.x.',
  ].join('\n');
}

/** The published ticket schema, built from the same field table as the help. */
export function ticketJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'ADLC ticket',
    description: 'A stored ADLC ticket. `adlc ticket create` accepts the same document without `id`, which the store mints as a ULID.',
    type: 'object',
    required: ['id', 'title'],
    properties: Object.fromEntries(
      TICKET_FIELDS.map((field) => [field.name, { ...field.schema, description: field.summary }]),
    ),
    additionalProperties: true,
  };
}

/** Exactly the bytes committed to schemas/ticket.schema.json. */
export const serializeTicketJsonSchema = () => `${JSON.stringify(ticketJsonSchema(), null, 2)}\n`;
