// End-to-end subprocess test for bin/watcher.mjs — the visibility core, which
// previously had NO executable coverage (P5 tests-lens high finding). A
// scripted `herdr` stub logs every argv; a temp `.adlc/` fixture supplies
// ticket state. Asserts the daemon actually publishes the expected pane and
// workspace tokens, and — the load-bearing invariant — NEVER calls
// report-agent. The watcher runs a heartbeat loop, so we sample the first
// publish burst and kill it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'watcher.mjs');

let dir;
let repo;
let logPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-watcher-e2e-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-e2e', ticketHash: 'x' }));
  writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), JSON.stringify({ seq: 1, ticket: 't-e2e', data: { phase: 'p4' } }));
  logPath = join(dir, 'herdr-calls.log');

  // herdr stub: report a version, a snapshot with one pane rooted in `repo`,
  // and log every invocation. `--version` must print the tested ceiling so the
  // version gate passes.
  const herdrStub = join(dir, 'herdr');
  writeFileSync(herdrStub, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in',
    '  "--version ") echo "herdr 0.7.4" ;;',
    `  "api snapshot") echo '{"result":{"snapshot":{"panes":[{"pane_id":"w1:p1","workspace_id":"w1","foreground_cwd":"${repo}"}]}}}' ;;`,
    '  *) : ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(herdrStub, 0o755);

  // adlc stub: `ticket store export --output <path>` writes an envelope.
  const adlcStub = join(dir, 'adlc');
  writeFileSync(adlcStub, [
    '#!/bin/sh',
    'if [ "$1 $2 $3" = "ticket store export" ]; then',
    '  out="$5"',
    `  printf '{"tickets":[{"id":"t-e2e","completed":false,"edges":[]},{"id":"t-ready","completed":false,"edges":[]}]}' > "$out"`,
    'fi',
    'exit 0',
  ].join('\n'));
  chmodSync(adlcStub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runWatcherBriefly(extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HERDR_BIN_PATH: join(dir, 'herdr'),
      HERDR_WORKSPACE_ID: 'w1',
      HERDR_SOCKET_PATH: '', // no socket — force polling path only
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  // let startup + first full refresh publish (pane then workspace tokens)
  for (let i = 0; i < 40 && !existsSync(logPath); i += 1) await sleep(50);
  for (let i = 0; i < 40; i += 1) {
    const seen = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    // wait for the actual backlog token line, not the startup clear-token call
    if (seen.includes('adlc_ready')) break;
    await sleep(50);
  }
  child.kill('SIGKILL');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

test('publishes the pane ticket/phase tokens for the mapped pane', async () => {
  const calls = await runWatcherBriefly();
  const paneReport = calls.split('\n').find((l) => l.startsWith('pane report-metadata w1:p1'));
  assert.ok(paneReport, `no pane report-metadata call in:\n${calls}`);
  assert.ok(paneReport.includes('ticket=t-e2e'));
  assert.ok(paneReport.includes('phase=P4'));
});

test('publishes aggregated workspace backlog tokens', async () => {
  const calls = await runWatcherBriefly();
  // The first workspace call is the startup version-warning clear; the backlog
  // token line is the one that carries adlc_ready.
  const wsReport = calls.split('\n').find((l) => l.startsWith('workspace report-metadata w1') && l.includes('adlc_ready'));
  assert.ok(wsReport, `no workspace backlog call in:\n${calls}`);
  assert.ok(wsReport.includes('adlc_ready=1')); // t-ready ready; t-e2e is active → in-flight
  assert.ok(wsReport.includes('adlc_active=1'));
});

test('NEVER calls report-agent — agent state belongs to herdr built-ins', async () => {
  const calls = await runWatcherBriefly();
  assert.ok(!calls.includes('report-agent'), `report-agent must never be emitted:\n${calls}`);
});
