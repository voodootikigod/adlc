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
let adlcRan;
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
  // A real on-disk ticket shard — ids are read from the FILESYSTEM, not a
  // subprocess. A booby-trapped `adlc` stub proves the handler never runs it.
  mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'tickets', `t-match--${'a'.repeat(64)}.json`), JSON.stringify({ id: 't-match', title: 'x' }));
  adlcRan = join(dir, 'adlc-ran');
  const adlc = join(dir, 'adlc');
  writeFileSync(adlc, `#!/bin/sh\ntouch "${adlcRan}"\nexit 0\n`); // must NEVER run
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

test('worktree.created matches the branch via a FILESYSTEM store read — notifies, and NEVER spawns adlc in the payload dir', () => {
  const payload = JSON.stringify({
    event: 'worktree_created',
    data: { workspace: { workspace_id: 'w9', label: 't-match', worktree: { repo_root: repo, checkout_path: repo } } },
  });
  const res = runEvent('worktree.created', payload);
  assert.equal(res.status, 0);
  assert.ok(calls().includes('notification show'), `no notification in: ${calls()}`);
  assert.ok(calls().includes('t-match'));
  // The security property: no subprocess ran with the untrusted repo as cwd.
  assert.ok(!existsSync(adlcRan), 'adlc must NEVER be executed for a worktree event (RCE guard)');
});

test('worktree.created for a branch that matches NO on-disk ticket does nothing (and still runs no subprocess)', () => {
  const payload = JSON.stringify({
    event: 'worktree_created',
    data: { workspace: { label: 'feature-x', worktree: { repo_root: repo, checkout_path: repo } } },
  });
  runEvent('worktree.created', payload);
  assert.ok(!calls().includes('notification show'), 'no nudge when the branch is not a ticket id');
  assert.ok(!existsSync(adlcRan));
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

test('a rapid re-idle within the dedupe window does not notify again', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle' } });
  // The window is a wall-clock bucket (floor(now/windowMs)), so a 60s window
  // flakes whenever the two runs straddle a minute boundary — CI hit exactly
  // that. MAX_SAFE_INTEGER keeps the entire test inside bucket 0, which makes
  // "within the window" true by construction instead of by luck.
  const window = { ADLC_HERDR_NUDGE_WINDOW_MS: String(Number.MAX_SAFE_INTEGER) };
  runEvent('pane.agent_status_changed', payload, window); // first: notify + mark
  const before = (calls().match(/notification show/g) || []).length;
  runEvent('pane.agent_status_changed', payload, window); // within window: suppressed
  const after = (calls().match(/notification show/g) || []).length;
  assert.equal(after, before, 'a flap within the window must not nudge twice');
});

test('a later idle (window elapsed) re-nudges — dedupe is a window, NOT permanent suppression', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle' } });
  // window 0 = every idle is a new cycle → must re-nudge (guards the HIGH bug).
  runEvent('pane.agent_status_changed', payload, { ADLC_HERDR_NUDGE_WINDOW_MS: '0' });
  const before = (calls().match(/notification show/g) || []).length;
  runEvent('pane.agent_status_changed', payload, { ADLC_HERDR_NUDGE_WINDOW_MS: '0' });
  const after = (calls().match(/notification show/g) || []).length;
  assert.equal(after, before + 1, 'a new idle cycle after the window must nudge again');
});

test('a pane exposing only cwd (no foreground_cwd) still resolves to its repo', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  // herdr stub returns a pane with cwd only — exercises the cwd fallback.
  writeFileSync(join(dir, 'herdr'), [
    '#!/bin/sh', `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in', `  "pane get") echo '{"result":{"pane":{"cwd":"${repo}"}}}' ;;`, 'esac', 'exit 0',
  ].join('\n'));
  const payload = JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'done' } });
  const res = runEvent('pane.agent_status_changed', payload);
  assert.equal(res.status, 0);
  assert.ok(calls().includes('notification show'), `cwd fallback must resolve the repo: ${calls()}`);
  assert.ok(calls().includes('t-active'));
});

test('with NO state dir the nudge still fires (can\'t dedupe → allow, not suppress)', () => {
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-active', ticketHash: 'x' }));
  const env = {
    ...process.env,
    PATH: `${dir}:/usr/bin:/bin`,
    HERDR_BIN_PATH: join(dir, 'herdr'),
    HERDR_PLUGIN_EVENT: 'pane.agent_status_changed',
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane_agent_status_changed', data: { pane_id: 'w4:p2', agent_status: 'idle' } }),
  };
  delete env.HERDR_PLUGIN_STATE_DIR; // no dedupe store available
  const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15_000, env });
  assert.equal(res.status, 0);
  assert.ok(calls().includes('notification show'), 'without a dedupe store, still nudge (allow, not suppress)');
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
