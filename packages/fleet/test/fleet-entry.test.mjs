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
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet.mjs');

test('running fleet.mjs directly DISPATCHES the CLI (--help prints usage)', () => {
  // Original guard (import.meta.url === argv[1]): fleet IS the entry → runCli → usage printed.
  // Inverted guard: fleet is the entry → guard false → runCli NOT called → no usage. So this
  // pins the entry-point dispatch that an import-based test cannot.
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fleet — parallel ADLC ticket orchestration/, 'the entry-point guard dispatches when run directly');
  // The documented exit-code contract is part of the CLI's interface (CONVENTIONS rule 4):
  // 0 = ok, 1 = operational error, 2 = a ticket failed/blocked/paused.
  assert.match(r.stdout, /Exit codes: 0 ok · 1 operational error · 2 a ticket failed\/blocked\/paused \(see --json "reason"\)\./);
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

// ── #786: the entry guard must resolve a SYMLINKED argv[1] ───────────────────
// npm's .bin entries are symlinks, so argv[1] is the link path while
// import.meta.url is the real file. A guard comparing them textually returns
// false there and the bin exits 0 having done nothing — a silent false green.

test('running fleet.mjs through a SYMLINK (like npm .bin) still dispatches the CLI (#786)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-symlink-'));
  const link = join(dir, 'adlc-fleet');
  symlinkSync(BIN, link);
  try {
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fleet — parallel ADLC ticket orchestration/,
      'a symlinked entry must dispatch, not exit 0 silently');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The guard keys on argv[1] (the script) — not argv[2] (the first user arg).
// With no arguments at all, argv[2] is undefined; a guard reading the wrong
// slot would decline to dispatch and the bin would exit 0 printing nothing.
test('running fleet.mjs with NO arguments still dispatches (prints usage)', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fleet — parallel ADLC ticket orchestration/);
});

// The other side of the same guard: under `node -e` process.argv is [node]
// alone, so argv[1] is undefined. That must read as "not the entry point" — a
// guard that answered true there would run the CLI from a bare import (usage
// on stdout is the observable).
test('importing fleet.mjs from a process with NO argv[1] (node -e) does NOT dispatch', () => {
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(BIN).href)})`],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a bare import must not print usage');
});

// `node -e <script> bogus` puts "bogus" at argv[1]; realpathSync on it throws.
// That must read as not-the-entry — neither dispatch nor a crash.
test('a NONEXISTENT argv[1] resolves to "not the entry" instead of dispatching or throwing', () => {
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(BIN).href)})`, 'definitely-not-a-file'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'a bare import must not print usage');
});

import { loadExtensionFiles as loadExt, MAX_EXTENSION_FILE_BYTES, readBoundedFile } from '../bin/fleet.mjs';
test('caller-supplied files must be REGULAR and bounded: a FIFO and an oversize file are refused before anything else runs (codex r7)', () => {
  // The checks live in the single-descriptor reader (fstat of the OPEN descriptor, bounded read): drive it with fake fs calls.
  const reader = (p) => { let done = false; return readBoundedFile(p, MAX_EXTENSION_FILE_BYTES, { openSync: () => 7, closeSync: () => {}, fstatSync: () => ({ isFile: () => p !== '/fifo', size: p === '/huge' ? MAX_EXTENSION_FILE_BYTES + 1 : 8 }), readSync: (fd, buf, off) => { if (done) return 0; done = true; buf.write('material', off); return 8; } }); };
  assert.equal(loadExt({ charterFile: '/c' }, reader).charterAddendum, 'material');
  assert.throws(() => loadExt({ charterFile: '/fifo' }, reader), /not a regular file/);
  assert.throws(() => loadExt({ deadEndFile: '/huge' }, reader), /exceeds/);
  assert.throws(() => loadExt({ deadEndFile: '/missing' }, () => { throw new Error('ENOENT'); }), /ENOENT/);
});

test('an invalid or unknown run flag under --json still yields exactly one result document with reason dispatch-refused (codex r9)', () => {
  const bin = new URL('../bin/fleet.mjs', import.meta.url).pathname;
  for (const argv of [['run', '--json', '--max-strikes', '0'], ['run', '--json', '--no-such-flag']]) {
    const r = spawnSync(process.execPath, [bin, ...argv], { encoding: 'utf8', cwd: mkdtempSync(join(tmpdir(), 'fleet-flags-')) });
    assert.equal(r.status, 1, `${argv.join(' ')}: exit 1`);
    let doc; try { doc = JSON.parse(r.stdout); } catch { doc = null; }
    assert.ok(doc && typeof doc === 'object', `exactly one (pretty-printed) document on stdout: ${r.stdout.slice(0, 200)}`);
    assert.equal(doc.reason, 'dispatch-refused');
    assert.equal(doc.exitCode, 1);
  }
});

test('a ticket-store failure before dispatch under --json still yields one result document (codex r10)', () => {
  const bin = new URL('../bin/fleet.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, 'run', '--json', '--no-pr'], { encoding: 'utf8', cwd: mkdtempSync(join(tmpdir(), 'fleet-nostore-')) });
  assert.notEqual(r.status, 0);
  let doc; try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  assert.ok(doc && typeof doc.reason === 'string', `one result document with a reason: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
});

test('--model-plane-git mirror with a concurrency other than 1 is refused (one writable mirror per worker) — under --json as a dispatch-refused document (codex r11)', () => {
  const bin = new URL('../bin/fleet.mjs', import.meta.url).pathname;
  const cwd = mkdtempSync(join(tmpdir(), 'fleet-mirror-cc-'));
  const r = spawnSync(process.execPath, [bin, 'run', '--json', '--model-plane-git', 'mirror', '--model-plane-git-mirror', '/m/mirror.git', '--model-plane-read', 'bounded', '--model-plane-read-only', '/usr', '--concurrency', '2'], { encoding: 'utf8', cwd });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires concurrency 1/);
  assert.equal(JSON.parse(r.stdout).reason, 'dispatch-refused');
});

test('the production path reads extension files through the bounded single-descriptor reader (a FIFO is refused, never the plain io.readFile)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ext-prod-'));
  try {
    const fifo = join(dir, 'charter.fifo'); execFileSync('mkfifo', [fifo]);
    // No injected reader: the default (production) reader must refuse the FIFO without blocking.
    assert.throws(() => loadExt({ charterFile: fifo }), /not a regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
