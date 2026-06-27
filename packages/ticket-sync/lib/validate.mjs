// validate.mjs — the definition-driven validator (zero-dep).
//
// Walks a schema.mjs definition and returns a flat list of `"<field path>: <msg>"`
// errors. This is the rich/external validator; it deliberately lives here and NOT
// in @adlc/core (CONVENTIONS rule 2 — core is frozen). It is a SUPERSET of core's
// validateTicket on the fields they share (see CORE_SHARED_FIELDS), so any ticket
// core accepts, this accepts on those fields too — enforced by the agreement test.

import { TICKET_DEF, BLOCK_DEF, CONFIG_DEF, SYNC_STATE_DEF } from './schema.mjs';

function typeName(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function validateField(value, spec, path) {
  const errors = [];
  const t = typeName(value);
  if (spec.type === 'string') {
    if (t !== 'string') return [`${path}: expected string`];
    if (spec.minLength && value.length < spec.minLength) errors.push(`${path}: must be non-empty`);
    if (spec.enum && !spec.enum.includes(value)) errors.push(`${path}: must be one of ${spec.enum.join(', ')}`);
  } else if (spec.type === 'number') {
    if (t !== 'number' || Number.isNaN(value)) return [`${path}: expected number`];
    if (spec.exclusiveMinimum !== undefined && !(value > spec.exclusiveMinimum)) {
      errors.push(`${path}: must be > ${spec.exclusiveMinimum}`);
    }
  } else if (spec.type === 'array') {
    if (t !== 'array') return [`${path}: expected array`];
    value.forEach((item, i) => errors.push(...validateField(item, spec.items, `${path}[${i}]`)));
  } else if (spec.type === 'object') {
    if (spec.fields) errors.push(...validateObject(value, spec.fields, path));
    else if (t !== 'object') errors.push(`${path}: expected object`);
  }
  return errors;
}

function validateObject(obj, fields, path) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return [`${path || 'value'}: expected object`];
  }
  const errors = [];
  for (const [name, spec] of Object.entries(fields)) {
    const present = Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== undefined;
    const p = path ? `${path}.${name}` : name;
    if (!present) {
      if (spec.required) errors.push(`${p}: required`);
      continue;
    }
    errors.push(...validateField(obj[name], spec, p));
  }
  // Unknown keys are tolerated (forward-compat); they are surfaced/handled by the
  // block codec, not rejected here.
  return errors;
}

/** Validate a value against a top-level definition. Returns string[] (empty = valid). */
export function validate(value, def) {
  return validateObject(value, def.fields, '');
}

export const validateTicket = (t) => validate(t, TICKET_DEF);
export const validateBlock = (b) => validate(b, BLOCK_DEF);
export const validateConfig = (c) => validate(c, CONFIG_DEF);
export const validateSyncState = (s) => validate(s, SYNC_STATE_DEF);

// Fields @adlc/core's validateTicket also checks. The cross-validator agreement
// test asserts: for any core-accepted ticket, this validator reports no errors on
// these fields (it may still flag non-shared fields like `category`/`budget`).
export const CORE_SHARED_FIELDS = ['id', 'title', 'scope', 'rails', 'edges', 'duration'];

/** The leading field name of an error string (e.g. "edges[0].to: ..." -> "edges"). */
export function errorField(error) {
  const m = error.match(/^(\$?[a-zA-Z]+)/);
  return m ? m[1] : '';
}
