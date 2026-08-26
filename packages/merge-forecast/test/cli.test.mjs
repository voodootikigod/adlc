import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function withTickets(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-cli-test-'));
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

describe('merge-forecast CLI parameter validation', () => {
  test('rejects conflict-threshold > 1', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--conflict-threshold', '99'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--conflict-threshold must be between 0 and 1/);
    });
  });

  test('rejects conflict-threshold < 0', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--conflict-threshold=-0.5'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--conflict-threshold must be between 0 and 1/);
    });
  });

  test('rejects width < 1', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--width', '0'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--width must be >= 1/);
    });
  });

  test('rejects build-min <= 0', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--build-min', '0'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--build-min must be > 0/);
    });
  });

  test('rejects merge-min <= 0', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--merge-min=-1'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--merge-min must be > 0/);
    });
  });

  test('rejects co-change-limit < 1', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--co-change-limit', '0'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /--co-change-limit must be >= 1/);
    });
  });

  test('accepts valid parameters and exits 0', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [
        CLI,
        '--tickets', ticketsFile,
        '--conflict-threshold', '0.8',
        '--width', '2',
        '--build-min', '10',
        '--merge-min', '2',
        '--co-change-limit', '100',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `Failed with stderr: ${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.certifiedWidth, 2);
    });
  });
});
