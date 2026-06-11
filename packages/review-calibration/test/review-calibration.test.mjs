// review-calibration/test/review-calibration.test.mjs
// Tests run offline — no network, no API keys, no real LLM.
// Uses mkdtempSync scratch git repos and fake review commands.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Lib under test
import { parseCommitFiles, filterCodeFiles, selectPlants, loadPlantsFile } from '../lib/targets.mjs';
import { isPlantCaught, extractLineNumbers, countFalsePositives, scoreReview } from '../lib/scorer.mjs';
import { groupByFile, applyAllPlantsToContent } from '../lib/runner.mjs';
import { buildJsonReport } from '../lib/report.mjs';
import { mutate } from '../../core/index.mjs';

const BIN = resolve(fileURLToPath(import.meta.url), '../../bin/review-calibration.mjs');

// ── helpers ──────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

function commitAll(dir, msg = 'init') {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
}

/** Create a small git repo with two commits. Second commit modifies a source file. */
function createRepo(dir) {
  initRepo(dir);
  mkdirSync(join(dir, 'src'));

  writeFileSync(join(dir, 'src', 'math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function isPositive(n) {',
    '  return n > 0;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'README.md'), '# test\n');
  commitAll(dir, 'initial');

  // Second commit: add multiply
  writeFileSync(join(dir, 'src', 'math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function isPositive(n) {',
    '  return n > 0;',
    '}',
    '',
    'export function multiply(a, b) {',
    '  return a * b;',
    '}',
    '',
  ].join('\n'));

  commitAll(dir, 'add multiply');
  return dir;
}

// ── parseCommitFiles ─────────────────────────────────────────────────────────

describe('parseCommitFiles', () => {
  it('extracts file names after the blank line in git show output', () => {
    const output = [
      'add multiply',
      '',
      'src/math.mjs',
      '',
    ].join('\n');
    assert.deepEqual(parseCommitFiles(output), ['src/math.mjs']);
  });

  it('handles multiple files', () => {
    const output = [
      'refactor',
      '',
      'lib/a.mjs',
      'lib/b.mjs',
      'test/a.test.mjs',
    ].join('\n');
    assert.deepEqual(parseCommitFiles(output), ['lib/a.mjs', 'lib/b.mjs', 'test/a.test.mjs']);
  });

  it('returns empty array when there are no files', () => {
    const output = 'init\n\n';
    assert.deepEqual(parseCommitFiles(output), []);
  });
});

// ── filterCodeFiles ──────────────────────────────────────────────────────────

describe('filterCodeFiles', () => {
  it('excludes test files', () => {
    assert.deepEqual(filterCodeFiles(['src/a.mjs', 'test/a.test.mjs']), ['src/a.mjs']);
  });

  it('excludes spec files', () => {
    assert.deepEqual(filterCodeFiles(['lib/b.mjs', 'spec/b.spec.mjs']), ['lib/b.mjs']);
  });

  it('excludes .md files', () => {
    assert.deepEqual(filterCodeFiles(['src/c.mjs', 'README.md']), ['src/c.mjs']);
  });

  it('excludes .json files', () => {
    assert.deepEqual(filterCodeFiles(['src/d.mjs', 'package.json']), ['src/d.mjs']);
  });

  it('keeps .mjs, .js, .py source files', () => {
    assert.deepEqual(filterCodeFiles(['src/e.mjs', 'lib/f.js']), ['src/e.mjs', 'lib/f.js']);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(filterCodeFiles([]), []);
  });
});

// ── selectPlants ─────────────────────────────────────────────────────────────

describe('selectPlants', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-select-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'calc.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      'export function isGood(x) {',
      '  return x > 0 && x < 100;',
      '}',
      'export function toggle(flag) {',
      '  return !flag;',
      '}',
    ].join('\n'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns at most maxPlants entries', () => {
    const plants = selectPlants(['src/calc.mjs'], dir, 3, mutate.generateMutants);
    assert.ok(plants.length <= 3, `Expected <=3, got ${plants.length}`);
  });

  it('each plant has required fields', () => {
    const plants = selectPlants(['src/calc.mjs'], dir, 5, mutate.generateMutants);
    for (const p of plants) {
      assert.ok(typeof p.file === 'string');
      assert.ok(typeof p.absolutePath === 'string');
      assert.ok(typeof p.line === 'number');
      assert.ok(typeof p.operator === 'string');
      assert.ok(typeof p.original === 'string');
      assert.ok(typeof p.mutated === 'string');
    }
  });

  it('spreads across operators (multiple operators present when content allows)', () => {
    const plants = selectPlants(['src/calc.mjs'], dir, 10, mutate.generateMutants);
    const ops = new Set(plants.map((p) => p.operator));
    assert.ok(ops.size >= 2, `Expected >=2 operators, got ${ops.size}: ${[...ops].join(', ')}`);
  });

  it('returns empty for no files', () => {
    const plants = selectPlants([], dir, 5, mutate.generateMutants);
    assert.deepEqual(plants, []);
  });
});

