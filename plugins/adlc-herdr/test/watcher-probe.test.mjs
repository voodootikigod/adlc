// Issue #832: a FAILED `herdr --version` probe (binary not on PATH, transient
// IPC hiccup at session start) must not be conflated with an UNSUPPORTED
// version. Before: the empty stdout of a failed probe was parsed as
// "untested herdr version (unparseable)", published through the shim that had
// just failed, and main() returned — observer silently off for the session.
// After: a failed probe logs one stderr line, publishes nothing, and re-probes
// on a timer; the real degrade path (parsed, too-new version) is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { probeOutcome } from '../lib/probe.mjs';
import { spawnHookAsync } from './helpers/run-hook.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'watcher.mjs');
const CEILING = '0.7.4';

// Every fixture directory is registered here and removed once, after the file.
const fixtures = new Set();
after(() => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });

// ---- AC4: probeOutcome is pure and distinguishes the three outcomes --------

test('AC4 probeOutcome: a failed probe is probe-failed with the probe detail, never unsupported', () => {
  assert.deepEqual(probeOutcome({ ok: false, stderr: 'ENOENT' }, CEILING), { kind: 'probe-failed', detail: 'ENOENT' });
  assert.deepEqual(probeOutcome({ ok: false, error: 'spawn herdr ENOENT' }, CEILING), { kind: 'probe-failed', detail: 'spawn herdr ENOENT' });
  assert.deepEqual(probeOutcome({ ok: false, code: 3, stderr: '' }, CEILING), { kind: 'probe-failed', detail: 'exit 3' });
  assert.deepEqual(probeOutcome({ ok: false }, CEILING), { kind: 'probe-failed', detail: 'no output' });
  assert.deepEqual(probeOutcome(undefined, CEILING), { kind: 'probe-failed', detail: 'no output' });
});

test('AC4 probeOutcome: detail is trimmed and capped at 200 characters', () => {
  const long = `  ${'x'.repeat(500)}  `;
  const out = probeOutcome({ ok: false, stderr: long }, CEILING);
  assert.equal(out.kind, 'probe-failed');
  assert.equal(out.detail.length, 200);
  assert.equal(out.detail, 'x'.repeat(200));
});

test('AC4 probeOutcome: a parsed too-new version is unsupported with the existing token text', () => {
  assert.deepEqual(probeOutcome({ ok: true, stdout: 'herdr 9.9.9' }, CEILING), {
    kind: 'unsupported', token: 'untested herdr version 9.9.9 (tested <= 0.7.4)',
  });
});

test('AC4 probeOutcome: the tested ceiling and older versions are supported', () => {
  assert.deepEqual(probeOutcome({ ok: true, stdout: 'herdr 0.7.4' }, CEILING), { kind: 'supported' });
  assert.deepEqual(probeOutcome({ ok: true, stdout: 'herdr 0.7.3\n' }, CEILING), { kind: 'supported' });
});

test('AC4 probeOutcome: a successful probe with unparseable output is still unsupported (versionGate unchanged)', () => {
  assert.deepEqual(probeOutcome({ ok: true, stdout: '' }, CEILING), {
    kind: 'unsupported', token: 'untested herdr version (unparseable)',
  });
  assert.deepEqual(probeOutcome({ ok: true, stdout: 'something weird' }, CEILING), {
    kind: 'unsupported', token: 'untested herdr version (unparseable)',
  });
});

test('AC4 probeOutcome does not mutate its input', () => {
  const version = { ok: false, stderr: '  boom  ' };
  const before = JSON.stringify(version);
  probeOutcome(version, CEILING);
  assert.equal(JSON.stringify(version), before);
});

// ---- AC5: the real bin retries a failed probe and never publishes a token for it

function makeFixture({ failFirst }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-probe-'));
  fixtures.add(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-probe', ticketHash: 'x' }));
  writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), JSON.stringify({ seq: 1, ticket: 't-probe', data: { phase: 'p4' } }));
  const logPath = join(dir, 'herdr-calls.log');
  const countPath = join(dir, 'version-calls');
  // herdr stub: the Nth `--version` call fails (exit 1, stderr "boom") while
  // N <= failFirst; later calls print the tested ceiling. Every argv is logged.
  // The shim drains stdin so a caller writing to it can never EPIPE.
  const herdrStub = join(dir, 'herdr');
  writeFileSync(herdrStub, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in',
    '  "--version ")',
    `    n=$(cat "${countPath}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${countPath}"`,
    `    if [ "$n" -le ${failFirst} ]; then echo "boom" >&2; exit 1; fi`,
    '    echo "herdr 0.7.4" ;;',
    `  "api snapshot") echo '{"result":{"snapshot":{"panes":[{"pane_id":"w1:p1","workspace_id":"w1","foreground_cwd":"${repo}"}]}}}' ;;`,
    '  *) : ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(herdrStub, 0o755);
  const adlcStub = join(dir, 'adlc');
  writeFileSync(adlcStub, [
    '#!/bin/sh',
    'if [ "$1 $2 $3" = "ticket store export" ]; then',
    '  out="$5"',
    `  printf '{"tickets":[{"id":"t-probe","completed":false,"edges":[]}]}' > "$out"`,
    'fi',
    'exit 0',
  ].join('\n'));
  chmodSync(adlcStub, 0o755);
  return { dir, logPath, countPath };
}

