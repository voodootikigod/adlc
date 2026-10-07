// Pack validation (AC6): every rule under the spec's "Question packs" section,
// plus the shipped change-risk-v1 pack matching the spec's table exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { installNoNetwork } from './helpers/no-network.mjs';
import { PackError, loadPack, packHash, validatePack, SHIPPED_PACKS_DIR } from '../lib/pack.mjs';

installNoNetwork();

const SHIPPED = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'change-risk-v1', 'pack.json'), 'utf8'));
const clone = () => structuredClone(SHIPPED);
const rejects = (pack, pattern) => assert.throws(() => validatePack(pack), (error) => error instanceof PackError && pattern.test(error.message));

// Each case trips exactly one condition of a guard, and asserts that guard's
// own message, so a later check rejecting the same pack cannot stand in for it.
const ISOLATED = [
  ['a numeric pack id', (p) => { p.id = 7; }, /^pack id 7 must match/],
  ['fieldBytes 0', (p) => { p.limits.fieldBytes = 0; }, /^limits\.fieldBytes must be an integer from 1/],
  ['a numeric description', (p) => { p.description = 7; }, /^the pack description must be a string of at most 1024 characters$/],
  ['an overlong description', (p) => { p.description = 'd'.repeat(1025); }, /^the pack description must be a string of at most 1024 characters$/],
  ['a numeric prompt', (p) => { p.questions[0].prompt = 7; }, /^question "risk" prompt must be a string of at most 512 characters$/],
  ['an overlong prompt', (p) => { p.questions[0].prompt = 'x'.repeat(513); }, /^question "risk" prompt must be a string of at most 512 characters$/],
  ['inputs given as a list', (p) => { p.inputs = ['linesAdded']; }, /^a pack must declare its inputs$/],
  ['no inputs', (p) => { p.inputs = {}; }, /^a pack must declare its inputs$/],
  ['a Noul domain that is not a list', (p) => { p.questions[1].domain = { length: 2 }; }, /a Noul domain is exactly/],
  ['a Noul domain with yes twice', (p) => { p.questions[1].domain = ['yes', 'yes']; }, /a Noul domain is exactly/],
  ['a Choice domain that is a string', (p) => { p.questions[0].domain = 'low'; }, /a Choice domain is a list/],
  ['an empty Choice domain', (p) => { p.questions[0].domain = []; }, /a Choice domain is a list/],
  ['a numeric Choice value', (p) => { p.questions[0].domain = [3]; }, /a Choice domain is a list/],
  ['a Choice value that is an object with a length', (p) => { p.questions[0].domain = [{ length: 1 }]; }, /a Choice domain is a list/],
  ['an empty Choice value', (p) => { p.questions[0].domain = ['']; }, /a Choice domain is a list/],
  ['a repeated Choice value', (p) => { p.questions[0].domain = ['low', 'low']; }, /a Choice domain is a list/],
  ['a null Score domain', (p) => { p.questions[0] = { ...p.questions[0], kind: 'Score', domain: null }; }, /a Score domain is \{ min, max \}/],
  ['a Score min that is not a number', (p) => { p.questions[0] = { ...p.questions[0], kind: 'Score', domain: { min: '0', max: 1 } }; }, /a Score domain is/],
  ['a Score max that is not a number', (p) => { p.questions[0] = { ...p.questions[0], kind: 'Score', domain: { min: 0, max: '1' } }; }, /a Score domain is/],
  ['a Score domain with min equal to max', (p) => { p.questions[0] = { ...p.questions[0], kind: 'Score', domain: { min: 1, max: 1 } }; }, /a Score domain is/],
  ['questions given as an object', (p) => { p.questions = {}; }, /^a pack must declare at least one question$/],
  ['no questions', (p) => { p.questions = []; }, /^a pack must declare at least one question$/],
  ['a question that is not an object', (p) => { p.questions[0] = 'risk'; }, /^every question needs a string id$/],
  ['a null question', (p) => { p.questions[0] = null; }, /^every question needs a string id$/],
  ['a question id with an underscore', (p) => { p.questions[0].id = 'risk_1'; }, /^question id "risk_1" must match/],
  ['a question id with capitals', (p) => { p.questions[0].id = 'Risk'; }, /^question id "Risk" must match/],
  ['a question id of 65 characters', (p) => { p.questions[0].id = `r${'x'.repeat(64)}`; }, /^question id "r(x){64}" must match/],
  ['a pack id of 65 characters', (p) => { p.id = `p${'x'.repeat(64)}`; }, /^pack id "p(x){64}" must match/],
  ['a numeric question id', (p) => { p.questions[0].id = 5; }, /^every question needs a string id$/],
  ['an empty question id', (p) => { p.questions[0].id = ''; }, /^every question needs a string id$/],
  ['question inputs given as a string', (p) => { p.questions[0].inputs = 'linesAdded'; }, /must list the inputs it may see/],
  ['no question inputs', (p) => { p.questions[0].inputs = []; }, /must list the inputs it may see/],
  ['question phases given as a string', (p) => { p.questions[0].phases = 'P0'; }, /must name the phases it describes/],
  ['no question phases', (p) => { p.questions[0].phases = []; }, /must name the phases it describes/],
  ['a minProbability given as a string', (p) => { p.aggregation.allowIf[0].minProbability = '0.5'; }, /minProbability for "risk" must be between 0 and 1/],
];

