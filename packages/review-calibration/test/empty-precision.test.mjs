// review-calibration/test/empty-precision.test.mjs
// Regression test for #755: do not fail-open to precision 1.0 when zero scoreable findings emitted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scorePlants } from '../lib/scorer.mjs';
import { buildJsonReport, printScorecard } from '../lib/report.mjs';

const BIN = resolve(fileURLToPath(import.meta.url), '../../bin/review-calibration.mjs');

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

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
}

describe('empty-precision: unit tests', () => {
  const dummyPlant = {
    file: 'src/math.mjs',
    line: 10,
    operator: 'replace-mul',
    category: 'math',
    defect: 'multiplication bug',
    original: 'return a * b;',
    mutated: 'return a + b;',
  };

  it('AC1: scorePlants sets precision to null when zero findings emitted (precisionDenom === 0)', async () => {
    const score = await scorePlants([dummyPlant], [], {
      judge: async () => false,
    });
    assert.equal(score.caught, 0);
    assert.equal(score.truePositives, 0);
    assert.equal(score.falsePositives, 0);
    assert.equal(score.precision, null, 'precision must be null rather than 1.0 when denom is 0');
  });

  it('scorePlants sets precision to 1.0 when precisionDenom is 1 and all true positives', async () => {
    const finding = { file: 'src/math.mjs', line: 10, description: 'identifies bug' };
    const score = await scorePlants([dummyPlant], [finding], {
      judge: async () => true,
    });
    assert.equal(score.caught, 1);
    assert.equal(score.truePositives, 1);
    assert.equal(score.falsePositives, 0);
    assert.equal(score.precision, 1.0, 'precision must be 1.0 when truePositives=1 and falsePositives=0');
  });

  it('scorePlants sets precision to 0.0 when precisionDenom is 1 and all false positives', async () => {
    const finding = { file: 'src/other.mjs', line: 99, description: 'spurious finding' };
    const score = await scorePlants([dummyPlant], [finding], {
      judge: async () => true,
    });
    assert.equal(score.caught, 0);
    assert.equal(score.truePositives, 0);
    assert.equal(score.falsePositives, 1);
    assert.equal(score.precision, 0.0, 'precision must be 0.0 when truePositives=0 and falsePositives=1');
  });

  it('buildJsonReport surfaces precision: null and fails gate when minPrecision is configured', () => {
    const report = buildJsonReport({
      recall: 1,
      caught: 1,
      total: 1,
      precision: null,
      truePositives: 0,
      falsePositives: 0,
      minRecall: 0.5,
      minPrecision: 0.5,
      scorer: 'judge',
      commit: 'HEAD',
      reviewExitCode: 0,
      perCategory: {},
      results: [],
    });

    assert.equal(report.precision, null);
    assert.equal(report.minPrecision, 0.5);
    assert.equal(report.gatePass, false, 'gatePass must be false when precision is null and minPrecision is set');
  });

  it('buildJsonReport passes gate when precision is null but minPrecision is not configured', () => {
    const report = buildJsonReport({
      recall: 1,
      caught: 1,
      total: 1,
      precision: null,
      truePositives: 0,
      falsePositives: 0,
      minRecall: 0.5,
      minPrecision: null,
      scorer: 'judge',
      commit: 'HEAD',
      reviewExitCode: 0,
      perCategory: {},
      results: [],
    });

    assert.equal(report.precision, null);
    assert.equal(report.minPrecision, null);
    assert.equal(report.gatePass, true, 'gatePass can be true when minPrecision is not required');
  });

  it('buildJsonReport passes gate when precision is non-null and meets minPrecision threshold', () => {
    const report = buildJsonReport({
      recall: 1,
      caught: 1,
      total: 1,
      precision: 0.8,
      truePositives: 4,
      falsePositives: 1,
      minRecall: 0.5,
      minPrecision: 0.5,
      scorer: 'judge',
      commit: 'HEAD',
      reviewExitCode: 0,
      perCategory: {},
      results: [],
    });

    assert.equal(report.precision, 0.8);
    assert.equal(report.gatePass, true, 'gatePass must be true when precision >= minPrecision');
  });

  it('buildJsonReport passes gate when precision exactly equals minPrecision', () => {
    const report = buildJsonReport({
      recall: 1,
      caught: 1,
      total: 1,
      precision: 0.5,
      truePositives: 1,
      falsePositives: 1,
      minRecall: 0.5,
      minPrecision: 0.5,
      scorer: 'judge',
      commit: 'HEAD',
      reviewExitCode: 0,
      perCategory: {},
      results: [],
    });

    assert.equal(report.precision, 0.5);
    assert.equal(report.gatePass, true, 'gatePass must be true when precision === minPrecision');
  });

  it('printScorecard formats precision: null safely without printing 0.0%', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printScorecard({
        recall: 0,
        caught: 0,
        total: 1,
        precision: null,
        falsePositives: 0,
        perCategory: {},
        results: [],
        commit: 'test',
        minRecall: 0.5,
        minPrecision: 0.5,
        scorer: 'judge',
      });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    assert.match(output, /Precision:\s+null/);
    assert.doesNotMatch(output, /Precision:\s+0\.0%/);
    assert.match(output, /GATE FAIL — recall 0\.0% \/ precision null below thresholds/);
  });

  it('printScorecard handles numeric precision meeting minPrecision', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printScorecard({
        recall: 1.0,
        caught: 1,
        total: 1,
        precision: 0.5,
        falsePositives: 1,
        perCategory: {},
        results: [],
        commit: 'test',
        minRecall: 0.5,
        minPrecision: 0.5,
        scorer: 'judge',
      });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    assert.match(output, /Precision:\s+50\.0%/);
    assert.match(output, /Min precision:\s+50\.0%\s+\[PASS\]/);
    assert.match(output, /GATE PASS — recall 100\.0% meets minimum 50\.0%/);
  });

  it('printScorecard handles numeric precision below minPrecision', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printScorecard({
        recall: 1.0,
        caught: 1,
        total: 1,
        precision: 0.4,
        falsePositives: 1,
        perCategory: {},
        results: [],
        commit: 'test',
        minRecall: 0.5,
        minPrecision: 0.5,
        scorer: 'judge',
      });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    assert.match(output, /Precision:\s+40\.0%/);
    assert.match(output, /Min precision:\s+50\.0%\s+\[FAIL\]/);
    assert.match(output, /GATE FAIL — recall 100\.0% \/ precision 40\.0% below thresholds/);
  });

  it('printScorecard passes gate when precision is null and minPrecision is null', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printScorecard({
        recall: 1.0,
        caught: 1,
        total: 1,
        precision: null,
        falsePositives: 0,
        perCategory: {},
        results: [],
        commit: 'test',
        minRecall: 0.5,
        minPrecision: null,
        scorer: 'judge',
      });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    assert.match(output, /Precision:\s+null/);
    assert.match(output, /GATE PASS — recall 100\.0% meets minimum 50\.0%/);
  });
});

