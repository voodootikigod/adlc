// The trusted `adlc:begin` block grammar (spec §5.1), re-implemented locally.
//
// `@adlc/ticket-sync` owns this format (`packages/ticket-sync/lib/block.mjs`)
// but is NOT a runtime dependency of the autopilot, so the grammar is restated
// here byte for byte: HTML-comment sentinels wrap a fenced JSON object —
//
//   <!-- adlc:begin v=1 key=<token> -->
//   ```json
//   { "scope": [...], "rails": [...], "edges": [...], "duration": 1, "category": "feature" }
//   ```
//   <!-- adlc:end -->
//
// Every ambiguity FAILS CLOSED (duplicate/unbalanced sentinels, garbled JSON,
// an unsupported version, an invalid field) with line-named errors and NO
// partial block — a CLARIFY at triage, never a degraded ticket.

import { active, registerSeams } from './mutations.mjs';

registerSeams(['block.lenientGrammar',
  'block.acceptOlderVersions',
]);

export const SUPPORTED_BLOCK_VERSION = 1;

/** The ticket-sync category set (packages/ticket-sync/lib/schema.mjs CATEGORIES). */
export const CATEGORIES = Object.freeze([
  'feature', 'bug', 'bugfix', 'refactor', 'docs', 'chore', 'test', 'spec', 'contract', 'architecture',
]);

const BEGIN_RE = /<!--\s*adlc:begin\b([^>]*?)-->/g;
const END_RE = /<!--\s*adlc:end\s*-->/g;
const FENCE_RE = /```(?:json|adlc)?[ \t]*\r?\n([\s\S]*?)\r?\n```/;

export const normalizeNewlines = (text) => String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function matchAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ index: m.index, end: m.index + m[0].length, groups: m });
  return out;
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** The BLOCK_DEF subset of the ticket-sync schema: scope, rails, edges, duration, category, budget, $schema. */
export function validateBlockFields(fields) {
  const errors = [];
  if ('$schema' in fields && typeof fields.$schema !== 'string') errors.push('$schema: expected string');
  for (const k of ['scope', 'rails']) if (k in fields && !isStringArray(fields[k])) errors.push(`${k}: expected array of strings`);
  if ('edges' in fields) {
    if (!Array.isArray(fields.edges)) errors.push('edges: expected array');
    else fields.edges.forEach((e, i) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) { errors.push(`edges[${i}]: expected object`); return; }
      if (typeof e.to !== 'string') errors.push(`edges[${i}].to: ${'to' in e ? 'expected string' : 'required'}`);
      if ('contract' in e && typeof e.contract !== 'string') errors.push(`edges[${i}].contract: expected string`);
      for (const k of Object.keys(e)) if (k !== 'to' && k !== 'contract') errors.push(`edges[${i}].${k}: unknown key`);
    });
  }
  for (const k of ['duration', 'budget']) {
    if (k in fields && !(typeof fields[k] === 'number' && Number.isFinite(fields[k]) && fields[k] > 0)) errors.push(`${k}: must be > 0`);
  }
  if ('category' in fields && !(typeof fields.category === 'string' && CATEGORIES.includes(fields.category))) {
    errors.push(`category: must be one of ${CATEGORIES.join(', ')}`);
  }
  return errors;
}

/**
 * Parse an issue body. `{ ok, block, fields, prefix, suffix, version, key, errors }`:
 * no sentinels → ok:true, block:null; exactly one well-formed pair → fields;
 * anything else → ok:false with line-named errors and block:null.
 */
