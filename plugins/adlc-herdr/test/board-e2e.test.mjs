// End-to-end subprocess tests for bin/board.mjs: a scripted `herdr` stub and
// a real git fixture drive the actual entrypoint. Pins both sides of repo
// resolution — a resolvable repo must render the board header (not the
// refusal), and a non-repo must refuse. 'q' on stdin exits the loop.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs');

let dir;
let repo;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-board-e2e-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-e2e', ticketHash: 'x' }));
  const herdrStub = join(dir, 'herdr');
  writeFileSync(herdrStub, [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "pane get") echo '{"result":{"pane":{"foreground_cwd":"${repo}"}}}' ;;`,
    // one OTHER pane rooted in the same repo, so the pane->row extraction
    // (agent / agent_status / tokens.ticket) actually runs against a real pane
    `  "api snapshot") echo '{"result":{"snapshot":{"panes":[{"pane_id":"w1:p9","workspace_id":"w1","foreground_cwd":"${repo}","agent":"codex","agent_status":"blocked","tokens":{"ticket":"t-mapped"}}]}}}' ;;`,
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  chmodSync(herdrStub, 0o755);
  const adlcStub = join(dir, 'adlc');
  writeFileSync(adlcStub, '#!/bin/sh\nexit 1\n'); // backlog fails soft → "no tickets"
  chmodSync(adlcStub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runBoard = (contextJson) => spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  timeout: 15_000,
  input: 'q',
  env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    HERDR_BIN_PATH: join(dir, 'herdr'),
    HERDR_PLUGIN_CONTEXT_JSON: contextJson,
  },
});

test('a resolvable repo renders the board header, not the refusal', () => {
  const res = runBoard(JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: repo }));
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('ADLC board · repo'), `no header in: ${res.stdout.slice(0, 200)}`);
  assert.ok(res.stdout.includes('t-e2e'));
  assert.ok(!res.stdout.includes('does not resolve'));
});

test('the mapped pane row renders agent, status, and ticket from the snapshot', () => {
  const res = runBoard(JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: repo }));
  assert.equal(res.status, 0);
  // pane->row extraction (byId.get(...).agent / .agent_status / .tokens.ticket)
  assert.ok(res.stdout.includes('w1:p9'), 'the other pane must appear in the map');
  assert.ok(res.stdout.includes('codex'));
  assert.ok(res.stdout.includes('blocked'));
  assert.ok(res.stdout.includes('t-mapped'));
});

test('a non-repo directory refuses with the no-repo message', () => {
  const plain = join(dir, 'plain');
  mkdirSync(plain, { recursive: true });
  // repoint the stub's pane info at the non-repo dir
  writeFileSync(join(dir, 'herdr'), [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "pane get") echo '{"result":{"pane":{"foreground_cwd":"${plain}"}}}' ;;`,
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
  const res = runBoard(JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: plain }));
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('does not resolve to a git repository'));
});
