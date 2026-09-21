import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runForecast } from '../lib/forecast.mjs';

const CLI = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function writeFile(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(join(root, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function gitInit(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, files, message) {
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(dir, relPath, content);
    execFileSync('git', ['add', relPath], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'ignore' });
}

function withTickets(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-floor-test-'));
  const ticketsFile = join(dir, 'tickets.json');
  writeFileSync(ticketsFile, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Ticket 1', scope: ['packages/a/**'] },
      { id: 'T2', title: 'Ticket 2', scope: ['packages/b/**'] },
    ],
  }));
  try {
    fn(ticketsFile, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('merge-forecast co-change floor and empty history handling (#682)', () => {
  test('AC1: rejects --co-change-limit 0 with exit 1 and opError message', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--co-change-limit', '0'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--co-change-limit must be >= 1/);
    });
  });

  test('AC2: rejects negative --co-change-limit via opError', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--co-change-limit=-1'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--co-change-limit must be >= 1/);

      const res2 = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--co-change-limit=-5'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res2.status, 1);
      assert.match(res2.stderr, /--co-change-limit must be >= 1/);
    });
  });

  test('AC3a: warns when git history yields zero commits or empty file history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-floor-test-'));
    try {
      gitInit(root);
      gitCommit(root, {}, 'empty commit with no files');
      const tickets = [
        { id: 'T1', title: 'Ticket 1', scope: ['src/a.js'] },
        { id: 'T2', title: 'Ticket 2', scope: ['src/b.js'] },
      ];
      const result = await runForecast({ tickets, root });
      assert.ok(
        result.warnings.some((w) => /co-change: zero commits or empty file history/i.test(w)),
        `expected descriptive warning in warnings, got: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('AC3b: warns when git history yields no co-change pairs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-floor-test-'));
    try {
      gitInit(root);
      // Commits touching separate files individually: fileCounts > 0, pairCounts == 0
      gitCommit(root, { 'src/a.js': '// a' }, 'single file a');
      gitCommit(root, { 'src/b.js': '// b' }, 'single file b');
      const tickets = [
        { id: 'T1', title: 'Ticket 1', scope: ['src/a.js'] },
        { id: 'T2', title: 'Ticket 2', scope: ['src/b.js'] },
      ];
      const result = await runForecast({ tickets, root });
      assert.ok(
        result.warnings.some((w) => /co-change: empty co-change pairs in history/i.test(w)),
        `expected warning about empty co-change pairs, got: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('AC3c: does NOT warn about empty co-change history when co-change pairs exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-floor-test-'));
    try {
      gitInit(root);
      // Commit touching both files: pairCounts > 0
      gitCommit(root, { 'src/a.js': '// a', 'src/b.js': '// b' }, 'co-change commit');
      const tickets = [
        { id: 'T1', title: 'Ticket 1', scope: ['src/a.js'] },
        { id: 'T2', title: 'Ticket 2', scope: ['src/b.js'] },
      ];
      const result = await runForecast({ tickets, root });
      assert.ok(
        !result.warnings.some((w) => /co-change: (?:zero commits|empty)/i.test(w)),
        `unexpected empty co-change warning when pairs exist: ${JSON.stringify(result.warnings)}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('AC3d: CLI JSON output includes warning when history yields zero commits or empty pairs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-floor-test-'));
    try {
      gitInit(dir);
      gitCommit(dir, {}, 'empty commit');
      const ticketsFile = join(dir, 'tickets.json');
      writeFileSync(ticketsFile, JSON.stringify({
        tickets: [
          { id: 'T1', title: 'Ticket 1', scope: ['src/a.js'] },
          { id: 'T2', title: 'Ticket 2', scope: ['src/b.js'] },
        ],
      }));
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const parsed = JSON.parse(res.stdout);
      assert.ok(
        parsed.warnings.some((w) => /co-change.*(?:zero commits|empty)/i.test(w)),
        `expected warning in CLI JSON output, got: ${JSON.stringify(parsed.warnings)}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
