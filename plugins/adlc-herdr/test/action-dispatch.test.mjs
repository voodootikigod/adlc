// End-to-end subprocess tests for bin/action.mjs with a stub `herdr` at the
// front of PATH that records every invocation. Pins the fail-closed refuse
// path all the way through the real dispatcher: a bad context must end in a
// real notification call, nothing else spawned.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'action.mjs');

let dir;
let repo;
let logPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-dispatch-'));
  logPath = join(dir, 'herdr-calls.log');
  repo = join(dir, 'repo');
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 't-d', ticketHash: 'x' }));
  const stub = join(dir, 'herdr');
  // herdr stub logs everything and answers `pane get` with a repo-rooted pane.
  writeFileSync(stub, [
    '#!/bin/sh',
    `echo "$@" >> "${logPath}"`,
    'case "$1 $2" in',
    `  "pane get") echo '{"result":{"pane":{"foreground_cwd":"${repo}"}}}' ;;`,
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Write an `adlc` stub that emits `gateJson` on the given exit code.
function writeAdlcStub(gateJson, exitCode) {
  const adlc = join(dir, 'adlc');
  writeFileSync(adlc, `#!/bin/sh\ncat <<'JSON'\n${gateJson}\nJSON\nexit ${exitCode}\n`);
  chmodSync(adlc, 0o755);
}

const paneCtx = () => JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: repo });

const runAction = (env) => spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  timeout: 15_000,
  env: {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    HERDR_BIN_PATH: join(dir, 'herdr'),
    ...env,
  },
});

test('a malformed context fails closed into a real notification (nothing else spawned)', () => {
  const res = runAction({ HERDR_PLUGIN_ACTION_ID: 'gate', HERDR_PLUGIN_CONTEXT_JSON: '{not json' });
  assert.equal(res.status, 0);
  const calls = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'exactly one herdr call: the notification');
  assert.ok(calls[0].startsWith('notification show ADLC'));
  assert.ok(calls[0].includes('cannot act'));
});

test('a missing context also refuses via notification', () => {
  const res = runAction({ HERDR_PLUGIN_ACTION_ID: 'gate' });
  assert.equal(res.status, 0);
  assert.ok(existsSync(logPath), 'the refuse path must actually notify');
  assert.ok(readFileSync(logPath, 'utf8').includes('notification show ADLC'));
});

test('gate: a failing verify (exit 2) fires the FAIL notification with the request sound', () => {
  writeAdlcStub('{"valid":false,"message":"chain break at seq 4"}', 2);
  const res = runAction({ HERDR_PLUGIN_ACTION_ID: 'gate', HERDR_PLUGIN_CONTEXT_JSON: paneCtx() });
  assert.equal(res.status, 0);
  // The notification body spans two lines (echo + message), so assert against
  // the full logged call, not a single physical line.
  const calls = readFileSync(logPath, 'utf8');
  assert.ok(calls.includes('notification show ADLC gate: FAIL'), `expected FAIL notification in:\n${calls}`);
  assert.ok(calls.includes('chain break'));
  assert.ok(calls.includes('--sound request'));
});

test('prosecute: fails closed with a notification and spawns NOTHING when adversarial-review is absent', () => {
  // git present (for repo resolution) but adversarial-review absent → the
  // requiresBin guard must trip. /usr/bin holds git; adversarial-review lives
  // in the fnm node dir, deliberately excluded here.
  const res = runAction({
    HERDR_PLUGIN_ACTION_ID: 'prosecute',
    HERDR_PLUGIN_CONTEXT_JSON: paneCtx(),
    PATH: `${dir}:/usr/bin:/bin`,
  });
  assert.equal(res.status, 0);
  const calls = readFileSync(logPath, 'utf8');
  assert.ok(calls.includes('notification show ADLC'), 'must notify the fail-closed reason');
  assert.ok(calls.includes('adversarial-review not on PATH'));
  assert.ok(!calls.includes('agent start'), 'nothing may be spawned when the binary is absent');
});
