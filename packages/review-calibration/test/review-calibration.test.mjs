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
import {
  parseCommitFiles, filterCodeFiles, selectPlants, loadPlantsFile,
  operatorToCategory, describeDefect,
} from '../lib/targets.mjs';
import { locatingFindings } from '../lib/scorer.mjs';
import { parseFindings, parseProseFindings } from '../lib/findings.mjs';
import { referenceJudge } from '../lib/judge.mjs';
import { echoReviewer, oracleReviewer } from '../lib/controls.mjs';
import { verifyWitness, filterEquivalentMutants } from '../lib/verify.mjs';
import {
  groupByFile, applyAllPlantsToContent, runWithPlants, tokenizeCommand, substituteToken,
} from '../lib/runner.mjs';
import { existsSync } from 'node:fs';
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

// ── findings parsing ──────────────────────────────────────────────────────────

describe('parseFindings', () => {
  it('parses adversarial-review JSON findings shape', () => {
    const out = JSON.stringify({
      findings: [
        { file: 'src/auth.mjs', line_start: 42, title: 'Auth bypass', body: 'inverted check', evidence: 'if (role !== admin)' },
      ],
    });
    const f = parseFindings(out);
    assert.equal(f.length, 1);
    assert.equal(f[0].file, 'src/auth.mjs');
    assert.equal(f[0].line, 42);
    assert.ok(f[0].description.includes('Auth bypass'));
  });

  it('parses a bare JSON array of findings', () => {
    const out = JSON.stringify([{ file: 'a.mjs', line: 7, body: 'bug' }]);
    const f = parseFindings(out);
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 7);
  });

  it('tolerates log lines around a JSON block', () => {
    const out = 'starting review...\n{"findings":[{"file":"a.mjs","line":3,"body":"x"}]}\ndone';
    const f = parseFindings(out);
    assert.equal(f.length, 1);
    assert.equal(f[0].file, 'a.mjs');
  });

  it('falls back to prose file:line parsing', () => {
    const f = parseProseFindings('src/math.mjs:10 off-by-one here\nnoise');
    assert.equal(f.length, 1);
    assert.equal(f[0].file, 'math.mjs');
    assert.equal(f[0].line, 10);
    assert.ok(f[0].description.includes('off-by-one'));
  });

  it('carries a repro field through when present', () => {
    const out = JSON.stringify({ findings: [{ file: 'a.mjs', line: 1, body: 'x', repro: { cmd: 'node', args: ['t.mjs'] } }] });
    const f = parseFindings(out);
    assert.ok(f[0].repro);
    assert.equal(f[0].repro.cmd, 'node');
  });
});

// Note: judge.mjs and scorer.mjs unit tests now live in their own dedicated
// files (test/judge.test.mjs, test/scorer.test.mjs) per the per-concern
// test-file pattern (issue #64). This file keeps CLI/E2E and other-module
// coverage.

// ── control reviewers + locatingFindings ──────────────────────────────────────

describe('controls + locatingFindings', () => {
  const plants = [{ file: 'src/a.mjs', line: 10, defect: 'Inverted boolean branch.', category: 'logic-inversion', mutated: 'return false' }];

  it('echoReviewer emits one located, content-free finding per plant', () => {
    const f = echoReviewer(plants);
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 10);
    assert.ok(locatingFindings(plants[0], f).length === 1);   // it LOCATES
    assert.equal(referenceJudge(plants[0], f[0]), false);     // but does not IDENTIFY
  });

  it('oracleReviewer emits findings that both locate and identify', () => {
    const f = oracleReviewer(plants);
    assert.equal(referenceJudge(plants[0], f[0]), true);
  });
});

// ── verify: witness / equivalent-mutant filter ────────────────────────────────

