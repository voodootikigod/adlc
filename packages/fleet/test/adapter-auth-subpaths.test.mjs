import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homeState as agyHome } from '../lib/adapters/agy.mjs';
import { homeState as jetskiHome } from '../lib/adapters/jetski.mjs';
import { detectBinary } from '../lib/adapters/gemini.mjs';

test('agy and jetski adapters exclude root .antigravity and .jetski dirs from writable homeState.dirs', () => {
  assert.ok(!agyHome.dirs.includes('.antigravity'));
  assert.deepEqual(
    agyHome.dirs.filter((d) => d.startsWith('.antigravity')),
    ['.antigravity/logs', '.antigravity/sessions', '.antigravity/tmp'],
  );
  assert.ok(!jetskiHome.dirs.includes('.jetski'));
  assert.deepEqual(
    jetskiHome.dirs.filter((d) => d.startsWith('.jetski')),
    ['.jetski/logs', '.jetski/sessions', '.jetski/tmp'],
  );
  for (const home of [agyHome, jetskiHome]) {
    for (const keep of ['.gemini/tmp', '.gemini/sessions', '.cache/gemini']) assert.ok(home.dirs.includes(keep));
    assert.deepEqual(home.files, ['.gemini/oauth_creds.json', '.gemini/google_accounts.json']);
  }
});

test('gemini detectBinary skips group-writable and world-writable candidate binaries and directories on POSIX while preserving win32 lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-auth-subpaths-'));
  try {
    const mkBin = (name, dirMode, fileMode, ext = '') => {
      const dir = join(root, name);
      mkdirSync(dir);
      const file = join(dir, `agy${ext}`);
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, fileMode);
      chmodSync(dir, dirMode);
      return { dir, file };
    };
    const safe = mkBin('safe', 0o755, 0o755);
    const groupFile = mkBin('group-file', 0o755, 0o775);
    const worldFile = mkBin('world-file', 0o755, 0o757);
    const groupDir = mkBin('group-dir', 0o775, 0o755);
    const worldDir = mkBin('world-dir', 0o777, 0o755);

    assert.equal(detectBinary(['agy'], { PATH: safe.dir }, 'linux'), safe.file);
    for (const bad of [groupFile, worldFile, groupDir, worldDir]) {
      assert.equal(detectBinary(['agy'], { PATH: bad.dir }, 'linux'), null);
      assert.equal(detectBinary(['agy'], { PATH: `${bad.dir}:${safe.dir}` }, 'linux'), safe.file);
    }

    const win = mkBin('win', 0o777, 0o777, '.cmd');
    assert.equal(detectBinary(['agy'], { PATH: win.dir, PATHEXT: '.cmd' }, 'win32'), win.file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
