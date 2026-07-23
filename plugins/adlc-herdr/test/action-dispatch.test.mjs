// End-to-end subprocess tests for bin/action.mjs with a stub `herdr` at the
// front of PATH that records every invocation. Pins the fail-closed refuse
// path all the way through the real dispatcher: a bad context must end in a
// real notification call, nothing else spawned.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'action.mjs');

let dir;
let logPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-dispatch-'));
  logPath = join(dir, 'herdr-calls.log');
  const stub = join(dir, 'herdr');
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
