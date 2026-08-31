// The adlc-opencode CLI dispatches ONLY when run as the entry point, so importing
// it (e.g. a future test importing cliMain) must not parse argv or exit.
//
// This file deliberately does NOT import ../bin/cli.mjs directly for the direct/
// symlinked dispatch checks: under an inverted guard the import itself would
// dispatch (and process.exit), which would let the test's own process exit before
// ever asserting. Driving the bin as a SUBPROCESS is the only way to observe the
// guard from the direct-execution side. All direct/symlinked invocations below use
// `--help`, which is side-effect-free (prints USAGE, returns 0) — `init` (the
// default command) writes files and must never run unattended in a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs');

test('running cli.mjs directly DISPATCHES the CLI (--help prints usage)', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: adlc-opencode init \[projectRoot\]/,
    'the entry-point guard dispatches when run directly');
});

// ── #899 (same class as #786): the entry guard must resolve a SYMLINKED argv[1] ──
// npm's .bin entries are symlinks, so argv[1] is the link path while
// import.meta.url is the real file. A guard comparing them textually returns
// false there and the bin exits 0 having done nothing — a silent false green.

test('running cli.mjs through a SYMLINK (like npm .bin) still dispatches the CLI (#899)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cli-symlink-'));
  const link = join(dir, 'adlc-opencode');
  symlinkSync(BIN, link);
  try {
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: adlc-opencode init \[projectRoot\]/,
      'a symlinked entry must dispatch, not exit 0 silently');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other side of the same guard: under `node -e` process.argv is [node]
// alone, so argv[1] is undefined. That must read as "not the entry point" — a
// guard that answered true there would run the CLI (and, with the default
// "init" command, attempt a real scaffold write) from a bare import.
test('importing cli.mjs from a process with NO argv[1] (node -e) does NOT dispatch', () => {
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(BIN).href)})`],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a bare import must not print usage or run init');
});

// `node -e <script> bogus` puts "bogus" at argv[1]; realpathSync on it throws.
// That must read as not-the-entry — neither dispatch nor a crash.
test('a NONEXISTENT argv[1] resolves to "not the entry" instead of dispatching or throwing', () => {
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(BIN).href)})`, 'definitely-not-a-file'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a bare import with an unresolvable argv[1] must not print usage or run init');
});

// Regression: a DIRECT (non-symlinked) invocation with no positional command
// argument still dispatches (defaults to "init") rather than being silently
// skipped by the guard — pinned via --help alongside it so the assertion is
// about the GUARD firing, not about init's own side effects.
test('running cli.mjs directly with an unknown command still dispatches (guard fires, cliMain reports the error)', () => {
  const r = spawnSync(process.execPath, [BIN, 'not-a-command'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /unknown command "not-a-command"/);
});

// The guard keys on argv[1] (the script path) — not argv[2] (the first CLI
// argument). With NO CLI argument at all (bare `node cli.mjs`), argv[2] is
// undefined; a guard reading the wrong slot would decline to dispatch and the
// bin would exit 0 having silently done nothing (this exact off-by-one is
// what the mutation gate found: every OTHER test here also supplies a second
// argv entry — --help or a command — so argv[1] and argv[2] were both truthy
// in every case and could not distinguish the two). The default command with
// no argument is "init", which writes to projectRoot — run it against a
// throwaway tmpdir so the assertion never touches the real checkout.
test('running cli.mjs directly with NO CLI argument still dispatches (argv[1], not argv[2], is the entry check)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cli-bare-'));
  try {
    const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /adlc-opencode init:/,
      'a bare invocation (argv[2] undefined) must still dispatch — the guard reads argv[1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
