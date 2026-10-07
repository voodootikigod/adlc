// Question packs: loading and offline validation.
//
// Shipped packs live in this package's packs/<id>/pack.json. A project may add
// its own under .adlc/decision-packs/<id>/pack.json, but never one that shares
// a shipped ID. DecisionPack.schema.json documents the same shape this module
// checks; the validator is hand-written so the package has no dependencies.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from '@adlc/core';
import { canonicalHash } from './canonical.mjs';

export const SHIPPED_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
/** Pack and question IDs reach the provider verbatim, so they are plain identifiers, never free text. */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const QUESTION_ID_PATTERN = PACK_ID_PATTERN;
export const PACK_SCHEMA_VERSION = 1;
export const MAX_FIELD_BYTES = 4096;
export const MAX_TOTAL_BYTES = 32768;
export const MAX_PROMPT_LENGTH = 512;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_PACK_FILE_BYTES = 65536;

const KINDS = new Set(['Choice', 'Score', 'Noul']);
const PHASES = new Set(['P0', 'D1']);
/** Every field a v1 run collects, with its real source and type. A pack declares a subset. */
export const COLLECTABLE_FIELDS = Object.freeze({
  extensionCounts: Object.freeze({ source: 'git-diff', type: 'count-map' }),
  linesAdded: Object.freeze({ source: 'git-diff', type: 'integer' }),
  linesDeleted: Object.freeze({ source: 'git-diff', type: 'integer' }),
  filesChanged: Object.freeze({ source: 'git-diff', type: 'integer' }),
  ticketCategory: Object.freeze({ source: 'ticket-store', type: 'string' }),
  declaredRailCount: Object.freeze({ source: 'ticket-store', type: 'integer-or-none' }),
});
const NOUL_DOMAIN = ['yes', 'no'];
const PACK_KEYS = ['schemaVersion', 'id', 'mode', 'description', 'limits', 'inputs', 'questions', 'aggregation'];
const LIMIT_KEYS = ['fieldBytes', 'totalBytes'];
const INPUT_KEYS = ['source', 'type', 'classification', 'maxBytes'];
const QUESTION_KEYS = ['id', 'kind', 'prompt', 'domain', 'phases', 'inputs'];
const AGGREGATION_KEYS = ['escalateIf', 'allowIf'];
const CONDITION_KEYS = ['question', 'equals', 'atLeast', 'atMost', 'minProbability'];
const SCORE_DOMAIN_KEYS = ['min', 'max'];

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}

const isProbability = (value) => typeof value === 'number' && value >= 0 && value <= 1;

/** Reject any key of `object` outside `allowed`; packs are closed, like the schema. */
function closed(object, allowed, where) {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new PackError(`${where} has unknown key "${extra}"`);
}

/** sha256 of the canonical pack; part of every run record. */
export function packHash(pack) {
  return canonicalHash(pack);
}

/**
 * Throw a PackError naming the first rule `pack` breaks; return it unchanged
 * when valid.
 */
