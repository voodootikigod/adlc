// Teardown contract for the smoke/proof scripts that the test runner executes:
// every temp directory a script creates under TMPDIR is gone when it exits, and
// git processes spawned on the script's behalf run auto-maintenance in the
// foreground, so no detached child can still be writing under a directory the
// script is removing.
//
// Each script runs with a private TMPDIR (os.tmpdir() honours it), so "nothing
// left behind" is an exact, parallel-safe check: an empty directory, not a
// before/after count of a shared one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = (name) => join(REPO, 'scripts', name);

function writeExecutable(dir, name, lines) {
  const path = join(dir, name);
  writeFileSync(path, [...lines, ''].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

function runScript(name, args, env) {
  return spawnSync(process.execPath, [script(name), ...args], { env, encoding: 'utf8' });
}

test('copilot-live-deny removes every lab it creates (all three legs)', (t) => {
  const privateTmp = tmp(t, 'teardown-copilot-tmp-');
  const home = tmp(t, 'teardown-copilot-home-');
  const bin = tmp(t, 'teardown-copilot-bin-');
  writeExecutable(bin, 'copilot', [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--version"* ]]; then echo mock; exit 0; fi',
    'if [[ "$*" == *"--deny-tool shell"* ]]; then echo "Permission denied due to the following rules: shell"; exit 0; fi',
    'if [[ "$*" == *"--allow-all-tools"* ]]; then printf CHANGED > protected/rail.txt; exit 0; fi',
    'exit 0',
  ]);
  const { ADLC_COPILOT_LIVE_INSTALL: _live, ...base } = process.env;
  const r = runScript('copilot-live-deny.mjs', ['--require'], {
    ...base, ADLC_COPILOT_LIVE_INSTALL: '1', HOME: home, TMPDIR: privateTmp, PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /deny-tool ok/, 'all three legs ran, so all three labs were created');
  assert.deepEqual(readdirSync(privateTmp), [], 'a lab directory survived the run');
});

test('copilot-live-deny removes its labs when a leg fails', (t) => {
  const privateTmp = tmp(t, 'teardown-copilot-tmp-');
  const home = tmp(t, 'teardown-copilot-home-');
  const bin = tmp(t, 'teardown-copilot-bin-');
  writeExecutable(bin, 'copilot', [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--version"* ]]; then echo mock; exit 0; fi',
    'exit 0',
  ]);
  const { ADLC_COPILOT_LIVE_INSTALL: _live, ...base } = process.env;
  const r = runScript('copilot-live-deny.mjs', ['--require'], {
    ...base, ADLC_COPILOT_LIVE_INSTALL: '1', HOME: home, TMPDIR: privateTmp, PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /CONTROL FAILED/);
  assert.deepEqual(readdirSync(privateTmp), [], 'a lab directory survived a failing run');
});

test('gemini-install-smoke removes its fixture repository', (t) => {
  const privateTmp = tmp(t, 'teardown-gemini-tmp-');
  const r = runScript('gemini-install-smoke.mjs', [REPO], { ...process.env, TMPDIR: privateTmp });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /shim denies a frozen-rail write/, 'the fixture was created and driven');
  assert.deepEqual(readdirSync(privateTmp), [], 'the gemini-smoke fixture survived the run');
});

test('codex-install-smoke runs git under codex with foreground auto-maintenance, and removes its roots', (t) => {
  const privateTmp = tmp(t, 'teardown-codex-tmp-');
  const bin = tmp(t, 'teardown-codex-bin-');
  const seen = join(tmp(t, 'teardown-codex-out-'), 'git-config.txt');
  // Stands in for the codex CLI: records the gc settings any git it spawns would
  // see, then fails the first call so the smoke goes straight to teardown.
  writeExecutable(bin, 'codex', [
    '#!/usr/bin/env bash',
    `{ echo "autoDetach=$(git config --get gc.autoDetach)"; } > '${seen}'`,
    'exit 1',
  ]);
  const { ADLC_CODEX_SMOKE_FAIL_AFTER_TEMP: _fail, ...base } = process.env;
  const r = runScript('codex-install-smoke.mjs', [REPO], {
    ...base, ADLC_CODEX_LIVE_INSTALL: '1', TMPDIR: privateTmp, PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /codex plugin marketplace add .* failed/);
  assert.equal(readFileSync(seen, 'utf8').trim(), 'autoDetach=false');
  assert.deepEqual(readdirSync(privateTmp), [], 'a codex temp root survived the run');
});
