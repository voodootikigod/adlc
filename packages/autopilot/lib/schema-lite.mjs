// A minimal, fail-closed JSON-Schema subset validator (spec §9.4).
//
// The autopilot validates the pinned `.adlc/config.json` against two schemas:
// its own `autopilot` block and `packages/ticket-sync/schemas/adlc-config.schema.json`
// for `ticketSync`. @adlc/ticket-sync is NOT a runtime dependency (the package
// depends on core, fleet and tickets only — AC 15), so the schema file is read
// from the pinned blob and evaluated here. Exactly the keywords those schemas
// use are supported; an UNSUPPORTED keyword is an error, never a silent pass.

const SUPPORTED = new Set(['$schema', '$id', 'title', 'description', 'type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'exclusiveMinimum', 'minItems', 'pattern']);

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(declared, actual) {
  const list = Array.isArray(declared) ? declared : [declared];
  return list.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

/**
 * @returns {string[]} errors as "<path>: <message>"; empty = valid.
 * @throws on an unsupported keyword (fail closed on schema drift).
 */
export function validateAgainst(schema, value, path = '$') {
  const errors = [];
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) throw new Error(`schema-unsupported: keyword "${k}" at ${path}`);
  const actual = typeOf(value);
  if (schema.type !== undefined && !typeMatches(schema.type, actual)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}, got ${actual}`);
    return errors;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateAgainst(schema.items, item, `${path}[${i}]`)));
  }
  if (actual === 'object') {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) if (!(req in value)) errors.push(`${path}.${req}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) errors.push(...validateAgainst(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown key`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateAgainst(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return errors;
}
