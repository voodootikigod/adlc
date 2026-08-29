// floor-zero.test.mjs — issue #697: `--floor 0` must be REJECTED, not accepted.
//
// With floor 0, Rule 1b (`density < floor`) and the P3 filter
// (`railDensity < floor`) can never match, so the gate is a guaranteed exit 0
// for every ticket set and an unrailed ticket silently leaves frontier. The
// accepted range is (0, 1]; the predicate lives in ONE exported validator that
// the bin, runRouter and assignAll all call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { assertFloor, DEFAULT_FLOOR, parseFloor } from '../lib/floor.mjs';
import { assignAll, assignTicket } from '../lib/assign.mjs';
import { runRouter } from '../lib/router.mjs';
import { buildPriors } from '../lib/priors.mjs';

const UNRAILED = { id: 'T-BARE', title: 'No rails at all', category: 'feature', scope: ['a', 'b'] };

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'model-router-floor-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeTickets(dir, tickets) {
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const ticketsPath = join(adlc, 'tickets.json');
  writeFileSync(ticketsPath, JSON.stringify({ tickets }));
  return ticketsPath;
}

function runCLI(args, cwd) {
  const cli = new URL('../bin/model-router.mjs', import.meta.url).pathname;
  try {
    const out = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── AC3: the single validator ────────────────────────────────────────────────

test('assertFloor rejects every value outside (0, 1] with the documented message', () => {
  for (const bad of [0, -0, 0.0000, -1, NaN, 1.0000001, Infinity, -Infinity]) {
    assert.throws(
      () => assertFloor(bad),
      /--floor must be a number greater than 0 and at most 1/,
      `expected ${Object.is(bad, -0) ? '-0' : bad} to be rejected`
    );
  }
});

test('assertFloor explains WHY 0 is refused and echoes the raw flag text', () => {
  assert.throws(() => assertFloor(0, '0'), /0 would disable the P3 rail-density gate/);
  assert.throws(() => assertFloor(0, '0'), /unrailed tickets leave frontier/);
  assert.throws(() => assertFloor(-0, '-0'), /got: -0/);
  assert.throws(() => assertFloor(0, '0.0'), /got: 0\.0/);
  // No raw text supplied → falls back to the numeric value — and -0 must still
  // read as "-0", not "0" (String(-0) is "0"), or the operator cannot tell a
  // negative-zero template value from a literal zero.
  assert.throws(() => assertFloor(NaN), /got: NaN/);
  assert.throws(() => assertFloor(-0), /got: -0/);
  assert.throws(() => assertFloor(0), /got: 0$/);
  assert.throws(() => assertFloor(-1), /got: -1/);
});

test('assertFloor accepts the open-closed interval (0, 1] and returns the value', () => {
  for (const ok of [0.0001, 0.2, 0.5, 1]) {
    assert.equal(assertFloor(ok), ok);
  }
  assert.equal(DEFAULT_FLOOR, 0.2);
  assert.equal(assertFloor(DEFAULT_FLOOR), 0.2);
});

test('assertFloor rejects non-number types (strings, null, undefined, objects)', () => {
  for (const bad of ['0.2', null, undefined, {}, [], true]) {
    assert.throws(() => assertFloor(bad), /--floor must be a number greater than 0 and at most 1/);
  }
});

test('assertFloor marks the error as operational (isOpError) so callers exit 1, not 2', () => {
  let caught;
  try { assertFloor(0); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.isOpError, true);
});

// ── AC3: library entry points cannot bypass it ───────────────────────────────

test('assignAll throws on floor 0 even for an EMPTY ticket list (the check is its own, not per-ticket)', () => {
  const priors = buildPriors([]);
  assert.throws(() => assignAll([], { floats: {} }, priors, 0), /greater than 0/);
  assert.throws(() => assignAll([UNRAILED], { floats: { 'T-BARE': 0 } }, priors, 0), /greater than 0/);
  assert.throws(() => assignAll([UNRAILED], { floats: { 'T-BARE': 0 } }, priors, -0), /greater than 0/);
});

test('assignTicket throws on floor 0 and 1.5; still routes an unrailed ticket to frontier at 0.2', () => {
  const priors = buildPriors([]);
  assert.throws(() => assignTicket(UNRAILED, 0, priors, 0), /greater than 0/);
  assert.throws(() => assignTicket(UNRAILED, 0, priors, 1.5), /greater than 0/);
  const a = assignTicket(UNRAILED, 0, priors, 0.2);
  assert.equal(a.tier, 'frontier');
  assert.equal(a.mode, 'direct');
  assert.equal(a.railDensity, 0);
});

test('runRouter rejects floor 0 BEFORE reading tickets (an empty store would otherwise return early with exit 0)', async () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, []);
    await assert.rejects(
      () => runRouter({ ticketsPath, floor: 0, adlcDir: join(tmp, '.adlc') }),
      /greater than 0/
    );
    await assert.rejects(
      () => runRouter({ ticketsPath, floor: -0, adlcDir: join(tmp, '.adlc') }),
      /greater than 0/
    );
    // The default is untouched: omitting floor still routes.
    const ok = await runRouter({ ticketsPath, adlcDir: join(tmp, '.adlc') });
    assert.deepEqual(ok.assignments, []);
  } finally {
    cleanup(tmp);
  }
});

