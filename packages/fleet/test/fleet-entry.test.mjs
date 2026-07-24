// The fleet bin dispatches its CLI ONLY when run as the entry point, so importing it (e.g.
// run-live.test.mjs importing runLive) does not parse argv or exit.
//
// This file deliberately does NOT import ../bin/fleet.mjs: under an inverted guard the import
// itself would dispatch (and process.exit), which would let this test's worker exit cleanly
// before ever asserting. Driving the bin as a SUBPROCESS is the only way to observe the guard
// from the direct-execution side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet.mjs');

test('running fleet.mjs directly DISPATCHES the CLI (--help prints usage)', () => {
  // Original guard (import.meta.url === argv[1]): fleet IS the entry → runCli → usage printed.
  // Inverted guard: fleet is the entry → guard false → runCli NOT called → no usage. So this
  // pins the entry-point dispatch that an import-based test cannot.
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fleet — parallel ADLC ticket orchestration/, 'the entry-point guard dispatches when run directly');
});