export function validatePack(pack) {
  if (!isPlainObject(pack)) throw new PackError('a pack must be a JSON object');
  closed(pack, PACK_KEYS, 'the pack');
  if (pack.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new PackError(`unknown pack schemaVersion ${JSON.stringify(pack.schemaVersion)}; expected ${PACK_SCHEMA_VERSION}`);
  }
  if (typeof pack.id !== 'string' || !PACK_ID_PATTERN.test(pack.id)) {
    throw new PackError(`pack id ${JSON.stringify(pack.id)} must match ${PACK_ID_PATTERN}`);
  }
  if (pack.mode !== 'shadow') throw new PackError(`pack mode ${JSON.stringify(pack.mode)} is not allowed; only "shadow" exists`);
  if (pack.description !== undefined && !(typeof pack.description === 'string' && pack.description.length <= MAX_DESCRIPTION_LENGTH)) {
    throw new PackError(`the pack description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  validateLimits(pack.limits);
  validateInputs(pack.inputs);
  const questions = validateQuestions(pack.questions, pack.inputs);
  validateAggregation(pack.aggregation, questions);
  return pack;
}

function validateLimits(limits) {
  if (!isPlainObject(limits)) throw new PackError('pack limits must declare fieldBytes and totalBytes');
  closed(limits, LIMIT_KEYS, 'limits');
  for (const [key, ceiling] of [['fieldBytes', MAX_FIELD_BYTES], ['totalBytes', MAX_TOTAL_BYTES]]) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      throw new PackError(`limits.${key} must be an integer from 1 to ${ceiling}`);
    }
  }
}

function validateInputs(inputs) {
  if (!isPlainObject(inputs) || Object.keys(inputs).length === 0) throw new PackError('a pack must declare its inputs');
  for (const [name, field] of Object.entries(inputs)) {
    if (!isPlainObject(field)) throw new PackError(`input "${name}" must be an object`);
    closed(field, INPUT_KEYS, `input "${name}"`);
    if (!Object.hasOwn(COLLECTABLE_FIELDS, name)) throw new PackError(`input "${name}" is not a collectable field`);
    const collectable = COLLECTABLE_FIELDS[name];
    for (const key of ['source', 'type']) {
      if (field[key] !== collectable[key]) {
        throw new PackError(`input "${name}" must declare ${key} ${JSON.stringify(collectable[key])}, not ${JSON.stringify(field[key])}`);
      }
    }
    if (field.classification !== 'metadata') {
      throw new PackError(`input "${name}" classification ${JSON.stringify(field.classification)} is not allowed; v1 packs are metadata-only`);
    }
    if (!Number.isInteger(field.maxBytes) || field.maxBytes < 1 || field.maxBytes > MAX_FIELD_BYTES) {
      throw new PackError(`input "${name}" maxBytes must be an integer from 1 to ${MAX_FIELD_BYTES}`);
    }
  }
}

function validateDomain(question) {
  const { id, kind, domain } = question;
  if (kind === 'Noul') {
    if (!Array.isArray(domain) || domain.length !== 2 || !NOUL_DOMAIN.every((value) => domain.includes(value))) {
      throw new PackError(`question "${id}": a Noul domain is exactly ["yes", "no"]`);
    }
    return;
  }
  if (kind === 'Choice') {
    const valid = Array.isArray(domain) && domain.length > 0
      && domain.every((value) => typeof value === 'string' && value.length > 0)
      && new Set(domain).size === domain.length;
    if (!valid) throw new PackError(`question "${id}": a Choice domain is a list of distinct non-empty strings`);
    return;
  }
  const valid = isPlainObject(domain) && Number.isFinite(domain.min) && Number.isFinite(domain.max) && domain.min < domain.max;
  if (!valid) throw new PackError(`question "${id}": a Score domain is { min, max } with min < max`);
  closed(domain, SCORE_DOMAIN_KEYS, `question "${id}" domain`);
}

function validateQuestions(questions, inputs) {
  if (!Array.isArray(questions) || questions.length === 0) throw new PackError('a pack must declare at least one question');
  const byId = new Map();
  for (const question of questions) {
    if (!isPlainObject(question) || typeof question.id !== 'string' || question.id.length === 0) {
      throw new PackError('every question needs a string id');
    }
    if (!QUESTION_ID_PATTERN.test(question.id)) throw new PackError(`question id ${JSON.stringify(question.id)} must match ${QUESTION_ID_PATTERN}`);
    if (byId.has(question.id)) throw new PackError(`duplicate question id "${question.id}"`);
    closed(question, QUESTION_KEYS, `question "${question.id}"`);
    byId.set(question.id, question);
    if (question.prompt !== undefined && !(typeof question.prompt === 'string' && question.prompt.length <= MAX_PROMPT_LENGTH)) {
      throw new PackError(`question "${question.id}" prompt must be a string of at most ${MAX_PROMPT_LENGTH} characters`);
    }
    if (!KINDS.has(question.kind)) throw new PackError(`question "${question.id}" has unknown kind ${JSON.stringify(question.kind)}`);
    validateDomain(question);
    if (!Array.isArray(question.inputs) || question.inputs.length === 0) {
      throw new PackError(`question "${question.id}" must list the inputs it may see`);
    }
    for (const name of question.inputs) {
      if (!Object.hasOwn(inputs, name)) throw new PackError(`question "${question.id}" uses undeclared input "${name}"`);
    }
    if (!Array.isArray(question.phases) || question.phases.length === 0) {
      throw new PackError(`question "${question.id}" must name the phases it describes`);
    }
    for (const phase of question.phases) {
      if (!PHASES.has(phase)) throw new PackError(`question "${question.id}" names phase "${phase}"; only P0 and D1 are allowed`);
    }
  }
  return byId;
}

function validateCondition(condition, questions, list) {
  const where = `aggregation.${list}`;
  if (!isPlainObject(condition)) throw new PackError(`${where}: every condition is an object`);
  closed(condition, CONDITION_KEYS, where);
  const question = questions.get(condition.question);
  if (!question) throw new PackError(`${where}: unknown question ${JSON.stringify(condition.question)}`);
  if (condition.minProbability !== undefined && !isProbability(condition.minProbability)) {
    throw new PackError(`${where}: minProbability for "${question.id}" must be between 0 and 1`);
  }
  if (question.kind === 'Score') {
    if (Object.hasOwn(condition, 'equals')) throw new PackError(`${where}: a Score condition for "${question.id}" may not use equals`);
    const bounds = ['atLeast', 'atMost'].filter((key) => condition[key] !== undefined);
    if (bounds.length === 0) throw new PackError(`${where}: a Score condition needs atLeast or atMost`);
    for (const key of bounds) {
      const value = condition[key];
      if (!Number.isFinite(value) || value < question.domain.min || value > question.domain.max) {
        throw new PackError(`${where}: ${key} for "${question.id}" is outside its domain`);
      }
    }
    return;
  }
  if (Object.hasOwn(condition, 'atLeast') || Object.hasOwn(condition, 'atMost')) {
    throw new PackError(`${where}: a ${question.kind} condition for "${question.id}" may not use atLeast/atMost`);
  }
  if (!Object.hasOwn(condition, 'equals')) throw new PackError(`${where}: a ${question.kind} condition for "${question.id}" needs equals`);
  if (!question.domain.includes(condition.equals)) {
    throw new PackError(`${where}: ${JSON.stringify(condition.equals)} is not in the domain of "${question.id}"`);
  }
}

function validateAggregation(aggregation, questions) {
  if (!isPlainObject(aggregation)) throw new PackError('a pack must declare its aggregation');
  closed(aggregation, AGGREGATION_KEYS, 'aggregation');
  for (const list of ['escalateIf', 'allowIf']) {
    if (!Array.isArray(aggregation[list])) throw new PackError(`aggregation.${list} must be a list`);
    for (const condition of aggregation[list]) validateCondition(condition, questions, list);
  }
}

function readPackFile(path, id) {
  const { size } = statSync(path);
  if (size > MAX_PACK_FILE_BYTES) {
    throw new PackError(`pack "${id}" at ${path} is ${size} bytes; a pack file may be at most ${MAX_PACK_FILE_BYTES}`);
  }
  let pack;
  try {
    pack = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PackError(`pack "${id}" at ${path} is not readable JSON: ${error.message}`);
  }
  validatePack(pack);
  if (pack.id !== id) throw new PackError(`pack at ${path} declares id "${pack.id}", which does not match its directory "${id}"`);
  return pack;
}

/**
 * The pack directories under `dir`. A symbolic link counts as a directory when
 * its target is one, exactly as loading a pack through it would, so a linked
 * project pack cannot slip past the shadowing check.
 */
function packDirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name), { throwIfNoEntry: false })?.isDirectory());
}

/**
 * Load and validate pack `id`. A project pack that shares an ID with a shipped
 * pack is refused whichever pack was asked for: it would otherwise change what
 * the shipped ID means in this repository.
 * @param {string} id
 * @param {{ projectRoot: string, shippedDir?: string }} options
 */
export function loadPack(id, { projectRoot, shippedDir = SHIPPED_PACKS_DIR }) {
  if (typeof id !== 'string' || !PACK_ID_PATTERN.test(id)) throw new PackError(`pack id ${JSON.stringify(id)} must match ${PACK_ID_PATTERN}`);
  const projectDir = join(projectRoot, '.adlc', 'decision-packs');
  const shipped = new Set(packDirectories(shippedDir));
  for (const name of packDirectories(projectDir)) {
    if (shipped.has(name)) throw new PackError(`project pack ${join(projectDir, name)} shadows the shipped pack "${name}"`);
  }
  for (const dir of [shippedDir, projectDir]) {
    const path = join(dir, id, 'pack.json');
    if (existsSync(path)) return readPackFile(path, id);
  }
  throw new PackError(`no pack "${id}": looked in ${shippedDir} and ${projectDir}`);
}
