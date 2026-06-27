// block.mjs — the fenced ```adlc block codec (zero-dep). This is the ONLY code
// that knows the issue-body block format.
//
// Format: HTML-comment sentinels wrap a fenced JSON block in the issue body:
//
//   <prefix prose>
//   <!-- adlc:begin v=1 key=<uuid> -->
//   ```json
//   { ...execution fields... }
//   ```
//   <!-- adlc:end -->
//   <suffix prose>
//
// parseBlock splits the body into {prefix, block, suffix} and returns the parsed
// fields; serializeBlock rebuilds the body, preserving both prose segments. Field
// semantics are delegated to T1's validateBlock — there is no second schema. Every
// ambiguity FAILS CLOSED with an error that names the offending line (the Validity
// Gate / callers turn a non-empty `errors` into a deny).

import { validateBlock } from './validate.mjs';
import { canonicalEqual, normalizeNewlines } from './canonical.mjs';

export const SUPPORTED_BLOCK_VERSION = 1;

const BEGIN_RE = /<!--\s*adlc:begin\b([^>]*?)-->/g;
const END_RE = /<!--\s*adlc:end\s*-->/g;
const FENCE_RE = /```(?:json|adlc)?[ \t]*\r?\n([\s\S]*?)\r?\n```/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function matchAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ index: m.index, end: m.index + m[0].length, groups: m });
  return out;
}

/**
 * Parse an issue body. Returns:
 *   { ok, block, fields, prefix, suffix, version, key, errors }
 * - No sentinels at all → ok:true, block:null (caller imports title/body only).
 * - Exactly one well-formed pair → fields parsed + field-validated.
 * - Anything else (missing/duplicate/unbalanced sentinel, garbled JSON,
 *   unsupported version, invalid fields) → ok:false with line-named errors and
 *   block:null (NEVER a partial/degraded block).
 */
export function parseBlock(rawBody) {
  const body = normalizeNewlines(rawBody ?? '');
  const begins = matchAll(BEGIN_RE, body);
  const ends = matchAll(END_RE, body);

  if (begins.length === 0 && ends.length === 0) {
    return { ok: true, block: null, fields: null, prefix: body, suffix: '', version: null, key: null, errors: [] };
  }

  const errors = [];
  const fail = () => ({ ok: false, block: null, fields: null, prefix: body, suffix: '', version: null, key: null, errors });

  if (begins.length !== 1 || ends.length !== 1) {
    if (begins.length !== 1) {
      errors.push(`expected exactly one 'adlc:begin' sentinel, found ${begins.length}` +
        (begins[1] ? ` (duplicate at line ${lineOf(body, begins[1].index)})` : ''));
    }
    if (ends.length !== 1) {
      errors.push(`expected exactly one 'adlc:end' sentinel, found ${ends.length}` +
        (ends[1] ? ` (duplicate at line ${lineOf(body, ends[1].index)})` : ''));
    }
    return fail();
  }

  const begin = begins[0];
  const end = ends[0];
  if (begin.index > end.index) {
    errors.push(`'adlc:end' (line ${lineOf(body, end.index)}) appears before 'adlc:begin' (line ${lineOf(body, begin.index)})`);
    return fail();
  }

  const prefix = body.slice(0, begin.index);
  const suffix = body.slice(end.end);

  // Sentinel attributes: v=<n> (required), key=<token> (optional).
  const attrs = begin.groups[1] ?? '';
  const vMatch = attrs.match(/\bv=(\d+)\b/);
  const keyMatch = attrs.match(/\bkey=(\S+)/);
  if (!vMatch) {
    errors.push(`'adlc:begin' (line ${lineOf(body, begin.index)}) is missing the required v=<n> version`);
    return fail();
  }
  const version = Number(vMatch[1]);
  const key = keyMatch ? keyMatch[1] : null;
  if (version > SUPPORTED_BLOCK_VERSION) {
    errors.push(`block version v=${version} (line ${lineOf(body, begin.index)}) is newer than supported (max ${SUPPORTED_BLOCK_VERSION}) — upgrade @adlc/ticket-sync`);
    return fail();
  }

  const inner = body.slice(begin.end, end.index);
  const fenced = inner.match(FENCE_RE);
  const jsonText = (fenced ? fenced[1] : inner).trim();
  if (!jsonText) {
    errors.push(`no JSON found between the adlc sentinels (line ${lineOf(body, begin.end)})`);
    return fail();
  }

  let fields;
  try {
    fields = JSON.parse(jsonText);
  } catch (e) {
    errors.push(`invalid JSON in the adlc block (line ${lineOf(body, begin.end)}): ${e.message}`);
    return fail();
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push(`the adlc block must be a JSON object (line ${lineOf(body, begin.end)})`);
    return fail();
  }

  const fieldErrors = validateBlock(fields);
  if (fieldErrors.length) {
    errors.push(...fieldErrors.map((e) => `block field ${e}`));
    return fail();
  }

  return { ok: true, block: fields, fields, prefix, suffix, version, key, errors: [] };
}

/**
 * Rebuild an issue body from prose + fields. `prose` is {prefix, suffix} (both
 * preserved verbatim). The result round-trips through parseBlock.
 */
export function serializeBlock(prose, fields, { version = SUPPORTED_BLOCK_VERSION, key = null } = {}) {
  const prefix = prose?.prefix ?? '';
  const suffix = prose?.suffix ?? '';
  const attrs = `v=${version}${key ? ` key=${key}` : ''}`;
  const json = JSON.stringify(fields, null, 2);
  const blockText =
    `<!-- adlc:begin ${attrs} -->\n` +
    '```json\n' +
    `${json}\n` +
    '```\n' +
    '<!-- adlc:end -->';
  return `${prefix}${blockText}${suffix}`;
}

/** Two blocks are equal ignoring the editor-only `$schema` hint. */
export function blocksEqual(a, b) {
  return canonicalEqual(a, b, { omit: ['$schema'] });
}