function startWatcher(dir, retryMs) {
  // Through the directory's bounded helper (scripts/test/hook-spawn-timeout-drift):
  // a daemon the test forgets to kill is reaped at the deadline.
  const child = spawnHookAsync([script], {
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HERDR_BIN_PATH: join(dir, 'herdr'),
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_SOCKET_PATH: '',
      ADLC_HERDR_PROBE_RETRY_MS: String(retryMs),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

const readLog = (logPath) => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');

test('AC5 a probe that fails once logs a retry line, publishes no token, re-probes, then starts normally', async () => {
  const { dir, logPath, countPath } = makeFixture({ failFirst: 1 });
  const { child, stderr } = startWatcher(dir, 100);
  try {
    // Wait for the normal start marker: the clear-token call only happens on the SUPPORTED path.
    for (let i = 0; i < 100 && !readLog(logPath).includes('--clear-token adlc'); i += 1) await sleep(50);
    const calls = readLog(logPath).split('\n').filter(Boolean);
    assert.equal(readFileSync(countPath, 'utf8').trim(), '2', `expected exactly two --version probes, log:\n${calls.join('\n')}`);
    assert.match(stderr(), /\[adlc watcher\] herdr --version probe failed: boom; retrying in 100 ms/);
    assert.equal((stderr().match(/probe failed/g) ?? []).length, 1, 'exactly one retry line for one failure');
    assert.ok(!calls.some((l) => l.includes('--token adlc=')), `a failed probe must publish NO token:\n${calls.join('\n')}`);
    const firstVersion = calls.indexOf('--version');
    const secondVersion = calls.indexOf('--version', firstVersion + 1);
    const clear = calls.findIndex((l) => l.includes('--clear-token adlc'));
    assert.ok(firstVersion === 0 && secondVersion > firstVersion && clear > secondVersion,
      `expected --version, --version, then the normal start; got:\n${calls.join('\n')}`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('AC5 a probe that keeps failing keeps re-probing and never publishes anything', async () => {
  const { dir, logPath } = makeFixture({ failFirst: 1_000_000 });
  const { child, stderr } = startWatcher(dir, 60);
  try {
    for (let i = 0; i < 60 && (stderr().match(/probe failed/g) ?? []).length < 3; i += 1) await sleep(50);
    const retries = (stderr().match(/probe failed: boom; retrying in 60 ms/g) ?? []).length;
    assert.ok(retries >= 3, `expected at least 3 retry lines, got ${retries}:\n${stderr()}`);
    const calls = readLog(logPath).split('\n').filter(Boolean);
    assert.ok(calls.every((l) => l === '--version'), `only --version probes may run while the probe fails:\n${calls.join('\n')}`);
    assert.equal(child.exitCode, null, 'the watcher must still be alive (not exited after the first failure)');
  } finally {
    child.kill('SIGKILL');
  }
});

test('AC5 regression: a parsed too-new version still publishes the single warning token and stops', async () => {
  const { dir, logPath } = makeFixture({ failFirst: 0 });
  // Override the stub's version line to a too-new version.
  const stub = readFileSync(join(dir, 'herdr'), 'utf8').replace('echo "herdr 0.7.4"', 'echo "herdr 9.9.9"');
  writeFileSync(join(dir, 'herdr'), stub);
  const { child, stderr } = startWatcher(dir, 100);
  try {
    for (let i = 0; i < 100 && !readLog(logPath).includes('--token adlc='); i += 1) await sleep(50);
    const calls = readLog(logPath).split('\n').filter(Boolean);
    assert.ok(calls.some((l) => l.includes('--token adlc=untested herdr version 9.9.9')), `degrade token expected:\n${calls.join('\n')}`);
    assert.ok(!calls.some((l) => l.includes('--clear-token')), 'the unsupported path must not start normally');
    assert.ok(!/probe failed/.test(stderr()), 'a successful probe is not a failed probe');
  } finally {
    child.kill('SIGKILL');
  }
});

test('AC5 the smallest positive retry override (1 ms) is honoured, not replaced by the heartbeat default', async () => {
  const { dir } = makeFixture({ failFirst: 1_000_000 });
  const { child, stderr } = startWatcher(dir, 1);
  try {
    for (let i = 0; i < 60 && !/probe failed/.test(stderr()); i += 1) await sleep(50);
    assert.match(stderr(), /retrying in 1 ms/, `a 1 ms override must be used verbatim:\n${stderr()}`);
    assert.ok(!/retrying in 45000 ms/.test(stderr()), 'the heartbeat default must not replace a valid override');
  } finally {
    child.kill('SIGKILL');
  }
});

test('AC5 a non-positive or non-numeric retry override falls back to the heartbeat default', async () => {
  const { dir } = makeFixture({ failFirst: 1_000_000 });
  for (const bad of ['0', '-5', 'soon']) {
    const { child, stderr } = startWatcher(dir, bad);
    try {
      for (let i = 0; i < 60 && !/probe failed/.test(stderr()); i += 1) await sleep(50);
      assert.match(stderr(), /retrying in 45000 ms/, `override ${JSON.stringify(bad)} must fall back:\n${stderr()}`);
    } finally {
      child.kill('SIGKILL');
    }
  }
});
