// End-to-end: the log flail-detector analyzes must actually get written (T62).
//
// #284's field-name fix was necessary but not sufficient. `checkFlail` analyzes
// `.adlc/fleet-logs/<ticket>.log`, and nothing in the fleet ever wrote that
// file — `dispatch` kept the worker transcript purely in memory. So the
// detector was handed a nonexistent path, exited 1, and every between-strike
// consultation fail-opened no matter how correctly the document was parsed.
//
// These tests drive the REAL `buildLiveDeps` effects, so a regression that
// stops writing the log surfaces here instead of as a silent no-op in prod.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveDeps, fleetLogPath, defaultIo } from '../lib/live-deps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADLC_BIN = resolve(HERE, '../../cli/bin/adlc.mjs');

/** Write a log file into `dir` and return its path. */
function makeLogAt(dir, content) {
  const p = join(dir, 'session.log');
  writeFileSync(p, content);
  return p;
}

const sandboxSpec = { mode: 'sandbox', backend: { name: 'bubblewrap' } };
// adlcBin MUST be set: buildLiveDeps resolves `config.adlcBin ?? 'adlc'` and
// passes it down, so without it these tests would spawn whatever `adlc` the
// developer happens to have on PATH instead of the binary under review.
const config = { gate: { build: 'npm run build', test: 'npm test' }, timeoutMinutes: 1, modelAuthKey: 'ANTHROPIC_API_KEY', adlcBin: ADLC_BIN };
const ticket = { id: 'T1', title: 'T1', scope: ['src/**'], body: 'do it', edges: [] };

/**
 * io wired to a real temp statusDir with a real appendLog and a real spawnSync
 * over the actual adlc binary — only the worker itself is faked, since we are
 * testing what the fleet does with the worker's transcript.
 */
function makeIo(workerOutput, workerResult = {}) {
  return {
    git: () => (...args) => (args[0] === 'rev-parse' ? 'SHA' : ''),
    // No `?? ADLC_BIN` fallback: the bin must arrive from config, or these
    // tests would quietly exercise an ambient install instead of this worktree.
    adlc: (args, opts = {}) => spawnSync(opts.bin, args, { encoding: 'utf8', maxBuffer: opts.maxBuffer }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async () => ({ status: 0, stdout: workerOutput, stderr: '', ...workerResult }),
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    // The REAL primitive, not a lookalike — a copy could not catch drift in it.
    appendLog: defaultIo().appendLog,
    ensureGitignore: () => {},
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-x' },
    hasGh: () => false,
  };
}

const makeDeps = (statusDir, workerOutput, workerResult) => buildLiveDeps({
  repo: '/repo', config, statusDir, sandboxSpec,
  reviewRunner: () => ({ ok: true, findings: [] }),
  io: makeIo(workerOutput, workerResult),
});

test('dispatch persists the worker transcript to the log flail-detector reads', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'Writing /etc/passwd\n');

  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });

  const p = fleetLogPath(statusDir, '/repo', 'T1');
  assert.ok(existsSync(p), `dispatch must write ${p} — checkFlail has nothing to analyze otherwise`);
  assert.match(readFileSync(p, 'utf8'), /Writing \/etc\/passwd/);
});

test('the transcript ACCUMULATES across strikes rather than being overwritten', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'error: boom\n');

  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 2, deadEnds: [] });

  const body = readFileSync(fleetLogPath(statusDir, '/repo', 'T1'), 'utf8');
  assert.match(body, /^=== T1 strike 1 ===$/m);
  assert.match(body, /^=== T1 strike 2 ===$/m, 'checkFlail runs over the accumulated log — strike 1 must survive');
  assert.equal(body.match(/error: boom/g).length, 2, 'both strikes contribute to the repeated-error signal');
});

// ---------------------------------------------------------------------------
// defaultIo() is the wiring production actually gets. Every other test injects
// its own io, so these primitives had no coverage at all — a null-returning
// `adlc` or a non-recursive mkdir would have shipped green.
// ---------------------------------------------------------------------------

test('defaultIo().adlc spawns the given bin and returns a real spawnSync result', async () => {
  const log = makeLogAt(mkdtempSync(join(tmpdir(), 'fleet-e2e-')), 'Writing /etc/passwd\n');

  const r = defaultIo().adlc(['flail-detector', '--json', '--scope=src/**', '--', log], { bin: ADLC_BIN });

  assert.ok(r, 'must return the spawn result, not null');
  assert.equal(r.status, 2, 'the configured bin ran and reported the flail verdict');
  assert.equal(JSON.parse(r.stdout).verdict, 'flail');
});

test('defaultIo().appendLog creates missing parent directories and appends', async () => {
  const p = join(mkdtempSync(join(tmpdir(), 'fleet-e2e-')), 'deep', 'nested', 'T1.log');
  const io = defaultIo();

  io.appendLog(p, 'first\n');
  io.appendLog(p, 'second\n');

  assert.equal(readFileSync(p, 'utf8'), 'first\nsecond\n', 'nested dirs created, writes appended not clobbered');
});

test('deps.flail() detects a REAL flail after a real dispatch (the whole point of #284)', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  // A worker that wrote outside its declared scope (ticket.scope is ['src/**']).
  const deps = makeDeps(statusDir, 'Writing /etc/passwd\n');

  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const r = await deps.flail({ ticket });

  assert.equal(r.flail, true, 'a scope-violating session must be diagnosed as a flail end to end');
  assert.notEqual(r.failedOpen, true, 'this is a real verdict, not the §12 fallback');
  assert.ok(
    r.signals.some((s) => s?.type === 'scope-violation'),
    `expected a scope-violation signal, got ${JSON.stringify(r.signals)}`,
  );
});

