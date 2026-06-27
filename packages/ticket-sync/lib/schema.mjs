// schema.mjs — THE single source of truth for ADLC ticket-sync schemas.
//
// Zero dependencies (CONVENTIONS rule 1). Consumed by:
//   - lib/validate.mjs       (the definition-driven validator), and
//   - scripts/gen-schema.mjs (JSON Schema generation).
// Editing a definition here WITHOUT regenerating the committed schemas/*.json
// fails the drift gate in test/schema.test.mjs — so the code validator and the
// published JSON Schemas can never diverge.
//
// Definition language (plain data, no deps):
//   { type: 'string'|'number'|'array'|'object',
//     required?: bool, enum?: string[], minLength?: number,
//     exclusiveMinimum?: number, items?: <spec>, fields?: {name: <spec>},
//     additionalProperties?: bool, description?: string }

export const CATEGORIES = [
  'feature', 'bug', 'bugfix', 'refactor', 'docs', 'chore', 'test',
  'spec', 'contract', 'architecture',
];

const STR = { type: 'string' };
// Non-empty string. NOTE: core's validateTicket rejects empty/falsy id+title too
// (`!t.id`), so requiring non-empty here stays in agreement with core on those
// shared fields.
const NESTR = { type: 'string', minLength: 1 };

// `edges[].to` is a plain string here (NOT minLength) to stay byte-for-byte in
// agreement with core's `typeof e.to !== 'string'` check on this shared field.
const EDGE = {
  type: 'object',
  additionalProperties: false,
  fields: {
    to: { type: 'string', required: true, description: 'Id of the dependent ticket.' },
    contract: { ...STR, description: 'Optional path to the contract this edge guarantees.' },
  },
};

export const TICKET_DEF = {
  id: 'adlc-ticket',
  title: 'ADLC ticket',
  description: 'A single ADLC ticket as stored in .adlc/tickets.json.',
  additionalProperties: true,
  fields: {
    id: { ...NESTR, required: true, description: 'Unique id: T<n> while local; gh:<owner>/<repo>#<n> once synced.' },
    title: { ...NESTR, required: true, description: 'One-line imperative summary (from the issue title once synced).' },
    body: { ...STR, description: 'Self-contained ticket text including acceptance criteria.' },
    scope: { type: 'array', items: STR, description: 'File globs this ticket may edit.' },
    rails: { type: 'array', items: STR, description: 'Frozen path globs that must not change during the build.' },
    edges: { type: 'array', items: EDGE, description: 'Prerequisite->dependent ordering edges.' },
    duration: { type: 'number', exclusiveMinimum: 0, description: 'Relative build-time estimate (> 0).' },
    category: { ...STR, enum: CATEGORIES, description: 'Routing category.' },
    budget: { type: 'number', exclusiveMinimum: 0, description: 'Optional token budget hint (> 0).' },
  },
};

// The subset legal inside the fenced ```adlc block (no id/title/origin). `$schema`
// is an optional editor-validation hint and is excluded from canonical equality.
export const BLOCK_DEF = {
  id: 'adlc-block',
  title: 'ADLC issue-body block',
  description: 'Execution metadata embedded in an external issue body between the adlc sentinels.',
  additionalProperties: true,
  fields: {
    $schema: { ...STR, description: 'Optional JSON Schema URL (editor hint; excluded from canonical equality).' },
    scope: TICKET_DEF.fields.scope,
    rails: TICKET_DEF.fields.rails,
    edges: TICKET_DEF.fields.edges,
    duration: TICKET_DEF.fields.duration,
    category: TICKET_DEF.fields.category,
    budget: TICKET_DEF.fields.budget,
  },
};

export const CONFIG_DEF = {
  id: 'adlc-config',
  title: 'ADLC ticket-sync config',
  description: '.adlc/config.json — ticket-sync provider configuration.',
  additionalProperties: true,
  fields: {
    ticketSync: {
      type: 'object',
      additionalProperties: false,
      description: 'External ticket-sync settings.',
      fields: {
        provider: { ...STR, enum: ['github'], required: true, description: 'External provider.' },
        repo: { ...STR, description: 'owner/name; auto-detected from the git remote when omitted.' },
        select: {
          type: 'object',
          additionalProperties: false,
          description: 'Which issues to sync.',
          fields: {
            state: { ...STR, enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
            labels: { type: 'array', items: STR, description: 'Sync issues carrying any of these labels.' },
            query: { ...STR, description: 'Optional raw search query.' },
          },
        },
        createLabel: { ...STR, description: 'Label applied to issues ADLC creates.' },
        statusLabels: { type: 'object', additionalProperties: true, description: 'Map of status -> adlc: label.' },
      },
    },
  },
};

export const SYNC_STATE_DEF = {
  id: 'adlc-sync-state',
  title: 'ADLC ticket-sync sidecar state',
  description: '.adlc/ticket-sync.state.json — gitignored rebuildable sync cache (NOT a rail).',
  additionalProperties: true,
  fields: {
    version: { type: 'number', required: true, description: 'Sidecar format version.' },
    tickets: { type: 'object', additionalProperties: true, description: 'ticket id -> sync record.' },
    pendingCreates: { type: 'object', additionalProperties: true, description: 'create key -> in-flight create record.' },
  },
};

export const DEFS = {
  'adlc-ticket': TICKET_DEF,
  'adlc-block': BLOCK_DEF,
  'adlc-config': CONFIG_DEF,
  'adlc-sync-state': SYNC_STATE_DEF,
};
