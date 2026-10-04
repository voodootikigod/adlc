// The hook runs `adlc` for preflight, flail detection, the manifest check, the
// review notice and the two bypass recorders. A repository can put its own
// node_modules/.bin/adlc ahead of the real one on PATH, so the hook resolves
// adlc with node_modules entries skipped, and only the calls that sign or
// verify (gate-manifest record / verify) receive the signing key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');
const KEY = 'manifest-key-must-not-leak';

/** A PATH dir whose `adlc` (a node script reached through a symlink, like a global install) records its env per subcommand. */
function recordingAdlc(t, dumpDir) {
  const dir = tmp(t, 'adlc-cc-trusted-');
  const impl = join(dir, 'adlc-impl.mjs');
  writeFileSync(impl, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(dumpDir)} + '/' + process.argv[2] + '.json', JSON.stringify(process.env));`,
    "process.stdout.write('{\"valid\":true,\"failedNames\":[],\"entries\":[]}');",
  ].join('\n'));
  chmodSync(impl, 0o755);
  symlinkSync(impl, join(dir, 'adlc'));
  return dir;
}

/** A node_modules/.bin dir whose `adlc` leaves `marker` behind if it ever runs. */
function plantedAdlc(t, marker) {
  const dir = join(tmp(t, 'adlc-cc-planted-'), 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'adlc'), `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`);
  chmodSync(join(dir, 'adlc'), 0o755);
  return dir;
}

/** An ADLC repo with a manifest, so both the preflight and manifest modes call adlc. */
function adlcRepo(t) {
  const dir = tmp(t, 'adlc-cc-repo-');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), '');
  return dir;
}

function runMode(mode, cwd, pathEnv) {
  return spawnHook([HOOK, mode], {
    cwd,
    input: '{}',
    env: { ...process.env, PATH: `${pathEnv}:${dirname(process.execPath)}:/usr/bin:/bin`, ADLC_MANIFEST_KEY: KEY },
  });
}

test('a node_modules adlc ahead of the real one on PATH never runs', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  const dumps = tmp(t, 'adlc-cc-dumps-');
  const pathEnv = `${plantedAdlc(t, marker)}:${recordingAdlc(t, dumps)}`;
  runMode('preflight', adlcRepo(t), pathEnv);
  assert.equal(existsSync(marker), false, 'the planted node_modules adlc ran');
  assert.equal(existsSync(join(dumps, 'preflight.json')), true, 'the real adlc further down PATH did not run');
});

test('only a node_modules adlc on PATH means adlc is not run at all', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  runMode('preflight', adlcRepo(t), plantedAdlc(t, marker));
  assert.equal(existsSync(marker), false);
});

test('a read-only call does not receive the signing key', (t) => {
  const dumps = tmp(t, 'adlc-cc-dumps-');
  runMode('preflight', adlcRepo(t), recordingAdlc(t, dumps));
  const env = JSON.parse(readFileSync(join(dumps, 'preflight.json'), 'utf8'));
  assert.equal(env.ADLC_MANIFEST_KEY, undefined, 'preflight received ADLC_MANIFEST_KEY');
});

test('the manifest verification still receives the signing key it needs', (t) => {
  const dumps = tmp(t, 'adlc-cc-dumps-');
  runMode('manifest', adlcRepo(t), recordingAdlc(t, dumps));
  const env = JSON.parse(readFileSync(join(dumps, 'gate-manifest.json'), 'utf8'));
  assert.equal(env.ADLC_MANIFEST_KEY, KEY, 'gate-manifest verify lost the key it verifies signatures with');
});

test('a non-node adlc executable is still run directly', (t) => {
  const dir = tmp(t, 'adlc-cc-shell-');
  const marker = join(dir, 'shell-ran');
  writeFileSync(join(dir, 'adlc'), `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`);
  chmodSync(join(dir, 'adlc'), 0o755);
  runMode('preflight', adlcRepo(t), dir);
  assert.equal(existsSync(marker), true, 'a shell-script adlc was not executed');
});

test('an extensionless node script runs under the hook\'s own node, not the interpreter its shebang names', (t) => {
  const dir = tmp(t, 'adlc-cc-shebang-');
  const dumps = tmp(t, 'adlc-cc-dumps-');
  writeFileSync(join(dir, 'adlc'), [
    '#!/nonexistent/bin/node',
    // CommonJS: Node 18 runs an extensionless file as CommonJS, without module detection.
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(dumps)} + '/' + process.argv[2] + '.json', '{}');`,
    "process.stdout.write('{\"failedNames\":[]}');",
  ].join('\n'));
  chmodSync(join(dir, 'adlc'), 0o755);
  runMode('preflight', adlcRepo(t), dir);
  assert.equal(existsSync(join(dumps, 'preflight.json')), true, 'the script was spawned through its unusable shebang');
});
