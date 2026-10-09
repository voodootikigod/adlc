// The hook runs `adlc` for preflight, flail detection, the manifest check, the
// review notice and the two bypass recorders. A repository can put its own
// node_modules/.bin/adlc ahead of the real one on PATH, so the hook resolves
// adlc with node_modules entries skipped, and only the calls that sign or
// verify (gate-manifest record / verify) receive the signing key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import { spawnHook } from './helpers/run-hook.mjs';
import { ownershipRejection, resolveTrustedBinary, untrustedBinaryReason } from '../adlc-hook.mjs';

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

// A `sudo npm i -g` install: a root-owned symlink (lstat always reports 0777 for a
// link) in a root-owned directory, pointing at a root-owned file nobody else can write.
const ROOT_FILE = { uid: 0, mode: 0o100755 };
const ROOT_LINK = { uid: 0, mode: 0o120777 };
const ROOT_DIR = { uid: 0, mode: 0o40755 };
const SELF = 1000;

test('a sudo npm -g install (root symlink, root directory, root file) is trusted', () => {
  assert.equal(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }, SELF), null);
  assert.equal(ownershipRejection({ file: ROOT_FILE, link: ROOT_FILE, dir: ROOT_DIR }, SELF), null, 'a root file placed directly in the directory');
});

test('a root-owned file that group or others can write is refused', () => {
  for (const mode of [0o100775, 0o100757]) {
    assert.match(ownershipRejection({ file: { uid: 0, mode }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /writable by group or others/);
  }
});

test('a link someone else planted that points at a root-owned program is refused', () => {
  assert.match(ownershipRejection({ file: ROOT_FILE, link: { uid: SELF, mode: 0o120777 }, dir: ROOT_DIR }, SELF), /link that root does not own/);
});

test('a root-owned file in a directory others can write, or that root does not own, is refused', () => {
  assert.match(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: { uid: 0, mode: 0o41777 } }, SELF), /its directory/);
  assert.match(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: { uid: SELF, mode: 0o40755 } }, SELF), /its directory/);
});

test('an adlc owned by another non-root account is refused with its uid; the user\'s own is trusted', () => {
  assert.match(ownershipRejection({ file: { uid: 1001, mode: 0o100755 }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /uid 1001/);
  assert.equal(ownershipRejection({ file: { uid: SELF, mode: 0o100755 }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), null);
});

// The resolver and the diagnostic share one decision; these drive it through the real filesystem.
const NOT_ROOT = process.getuid?.() === 0 && 'running as root';

test('a root-owned system symlink, the shape sudo npm -g creates, is resolved', { skip: NOT_ROOT }, (t) => {
  let st;
  try { st = lstatSync('/usr/bin/sh'); } catch { /* absent */ }
  if (!st?.isSymbolicLink() || st.uid !== 0) return t.skip('no root-owned /usr/bin/sh symlink on this host');
  assert.equal(resolveTrustedBinary('sh', '/usr/bin'), '/usr/bin/sh');
});

test('a symlink I own named adlc, pointing at a root-owned shell, is neither run nor trusted', { skip: NOT_ROOT }, (t) => {
  const dir = tmp(t, 'adlc-cc-shlink-');
  symlinkSync('/bin/sh', join(dir, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', dir), null);
  assert.match(untrustedBinaryReason('adlc', dir), /link that root does not own/);
});

test('a refused adlc is not blamed when a trusted one later on PATH resolves', (t) => {
  const pathEnv = `${plantedAdlc(t, join(tmp(t, 'adlc-cc-marker-'), 'ran'))}:${recordingAdlc(t, tmp(t, 'adlc-cc-dumps-'))}`;
  assert.equal(untrustedBinaryReason('adlc', pathEnv), null);
});

// The hook is spawned by absolute node path, so these PATHs leave out node's own
// directory, which can hold a real global adlc that would mask the case under test.
function runModeIsolated(mode, cwd, pathEnv) {
  return spawnHook([HOOK, mode], { cwd, input: '{}', env: { ...process.env, PATH: `${pathEnv}:/usr/bin:/bin` } });
}

function systemMessages(stdout) {
  return stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).systemMessage; } catch { return undefined; } }).filter(Boolean);
}

test('an adlc rejected for living in node_modules is named at session start, not silently skipped', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  const planted = plantedAdlc(t, marker);
  const r = runModeIsolated('preflight', adlcRepo(t), planted);
  const msg = systemMessages(r.stdout ?? '').join('\n');
  assert.ok(msg.includes(join(planted, 'adlc')), msg);
  const context = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l).hookSpecificOutput).find(Boolean);
  assert.equal(context?.hookEventName, 'SessionStart');
  assert.ok(context.additionalContext.includes(join(planted, 'adlc')), 'the model is not told why preflight did not run');
  assert.match(msg, /node_modules/);
  assert.equal(existsSync(marker), false, 'the diagnostic ran the rejected binary');
});

test('an adlc rejected for living in node_modules is named when the Stop manifest check cannot run', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  const planted = plantedAdlc(t, marker);
  const r = runModeIsolated('manifest', adlcRepo(t), planted);
  const msg = systemMessages(r.stdout ?? '').join('\n');
  assert.ok(msg.includes(join(planted, 'adlc')), msg);
  assert.match(msg, /node_modules/);
  assert.equal(existsSync(marker), false);
});

test('with no adlc on PATH at all, session start and the Stop check stay silent', (t) => {
  const empty = tmp(t, 'adlc-cc-empty-');
  assert.deepEqual(systemMessages(runModeIsolated('preflight', adlcRepo(t), empty).stdout ?? ''), []);
  assert.deepEqual(systemMessages(runModeIsolated('manifest', adlcRepo(t), empty).stdout ?? ''), []);
});

function railsBypass(t, pathEnv) {
  const repo = adlcRepo(t);
  writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'fixture', rails: ['test/**'] }] }));
  return spawnHook([HOOK, 'rails'], {
    cwd: repo,
    input: JSON.stringify({ cwd: repo, tool_input: { file_path: join(repo, 'test', 'x.mjs') } }),
    env: { ...process.env, ADLC_RAILS_BYPASS: '1', PATH: `${pathEnv}:/usr/bin:/bin` },
  });
}

/** A trusted adlc that runs and fails, as an unwritable .adlc would make it. */
function failingAdlc(t) {
  const dir = tmp(t, 'adlc-cc-failing-');
  writeFileSync(join(dir, 'adlc'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'adlc'), 0o755);
  return dir;
}

test('a rails bypass whose trusted adlc failed keeps the generic cause instead of blaming a refused one', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  const r = railsBypass(t, `${plantedAdlc(t, marker)}:${failingAdlc(t)}`);
  assert.match(r.stdout ?? '', /"permissionDecision":"deny"/);
  assert.match(r.stdout ?? '', /is @adlc\/cli installed/);
  assert.doesNotMatch(r.stdout ?? '', /was not run because/);
  assert.equal(existsSync(marker), false);
});

test('a rails bypass refused for want of a trusted adlc names the rejected one', (t) => {
  const marker = join(tmp(t, 'adlc-cc-marker-'), 'ran');
  const r = railsBypass(t, plantedAdlc(t, marker));
  assert.match(r.stdout ?? '', /"permissionDecision":"deny"/);
  assert.match(r.stdout ?? '', /node_modules/);
  assert.doesNotMatch(r.stdout ?? '', /is @adlc\/cli installed/);
  assert.equal(existsSync(marker), false);
});
