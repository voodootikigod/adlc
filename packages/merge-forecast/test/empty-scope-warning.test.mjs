import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runForecast } from '../lib/forecast.mjs';

const CLI = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));

function gitInit(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

describe('empty or zero-match scope warnings and SEQUENCE treatment (#680)', () => {
  test('AC1: ticket with no scope emits warning "ticket <id> has no scope defined"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-ac1-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/index.js'), '// file');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

      // Test undefined scope, non-array scope, and empty array scope
      const tickets = [
        { id: 'T-NOSCOPE', title: 'No scope' },
        { id: 'T-EMPTY', title: 'Empty array', scope: [] },
        { id: 'T-NULL', title: 'Null scope', scope: null },
        { id: 'T-STR', title: 'String scope', scope: 'src/index.js' },
        { id: 'T-OBJ', title: 'Object scope', scope: {} },
      ];

      const result = await runForecast({ tickets, root: dir });

      assert.ok(
        result.warnings.includes('ticket "T-NOSCOPE" has no scope defined'),
        `expected warning for T-NOSCOPE, got: ${JSON.stringify(result.warnings)}`
      );
      assert.ok(
        result.warnings.includes('ticket "T-EMPTY" has no scope defined'),
        `expected warning for T-EMPTY, got: ${JSON.stringify(result.warnings)}`
      );
      assert.ok(
        result.warnings.includes('ticket "T-NULL" has no scope defined'),
        `expected warning for T-NULL, got: ${JSON.stringify(result.warnings)}`
      );
      assert.ok(
        result.warnings.includes('ticket "T-STR" has no scope defined'),
        `expected warning for T-STR, got: ${JSON.stringify(result.warnings)}`
      );
      assert.ok(
        result.warnings.includes('ticket "T-OBJ" has no scope defined'),
        `expected warning for T-OBJ, got: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC2: ticket with scope matching zero repo files emits warning "ticket <id> scope matches 0 files in repo"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-ac2-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/index.js'), '// file');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

      const tickets = [
        { id: 'T-NOMATCH', title: 'No match', scope: ['nonexistent/**'] },
        { id: 'T-MATCH', title: 'Matches file', scope: ['src/**'] },
      ];

      const result = await runForecast({ tickets, root: dir });

      assert.ok(
        result.warnings.includes('ticket "T-NOMATCH" scope matches 0 files in repo'),
        `expected warning for T-NOMATCH, got: ${JSON.stringify(result.warnings)}`
      );
      assert.ok(
        !result.warnings.some((w) => w.includes('T-MATCH')),
        `unexpected warning for T-MATCH: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Windows path separators: scope matching recognizes backslash paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-win-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src\\sub'), { recursive: true });
      writeFileSync(join(dir, 'src\\sub', 'index.js'), '// file');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

      const tickets = [
        { id: 'T-WIN', title: 'Windows path', scope: ['src/**'] },
      ];

      const result = await runForecast({ tickets, root: dir });
      assert.ok(
        !result.warnings.some((w) => w.includes('T-WIN')),
        `unexpected warning for T-WIN: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('relative root: scope matching normalizes root path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-rel-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src/pkg'), { recursive: true });
      writeFileSync(join(dir, 'src/pkg', 'index.js'), '// file');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

      const tickets = [
        { id: 'T-REL', title: 'Relative root', scope: ['src/pkg/**'] },
      ];

      // Pass relative path to dir
      const relRoot = relative(process.cwd(), dir);
      const result = await runForecast({ tickets, root: relRoot });
      assert.ok(
        !result.warnings.some((w) => w.includes('T-REL')),
        `unexpected warning for T-REL with relative root: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC3: pairs involving unscoped or zero-match tickets are treated as SEQUENCE and excluded from parallel wave width', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-ac3-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src/auth'), { recursive: true });
      writeFileSync(join(dir, 'src/auth/index.js'), '// auth');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init auth'], { cwd: dir, stdio: 'ignore' });

      mkdirSync(join(dir, 'src/billing'), { recursive: true });
      writeFileSync(join(dir, 'src/billing/index.js'), '// billing');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init billing'], { cwd: dir, stdio: 'ignore' });

      // T1 (unscoped), T2 (zero-match), T3 (src/auth/**), T4 (src/billing/**)
      // All independent (wave 1).
      // T3 and T4 are disjoint and match files, so T3-T4 is PARALLEL.
      // Any pair involving T1 or T2 must be SEQUENCE, score 1.0, signal 'unscoped'.
      const tickets = [
        { id: 'T1', title: 'unscoped' },
        { id: 'T2', title: 'zero match', scope: ['missing/**'] },
        { id: 'T3', title: 'auth', scope: ['src/auth/**'] },
        { id: 'T4', title: 'billing', scope: ['src/billing/**'] },
      ];

      const result = await runForecast({ tickets, root: dir });

      // Verify pair verdicts and scores
      const p12 = result.pairs.find((p) => p.pair === 'T1–T2');
      const p13 = result.pairs.find((p) => p.pair === 'T1–T3');
      const p24 = result.pairs.find((p) => p.pair === 'T2–T4');
      const p34 = result.pairs.find((p) => p.pair === 'T3–T4');

      assert.ok(p12, 'pair T1-T2 should exist');
      assert.equal(p12.verdict, 'SEQUENCE');
      assert.equal(p12.score, 1.0);
      assert.equal(p12.signal, 'unscoped');
      assert.equal(p12.hardVeto, false);

      assert.ok(p13, 'pair T1-T3 should exist');
      assert.equal(p13.verdict, 'SEQUENCE');
      assert.equal(p13.score, 1.0);
      assert.equal(p13.signal, 'unscoped');
      assert.equal(p13.hardVeto, false);

      assert.ok(p24, 'pair T2-T4 should exist');
      assert.equal(p24.verdict, 'SEQUENCE');
      assert.equal(p24.score, 1.0);
      assert.equal(p24.signal, 'unscoped');
      assert.equal(p24.hardVeto, false);

      assert.ok(p34, 'pair T3-T4 should exist');
      assert.equal(p34.verdict, 'PARALLEL');
      assert.equal(p34.hardVeto, false);

      // T3 and T4 can run in parallel (width 2). T1 and T2 cannot run in parallel
      // with each other or with T3/T4, so the wave width must be 2 (the size of {T3, T4}).
      assert.equal(result.firstWaveWidth, 2);
      assert.equal(result.scheduleWidth, 2);
      assert.equal(result.gateFailures.length, 0, 'unscoped pairs in wave 1 do not fail gate without --width');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI surfaces warnings in --json output and text output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-empty-scope-cli-'));
    try {
      gitInit(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/app.js'), '// app');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

      const ticketsFile = join(dir, 'tickets.json');
      writeFileSync(ticketsFile, JSON.stringify({
        tickets: [
          { id: 'T1', title: 'Unscoped ticket' },
          { id: 'T2', title: 'Zero match ticket', scope: ['ghost/**'] },
        ],
      }));

      // JSON mode
      const resJson = spawnSync(
        process.execPath,
        [CLI, '--tickets', ticketsFile, '--json'],
        { encoding: 'utf8', cwd: dir }
      );
      assert.equal(resJson.status, 0, resJson.stderr);
      const parsed = JSON.parse(resJson.stdout);
      assert.ok(parsed.warnings.includes('ticket "T1" has no scope defined'));
      assert.ok(parsed.warnings.includes('ticket "T2" scope matches 0 files in repo'));
      assert.equal(parsed.firstWaveWidth, 1);

      // Over-width request on unscoped tickets fails with exit 2
      const resWidthFail = spawnSync(
        process.execPath,
        [CLI, '--tickets', ticketsFile, '--width', '2', '--json'],
        { encoding: 'utf8', cwd: dir }
      );
      assert.equal(resWidthFail.status, 2);
      const parsedWidthFail = JSON.parse(resWidthFail.stdout);
      assert.ok(parsedWidthFail.gateFailures.some((f) => f.includes('--width 2 exceeds firstWaveWidth 1')));

      // Width 1 request succeeds
      const resWidthPass = spawnSync(
        process.execPath,
        [CLI, '--tickets', ticketsFile, '--width', '1', '--json'],
        { encoding: 'utf8', cwd: dir }
      );
      assert.equal(resWidthPass.status, 0);

      // Text mode
      const resText = spawnSync(
        process.execPath,
        [CLI, '--tickets', ticketsFile],
        { encoding: 'utf8', cwd: dir }
      );
      assert.equal(resText.status, 0, resText.stderr);
      assert.match(resText.stdout, /ticket "T1" has no scope defined/);
      assert.match(resText.stdout, /ticket "T2" scope matches 0 files in repo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