for (const [name, mutate, message] of ISOLATED) {
  test(`rejected by its own guard: ${name}`, () => {
    const pack = clone();
    mutate(pack);
    assert.throws(() => validatePack(pack), (error) => error instanceof PackError && message.test(error.message), name);
  });
}

test('a Score bound that is not a number, or below the domain, is rejected by the bound check', () => {
  for (const atLeast of ['0.5', -1]) {
    const pack = clone();
    pack.questions[0] = { ...pack.questions[0], kind: 'Score', domain: { min: 0, max: 1 } };
    pack.aggregation = { escalateIf: [{ question: 'risk', atLeast }], allowIf: [] };
    assert.throws(() => validatePack(pack), (error) => error instanceof PackError && /atLeast for "risk" is outside its domain/.test(error.message), String(atLeast));
  }
});

test('loadPack checks the requested id itself', (t) => {
  const root = tmp(t, 'decision-packs-');
  for (const id of [7, 'Bad_Id']) {
    assert.throws(() => loadPack(id, { projectRoot: root }), (error) => error instanceof PackError && /^pack id .* must match/.test(error.message), String(id));
  }
});

test('the shipped change-risk-v1 pack is valid', () => {
  assert.doesNotThrow(() => validatePack(SHIPPED));
});

test('change-risk-v1 matches the spec: two questions, domains, inputs and aggregation', () => {
  assert.deepEqual(SHIPPED.questions.map((q) => [q.id, q.kind, q.domain]), [
    ['risk', 'Choice', ['low', 'medium', 'high']],
    ['needs-deeper-interrogation', 'Noul', ['yes', 'no']],
  ]);
  const fields = ['extensionCounts', 'linesAdded', 'linesDeleted', 'filesChanged', 'ticketCategory', 'declaredRailCount'];
  assert.deepEqual(Object.keys(SHIPPED.inputs).sort(), [...fields].sort());
  for (const question of SHIPPED.questions) assert.deepEqual([...question.inputs].sort(), [...fields].sort());
  assert.deepEqual(SHIPPED.aggregation, {
    escalateIf: [
      { question: 'risk', equals: 'high' },
      { question: 'needs-deeper-interrogation', equals: 'yes' },
    ],
    allowIf: [
      { question: 'risk', equals: 'low', minProbability: 0.7 },
      { question: 'needs-deeper-interrogation', equals: 'no', minProbability: 0.7 },
    ],
  });
});

test('pack IDs must match [a-z0-9][a-z0-9-]*', () => {
  for (const id of ['Change-risk', '-risk', 'risk_v1', '', 'a/b', '../x']) {
    rejects({ ...clone(), id }, /pack id/);
  }
});

test('single-character pack IDs are valid', () => {
  assert.doesNotThrow(() => validatePack({ ...clone(), id: 'a' }));
  assert.doesNotThrow(() => validatePack({ ...clone(), id: '7' }));
});

test('an unknown schema version is rejected', () => {
  rejects({ ...clone(), schemaVersion: 2 }, /schemaVersion/);
});

test('any mode other than shadow is rejected', () => {
  for (const mode of ['off', 'live', undefined]) rejects({ ...clone(), mode }, /mode/);
});

test('duplicate question IDs are rejected', () => {
  const pack = clone();
  pack.questions[1].id = 'risk';
  rejects(pack, /duplicate question id "risk"/);
});

test('a question may only see declared inputs', () => {
  const pack = clone();
  pack.questions[0].inputs = [...pack.questions[0].inputs, 'diffHunks'];
  rejects(pack, /undeclared input "diffHunks"/);
});

test('an input outside the input table is rejected', () => {
  const pack = clone();
  pack.inputs.diffHunks = { source: 'git-diff', type: 'string', classification: 'metadata', maxBytes: 64 };
  rejects(pack, /input "diffHunks" is not a collectable field/);
});

