// End-to-end subprocess tests for bin/on-event.mjs — drives the real event
// dispatcher with a scripted `herdr` (and `adlc`) stub that logs every call.
// Verifies the imports resolve at runtime and the plan→execution wiring: a
// pane.exited clears that pane's tokens; a matching worktree.created notifies;
// a malformed event does nothing.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'on-event.mjs');

let dir;
let repo;
let logPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-onevent-'));
  logPath = join(dir, 'herdr-calls.log');
  repo = join(dir, 'repo');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  // herdr stub: log every call; answer `pane get` with a repo-rooted pane.
  const herdr = join(dir, 'herdr');
  writeFileSync(herdr, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in',
    `  "pane get") echo '{"result":{"pane":{"foreground_cwd":"${repo}"}}}' ;;`,
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(herdr, 0o755);
  // adlc stub: `ticket list --json` returns one ticket id matching a branch.
  const adlc = join(dir, 'adlc');
  writeFileSync(adlc, '#!/bin/sh\nif [ "$1 $2 $3" = "ticket list --json" ]; then echo \'[{"id":"t-match","title":"x"}]\'; fi\nexit 0\n');
  chmodSync(adlc, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runEvent = (event, json, extraEnv = {}) => spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  timeout: 15_000,
  env: {
    ...process.env,
    PATH: `${dir}:/usr/bin:/bin`,
    HERDR_BIN_PATH: join(dir, 'herdr'),
    HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
    HERDR_PLUGIN_EVENT: event,
    HERDR_PLUGIN_EVENT_JSON: json,
    ...extraEnv,
  },
});
const calls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');

test('pane.exited clears that pane\'s ADLC tokens', () => {
  const res = runEvent('pane.exited', JSON.stringify({ event: 'pane_exited', data: { pane_id: 'w4:p2' } }));
  assert.equal(res.status, 0);
  const log = calls();
  assert.ok(log.includes('pane report-metadata w4:p2'), `no clear call in: ${log}`);
  assert.ok(log.includes('--clear-token ticket'));
});

test('worktree.created for a branch matching a ticket fires a notification', () => {
  const payload = JSON.stringify({
    event: 'worktree_created',
    data: { workspace: { workspace_id: 'w9', label: 't-match', worktree: { repo_root: repo, checkout_path: repo } } },
  });
  const res = runEvent('worktree.created', payload);
  assert.equal(res.status, 0);
  assert.ok(calls().includes('notification show'), `no notification in: ${calls()}`);
  assert.ok(calls().includes('t-match'));
});

test('worktree.created with a pointer already present does nothing', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-match', ticketHash: 'x' }));
  const payload = JSON.stringify({
    event: 'worktree_created',
    data: { workspace: { label: 't-match', worktree: { repo_root: repo, checkout_path: repo } } },
  });
  runEvent('worktree.created', payload);
  assert.ok(!calls().includes('notification show'), 'must not nag when already seeded');
});

test('agent going idle with an active ticket nudges to gate it (drives pane→repo resolution)', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle', agent: 'claude' } });
  const res = runEvent('pane.agent_status_changed', payload);
  assert.equal(res.status, 0);
  assert.ok(calls().includes('pane get w4:p2'), 'must resolve the pane to its repo via pane get');
  assert.ok(calls().includes('notification show'), `expected a gate nudge in: ${calls()}`);
  assert.ok(calls().includes('t-active'));
});

test('agent idle nudge is deduped — a second identical transition does not notify again', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle' } });
  runEvent('pane.agent_status_changed', payload); // first: notifies + marks
  const before = (calls().match(/notification show/g) || []).length;
  runEvent('pane.agent_status_changed', payload); // second: deduped
  const after = (calls().match(/notification show/g) || []).length;
  assert.equal(after, before, 'the same idle transition must not nudge twice (state-dir dedupe)');
});

test('agent idle in a non-repo pane does nothing (resolveRepoRoot → null)', () => {
  // point the herdr stub at a plain (non-git) dir
  const plain = join(dir, 'plain');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(dir, 'herdr'), [
    '#!/bin/sh', `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in', `  "pane get") echo '{"result":{"pane":{"foreground_cwd":"${plain}"}}}' ;;`, 'esac', 'exit 0',
  ].join('\n'));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle' } });
  runEvent('pane.agent_status_changed', payload);
  assert.ok(!calls().includes('notification show'), 'no repo → no active ticket → no nudge');
});

test('a malformed event JSON is a no-op (no crash, no calls)', () => {
  const res = runEvent('pane.exited', '{not json');
  assert.equal(res.status, 0);
  assert.equal(calls().trim(), '', 'nothing should be called');
});

test('an unknown event does nothing', () => {
  const res = runEvent('some.unknown', JSON.stringify({ data: {} }));
  assert.equal(res.status, 0);
  assert.equal(calls().trim(), '');
});
