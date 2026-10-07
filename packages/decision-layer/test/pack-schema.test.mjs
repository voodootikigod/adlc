// The shipped DecisionPack.schema.json and lib/pack.mjs must accept and reject
// the same pack shapes, so the documented contract and the enforced one cannot
// drift. The schema walker below implements only the keywords the schema uses
// and throws on any other, so the schema cannot quietly rely on an unchecked
// rule. Cross-reference rules a schema cannot express (declared inputs, unique
// question IDs, conditions inside a question's domain) are covered in
// pack-validator.test.mjs, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNoNetwork } from './helpers/no-network.mjs';
import { validatePack } from '../lib/pack.mjs';

installNoNetwork();

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(readFileSync(join(PACKAGE_DIR, 'schemas', 'DecisionPack.schema.json'), 'utf8'));
const SHIPPED = JSON.parse(readFileSync(join(PACKAGE_DIR, 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs']);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** True when `value` satisfies `schema` (a subset of JSON Schema 2020-12). */
function conforms(schema, value, root = SCHEMA) {
  if (schema === true) return true;
  if (schema === false) return false;
  for (const [keyword, arg] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    const ok = {
      $ref: () => conforms(arg.split('/').slice(1).reduce((node, part) => node[part], root), value, root),
      type: () => typeOf(value) === arg || (arg === 'number' && typeOf(value) === 'integer'),
      const: () => value === arg,
      enum: () => arg.includes(value),
      pattern: () => typeof value !== 'string' || new RegExp(arg, 'u').test(value),
      minimum: () => typeof value !== 'number' || value >= arg,
      maximum: () => typeof value !== 'number' || value <= arg,
      minLength: () => typeof value !== 'string' || value.length >= arg,
      maxLength: () => typeof value !== 'string' || value.length <= arg,
      minItems: () => !Array.isArray(value) || value.length >= arg,
      maxItems: () => !Array.isArray(value) || value.length <= arg,
      uniqueItems: () => !Array.isArray(value) || !arg || new Set(value.map((item) => JSON.stringify(item))).size === value.length,
      minProperties: () => typeOf(value) !== 'object' || Object.keys(value).length >= arg,
      required: () => typeOf(value) !== 'object' || arg.every((key) => Object.hasOwn(value, key)),
      properties: () => typeOf(value) !== 'object' || Object.entries(arg).every(([key, sub]) => !Object.hasOwn(value, key) || conforms(sub, value[key], root)),
      additionalProperties: () => typeOf(value) !== 'object' || Object.keys(value)
        .filter((key) => !Object.hasOwn(schema.properties ?? {}, key))
        .every((key) => conforms(arg, value[key], root)),
      items: () => !Array.isArray(value) || value.every((item) => conforms(arg, item, root)),
      oneOf: () => arg.filter((sub) => conforms(sub, value, root)).length === 1,
      anyOf: () => arg.some((sub) => conforms(sub, value, root)),
      not: () => !conforms(arg, value, root),
      allOf: () => arg.every((sub) => conforms(sub, value, root)),
      if: () => !conforms(arg, value, root) || conforms(schema.then ?? true, value, root),
      then: () => true,
    }[keyword];
    if (!ok) throw new Error(`schema keyword "${keyword}" is not supported by this walker`);
    if (!ok()) return false;
  }
  return true;
}

const validatorAccepts = (pack) => {
  try {
    validatePack(pack);
    return true;
  } catch {
    return false;
  }
};

const variant = (mutate) => {
  const pack = structuredClone(SHIPPED);
  mutate(pack);
  return pack;
};

const CASES = [
  ['the shipped pack', SHIPPED, true],
  ['a single-character ID', variant((p) => { p.id = 'a'; }), true],
  ['lower limits', variant((p) => { p.limits = { fieldBytes: 512, totalBytes: 1024 }; }), true],
  ['a Score question', variant((p) => {
    p.questions[0] = { ...p.questions[0], kind: 'Score', domain: { min: 0, max: 1 } };
    p.aggregation = { escalateIf: [{ question: 'risk', atLeast: 0.8 }], allowIf: [] };
  }), true],
  ['no description', variant((p) => { delete p.description; }), true],
  ['a question without a prompt', variant((p) => { delete p.questions[0].prompt; }), true],
  ['an unknown top-level key', variant((p) => { p.extra = 1; }), false],
  ['an unknown limits key', variant((p) => { p.limits.perQuestionBytes = 10; }), false],
  ['an unknown input key', variant((p) => { p.inputs.linesAdded.note = 'x'; }), false],
  ['an unknown question key', variant((p) => { p.questions[0].weight = 2; }), false],
  ['an unknown aggregation key', variant((p) => { p.aggregation.haltIf = []; }), false],
  ['an unknown condition key', variant((p) => { p.aggregation.escalateIf[0].weight = 2; }), false],
  ['a Choice with an object domain', variant((p) => { p.questions[0].domain = { min: 0, max: 1 }; }), false],
  ['a Score with an array domain', variant((p) => {
    p.questions[0].kind = 'Score';
    p.aggregation = { escalateIf: [], allowIf: [] };
  }), false],
  ['a Score domain with an unknown key', variant((p) => {
    p.questions[0] = { ...p.questions[0], kind: 'Score', domain: { min: 0, max: 1, step: 0.1 } };
    p.aggregation = { escalateIf: [], allowIf: [] };
  }), false],
  ['a Noul domain other than yes/no', variant((p) => { p.questions[1].domain = ['yes', 'maybe']; }), false],
  ['a Noul domain with three values', variant((p) => { p.questions[1].domain = ['yes', 'no', 'maybe']; }), false],
  ['an empty Choice domain', variant((p) => { p.questions[0].domain = []; }), false],
  ['a repeated Choice value', variant((p) => { p.questions[0].domain = ['low', 'low']; }), false],
  ['an unknown kind', variant((p) => { p.questions[0].kind = 'Boolean'; }), false],
  ['mode live', variant((p) => { p.mode = 'live'; }), false],
  ['schemaVersion 2', variant((p) => { p.schemaVersion = 2; }), false],
  ['an uppercase ID', variant((p) => { p.id = 'Risk'; }), false],
  ['fieldBytes above 4096', variant((p) => { p.limits.fieldBytes = 4097; }), false],
  ['totalBytes above 32768', variant((p) => { p.limits.totalBytes = 32769; }), false],
  ['a missing limit', variant((p) => { delete p.limits.totalBytes; }), false],
  ['maxBytes 0', variant((p) => { p.inputs.linesAdded.maxBytes = 0; }), false],
  ['a non-metadata classification', variant((p) => { p.inputs.linesAdded.classification = 'source-text'; }), false],
  ['an unknown source', variant((p) => { p.inputs.linesAdded.source = 'issue-body'; }), false],
  ['no inputs', variant((p) => { p.inputs = {}; }), false],
  ['phase P5', variant((p) => { p.questions[0].phases = ['P5']; }), false],
  ['no questions', variant((p) => { p.questions = []; }), false],
  ['minProbability above 1', variant((p) => { p.aggregation.allowIf[0].minProbability = 1.5; }), false],
  ['a missing allowIf', variant((p) => { delete p.aggregation.allowIf; }), false],
  ['a numeric description', variant((p) => { p.description = 7; }), false],
  ['an extra question with a 64-character id', variant((p) => { p.questions.push({ ...structuredClone(p.questions[0]), id: `q${'x'.repeat(63)}` }); }), true],
  ['an extra question with a 65-character id', variant((p) => { p.questions.push({ ...structuredClone(p.questions[0]), id: `q${'x'.repeat(64)}` }); }), false],
  ['an extra question with an underscore id', variant((p) => { p.questions.push({ ...structuredClone(p.questions[0]), id: 'q_1' }); }), false],
  ['an extra question with a capitalised id', variant((p) => { p.questions.push({ ...structuredClone(p.questions[0]), id: 'Q1' }); }), false],
  ['a 64-character pack id', variant((p) => { p.id = `p${'x'.repeat(63)}`; }), true],
  ['a 65-character pack id', variant((p) => { p.id = `p${'x'.repeat(64)}`; }), false],
  ['a description of 1024 characters', variant((p) => { p.description = 'd'.repeat(1024); }), true],
  ['a description over 1024 characters', variant((p) => { p.description = 'd'.repeat(1025); }), false],
  ['a numeric prompt', variant((p) => { p.questions[0].prompt = 7; }), false],
  ['a prompt of 512 characters', variant((p) => { p.questions[0].prompt = 'x'.repeat(512); }), true],
  ['a prompt over 512 characters', variant((p) => { p.questions[0].prompt = 'x'.repeat(513); }), false],
  ['an input that is not a collectable field', variant((p) => {
    p.inputs.diffHunks = { source: 'git-diff', type: 'string', classification: 'metadata', maxBytes: 64 };
  }), false],
  ['an input with the wrong type', variant((p) => { p.inputs.linesAdded.type = 'string'; }), false],
  ['an input with the wrong source', variant((p) => { p.inputs.ticketCategory.source = 'git-diff'; }), false],
  ['a subset of the inputs', variant((p) => {
    p.inputs = { linesAdded: p.inputs.linesAdded };
    for (const question of p.questions) question.inputs = ['linesAdded'];
  }), true],
  ['a condition with both equals and a bound', variant((p) => { p.aggregation.escalateIf[0].atLeast = 1; }), false],
  ['a condition with neither equals nor a bound', variant((p) => { delete p.aggregation.escalateIf[0].equals; }), false],
];

for (const [name, pack, expected] of CASES) {
  test(`schema and validator agree: ${name}`, () => {
    assert.equal(validatorAccepts(pack), expected, `validator on ${name}`);
    assert.equal(conforms(SCHEMA, pack), expected, `schema on ${name}`);
  });
}

test('Score min < max is a validator-only rule, and the schema says so', () => {
  assert.match(SCHEMA.description, /Score domain min < max/);
  for (const domain of [{ min: 1, max: 1 }, { min: 2, max: 1 }]) {
    const pack = variant((p) => {
      p.questions[0] = { ...p.questions[0], kind: 'Score', domain };
      p.aggregation = { escalateIf: [], allowIf: [] };
    });
    assert.equal(validatorAccepts(pack), false, JSON.stringify(domain));
    assert.equal(conforms(SCHEMA, pack), true, `the schema cannot express min < max: ${JSON.stringify(domain)}`);
  }
});

test('the walker refuses schema keywords it does not implement', () => {
  assert.throws(() => conforms({ format: 'email' }, 'x'), /not supported/);
});
