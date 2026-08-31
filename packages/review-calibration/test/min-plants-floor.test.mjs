// min-plants-floor.test.mjs — issue #751: a --min-plants floor so a 1-2-plant
// commit cannot GATE PASS at 100% recall from a coin flip.
// Deterministic: uses --plants-file to control the exact valid-plant count,
// and --scorer string (with a trivial review-cmd) to avoid needing an LLM
// provider, mirroring the existing suite's provider-independent tests.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = resolve(fileURLToPath(import.meta.url), '../../bin/review-calibration.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60000,
  });
}

const SOURCE_LINES = [
  'export function a1(n) {',
  '  return n > 0;',
  '}',
  'export function a2(n) {',
  '  return n >= 0;',
  '}',
  'export function a3(n) {',
  '  return n < 0;',
  '}',
  'export function a4(n) {',
  '  return n <= 0;',
  '}',
  '',
];

// Explicit "defect" text on each plant, deliberately sharing no >=4-char word
// with echoReviewer's fixed "<basename>:<line> changed" description — the
// scorer's echo self-test (echo must score ~0 against referenceJudge) would
// otherwise false-positive on an accidental substring match (e.g. a filename
// fragment leaking into an auto-derived defect string).
const ALL_PLANTS = [
  { file: 'src/calc.mjs', line: 2, original: '  return n > 0;', mutated: '  return n >= 0;', defect: 'boundary comparison operator inverted' },
  { file: 'src/calc.mjs', line: 5, original: '  return n >= 0;', mutated: '  return n > 0;', defect: 'strict inequality weakened incorrectly' },
  { file: 'src/calc.mjs', line: 8, original: '  return n < 0;', mutated: '  return n <= 0;', defect: 'negative range boundary widened wrongly' },
  { file: 'src/calc.mjs', line: 11, original: '  return n <= 0;', mutated: '  return n < 0;', defect: 'inclusive boundary narrowed improperly' },
];

function createRepo(dir) {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'calc.mjs'), SOURCE_LINES.join('\n'));
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
}

// Written OUTSIDE the repo dir — a plants.json left untracked inside the repo
// would trip the CLI's own dirty-tree check on every later test sharing dir.
let plantsFileCounter = 0;
const writtenPlantsFiles = [];
function writePlantsFile(plants) {
  const path = join(tmpdir(), `rc-plants-${process.pid}-${plantsFileCounter++}.json`);
  writeFileSync(path, JSON.stringify(plants));
  writtenPlantsFiles.push(path);
  return path;
}

const TRIVIAL_REVIEW_CMD = 'node -e "process.stdout.write(\'LGTM\\n\')"';

describe('review-calibration --min-plants floor (#751)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-min-plants-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const p of writtenPlantsFiles) rmSync(p, { force: true });
  });

  it('AC1: 1 valid plant with the default floor (4) exits 1, names the count and the floor, prints no scorecard', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS.slice(0, 1));
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--scorer', 'string',
      '--min-recall', '0',
      '--json',
    ], dir);

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(/\b1\b/.test(result.stderr), `stderr should name the actual count (1): ${result.stderr}`);
    assert.ok(/\b4\b/.test(result.stderr), `stderr should name the configured floor (4): ${result.stderr}`);
    assert.ok(!/recall/i.test(result.stdout), `no scorecard should be printed to stdout: ${result.stdout}`);
    assert.equal(result.stdout.trim(), '', `expected empty stdout on a refused sub-floor run, got: ${result.stdout}`);
  });

  it('AC2: 1 valid plant with --min-plants 1 explicitly proceeds to scoring (floor is configurable, not hardcoded)', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS.slice(0, 1));
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--scorer', 'string',
      '--min-recall', '0',
      '--min-plants', '1',
      '--json',
    ], dir);

    assert.notEqual(result.status, 1, `expected NOT an operational error, got exit 1: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.total, 1);
  });

  it('AC3: exactly 4 valid plants with the default floor (4) proceeds to scoring (boundary is >=, not >)', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS);
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--scorer', 'string',
      '--min-recall', '0',
      '--json',
    ], dir);

    assert.notEqual(result.status, 1, `expected NOT an operational error at the boundary, got exit 1: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.total, 4);
  });

  it('AC4: --min-plants abc rejects before any plant generation runs', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS);
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--min-plants', 'abc',
      '--json',
    ], dir);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.ok(/--min-plants/.test(result.stderr), result.stderr);
  });

  it('AC4: --min-plants -1 rejects before any plant generation runs', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS);
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--min-plants', '-1',
      '--json',
    ], dir);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.ok(/--min-plants/.test(result.stderr), result.stderr);
  });

  it('AC5: a passing run at the floor shows the plant count prominently in JSON output', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS);
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--scorer', 'string',
      '--min-recall', '0',
      '--json',
    ], dir);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.total, 'number');
    assert.equal(parsed.total, 4);
  });

  it('AC5: a passing run at the floor shows the plant count prominently in text output', () => {
    const plantsFile = writePlantsFile(ALL_PLANTS);
    const result = runCli([
      '--review-cmd', TRIVIAL_REVIEW_CMD,
      '--plants-file', plantsFile,
      '--scorer', 'string',
      '--min-recall', '0',
    ], dir);
    assert.ok(/Plants:\s*4/i.test(result.stdout), `expected a prominent "Plants: 4" line, got:\n${result.stdout}`);
  });

  it('--help documents --min-plants, its <n> argument, its default, and refuses with exit 1', () => {
    const result = runCli(['--help'], dir);
    assert.ok(result.stdout.includes('--min-plants <n>'), result.stdout);
    assert.ok(/default: 4/.test(result.stdout), 'help text should state the default of 4');
    assert.ok(result.stdout.includes('refuses with exit 1'), result.stdout);
  });
});