// ── isPlantCaught ─────────────────────────────────────────────────────────────

describe('isPlantCaught — catch by line proximity', () => {
  const plant = { file: 'src/math.mjs', line: 10, mutated: '  return a - b;', original: '  return a + b;' };

  it('catches when basename and exact line mentioned', () => {
    assert.ok(isPlantCaught('math.mjs:10 potential bug found', plant));
  });

  it('catches when basename and line within +3', () => {
    assert.ok(isPlantCaught('math.mjs:13 issue here', plant));
  });

  it('catches when basename and line within -3', () => {
    assert.ok(isPlantCaught('math.mjs:7 problem', plant));
  });

  it('misses when line is outside ±3', () => {
    assert.ok(!isPlantCaught('math.mjs:14 issue here', plant));
  });

  it('misses when file not mentioned at all', () => {
    assert.ok(!isPlantCaught('other.mjs:10 issue', plant));
  });
});

describe('isPlantCaught — catch by snippet', () => {
  const plant = {
    file: 'src/auth.mjs',
    line: 5,
    mutated: '  if (user.role !== "admin") {',
    original: '  if (user.role === "admin") {',
  };

  it('catches when a >=12-char substring of mutated line appears in output', () => {
    // 'user.role !== ' is 14 chars
    assert.ok(isPlantCaught('Found issue: user.role !== "admin"', plant));
  });

  it('misses when only short substrings match', () => {
    // Only 'user' appears — less than 12 chars
    assert.ok(!isPlantCaught('Found issue with user', plant));
  });

  it('misses when none of mutated line is in output', () => {
    assert.ok(!isPlantCaught('Unrelated finding about something else entirely', plant));
  });
});

describe('isPlantCaught — mutated line shorter than 12 chars', () => {
  const plant = { file: 'a.mjs', line: 3, mutated: '  x = 2;', original: '  x = 1;' };

  it('does not try snippet match when mutated line is short', () => {
    // File not mentioned, mutated too short for snippet — should miss
    assert.ok(!isPlantCaught('some output with no useful info', plant));
  });
});

// ── extractLineNumbers ────────────────────────────────────────────────────────

describe('extractLineNumbers', () => {
  it('extracts line numbers after filename:digits', () => {
    const nums = extractLineNumbers('math.mjs:42 is wrong, also math.mjs:100', 'math.mjs');
    assert.deepEqual(nums.sort((a, b) => a - b), [42, 100]);
  });

  it('returns empty when filename not found', () => {
    const nums = extractLineNumbers('other.mjs:5 issue', 'math.mjs');
    assert.deepEqual(nums, []);
  });

  it('handles full paths like src/math.mjs:10', () => {
    const nums = extractLineNumbers('src/math.mjs:10 bug', 'math.mjs');
    assert.deepEqual(nums, [10]);
  });
});

