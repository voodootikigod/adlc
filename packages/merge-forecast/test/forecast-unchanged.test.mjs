// Rail: the forecast is unchanged (spec: .adlc/specs/merge-forecast-scope-index.md,
// acceptance criterion 5).
//
// The golden was recorded with merge-forecast as it was BEFORE the scope index,
// on a fixture that fires every signal. A speed-up that changes any score,
// verdict, wave, width, warning or gate failure fails here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-unchanged-'));
  try {
    const root = join(dir, 'repo');
    mkdirSync(root);
    buildFixtureRepo(root);
    return fn({ dir, root });
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

  test('merge-forecast --json prints the golden byte for byte, and exits 2 on its gate failure', () => {
    withFixture(({ dir, root }) => {
      // Inputs live OUTSIDE the walked tree, so they add no file to it.
      const ticketsFile = join(dir, 'tickets.json');
      const graphFile = join(dir, 'graph.json');
      writeFileSync(ticketsFile, JSON.stringify({ tickets: FIXTURE_TICKETS }));
      writeFileSync(graphFile, JSON.stringify(FIXTURE_GRAPH));
      const res = spawnSync(
        process.execPath,
        [CLI, '--json', '--tickets', ticketsFile, '--graph-coupling', graphFile],
        { cwd: root, encoding: 'utf8', env: { ...process.env, ADLC_GRAPH_COUPLING_FILE: '' } },
      );
      assert.equal(res.stderr, '');
      assert.equal(res.stdout, CLI_GOLDEN);
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
