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
  // parseInt/parseFloat accepted a numeric PREFIX ('1e2' → 1, '2.9' → 2,
  // '0.95junk' → 0.95) and the range checks then validated the truncated value.
  for (const [flag, val, re] of [
    ['--width', '2.9', /--width must be an integer/],
    ['--width', '1e2junk', /--width must be a number/],
    ['--co-change-limit', '2.5', /--co-change-limit must be an integer/],
    ['--co-change-limit', '1e20', /--co-change-limit must be an integer/],
    ['--width', '9007199254740993', /--width must be an integer/],
    ['--conflict-threshold', '0.95junk', /--conflict-threshold must be a number/],
    ['--conflict-threshold', 'Infinity', /--conflict-threshold must be a number/],
    ['--build-min', '', /--build-min must be a number/],
    ['--merge-min', ' ', /--merge-min must be a number/],
  ]) {
    test(`rejects malformed numeric flag ${flag} ${JSON.stringify(val)} with exit 1`, () => {
      withTickets((ticketsFile) => {
        const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, flag, val], {
          encoding: 'utf8', cwd: repoRoot,
        });
        assert.equal(res.status, 1, res.stdout + res.stderr);
        assert.match(res.stderr, re);
      });
    });
  }

  // Boundary: the smallest legal fan-out. A gate can still FAIL on width
  // (exit 2, > certifiedWidth) but it must never be rejected as malformed.
  for (const [flag, val, rejectRe] of [
    ['--width', '1', /--width must be >= 1/],
    ['--co-change-limit', '1', /--co-change-limit must be >= 1/],
    ['--conflict-threshold', '0', /--conflict-threshold must be between 0 and 1/],
    ['--conflict-threshold', '1', /--conflict-threshold must be between 0 and 1/],
  ]) {
    test(`accepts the boundary value ${flag} ${val} (not an operational error)`, () => {
      withTickets((ticketsFile) => {
        const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, flag, val, '--json'], {
          encoding: 'utf8', cwd: repoRoot,
        });
        assert.notEqual(res.status, 1, res.stdout + res.stderr);
        assert.doesNotMatch(res.stderr, rejectRe);
      });
    });
  }

  test('accepts an integer written in scientific notation (--co-change-limit 1e2)', () => {
    withTickets((ticketsFile) => {
      const res = spawnSync(process.execPath, [CLI, '--tickets', ticketsFile, '--co-change-limit', '1e2', '--json'], {
        encoding: 'utf8', cwd: repoRoot,
      });
      assert.equal(res.status, 0, res.stdout + res.stderr);
    });
  });

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
