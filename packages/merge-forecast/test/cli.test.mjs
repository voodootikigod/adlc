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
      { id: 'T1', title: 'Ticket 1', scope: ['packages/autopilot/**'] },
      { id: 'T2', title: 'Ticket 2', scope: ['packages/backlog-groom/**'] },
    ],
  }));
  try {
    fn(ticketsFile, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('merge-forecast CLI --help', () => {
  test('lists --graph-coupling with its description', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8', cwd: repoRoot,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(
      res.stdout.includes('--graph-coupling <path>    Path to semantic call/symbol graph coupling JSON'),
      `expected help text to include the --graph-coupling entry, got:\n${res.stdout}`
    );
  });
});

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

// ─── #997: the help text's claims about the width gate must be TRUE ──────────
//
// Renaming certifiedWidth → firstWaveWidth touched three help lines that assert
// things about the binary's behaviour: which exit code the width gate uses,
// that the comparison is strict, and that it measures wave 1 rather than the
// whole schedule. Those claims are PARSED out of --help and checked against
// what the binary actually does, following
// packages/spec-lint/test/readme-exit-codes.test.mjs — so a prose rewording is
// free, but a claim that stops being true is not.
describe('merge-forecast CLI --help documents the width gate truthfully (#997)', () => {
  function help() {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8', cwd: repoRoot,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    return res.stdout;
  }

  // Foundation-first DAG: wave 1 is T0 alone, wave 2 is T1 + T2 (disjoint
  // scopes, no conflict). So firstWaveWidth is 1 and scheduleWidth is 2 — the
  // gap that makes "wave 1 only" a checkable claim rather than a slogan.
  function withDag(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'mf-cli-997-'));
    const ticketsFile = join(dir, 'tickets.json');
    writeFileSync(ticketsFile, JSON.stringify({
      tickets: [
        { id: 'T0', title: 'foundation', scope: ['packages/core/**'], edges: [{ to: 'T1' }, { to: 'T2' }] },
        { id: 'T1', title: 'one', scope: ['packages/autopilot/**'] },
        { id: 'T2', title: 'two', scope: ['packages/backlog-groom/**'] },
      ],
    }));
    try {
      fn(ticketsFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function runWidth(ticketsFile, width) {
    return spawnSync(
      process.execPath,
      [CLI, '--tickets', ticketsFile, '--width', String(width), '--json'],
      { encoding: 'utf8', cwd: repoRoot }
    );
  }

  test('the --width entry is listed with its placeholder and its gate claim', () => {
    // Same contract as the --graph-coupling entry above: the options table is
    // user-facing, so a dropped or garbled entry is a real regression.
    assert.match(
      help(),
      /^\s*--width <N>\s+Desired fan-out width; exit \d+ if > firstWaveWidth$/m
    );
  });

  test('the exit code the help documents is the exit code the binary produces', () => {
    const m = help().match(/--width <N>\s+Desired fan-out width; exit (\d+) if > firstWaveWidth/);
    assert.ok(m, 'help does not document an exit code for the width gate');
    const documented = Number(m[1]);

    withDag((ticketsFile) => {
      const res = runWidth(ticketsFile, 2);
      assert.equal(
        res.status, documented,
        `help promises exit ${documented}; binary exited ${res.status}`
      );
    });
  });

  test('the comparison the exit-code table documents predicts the boundary', () => {
    const m = help().match(/Gate fails \(--width (\S+) firstWaveWidth,/);
    assert.ok(m, 'the exit-code table does not state the width comparison');
    const op = m[1];

    // Evaluate the DOCUMENTED rule at width === firstWaveWidth (which is 1 for
    // this DAG) and hold the binary to it, rather than asserting the operator
    // spelling. A strict '>' predicts the gate passes there; anything
    // inclusive predicts it fails.
    const predictsFailure = { '>': false, '>=': true, '<': true, '<=': true }[op];
    assert.notEqual(predictsFailure, undefined, `unrecognized comparison in help: ${op}`);

    withDag((ticketsFile) => {
      const res = runWidth(ticketsFile, 1);
      assert.equal(
        res.status === 2, predictsFailure,
        `help documents "--width ${op} firstWaveWidth" but at width === firstWaveWidth the binary exited ${res.status}`
      );
    });
  });

  test('the help claims the gate measures wave 1 only, and the binary agrees', () => {
    const m = help().match(/\(wave (\d+) only, not the whole schedule\)/);
    assert.ok(m, 'help does not state which wave the gate measures');
    const documentedWave = Number(m[1]);

    withDag((ticketsFile) => {
      const res = runWidth(ticketsFile, 2);
      const parsed = JSON.parse(res.stdout);

      // The gate must reject a width the SCHEDULE could support but wave 1
      // cannot — otherwise "not the whole schedule" is false.
      assert.equal(parsed.scheduleWidth, 2);
      assert.equal(parsed.firstWaveWidth, 1);
      assert.equal(res.status, 2);

      // And the wave the help names must be the one whose width bounds it.
      assert.equal(
        parsed.waves[documentedWave - 1].length, parsed.firstWaveWidth,
        `help says wave ${documentedWave}, but the gate is bounded by wave 1`
      );
    });
  });
});
