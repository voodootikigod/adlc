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