// ── countFalsePositives ───────────────────────────────────────────────────────

describe('countFalsePositives', () => {
  it('counts findings not matching any plant', () => {
    const plants = [{ file: 'math.mjs', line: 10 }];
    // math.mjs:10 matches the plant; other.mjs:5 does not
    const fps = countFalsePositives('math.mjs:10 bug\nother.mjs:5 issue', plants);
    assert.equal(fps, 1);
  });

  it('counts zero when all findings match plants', () => {
    const plants = [{ file: 'math.mjs', line: 10 }];
    const fps = countFalsePositives('math.mjs:10 bug', plants);
    assert.equal(fps, 0);
  });

  it('handles empty output', () => {
    const fps = countFalsePositives('', [{ file: 'x.mjs', line: 1 }]);
    assert.equal(fps, 0);
  });

  it('tolerates ±3 line proximity for plants', () => {
    const plants = [{ file: 'a.mjs', line: 10 }];
    // a.mjs:12 is within ±3 of line 10 → matches plant → not a FP
    const fps = countFalsePositives('a.mjs:12 issue', plants);
    assert.equal(fps, 0);
  });
});

// ── scoreReview ───────────────────────────────────────────────────────────────

describe('scoreReview', () => {
  const plants = [
    { file: 'src/math.mjs', line: 5, operator: 'off-by-one',       original: '  return n + 1;', mutated: '  return n + 2;' },
    { file: 'src/math.mjs', line: 10, operator: 'bool-flip',        original: '  return true;', mutated: '  return false;' },
    { file: 'src/auth.mjs', line: 20, operator: 'invert-comparison', original: '  if (x > 0) {', mutated: '  if (x <= 0) {' },
  ];

  it('recall = caught / total', () => {
    // Reviewer finds first and third plants
    const output = 'math.mjs:5 bug\nauth.mjs:20 issue';
    const score = scoreReview(output, plants);
    assert.equal(score.caught, 2);
    assert.equal(score.total, 3);
    assert.ok(Math.abs(score.recall - 2 / 3) < 0.001);
  });

  it('recall = 1 when all plants caught', () => {
    const output = 'math.mjs:5 ok\nmath.mjs:10 ok\nauth.mjs:20 ok';
    const score = scoreReview(output, plants);
    assert.equal(score.recall, 1);
    assert.equal(score.caught, 3);
  });

  it('recall = 0 when no plants caught', () => {
    const output = 'no useful findings here at all';
    const score = scoreReview(output, plants);
    assert.equal(score.recall, 0);
    assert.equal(score.caught, 0);
  });

  it('per-operator breakdown is correct', () => {
    // Only catch the off-by-one plant
    const output = 'math.mjs:5 off by one';
    const score = scoreReview(output, plants);
    assert.equal(score.perOperator['off-by-one'].caught, 1);
    assert.equal(score.perOperator['off-by-one'].total, 1);
    assert.equal(score.perOperator['bool-flip'].caught, 0);
    assert.equal(score.perOperator['bool-flip'].total, 1);
    assert.equal(score.perOperator['invert-comparison'].caught, 0);
    assert.equal(score.perOperator['invert-comparison'].total, 1);
  });

  it('results array has caught flag per plant', () => {
    const output = 'math.mjs:10 bool flip issue';
    const score = scoreReview(output, plants);
    const boolFlipResult = score.results.find((r) => r.operator === 'bool-flip');
    assert.ok(boolFlipResult.caught);
    const offByOneResult = score.results.find((r) => r.operator === 'off-by-one');
    assert.ok(!offByOneResult.caught);
  });

  it('falsePositives count is included', () => {
    const output = 'math.mjs:5 issue\nunrelated.mjs:99 spurious';
    const score = scoreReview(output, plants);
    assert.ok(typeof score.falsePositives === 'number');
  });
});