describe('filterEquivalentMutants', () => {
  it('passes through plants without a witness (witnessed:false), drops none', () => {
    const plants = [{ absolutePath: '/x', line: 1, original: 'a', mutated: 'b' }];
    const { valid, equivalent } = filterEquivalentMutants(plants, '/tmp', () => ({ status: 0 }));
    assert.equal(valid.length, 1);
    assert.equal(valid[0].witnessed, false);
    assert.equal(equivalent.length, 0);
  });

  it('verifyWitness confirms a discriminating witness (pass on original, fail on mutant)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-witness-'));
    try {
      const file = join(dir, 's.mjs');
      writeFileSync(file, 'const v = 1;\n');
      const plant = {
        absolutePath: file, line: 1, original: 'const v = 1;', mutated: 'const v = 2;',
        witness: { cmd: 'node', args: [] },
      };
      // injected runFn: read the file, exit 0 iff it still says "= 1"
      const runFn = () => {
        const cur = readFileSync(file, 'utf8');
        return { status: cur.includes('= 1') ? 0 : 1, timedOut: false };
      };
      const v = verifyWitness(plant, dir, runFn);
      assert.equal(v.discriminates, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an equivalent mutant (witness fails to discriminate) for exclusion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-equiv-'));
    try {
      const file = join(dir, 's.mjs');
      writeFileSync(file, 'const v = 1;\n');
      const plant = {
        absolutePath: file, line: 1, original: 'const v = 1;', mutated: 'const v = 2;',
        witness: { cmd: 'node', args: [] },
      };
      const runFn = () => ({ status: 0, timedOut: false }); // passes on both → no discrimination
      const { valid, equivalent } = filterEquivalentMutants([plant], dir, runFn);
      assert.equal(valid.length, 0);
      assert.equal(equivalent.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── targets: category + defect ────────────────────────────────────────────────

describe('operatorToCategory / describeDefect', () => {
  it('maps mechanical operators to real bug categories', () => {
    assert.equal(operatorToCategory('invert-comparison'), 'logic-inversion');
    assert.equal(operatorToCategory('off-by-one'), 'off-by-one');
    assert.equal(operatorToCategory('null-return'), 'null-handling');
  });

  it('describeDefect produces a non-empty defect description with the change', () => {
    const d = describeDefect('invert-comparison', 'if (x > 0)', 'if (x <= 0)');
    assert.ok(d.length > 0);
    assert.ok(d.includes('x <= 0'));
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

// ── tokenizeCommand / substituteToken ─────────────────────────────────────────

describe('tokenizeCommand / substituteToken', () => {
  it('splits on whitespace and honors quotes', () => {
    assert.deepEqual(tokenizeCommand('node s.mjs "a b" {base}'), ['node', 's.mjs', 'a b', '{base}']);
  });

  it('substitutes {base} as a literal token (never re-tokenized)', () => {
    assert.deepEqual(
      substituteToken(['cmd', '{base}'], '{base}', '$(touch X)'),
      ['cmd', '$(touch X)'],
    );
  });
});

// ── SECURITY: command injection via malicious base ref (regression) ───────────

describe('runWithPlants — command injection regression', () => {
  it('does NOT execute a shell payload embedded in the base ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-injection-'));
    try {
      const sentinel = join(dir, 'PWNED');
      // Malicious ref. If ever handed to /bin/sh, $(touch PWNED) runs.
      const maliciousRef = `$(touch ${sentinel})`;

      // Empty plants → no files mutated; the run only exercises command
      // construction + spawn. Deterministic, offline echo command.
      const result = runWithPlants(
        [],
        `node -e "process.stdout.write(process.argv[1])" {base}`,
        maliciousRef,
        dir,
        30000,
      );

      assert.equal(
        existsSync(sentinel), false,
        'INJECTION: shell executed $(touch PWNED) from the base ref',
      );
      // The untrusted ref arrived verbatim as a single literal argument.
      assert.equal(result.stdout, maliciousRef);
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT execute a "; touch" payload embedded in the base ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-injection-'));
    try {
      const sentinel = join(dir, 'PWNED');
      const maliciousRef = `HEAD; touch ${sentinel}`;
      const result = runWithPlants(
        [],
        `node -e "process.stdout.write(process.argv[1])" {base}`,
        maliciousRef,
        dir,
        30000,
      );
      assert.equal(existsSync(sentinel), false, 'INJECTION: "; touch" executed');
      assert.equal(result.stdout, maliciousRef);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── buildJsonReport ───────────────────────────────────────────────────────────

describe('buildJsonReport', () => {
  it('shapes the output correctly', () => {
    const scorecard = {
      recall: 0.75, caught: 3, total: 4,
      precision: 0.6, truePositives: 3, falsePositives: 2,
      minRecall: 0.5, scorer: 'judge', equivalentExcluded: 1,
      commit: 'abc123', reviewExitCode: 0,
      perCategory: {
        'logic-inversion': { caught: 2, total: 2, recall: 1 },
        'off-by-one': { caught: 1, total: 2, recall: 0.5 },
      },
      results: [
        { file: 'src/a.mjs', line: 5, category: 'logic-inversion', operator: 'bool-flip', caught: true, original: 'x', mutated: 'y' },
        { file: 'src/b.mjs', line: 10, category: 'off-by-one', operator: 'off-by-one', caught: false, original: 'x', mutated: 'z' },
      ],
    };
    const report = buildJsonReport(scorecard);
    assert.equal(report.recall, 0.75);
    assert.equal(report.precision, 0.6);
    assert.equal(report.falsePositives, 2);
    assert.equal(report.scorer, 'judge');
    assert.equal(report.equivalentExcluded, 1);
    assert.equal(report.gatePass, true);
    assert.deepEqual(Object.keys(report.perCategory), ['logic-inversion', 'off-by-one']);
    assert.equal(report.plants[0].status, 'caught');
    assert.equal(report.plants[0].category, 'logic-inversion');
    assert.equal(report.plants[1].status, 'missed');
  });

  it('gatePass is false when recall < minRecall', () => {
    const scorecard = {
      recall: 0.3, caught: 1, total: 3, precision: 1, truePositives: 1, falsePositives: 0,
      minRecall: 0.5, scorer: 'judge', commit: 'x', reviewExitCode: 0,
      perCategory: {}, results: [],
    };
    assert.equal(buildJsonReport(scorecard).gatePass, false);
  });

  it('gatePass is false when precision below minPrecision even if recall passes', () => {
    const scorecard = {
      recall: 1, caught: 3, total: 3, precision: 0.4, truePositives: 3, falsePositives: 4,
      minRecall: 0.5, minPrecision: 0.6, scorer: 'judge', commit: 'x', reviewExitCode: 0,
      perCategory: {}, results: [],
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
        '--plants', '2', '--min-plants', '1',
        '--min-recall', '0',
        '--scorer', 'string', // offline: default judge needs an LLM
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

// ── end-to-end: the echo reviewer is no longer trusted ────────────────────────
// A reviewer that echoes every changed line used to score recall 1.0 and PASS.
// Now: the default (judge) scorer fails CLOSED with no LLM rather than emit a
// string-matched number, and the gameable behavior survives ONLY behind the
// explicit, warned --scorer string legacy flag.

describe('E2E: echo reviewer is not trusted; default judge fails closed', () => {
  let dir;
  let scriptDir;
  let scriptPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-e2e-echo-'));
    createRepo(dir);
    scriptDir = mkdtempSync(join(tmpdir(), 'rc-script-'));
    scriptPath = join(scriptDir, 'fake-review.mjs');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env node',
      '// Echo reviewer: report every changed line as a finding, claiming nothing.',
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

  it('default scorer (judge) with NO LLM provider → exit 1, refuses to string-match', () => {
    const result = spawnSync('node', [BIN,
      '--review-cmd', `node ${scriptPath} {base}`,
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0', '--json',
    ], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000,
      env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ADLC_PROVIDER: '' },
    });
    assert.equal(result.status, 1, `expected fail-closed exit 1, got ${result.status}`);
    assert.ok(/no LLM provider/i.test(result.stderr), result.stderr);
  });

  it('--scorer string runs but PRINTS A WARNING that the number is untrustworthy', () => {
    const result = runCli([
      '--review-cmd', `node ${scriptPath} {base}`,
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0', '--scorer', 'string', '--json',
    ], dir);
    assert.notEqual(result.status, 1, `opError: ${result.stderr}`);
    assert.ok(/NOT trustworthy|gameab|echo/i.test(result.stderr), `expected legacy warning, got: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scorer, 'string');
    assert.ok(parsed.total > 0);
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
        '--plants', '3', '--min-plants', '1',
        '--min-recall', '0.5',
        '--scorer', 'string',
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
        '--plants', '3', '--min-plants', '1',
        '--min-recall', '0',
        '--scorer', 'string',
      ],
      dir
    );

    const after = readFileSync(srcPath, 'utf8');
    assert.equal(after, before, 'File was not restored after calibration run');
  });
});

// ── E2E: --review-provider / --strict guard (issue #64) ───────────────────────
// The judge is resolved via the same auto-detect provider path as everything
// else, while --review-cmd runs as an opaque subprocess. These tests force a
// detectable (but fake) judge provider via env vars and drive the CLI with a
// reviewer that reports nothing, so no locating findings exist and the judge
// function is never actually invoked (no network needed) — only the
// provider-name comparison, which happens before any findings are scored.

describe('E2E: --review-provider / --strict provider-independence guard', () => {
  let dir;
  const fakeProviderEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: 'dummy-key-for-detection-only',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ADLC_PROVIDER: 'anthropic',
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-provider-guard-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync('node', [BIN, ...args], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000, env: fakeProviderEnv,
    });
  }

  it('same-family judge + --review-provider → warns by default, still passes the gate', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--review-provider', 'anthropic', '--json',
    ]);
    assert.equal(result.status, 0, `expected pass, got ${result.status}: ${result.stderr}`);
    assert.ok(/same model family|independence/i.test(result.stderr), result.stderr);
  });

  it('same-family judge + --review-provider + --strict → gate-fails (exit 2)', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--review-provider', 'anthropic', '--strict', '--json',
    ]);
    assert.equal(result.status, 2, `expected gate-fail exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(/same model family|independence/i.test(result.stderr), result.stderr);
  });

  it('a claude alias for --review-provider is still recognized as the same family under --strict', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--review-provider', 'claude', '--strict', '--json',
    ]);
    assert.equal(result.status, 2, `expected gate-fail exit 2, got ${result.status}: ${result.stderr}`);
  });

  it('different --review-provider from the judge → no warning, gate governed only by recall', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--review-provider', 'openai', '--json',
    ]);
    assert.equal(result.status, 0, `expected pass, got ${result.status}: ${result.stderr}`);
    assert.ok(!/same model family|independence/i.test(result.stderr), result.stderr);
  });

  it('--strict without --review-provider is an operational error (exit 1)', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0', '--strict',
    ]);
    assert.equal(result.status, 1, `expected opError exit 1, got ${result.status}: ${result.stderr}`);
    assert.ok(/--strict requires --review-provider/.test(result.stderr), result.stderr);
  });

  it('no --review-provider at all → no comparison, no warning', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0', '--json',
    ]);
    assert.equal(result.status, 0);
    assert.ok(!/same model family|independence/i.test(result.stderr), result.stderr);
  });
});

// ── E2E: agy provider's tier-dependent model family (issue #64 follow-up) ─────
// detectProvider().name for 'agy' is the literal string 'agy', but agy proxies
// to a tier-dependent underlying model (Gemini on --tier cheap, Claude on
// --tier mid/frontier — see packages/core/lib/llm.mjs PROVIDERS[3].models).
// These tests force ADLC_PROVIDER=agy (no real agy binary needed — the fake
// reviewer reports nothing, so the judge function itself is never invoked)
// and verify the guard compares against the RESOLVED family, not 'agy'.

describe('E2E: agy provider resolves to its tier-dependent model family', () => {
  let dir;
  const agyEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '',
    ADLC_PROVIDER: 'agy',
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-agy-guard-'));
    createRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync('node', [BIN, ...args], {
      cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000, env: agyEnv,
    });
  }

  it('agy + --tier mid + --review-provider anthropic --strict → gate-fails (both are Claude)', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--tier', 'mid', '--review-provider', 'anthropic', '--strict', '--json',
    ]);
    assert.equal(result.status, 2, `expected gate-fail exit 2, got ${result.status}: ${result.stderr}`);
    assert.ok(/same model family|independence/i.test(result.stderr), result.stderr);
  });

  it('agy + --tier cheap + --review-provider gemini --strict → gate-fails (both are Gemini)', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--tier', 'cheap', '--review-provider', 'gemini', '--strict', '--json',
    ]);
    assert.equal(result.status, 2, `expected gate-fail exit 2, got ${result.status}: ${result.stderr}`);
  });

  it('agy + --tier cheap + --review-provider anthropic → no warning (genuinely different families)', () => {
    const result = run([
      '--review-cmd', 'node -e "process.stdout.write(\'LGTM\\n\')"',
      '--commit', 'HEAD', '--plants', '3', '--min-plants', '1', '--min-recall', '0',
      '--tier', 'cheap', '--review-provider', 'anthropic', '--json',
    ]);
    assert.equal(result.status, 0, `expected pass, got ${result.status}: ${result.stderr}`);
    assert.ok(!/same model family|independence/i.test(result.stderr), result.stderr);
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
