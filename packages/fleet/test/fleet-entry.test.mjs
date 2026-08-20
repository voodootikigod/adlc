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

// ── the argv slice is a real boundary (#530 mutation gate) ───────────────────
// `const raw = process.argv.slice(2)` became diff-derived when parseFlags was
// hoisted out of runCli, and the gate immediately found that `slice(3)` survives:
// nothing noticed the SUBCOMMAND being dropped. With slice(3) the first flag is
// read as the subcommand, so `fleet status --json` reports "unknown subcommand:
// --json" instead of running status. Asserted through the real bin, because the
// slice only exists on the entry path.

test('the CLI reads the SUBCOMMAND from argv, not the first flag', () => {
  const res = spawnSync(process.execPath, [BIN, 'status', '--json'], { encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.doesNotMatch(out, /unknown subcommand/i,
    `"status" must be recognised as the subcommand: ${out.slice(0, 300)}`);
});

test('an actually-unknown subcommand IS reported, so the check above can fail', () => {
  // Without this pair the assertion above would pass against a bin that never
  // says "unknown subcommand" at all.
  const res = spawnSync(process.execPath, [BIN, 'not-a-subcommand'], { encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.match(out, /unknown subcommand: not-a-subcommand/i);
});