test('an input must declare the real type and source of its field', () => {
  for (const [field, key, value] of [['linesAdded', 'type', 'string'], ['ticketCategory', 'type', 'integer'], ['extensionCounts', 'source', 'ticket-store']]) {
    const pack = clone();
    pack.inputs[field] = { ...pack.inputs[field], [key]: value };
    rejects(pack, new RegExp(`input "${field}" .*${key}`));
  }
});

test('a pack may declare a subset of the collectable fields', () => {
  const pack = clone();
  pack.inputs = { linesAdded: pack.inputs.linesAdded, filesChanged: pack.inputs.filesChanged };
  for (const question of pack.questions) question.inputs = ['linesAdded', 'filesChanged'];
  assert.doesNotThrow(() => validatePack(pack));
});

test('a Score condition may not use equals, and needs a bound', () => {
  const score = clone();
  score.questions[0] = { ...score.questions[0], kind: 'Score', domain: { min: 0, max: 1 } };
  score.aggregation = { escalateIf: [{ question: 'risk', equals: 'high' }], allowIf: [] };
  rejects(score, /Score condition .*equals/);
  score.aggregation = { escalateIf: [{ question: 'risk', minProbability: 0.5 }], allowIf: [] };
  rejects(score, /atLeast or atMost/);
});

test('a Choice or Noul condition needs equals and may not use bounds', () => {
  for (const [index, extra] of [[0, { atLeast: 1 }], [1, { atMost: 0 }]]) {
    const pack = clone();
    pack.aggregation = { escalateIf: [{ ...pack.aggregation.escalateIf[index], ...extra }], allowIf: [] };
    rejects(pack, /atLeast\/atMost/);
  }
  const missing = clone();
  missing.aggregation = { escalateIf: [{ question: 'risk' }], allowIf: [] };
  rejects(missing, /needs equals/);
});

test('unknown question kinds are rejected', () => {
  const pack = clone();
  pack.questions[0].kind = 'Boolean';
  rejects(pack, /kind/);
});

test('a Noul question must answer yes or no', () => {
  const pack = clone();
  pack.questions[1].domain = ['yes', 'no', 'maybe'];
  rejects(pack, /Noul/);
});

test('a Choice domain must be distinct non-empty strings', () => {
  for (const domain of [[], ['low', 'low'], ['low', 3]]) {
    const pack = clone();
    pack.questions[0].domain = domain;
    rejects(pack, /domain/);
  }
});

test('a Score question needs a numeric range', () => {
  const pack = clone();
  pack.questions[0] = { ...pack.questions[0], kind: 'Score', domain: { min: 0, max: 1 } };
  pack.aggregation = { escalateIf: [{ question: 'risk', atLeast: 0.8 }], allowIf: [{ question: 'risk', atMost: 0.2, minProbability: 0.7 }] };
  assert.doesNotThrow(() => validatePack(pack));
  pack.questions[0].domain = { min: 1, max: 0 };
  rejects(pack, /domain/);
});

test('thresholds outside their domain are rejected', () => {
  const bad = [
    { escalateIf: [{ question: 'risk', equals: 'extreme' }], allowIf: [] },
    { escalateIf: [], allowIf: [{ question: 'risk', equals: 'low', minProbability: 1.5 }] },
    { escalateIf: [], allowIf: [{ question: 'risk', equals: 'low', minProbability: -0.1 }] },
    { escalateIf: [{ question: 'nope', equals: 'high' }], allowIf: [] },
  ];
  for (const aggregation of bad) rejects({ ...clone(), aggregation }, /aggregation/);
});

test('a Score threshold outside the range is rejected', () => {
  const pack = clone();
  pack.questions[0] = { ...pack.questions[0], kind: 'Score', domain: { min: 0, max: 1 } };
  pack.aggregation = { escalateIf: [{ question: 'risk', atLeast: 2 }], allowIf: [] };
  rejects(pack, /aggregation/);
});

test('unbounded or over-limit input fields are rejected', () => {
  for (const maxBytes of [undefined, 0, -1, 1.5, 4097]) {
    const pack = clone();
    pack.inputs.linesAdded = { ...pack.inputs.linesAdded, maxBytes };
    rejects(pack, /maxBytes/);
  }
});

test('a pack may lower the size limits but never raise them', () => {
  assert.doesNotThrow(() => validatePack({ ...clone(), limits: { fieldBytes: 1024, totalBytes: 4096 } }));
  rejects({ ...clone(), limits: { fieldBytes: 4097, totalBytes: 32768 } }, /fieldBytes/);
  rejects({ ...clone(), limits: { fieldBytes: 4096, totalBytes: 32769 } }, /totalBytes/);
});