export function parseBlock(rawBody) {
  const body = normalizeNewlines(rawBody);
  const begins = matchAll(BEGIN_RE, body);
  const ends = matchAll(END_RE, body);
  const none = { ok: true, block: null, fields: null, prefix: body, suffix: '', version: null, key: null, errors: [] };
  if (begins.length === 0 && ends.length === 0) return none;
  const errors = [];
  const fail = () => ({ ok: false, block: null, fields: null, prefix: body, suffix: '', version: null, key: null, errors });
  // Mutation seam `block.lenientGrammar`: the LAST begin/end pair is used and field errors are ignored.
  const lenient = active('block.lenientGrammar');
  if (!lenient && (begins.length !== 1 || ends.length !== 1)) {
    if (begins.length !== 1) errors.push(`expected exactly one 'adlc:begin' sentinel, found ${begins.length}${begins[1] ? ` (duplicate at line ${lineOf(body, begins[1].index)})` : ''}`);
    if (ends.length !== 1) errors.push(`expected exactly one 'adlc:end' sentinel, found ${ends.length}${ends[1] ? ` (duplicate at line ${lineOf(body, ends[1].index)})` : ''}`);
    return fail();
  }
  const begin = begins[lenient ? begins.length - 1 : 0];
  const end = ends[lenient ? ends.length - 1 : 0];
  if (!begin || !end) { errors.push('unbalanced adlc sentinels'); return fail(); }
  if (begin.index > end.index) { errors.push(`'adlc:end' (line ${lineOf(body, end.index)}) appears before 'adlc:begin' (line ${lineOf(body, begin.index)})`); return fail(); }
  const attrs = begin.groups[1] ?? '';
  const vMatch = attrs.match(/\bv=(\d+)\b/);
  const keyMatch = attrs.match(/\bkey=(\S+)/);
  if (!vMatch) { errors.push(`'adlc:begin' (line ${lineOf(body, begin.index)}) is missing the required v=<n> version`); return fail(); }
  const version = Number(vMatch[1]);
  // Only the supported version is trusted input: an older or unknown one is refused too (codex r8 A1).
  // Mutation seam `block.acceptOlderVersions`: any version up to the supported one is accepted.
  if (version < SUPPORTED_BLOCK_VERSION && !active('block.acceptOlderVersions')) { errors.push(`block version v=${version} (line ${lineOf(body, begin.index)}) is not supported (only v=${SUPPORTED_BLOCK_VERSION})`); return fail(); }
  if (version > SUPPORTED_BLOCK_VERSION) { errors.push(`block version v=${version} (line ${lineOf(body, begin.index)}) is newer than supported (max ${SUPPORTED_BLOCK_VERSION})`); return fail(); }
  const inner = body.slice(begin.end, end.index);
  const fenced = inner.match(FENCE_RE);
  const jsonText = (fenced ? fenced[1] : inner).trim();
  if (!jsonText) { errors.push(`no JSON found between the adlc sentinels (line ${lineOf(body, begin.end)})`); return fail(); }
  let fields;
  try { fields = JSON.parse(jsonText); } catch (e) { errors.push(`invalid JSON in the adlc block (line ${lineOf(body, begin.end)}): ${e.message}`); return fail(); }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) { errors.push(`the adlc block must be a JSON object (line ${lineOf(body, begin.end)})`); return fail(); }
  const fieldErrors = lenient ? [] : validateBlockFields(fields);
  if (fieldErrors.length) { errors.push(...fieldErrors.map((e) => `block field ${e}`)); return fail(); }
  return { ok: true, block: fields, fields, prefix: body.slice(0, begin.index), suffix: body.slice(end.end), version, key: keyMatch ? keyMatch[1] : null, errors: [] };
}

/** Rebuild a body from prose + fields; round-trips through parseBlock. */
export function serializeBlock(prose, fields, { version = SUPPORTED_BLOCK_VERSION, key = null } = {}) {
  const attrs = `v=${version}${key ? ` key=${key}` : ''}`;
  return `${prose?.prefix ?? ''}<!-- adlc:begin ${attrs} -->\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n<!-- adlc:end -->${prose?.suffix ?? ''}`;
}

/** The body with the block removed (prefix + suffix), for the ticket body of §5.1. */
export function stripBlock(parsed) {
  return `${parsed.prefix ?? ''}${parsed.suffix ?? ''}`.replace(/\n{3,}/g, '\n\n').trim();
}

/** The fix template appended to every CLARIFY comment (§5.4): the block skeleton. */
export function blockSkeleton() {
  return serializeBlock({ prefix: '', suffix: '' }, {
    scope: ['packages/<name>/**'], rails: [], edges: [], duration: 1, category: 'feature',
  });
}