test('runRouter at floor 0.2 still reports the P3 finding for an unrailed ticket', async () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const result = await runRouter({ ticketsPath, floor: 0.2, adlcDir: join(tmp, '.adlc') });
    assert.equal(result.p3Findings.length, 1);
    assert.equal(result.p3Findings[0].id, 'T-BARE');
    assert.equal(result.assignments[0].tier, 'frontier');
  } finally {
    cleanup(tmp);
  }
});

// ── AC1: CLI rejects 0 / -0 / 0.0 / 1.5 / abc with exit 1 ─────────────────────

test('CLI: --floor 0, -0 and 0.0 exit 1 with the range error (never a green table)', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    for (const raw of ['0', '-0', '0.0']) {
      // `--floor=<v>` form: node's parseArgs rejects a dash-leading value after a space.
      const r = runCLI(['--tickets', ticketsPath, `--floor=${raw}`], tmp);
      assert.equal(r.code, 1, `--floor ${raw}: expected exit 1, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
      assert.match(r.stderr, /greater than 0/, `--floor ${raw}: stderr should carry the range error`);
      assert.match(r.stderr, /disable the P3 rail-density gate/, `--floor ${raw}: stderr should say why`);
      assert.match(r.stderr, new RegExp(`got: ${raw.replace('.', '\\.')}`), `--floor ${raw}: stderr should echo the raw flag text`);
      assert.ok(!r.stdout.includes('T-BARE'), `--floor ${raw}: no assignment table may be printed`);
    }
  } finally {
    cleanup(tmp);
  }
});

test('CLI: --floor 1.5 and --floor abc still exit 1', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    for (const raw of ['1.5', 'abc', '-1']) {
      const r = runCLI(['--tickets', ticketsPath, `--floor=${raw}`], tmp);
      assert.equal(r.code, 1, `--floor ${raw}: expected exit 1, got ${r.code}`);
      assert.match(r.stderr, /greater than 0 and at most 1/);
    }
  } finally {
    cleanup(tmp);
  }
});

test('CLI: --floor 0 with --json prints no assignments document on stdout', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const r = runCLI(['--tickets', ticketsPath, '--floor', '0', '--json'], tmp);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), '');
  } finally {
    cleanup(tmp);
  }
});

// ── AC2: regression pin — the gate still fires at the default floor ──────────

test('CLI: the same unrailed fixture at --floor 0.2 exits 2 with a P3 finding naming the ticket', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const r = runCLI(['--tickets', ticketsPath, '--floor', '0.2'], tmp);
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /P3 finding: ticket T-BARE/);

    const j = runCLI(['--tickets', ticketsPath, '--floor', '0.2', '--json'], tmp);
    assert.equal(j.code, 2);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.assignments[0].id, 'T-BARE');
    assert.equal(parsed.assignments[0].tier, 'frontier');
    assert.equal(parsed.p3Findings.length, 1);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: omitting --floor uses the 0.2 default (unrailed ticket → exit 2, frontier)', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const r = runCLI(['--tickets', ticketsPath, '--json'], tmp);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).assignments[0].tier, 'frontier');
  } finally {
    cleanup(tmp);
  }
});

// ── review finding (codex r1): space-separated negatives never reached the validator ──

test('CLI: space-separated `--floor -0` and `--floor -1` get the range error, not a parseArgs stack trace', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    for (const raw of ['-0', '-1']) {
      const r = runCLI(['--tickets', ticketsPath, '--floor', raw], tmp);
      assert.equal(r.code, 1, `--floor ${raw}: expected exit 1, got ${r.code}`);
      assert.match(r.stderr, /^error: --floor must be a number greater than 0 and at most 1/m, `--floor ${raw}: range error expected`);
      assert.match(r.stderr, new RegExp(`got: ${raw}`), `--floor ${raw}: raw token echoed`);
      assert.match(r.stderr, /--floor=<n>/, `--floor ${raw}: the accepted spelling is suggested`);
      assert.doesNotMatch(r.stderr, /node:internal|\n\s+at /, `--floor ${raw}: no stack trace`);
      assert.ok(!r.stdout.includes('T-BARE'));
    }
  } finally {
    cleanup(tmp);
  }
});

test('CLI: `--floor` with no value is an operational error carrying the range message, no stack trace', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const r = runCLI(['--tickets', ticketsPath, '--floor'], tmp);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: --floor must be a number greater than 0 and at most 1/m);
    assert.match(r.stderr, /got: \(missing\)/);
    assert.match(r.stderr, /argument missing/);
    assert.doesNotMatch(r.stderr, /node:internal|\n\s+at /);
  } finally {
    cleanup(tmp);
  }
});

test('CLI: any other parseArgs failure (unknown option) is an `error:` line with exit 1, not a stack trace', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const r = runCLI(['--tickets', ticketsPath, '--bogus'], tmp);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: .*--bogus/m);
    assert.doesNotMatch(r.stderr, /greater than 0/, 'a non-floor parse failure must not be dressed up as a floor error');
    assert.doesNotMatch(r.stderr, /node:internal|\n\s+at /);
  } finally {
    cleanup(tmp);
  }
});

// ── review finding (codex r2): parseFloat honoured `0.5abc` as 0.5 ────────────

test('parseFloor accepts only plain decimals; numeric-prefixed junk, hex and empty text are NaN', () => {
  for (const [raw, want] of [['0.2', 0.2], [' 0.2 ', 0.2], ['.2', 0.2], ['1', 1], ['1e-1', 0.1], ['+0.5', 0.5], ['1.', 1]]) {
    assert.equal(parseFloor(raw), want, `parseFloor(${JSON.stringify(raw)})`);
  }
  assert.ok(Object.is(parseFloor('-0'), -0), 'the sign of -0 must survive so the error can echo it');
  for (const bad of ['0.5abc', '0x1', '1,5', '', '   ', 'abc', '0.2.1', '1e', 'Infinity', '--floor']) {
    assert.ok(Number.isNaN(parseFloor(bad)), `parseFloor(${JSON.stringify(bad)}) must be NaN`);
  }
});

test('CLI: `--floor=0.5abc` is refused (was silently honoured as 0.5), `--floor=0.5` still routes', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const bad = runCLI(['--tickets', ticketsPath, '--floor=0.5abc'], tmp);
    assert.equal(bad.code, 1, `stdout:${bad.stdout}\nstderr:${bad.stderr}`);
    assert.match(bad.stderr, /greater than 0 and at most 1/);
    assert.match(bad.stderr, /got: 0\.5abc/);
    const ok = runCLI(['--tickets', ticketsPath, '--floor=0.5', '--json'], tmp);
    assert.equal(ok.code, 2);
    assert.equal(JSON.parse(ok.stdout).p3Findings[0].floor, 0.5);
  } finally {
    cleanup(tmp);
  }
});

// ── flag position must not matter (kills argv-offset / sentinel mutants) ──────

test('CLI: `--floor -0` as the FIRST argument still echoes `got: -0`; `--json` first still yields a JSON document', () => {
  const tmp = makeTmp();
  try {
    const ticketsPath = writeTickets(tmp, [UNRAILED]);
    const first = runCLI(['--floor', '-0', '--tickets', ticketsPath], tmp);
    assert.equal(first.code, 1);
    assert.match(first.stderr, /got: -0/);
    const jsonFirst = runCLI(['--json', '--tickets', ticketsPath], tmp);
    assert.equal(jsonFirst.code, 2);
    assert.equal(JSON.parse(jsonFirst.stdout).assignments[0].id, 'T-BARE');
  } finally {
    cleanup(tmp);
  }
});