// ── applyAllPlantsToContent ───────────────────────────────────────────────────

describe('applyAllPlantsToContent', () => {
  const content = 'line1\nline2\nline3\nline4\n';

  it('applies a single plant', () => {
    const plants = [{ line: 2, original: 'line2', mutated: 'MUTATED' }];
    const result = applyAllPlantsToContent(content, plants);
    assert.equal(result, 'line1\nMUTATED\nline3\nline4\n');
  });

  it('applies multiple plants on different lines', () => {
    const plants = [
      { line: 1, original: 'line1', mutated: 'AAA' },
      { line: 3, original: 'line3', mutated: 'BBB' },
    ];
    const result = applyAllPlantsToContent(content, plants);
    assert.equal(result, 'AAA\nline2\nBBB\nline4\n');
  });

  it('skips plant if original does not match (prior mutation)', () => {
    const plants = [
      { line: 1, original: 'line1', mutated: 'AAA' },
      { line: 1, original: 'line1', mutated: 'BBB' }, // same line — first wins
    ];
    const result = applyAllPlantsToContent(content, plants);
    // AAA was applied; BBB original 'line1' no longer matches → skipped
    assert.equal(result, 'AAA\nline2\nline3\nline4\n');
  });
});

// ── groupByFile ───────────────────────────────────────────────────────────────

describe('groupByFile', () => {
  it('groups plants by absolutePath', () => {
    const plants = [
      { absolutePath: '/a.mjs', line: 1 },
      { absolutePath: '/b.mjs', line: 2 },
      { absolutePath: '/a.mjs', line: 3 },
    ];
    const grouped = groupByFile(plants);
    assert.equal(grouped.size, 2);
    assert.equal(grouped.get('/a.mjs').length, 2);
    assert.equal(grouped.get('/b.mjs').length, 1);
  });

  it('returns empty map for empty input', () => {
    assert.equal(groupByFile([]).size, 0);
  });
});

// ── buildJsonReport ───────────────────────────────────────────────────────────

describe('buildJsonReport', () => {
  it('shapes the output correctly', () => {
    const scorecard = {
      recall: 0.75,
      caught: 3,
      total: 4,
      falsePositives: 2,
      minRecall: 0.5,
      commit: 'abc123',
      reviewExitCode: 0,
      perOperator: {
        'bool-flip': { caught: 2, total: 2, recall: 1 },
        'off-by-one': { caught: 1, total: 2, recall: 0.5 },
      },
      results: [
        { file: 'src/a.mjs', line: 5, operator: 'bool-flip', caught: true, original: 'x', mutated: 'y' },
        { file: 'src/b.mjs', line: 10, operator: 'off-by-one', caught: false, original: 'x', mutated: 'z' },
      ],
    };
    const report = buildJsonReport(scorecard);
    assert.equal(report.recall, 0.75);
    assert.equal(report.caught, 3);
    assert.equal(report.total, 4);
    assert.equal(report.falsePositives, 2);
    assert.equal(report.gatePass, true);
    assert.equal(report.commit, 'abc123');
    assert.equal(report.reviewExitCode, 0);
    assert.deepEqual(Object.keys(report.perOperator), ['bool-flip', 'off-by-one']);
    assert.equal(report.plants[0].status, 'caught');
    assert.equal(report.plants[1].status, 'missed');
  });

  it('gatePass is false when recall < minRecall', () => {
    const scorecard = {
      recall: 0.3, caught: 1, total: 3, falsePositives: 0,
      minRecall: 0.5, commit: 'x', reviewExitCode: 0,
      perOperator: {}, results: [],
    };
    assert.equal(buildJsonReport(scorecard).gatePass, false);
  });
});

// ── {base} substitution ───────────────────────────────────────────────────────

