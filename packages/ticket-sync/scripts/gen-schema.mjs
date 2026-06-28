#!/usr/bin/env node
// gen-schema.mjs — emit JSON Schema (draft 2020-12) files from the lib/schema.mjs
// definitions. Run on any change to the definition; the committed schemas/*.json
// are drift-gated against this generator in test/schema.test.mjs.
//
//   node scripts/gen-schema.mjs        # write schemas/*.json
//
// Importable: generateAll() returns {filename: jsonString} without writing, so the
// drift test compares in-memory output to the committed files.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFS } from '../lib/schema.mjs';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const ID_BASE = 'https://adlc.dev/schema/v1/';

function fieldToJsonSchema(spec) {
  if (spec.type === 'string') {
    const s = { type: 'string' };
    if (spec.enum) s.enum = spec.enum;
    if (spec.minLength) s.minLength = spec.minLength;
    if (spec.description) s.description = spec.description;
    return s;
  }
  if (spec.type === 'number') {
    const s = { type: 'number' };
    if (spec.exclusiveMinimum !== undefined) s.exclusiveMinimum = spec.exclusiveMinimum;
    if (spec.description) s.description = spec.description;
    return s;
  }
  if (spec.type === 'array') {
    const s = { type: 'array', items: fieldToJsonSchema(spec.items) };
    if (spec.description) s.description = spec.description;
    return s;
  }
  // object
  return objectToJsonSchema(spec);
}

function objectToJsonSchema(def) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(def.fields ?? {})) {
    properties[name] = fieldToJsonSchema(spec);
    if (spec.required) required.push(name);
  }
  const s = { type: 'object', properties };
  if (required.length) s.required = required;
  s.additionalProperties = def.additionalProperties !== undefined ? def.additionalProperties : true;
  if (def.description && !def.id) s.description = def.description; // nested object description
  return s;
}

/** Generate the full JSON Schema string for one top-level definition. */
export function generate(def) {
  const body = objectToJsonSchema(def);
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${ID_BASE}${def.id}.schema.json`,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    ...body,
  };
  return JSON.stringify(schema, null, 2) + '\n';
}

/** All artifacts as {filename: jsonString} — used by the drift test (no writes). */
export function generateAll() {
  const out = {};
  for (const def of Object.values(DEFS)) out[`${def.id}.schema.json`] = generate(def);
  return out;
}

function main() {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const all = generateAll();
  for (const [file, content] of Object.entries(all)) writeFileSync(join(SCHEMA_DIR, file), content);
  console.log(`wrote ${Object.keys(all).length} schema(s) to ${SCHEMA_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
