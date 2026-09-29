// spawn-bounds.test.mjs — a child that never exits must not hang a Copilot hook,
// and the audited-bypass recorder must not hand its credentials to an untrusted adlc.
//
// The lifecycle hook spawns `git` (the changed-path scan) and `adlc` (manifest
// verify/show), and the build gate spawns `adlc gate-manifest record` for an
// audited bypass. Without a timeout, spawnSync waits forever on a child that
// never exits; the host's per-hook timeout is the only other bound, and nothing
// that calls these modules directly (tests, scripts) gets it.
//
// The tests must not be able to hang either, so every spawn here goes through
// the bounded helper and every test declares its own timeout. A regression
// fails on the elapsed-time assertion; it never wedges the runner.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runHook } from './helpers/run-hook.mjs';
import { run, gitChangedPaths, stopReview } from '../adlc-lifecycle.mjs';
// Read off the module namespace so a missing export fails the assertions that
// use it rather than the whole file's import.
const { BYPASS_RECORD_ENV_ALLOWLIST = [] } = await import('../adlc-build-gate.mjs');

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE = join(HOOKS, 'adlc-lifecycle.mjs');
const BUILD_GATE = join(HOOKS, 'adlc-build-gate.mjs');

// The per-operation budget the hooks allow a child program. Duplicated rather
// than imported: the constants are module-private, and a test that read them
// back would pass even if no spawn used them.
const BUDGET_MS = 5000;
// Two budgets of slack cover node startup plus the SIGKILL round trip. A hung
// spawn overshoots this by orders of magnitude.
const BOUND_MS = 2 * BUDGET_MS;
const HARD_KILL_MS = 30_000;

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).trim();

const SANDBOXES = [];
const sandbox = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SANDBOXES.push(dir);
  return dir;
};