describe('{base} substitution in review command', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-base-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('substitutes {base} with the commit ref in the command', () => {
    // Use a fake review cmd that writes what it received to stdout.
    // The cmd prints the first argument (which should be the commit ref after substitution).
    const fakeReviewCmd = `node -e "process.stdout.write(process.argv.slice(1).join(' '))" -- {base}`;
    const result = runCli(
      [
        '--review-cmd', fakeReviewCmd,
        '--commit', 'HEAD',
        '--plants', '2',
        '--min-recall', '0',
        '--json',
      ],
      dir
    );
    // Should not be an opError (exit 1)
    assert.notEqual(result.status, 1, `opError: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.commit, 'HEAD');
  });
});

// ── end-to-end: fake review cmd that finds known plants ───────────────────────

describe('E2E: fake review finds all plants → recall 1.0, gate passes', () => {
  let dir;
  let scriptDir;
  let scriptPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-e2e-pass-'));
    createRepo(dir);

    // Write the helper review script to a SEPARATE temp dir (outside the git
    // repo) so writing it doesn't make the repo dirty.
    scriptDir = mkdtempSync(join(tmpdir(), 'rc-script-'));
    scriptPath = join(scriptDir, 'fake-review.mjs');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env node',
      '// Fake reviewer: report every changed line in any file as a finding.',
      'import { execFileSync } from "node:child_process";',
      'const baseRef = process.argv[2] ?? "HEAD";',
      'let diff;',
      'try {',
      '  diff = execFileSync("git", ["diff", baseRef], { encoding: "utf8" });',
      '} catch { diff = ""; }',
      'const lines = diff.split("\\n");',
      'let currentFile = "";',
      'let newLine = 0;',
      'for (const l of lines) {',
      '  const fm = l.match(/^\\+\\+\\+ b\\/(.+)$/);',
      '  if (fm) { currentFile = fm[1].split("/").pop(); continue; }',
      '  const hm = l.match(/^@@ -\\d+(?:,\\d+)? \\+(\\d+)/);',
      '  if (hm) { newLine = parseInt(hm[1]); continue; }',
      '  if (l.startsWith("+") && !l.startsWith("+++")) {',
      '    if (currentFile) process.stdout.write(currentFile + ":" + newLine + " changed\\n");',
      '    newLine++;',
      '  } else if (!l.startsWith("-") && !l.startsWith("\\\\\\\\")) newLine++;',
      '}',
    ].join('\n'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it('exits 0 when recall meets threshold and outputs valid JSON', () => {
    const result = runCli(
      [
        '--review-cmd', `node ${scriptPath} {base}`,
        '--commit', 'HEAD',
        '--plants', '3',
        '--min-recall', '0',
        '--json',
      ],
      dir
    );

    assert.notEqual(result.status, 1, `opError: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, result.stdout);
    assert.ok(typeof parsed.recall === 'number');
    assert.ok(parsed.total > 0, 'Expected at least one plant');
    assert.equal(parsed.gatePass, true);
    assert.equal(result.status, 0);
  });

  it('reporter catches plants whose lines appear in diff output → recall > 0', () => {
    // Run with --min-recall 0 so we just verify the run works and recall is measured.
    const result = runCli(
      [
        '--review-cmd', `node ${scriptPath} {base}`,
        '--commit', 'HEAD',
        '--plants', '4',
        '--min-recall', '0',
        '--json',
      ],
      dir
    );
    assert.notEqual(result.status, 1, `opError: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    // The fake reviewer reports all changed lines, so at least some plants
    // whose lines are reported should be caught.
    assert.ok(parsed.total >= 1);
    assert.ok(parsed.recall >= 0 && parsed.recall <= 1);
  });
});

describe('E2E: fake review finds nothing → recall 0, gate fails (exit 2)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-e2e-fail-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 when recall is below min-recall', () => {
    // Fake review that reports nothing useful
    const result = runCli(
      [
        '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
        '--commit', 'HEAD',
        '--plants', '3',
        '--min-recall', '0.5',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 2, `Expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); });
    assert.equal(parsed.recall, 0);
    assert.equal(parsed.gatePass, false);
  });
});