test('inputs must be metadata from a known source and type', () => {
  for (const [key, value] of [['classification', 'source-text'], ['source', 'issue-body'], ['type', 'blob']]) {
    const pack = clone();
    pack.inputs.linesAdded = { ...pack.inputs.linesAdded, [key]: value };
    rejects(pack, new RegExp(key));
  }
});

test('a question naming a phase other than P0 or D1 is rejected', () => {
  const pack = clone();
  pack.questions[0].phases = ['P0', 'P5'];
  rejects(pack, /phase "P5"/);
});

test('packHash is a sha256 of the canonical pack, independent of key order', () => {
  const reordered = Object.fromEntries(Object.entries(SHIPPED).reverse());
  assert.match(packHash(SHIPPED), /^[0-9a-f]{64}$/);
  assert.equal(packHash(reordered), packHash(SHIPPED));
  assert.notEqual(packHash({ ...clone(), description: 'changed' }), packHash(SHIPPED));
});

test('loadPack finds a shipped pack and a project pack, and validates what it loads', (t) => {
  const root = tmp(t, 'decision-packs-');
  assert.equal(loadPack('change-risk-v1', { projectRoot: root }).id, 'change-risk-v1');
  const own = { ...clone(), id: 'own-pack' };
  mkdirSync(join(root, '.adlc', 'decision-packs', 'own-pack'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'own-pack', 'pack.json'), JSON.stringify(own));
  assert.equal(loadPack('own-pack', { projectRoot: root }).id, 'own-pack');
  writeFileSync(join(root, '.adlc', 'decision-packs', 'own-pack', 'pack.json'), JSON.stringify({ ...own, mode: 'live' }));
  assert.throws(() => loadPack('own-pack', { projectRoot: root }), PackError);
});

test('a pack file over 64 KiB is refused before it is read or parsed', (t) => {
  const root = tmp(t, 'decision-packs-');
  mkdirSync(join(root, '.adlc', 'decision-packs', 'huge-pack'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'huge-pack', 'pack.json'), `{ not json ${' '.repeat(70_000)}`);
  assert.throws(() => loadPack('huge-pack', { projectRoot: root }), (error) => error instanceof PackError && /is 70011 bytes; a pack file may be at most 65536/.test(error.message));
});

test('a pack file of exactly 64 KiB is read', (t) => {
  const root = tmp(t, 'decision-packs-');
  mkdirSync(join(root, '.adlc', 'decision-packs', 'big-pack'), { recursive: true });
  const text = JSON.stringify({ ...clone(), id: 'big-pack' });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'big-pack', 'pack.json'), text.padEnd(65_536, ' '));
  assert.equal(loadPack('big-pack', { projectRoot: root }).id, 'big-pack');
});

test('a pack file whose id differs from its directory is rejected', (t) => {
  const root = tmp(t, 'decision-packs-');
  mkdirSync(join(root, '.adlc', 'decision-packs', 'alias'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'alias', 'pack.json'), JSON.stringify({ ...clone(), id: 'other' }));
  assert.throws(() => loadPack('alias', { projectRoot: root }), /does not match/);
});

test('an unknown pack, or one that is not JSON, is a pack error', (t) => {
  const root = tmp(t, 'decision-packs-');
  assert.throws(() => loadPack('missing-pack', { projectRoot: root }), /no pack "missing-pack"/);
  mkdirSync(join(root, '.adlc', 'decision-packs', 'broken'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'broken', 'pack.json'), '{not json');
  assert.throws(() => loadPack('broken', { projectRoot: root }), PackError);
});

test('a project pack with a shipped ID is refused, even when another pack is requested', (t) => {
  const root = tmp(t, 'decision-packs-');
  mkdirSync(join(root, '.adlc', 'decision-packs', 'change-risk-v1'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'change-risk-v1', 'pack.json'), JSON.stringify(SHIPPED));
  mkdirSync(join(root, '.adlc', 'decision-packs', 'own-pack'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'decision-packs', 'own-pack', 'pack.json'), JSON.stringify({ ...clone(), id: 'own-pack' }));
  for (const id of ['change-risk-v1', 'own-pack']) {
    assert.throws(() => loadPack(id, { projectRoot: root }), /shadows the shipped pack "change-risk-v1"/);
  }
});

test('SHIPPED_PACKS_DIR is the package packs directory', () => {
  assert.equal(SHIPPED_PACKS_DIR, join(dirname(fileURLToPath(import.meta.url)), '..', 'packs'));
});