test('deps.flail() reports clean for a well-behaved session', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'all good\n');

  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  const r = await deps.flail({ ticket });

  assert.equal(r.flail, false);
  assert.notEqual(r.failedOpen, true, 'a clean verdict is a verdict, not a fail-open');
});

test('deps.flail() fails OPEN when no transcript exists (§12 backstop intact)', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'Writing /etc/passwd\n');

  // Discriminating: prove a REAL verdict is obtainable in this environment
  // first, so the fail-open below is pinned to the missing log rather than to
  // a broken binary — every unverifiable outcome yields the same shape.
  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.notEqual((await deps.flail({ ticket })).failedOpen, true, 'precondition: a real verdict is reachable here');

  rmSync(fleetLogPath(statusDir, '/repo', 'T1'));
  const r = await deps.flail({ ticket });

  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true, 'a missing log is unverifiable, never a flail');
});

// ---------------------------------------------------------------------------
// The scheduler consults flail ONLY after a FAILED strike (scheduler.mjs:72-76,
// 82-86). Every test above drives a successful worker, so without these the
// transcript write could be moved inside dispatch's success-only branch and the
// whole suite would stay green while production reproduced #284 exactly.
// ---------------------------------------------------------------------------

test('the transcript is written when the worker strike FAILS', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'Writing /etc/passwd\n', { status: 1 });

  const res = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.notEqual(res.exitCode, 0, 'precondition: this strike must have failed');

  const r = await deps.flail({ ticket });
  assert.equal(r.flail, true, 'the failed strike is exactly when the scheduler asks');
  assert.notEqual(r.failedOpen, true);
});

test('the transcript is written when the worker TIMES OUT', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'Writing /etc/passwd\n', { status: null, signal: 'SIGTERM' });

  await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });

  assert.equal((await deps.flail({ ticket })).flail, true);
});

test('the transcript is written when the worker emits TICKET-BLOCKED', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const deps = makeDeps(statusDir, 'TICKET-BLOCKED\nWriting /etc/passwd\n');

  const res = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  assert.equal(res.blocked, true, 'precondition: blocked');

  assert.ok(existsSync(fleetLogPath(statusDir, '/repo', 'T1')), 'a blocked run still leaves a transcript');
});

test('ensureGitignore excludes fleet state from a LINKED git worktree', async () => {
  // <repo>/.git is a FILE in a linked worktree, so the old <repo>/.git/info
  // path silently failed — leaving .adlc/fleet-logs/ untracked and aborting
  // every later run at preflight.
  const root = mkdtempSync(join(tmpdir(), 'fleet-e2e-git-'));
  const main = join(root, 'main');
  const run = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  mkdirSync(main, { recursive: true });
  run(main, 'init', '-q', '-b', 'main');
  run(main, 'config', 'user.email', 't@t.t');
  run(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'f.txt'), 'x\n');
  run(main, 'add', '-A');
  run(main, 'commit', '-qm', 'init');
  const linked = join(root, 'wt');
  run(main, 'worktree', 'add', '-q', linked, '-b', 'side');
  assert.ok(statSync(join(linked, '.git')).isFile(), 'precondition: linked worktree .git is a FILE');

  defaultIo().ensureGitignore(linked);

  const excl = readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excl, /\.adlc\/fleet-logs\//, 'the transcript dir must be excluded from the common dir');
  assert.equal(run(linked, 'status', '--porcelain').stdout.trim(), '', 'no untracked fleet state left behind');
});

// ---------------------------------------------------------------------------
// Run isolation. The log is git-excluded and INERT, so nothing else ever
// deletes it; the detector's repeated-error threshold is 2. Without a reset a
// re-run would be judged on the PREVIOUS run's errors and killed on the first
// strike it ever took — a fail-CLOSED misfire from stale state.
// ---------------------------------------------------------------------------

test('strike 1 TRUNCATES, so a re-run is not judged on the previous run errors', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const first = makeDeps(statusDir, 'error: boom\n', { status: 1 });

  // Run 1: two strikes, so 'error: boom' appears twice — enough on its own to
  // trip the detector's repeated-error signal (--max-repeat defaults to 2).
  await first.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });
  await first.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 2, deadEnds: [] });
  assert.equal((await first.flail({ ticket })).flail, true, 'precondition: run 1 really did flail');

  // Run 2, first strike: a single clean-ish failure must NOT inherit run 1.
  const second = makeDeps(statusDir, 'error: boom\n', { status: 1 });
  await second.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });

  const body = readFileSync(fleetLogPath(statusDir, '/repo', 'T1'), 'utf8');
  assert.equal(body.match(/error: boom/g).length, 1, 'run 2 strike 1 must start from a clean transcript');
  assert.equal((await second.flail({ ticket })).flail, false, 'a fresh run must not be killed by stale state');
});

test('a commit failure reaches the transcript the flail check analyzes', async () => {
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const io = makeIo('worker ok\n');
  io.git = () => (...args) => {
    if (args[0] === 'rev-parse') return 'SHA';
    if (args.includes('commit')) throw new Error('nothing to commit');
    return '';
  };
  const deps = buildLiveDeps({ repo: '/repo', config, statusDir, sandboxSpec, reviewRunner: () => ({ ok: true, findings: [] }), io });

  const res = await deps.dispatch({ ticket, worktree: '/wt/T1', startSha: 'SHA', strike: 1, deadEnds: [] });

  assert.equal(res.exitCode, 1, 'precondition: the commit failed');
  const body = readFileSync(fleetLogPath(statusDir, '/repo', 'T1'), 'utf8');
  assert.match(body, /commit failed: nothing to commit/);
  assert.match(body, /worker ok/, 'appending the failure must not truncate the transcript it joins');
});