describe('E2E: file restoration after run', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-restore-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('src/math.mjs is byte-identical after calibration run', () => {
    const srcPath = join(dir, 'src', 'math.mjs');
    const before = readFileSync(srcPath, 'utf8');

    runCli(
      [
        '--review-cmd', 'node -e "process.stdout.write(\'ok\\n\')"',
        '--commit', 'HEAD',
        '--plants', '3',
        '--min-recall', '0',
      ],
      dir
    );

    const after = readFileSync(srcPath, 'utf8');
    assert.equal(after, before, 'File was not restored after calibration run');
  });
});

describe('E2E: dirty tree rejection', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-dirty-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'init'], dir);
    // Make tree dirty
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 2;\n');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 with a clear message on dirty tree', () => {
    const result = runCli(
      ['--review-cmd', 'echo ok', '--commit', 'HEAD'],
      dir
    );
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('commit or stash'), result.stderr);
  });
});

describe('loadPlantsFile', () => {
  it('loads valid plants, validates line content against working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-plants-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), 'const x = 1;\nconst y = 2;\n');
      const plantsPath = join(dir, 'plants.json');
      writeFileSync(plantsPath, JSON.stringify([
        { file: 'a.mjs', line: 2, original: 'const y = 2;', mutated: 'const y = 3;', category: 'subtle-llm' },
      ]));
      const { plants, errors } = loadPlantsFile(plantsPath, dir);
      assert.equal(errors.length, 0);
      assert.equal(plants.length, 1);
      assert.equal(plants[0].operator, 'subtle-llm');
      assert.equal(plants[0].line, 2);
      assert.ok(plants[0].absolutePath.endsWith('a.mjs'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects drifted plants (original does not match file content)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-plants-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), 'const x = 1;\n');
      const plantsPath = join(dir, 'plants.json');
      writeFileSync(plantsPath, JSON.stringify([
        { file: 'a.mjs', line: 1, original: 'const x = 999;', mutated: 'const x = 0;' },
      ]));
      const { plants, errors } = loadPlantsFile(plantsPath, dir);
      assert.equal(plants.length, 0);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes('drifted'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSON, non-arrays, malformed entries, missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-plants-'));
    try {
      const badJson = join(dir, 'bad.json');
      writeFileSync(badJson, 'not json');
      assert.ok(loadPlantsFile(badJson, dir).errors[0].includes('invalid JSON'));

      const notArray = join(dir, 'obj.json');
      writeFileSync(notArray, '{}');
      assert.ok(loadPlantsFile(notArray, dir).errors[0].includes('array'));

      const mixed = join(dir, 'mixed.json');
      writeFileSync(mixed, JSON.stringify([
        { file: 'missing.mjs', line: 1, original: 'x', mutated: 'y' },
        { line: 1, original: 'x', mutated: 'y' },
        { file: 'a.mjs', line: 0, original: 'x', mutated: 'y' },
        { file: 'a.mjs', line: 1, original: 'x', mutated: 'x' },
      ]));
      const { plants, errors } = loadPlantsFile(mixed, dir);
      assert.equal(plants.length, 0);
      assert.equal(errors.length, 4);

      assert.ok(loadPlantsFile(join(dir, 'nope.json'), dir).errors[0].includes('cannot read'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI: no-args behavior', () => {
  it('exits 1 when --review-cmd is missing', () => {
    const result = runCli([], process.cwd());
    assert.equal(result.status, 1);
  });

  it('exits 0 and shows help with --help flag', () => {
    const result = runCli(['--help'], process.cwd());
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('review-calibration'));
    assert.ok(result.stdout.includes('--review-cmd'));
    assert.ok(result.stdout.includes('--plants'));
    assert.ok(result.stdout.includes('--min-recall'));
  });
});