after(() => {
  for (const dir of SANDBOXES) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** A PATH directory whose `name` is a shell script that never exits. */
function blockingShellBin(name) {
  const dir = sandbox(`adlc-copilot-block-${name}-`);
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexec sleep 100000\n');
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * A PATH directory whose `adlc` is a Node script that never exits, laid out as
 * a global install is: an extensionless link to a `.mjs` target. Runnable both
 * directly (shebang) and as `node <path>`.
 */
function blockingNodeAdlc() {
  const dir = sandbox('adlc-copilot-block-node-adlc-');
  const impl = join(dir, 'adlc-impl.mjs');
  writeFileSync(impl, '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n');
  chmodSync(impl, 0o755);
  symlinkSync(impl, join(dir, 'adlc'));
  return dir;
}

function initRepo(prefix) {
  const dir = sandbox(prefix);
  const git = (args) => execFileSync(REAL_GIT, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}');
  writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  git(['add', '-A']);
  git(['commit', '-m', 'baseline']);
  writeFileSync(join(dir, 'README.md'), 'baseline\nchanged\n');
  return dir;
}

/** Run `node args…` with `fakeBinDir` first on PATH; report elapsed time and stdout. */
function runTimed(args, { cwd, fakeBinDir, input = '{}', env = {} }) {
  const started = Date.now();
  let stdout = '';
  let timedOut = false;
  try {
    stdout = runHook(args, {
      input,
      cwd,
      timeout: HARD_KILL_MS,
      env: { ...process.env, ...env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}` },
    });
  } catch (err) {
    if (err?.timedOut) timedOut = true;
    else throw err;
  }
  return { elapsed: Date.now() - started, timedOut, stdout };
}

test('a git that never exits cannot hang the review hook, and the scan shares one budget', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-copilot-bound-git-');
  const { elapsed, timedOut } = runTimed([LIFECYCLE, 'review'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir }),
    fakeBinDir: blockingShellBin('git'),
  });
  assert.equal(timedOut, false, 'the review hook had to be killed — a blocked git still hangs it');
  assert.ok(elapsed < BOUND_MS, `review with a blocked git took ${elapsed}ms, over ${BOUND_MS}ms — the budget is per call, not per scan`);
});

test('an adlc that never exits cannot hang the verify hook, which still reports the failure', { timeout: 120_000 }, () => {
  const dir = initRepo('adlc-copilot-bound-verify-');
  const { elapsed, timedOut, stdout } = runTimed([LIFECYCLE, 'verify'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir }),
    fakeBinDir: blockingShellBin('adlc'),
  });
  assert.equal(timedOut, false, 'the verify hook had to be killed — a blocked adlc still hangs it');
  assert.ok(elapsed < BOUND_MS, `verify with a blocked adlc took ${elapsed}ms, over ${BOUND_MS}ms`);
  assert.match(stdout, /gate-manifest verification did not pass/, 'a killed verifier is a failed verification, never a silent pass');
});

test('a bypass recorder that never exits is killed and the bypass fails closed', { timeout: 120_000 }, () => {
  const cwd = sandbox('adlc-copilot-bound-bypass-');
  mkdirSync(join(cwd, '.adlc'), { recursive: true });
  const script = [
    `import { recordBuildGateBypass } from ${JSON.stringify(pathToFileURL(BUILD_GATE).href)};`,
    "const ok = recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: process.env.BYPASS_CWD });",
    'process.stdout.write(JSON.stringify({ ok }));',
  ].join('\n');
  const { elapsed, timedOut, stdout } = runTimed(['--input-type=module', '-e', script], {
    cwd,
    fakeBinDir: blockingNodeAdlc(),
    env: { BYPASS_CWD: cwd },
  });
  assert.equal(timedOut, false, 'recordBuildGateBypass had to be killed — a blocked adlc still hangs it');
  assert.ok(elapsed < BOUND_MS, `a blocked bypass recorder took ${elapsed}ms, over ${BOUND_MS}ms`);
  assert.deepEqual(JSON.parse(stdout), { ok: false }, 'an unrecorded bypass must report failure so the gate denies');
});

/** A spawnSync stand-in that records the options every call received. */
function recordingSpawn(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const impl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return result;
  };
  return { impl, calls };
}

test('run() hands every spawn a positive timeout and a SIGKILL reap', () => {
  const { impl, calls } = recordingSpawn();
  run(impl, 'adlc', ['gate-manifest', 'show'], '/tmp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.killSignal, 'SIGKILL');
  assert.equal(calls[0].opts.timeout, BUDGET_MS);
  assert.equal(calls[0].opts.cwd, '/tmp');
});

test('run() never passes a zero or negative timeout, which spawnSync reads as unbounded', () => {
  const { impl, calls } = recordingSpawn();
  run(impl, 'git', ['status'], '/tmp', 0);
  run(impl, 'git', ['status'], '/tmp', -250);
  for (const { opts } of calls) assert.equal(opts.timeout, 1);
});

test('gitChangedPaths gives every git call a share of one scan budget', () => {
  const { impl, calls } = recordingSpawn({ status: 0, stdout: 'abc123\n', stderr: '' });
  gitChangedPaths('/tmp', { spawnImpl: impl, base: 'main' });
  assert.ok(calls.length >= 4, `expected the full scan, saw ${calls.length} calls`);
  for (const { bin, opts } of calls) {
    assert.equal(bin, 'git');
    assert.equal(opts.killSignal, 'SIGKILL');
    assert.ok(opts.timeout >= 1 && opts.timeout <= BUDGET_MS, `timeout ${opts.timeout} is outside (0, ${BUDGET_MS}]`);
  }
});

test('stopReview bounds its manifest read as well as its git scan', () => {
  const root = sandbox('adlc-copilot-bound-stop-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  const calls = [];
  const impl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'git' && args[0] === 'status') return { status: 0, stdout: ' M src/auth/login.js\0', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  stopReview(root, { spawnImpl: impl, env: {} });
  const show = calls.find((c) => c.args.includes('show'));
  assert.ok(show, 'a risk-gated change must read the manifest');
  assert.equal(show.opts.killSignal, 'SIGKILL');
  assert.equal(show.opts.timeout, BUDGET_MS);
});

// --- the bypass recorder's binary and environment ---------------------------

/**
 * A PATH directory whose `adlc` dumps the environment it received to `dumpPath`
 * and exits 0, laid out as a global install is (extensionless link to `.mjs`).
 */
function envDumpingAdlc(dumpPath) {
  const dir = sandbox('adlc-copilot-envdump-');
  const impl = join(dir, 'adlc-impl.mjs');
  writeFileSync(
    impl,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));\n`,
  );
  chmodSync(impl, 0o755);
  symlinkSync(impl, join(dir, 'adlc'));
  return dir;
}

/** A `node_modules/.bin` directory whose `adlc` would leave `markerPath` behind if run. */
function plantedNodeModulesAdlc(markerPath) {
  const dir = join(sandbox('adlc-copilot-planted-'), 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'adlc');
  writeFileSync(bin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\n`);
  chmodSync(bin, 0o755);
  return dir;
}

/** Call recordBuildGateBypass in a child with the given PATH and extra env. */
function recordBypassInChild({ pathEnv, env = {} }) {
  const cwd = sandbox('adlc-copilot-bypass-cwd-');
  mkdirSync(join(cwd, '.adlc'), { recursive: true });
  const script = [
    `import { recordBuildGateBypass } from ${JSON.stringify(pathToFileURL(BUILD_GATE).href)};`,
    "const ok = recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: process.env.BYPASS_CWD });",
    'process.stdout.write(JSON.stringify({ ok }));',
  ].join('\n');
  const stdout = runHook(['--input-type=module', '-e', script], {
    cwd,
    timeout: HARD_KILL_MS,
    env: { ...process.env, ...env, BYPASS_CWD: cwd, PATH: pathEnv },
  });
  return JSON.parse(stdout);
}

test('the bypass recorder never hands the manifest or admin key to the adlc it spawns', { timeout: 60_000 }, () => {
  const dumpPath = join(sandbox('adlc-copilot-dump-'), 'env.json');
  const binDir = envDumpingAdlc(dumpPath);
  const pathEnv = `${binDir}:${dirname(process.execPath)}`;
  const result = recordBypassInChild({
    pathEnv,
    env: { ADLC_MANIFEST_KEY: 'manifest-key-must-not-leak', ADLC_ADMIN_KEY: 'admin-key-must-not-leak', UNRELATED_TOKEN: 'x' },
  });
  assert.deepEqual(result, { ok: true });
  const seen = JSON.parse(readFileSync(dumpPath, 'utf8'));
  assert.equal(seen.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY reached the spawned adlc');
  assert.equal(seen.ADLC_ADMIN_KEY, undefined, 'ADLC_ADMIN_KEY reached the spawned adlc');
  assert.equal(seen.UNRELATED_TOKEN, undefined, 'only allowlisted variables may reach the spawned adlc');
  assert.equal(seen.PATH, pathEnv, 'PATH is allowlisted and must still reach the child');
  for (const key of Object.keys(seen)) {
    assert.ok(BYPASS_RECORD_ENV_ALLOWLIST.includes(key), `child env carried a non-allowlisted variable: ${key}`);
  }
});

test('the bypass recorder skips a node_modules adlc ahead of the real one on PATH', { timeout: 60_000 }, () => {
  const marker = join(sandbox('adlc-copilot-marker-'), 'ran');
  const dumpPath = join(sandbox('adlc-copilot-dump2-'), 'env.json');
  const pathEnv = `${plantedNodeModulesAdlc(marker)}:${envDumpingAdlc(dumpPath)}:${dirname(process.execPath)}`;
  const result = recordBypassInChild({ pathEnv });
  assert.deepEqual(result, { ok: true });
  assert.equal(existsSync(marker), false, 'the node_modules adlc must never run');
  assert.equal(existsSync(dumpPath), true, 'the trusted adlc further down PATH must run');
});

test('the bypass recorder fails closed when every adlc on PATH is inside node_modules', { timeout: 60_000 }, () => {
  const marker = join(sandbox('adlc-copilot-marker2-'), 'ran');
  // PATH holds nothing else: the node binary's own directory may carry a real
  // global adlc, which would rightly be used.
  const result = recordBypassInChild({ pathEnv: plantedNodeModulesAdlc(marker) });
  assert.deepEqual(result, { ok: false }, 'no trusted adlc — the bypass is unrecorded and must be refused');
  assert.equal(existsSync(marker), false, 'no bare-PATH fallback to the node_modules adlc');
});