describe('empty-precision: E2E tests', () => {
  it('AC2: review-calibration --min-precision 0.5 fails with exit 2 when reviewer produces 0 findings (JSON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-empty-prec-e2e-json-'));
    try {
      createRepo(dir);
      const result = runCli(
        [
          '--review-cmd', 'node -e "process.stdout.write(\'[]\\n\')"',
          '--commit', 'HEAD',
          '--plants', '2',
          '--min-plants', '1',
          '--min-recall', '0',
          '--min-precision', '0.5',
          '--scorer', 'string',
          '--json',
        ],
        dir
      );

      assert.equal(result.status, 2, `Expected exit 2, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.precision, null);
      assert.equal(parsed.gatePass, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC2: review-calibration --min-precision 0.5 fails with exit 2 when reviewer produces 0 findings (non-JSON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-empty-prec-e2e-cli-'));
    try {
      createRepo(dir);
      const result = runCli(
        [
          '--review-cmd', 'node -e "process.stdout.write(\'[]\\n\')"',
          '--commit', 'HEAD',
          '--plants', '2',
          '--min-plants', '1',
          '--min-recall', '0',
          '--min-precision', '0.5',
          '--scorer', 'string',
        ],
        dir
      );

      assert.equal(result.status, 2, `Expected exit 2, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /gate fails — recall 0\.0% \(min 0\.0%\), precision null \(could not be measured\) \(min 50\.0%\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails gate with formatted percentage when precision is below min-precision (non-JSON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-empty-prec-e2e-below-'));
    try {
      createRepo(dir);
      const result = runCli(
        [
          '--review-cmd', 'node -e "process.stdout.write(JSON.stringify([{file:\'src/math.mjs\',line:2,description:\'bug\'},{file:\'src/other.mjs\',line:99,description:\'spurious\'}]))"',
          '--commit', 'HEAD',
          '--plants', '2',
          '--min-plants', '1',
          '--min-recall', '0',
          '--min-precision', '0.8',
          '--scorer', 'string',
        ],
        dir
      );

      assert.equal(result.status, 2, `Expected exit 2, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /precision 50\.0% \(min 80\.0%\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes gate when reviewer produces 0 findings if min-precision is not set and min-recall is met', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-empty-prec-e2e-pass-'));
    try {
      createRepo(dir);
      const result = runCli(
        [
          '--review-cmd', 'node -e "process.stdout.write(\'[]\\n\')"',
          '--commit', 'HEAD',
          '--plants', '2',
          '--min-plants', '1',
          '--min-recall', '0',
          '--scorer', 'string',
          '--json',
        ],
        dir
      );

      assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.precision, null);
      assert.equal(parsed.gatePass, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes gate when findings are emitted and precision meets min-precision (kills inverted precision check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-empty-prec-e2e-precpass-'));
    try {
      createRepo(dir);
      const result = runCli(
        [
          '--review-cmd', 'node -e "process.stdout.write(JSON.stringify([{file:\'src/math.mjs\',line:2,description:\'bug\'},{file:\'src/math.mjs\',line:6,description:\'bug\'}]))"',
          '--commit', 'HEAD',
          '--plants', '2',
          '--min-plants', '1',
          '--min-recall', '0.5',
          '--min-precision', '0.5',
          '--scorer', 'string',
          '--json',
        ],
        dir
      );

      assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.precision, 1.0);
      assert.equal(parsed.gatePass, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
