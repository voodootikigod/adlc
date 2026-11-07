// Rail: the forecast is unchanged (spec: .adlc/specs/merge-forecast-scope-index.md,
// acceptance criterion 5).
//
// The golden was recorded with merge-forecast as it was BEFORE the scope index,
// on a fixture that fires every signal. A speed-up that changes any score,
// verdict, wave, width, warning or gate failure fails here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runForecast } from '../lib/forecast.mjs';
import { buildFixtureRepo, FIXTURE_TICKETS, FIXTURE_GRAPH } from './helpers/forecast-fixture.mjs';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/forecast-unchanged.golden.json', import.meta.url), 'utf8'),
);
// The CLI's own golden: its bytes are what consumers read, and they differ from
// a direct runForecast call because loadTickets orders the tickets first.
const CLI_GOLDEN = readFileSync(
  new URL('./fixtures/forecast-unchanged.cli.golden.json', import.meta.url),
  'utf8',
);
const CLI = fileURLToPath(new URL('../bin/merge-forecast.mjs', import.meta.url));
// No inherited GIT_* variable may point the CLI's git calls at another
// repository, and no ambient graph-coupling file may add a signal.
const CLI_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  ADLC_GRAPH_COUPLING_FILE: '',
};

// Awaits fn before cleaning up, so an async callback never runs against a
// fixture that has already been deleted.
async function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-unchanged-'));
  try {
    const root = join(dir, 'repo');
    mkdirSync(root);
    buildFixtureRepo(root);
    return await fn({ dir, root });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('merge-forecast output is unchanged by the scope index', () => {
  test('the golden covers every signal, so equality means something', () => {
    const signals = new Set(GOLDEN.flatMap((run) => run.result.pairs.map((p) => p.signal)));
    for (const signal of [
      'scope-overlap',
      'namespace-collision',
      'import-radius',
      'co-change',
      'graph-coupling',
      'unscoped',
      'none',
    ]) {
      assert.ok(signals.has(signal), `golden has no ${signal} pair`);
    }
    assert.equal(GOLDEN.length, 4);
  });

  for (const golden of GOLDEN) {
    test(`runForecast equals the golden (graph: ${golden.graph}, threshold: ${golden.threshold})`, async () => {
      await withFixture(async ({ root }) => {
        const result = await runForecast({
          tickets: structuredClone(FIXTURE_TICKETS),
          root,
          graphCouplingData: golden.graph ? FIXTURE_GRAPH : undefined,
          conflictThreshold: golden.threshold,
        });
        assert.deepEqual(result, golden.result);
      });
    });
  }

  test('merge-forecast --json prints the golden byte for byte, and exits 2 on its gate failure', async () => {
    await withFixture(({ dir, root }) => {
      // Inputs live OUTSIDE the walked tree, so they add no file to it.
      const ticketsFile = join(dir, 'tickets.json');
      const graphFile = join(dir, 'graph.json');
      writeFileSync(ticketsFile, JSON.stringify({ tickets: FIXTURE_TICKETS }));
      writeFileSync(graphFile, JSON.stringify(FIXTURE_GRAPH));
      // stdout goes to a FILE, not a pipe. On macOS a piped stdout is written
      // asynchronously, and the CLI calls process.exit(2) right after printing,
      // so Node 18 drops everything past the first ~8 KB. That is a bug in the
      // CLI, older than this test; a file write is synchronous everywhere.
      const outFile = join(dir, 'stdout.json');
      const fd = openSync(outFile, 'w');
      let res;
      try {
        res = spawnSync(
          process.execPath,
          [CLI, '--json', '--tickets', ticketsFile, '--graph-coupling', graphFile],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', fd, 'pipe'], env: CLI_ENV },
        );
      } finally {
        closeSync(fd);
      }
      assert.equal(res.stderr, '');
      assert.equal(readFileSync(outFile, 'utf8'), CLI_GOLDEN);
      assert.equal(res.status, 2);
    });
  });

  test('the CLI golden is the same forecast as the library golden, reordered', () => {
    // Guards the CLI golden itself: it must hold the same pairs and answers,
    // so it cannot have been recorded from some unrelated run.
    const cli = JSON.parse(CLI_GOLDEN);
    const lib = GOLDEN.find((run) => run.graph && run.threshold === 0.5).result;
    const byPair = (pairs) =>
      Object.fromEntries(pairs.map((p) => [[p.a, p.b].sort().join('|'), [p.score, p.signal, p.verdict]]));
    assert.deepEqual(byPair(cli.pairs), byPair(lib.pairs));
    assert.equal(cli.pairs.length, lib.pairs.length);
    assert.deepEqual(cli.gateFailures.length, lib.gateFailures.length);
    assert.deepEqual(cli.warnings, lib.warnings);
  });
});
