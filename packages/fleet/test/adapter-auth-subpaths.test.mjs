import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homeState as agyHome } from '../lib/adapters/agy.mjs';
import { homeState as jetskiHome } from '../lib/adapters/jetski.mjs';
import { detectBinary, dispatch, isTrustedPosixOwner, isSafePosixDir, verifyPosixExecutable } from '../lib/adapters/gemini.mjs';

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

    // Writable grandparent directory is refused even when immediate bin dir and file are 0755
    const gp = join(root, 'writable-grandparent');
    const gpBin = join(gp, 'bin');
    mkdirSync(gpBin, { recursive: true });
    writeFileSync(join(gpBin, 'agy'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(gpBin, 'agy'), 0o755);
    chmodSync(gpBin, 0o755);
    chmodSync(gp, 0o777);
    assert.equal(detectBinary(['agy'], { PATH: gpBin }, 'linux'), null);
    assert.equal(detectBinary(['agy'], { PATH: `${gpBin}:${safe.dir}` }, 'linux'), realpathSync(safe.file));

    // Symlink candidate and symlinked PATH directory pin canonical realpath on Linux
    const linkDir = join(root, 'symlink-bin');
    mkdirSync(linkDir, { mode: 0o755 });
    symlinkSync(safe.file, join(linkDir, 'agy'));
    assert.equal(detectBinary(['agy'], { PATH: linkDir }, 'linux'), realpathSync(safe.file));
    assert.equal(verifyPosixExecutable(join(linkDir, 'agy'), 'darwin'), realpathSync(safe.file));
    const symDirAlias = join(root, 'alias-to-safe-dir');
    symlinkSync(safe.dir, symDirAlias);
    assert.equal(verifyPosixExecutable(join(symDirAlias, 'agy'), 'linux'), realpathSync(safe.file));
    assert.equal(verifyPosixExecutable(join(symDirAlias, 'agy'), 'darwin'), join(symDirAlias, 'agy'));
    assert.equal(verifyPosixExecutable(safe.file, 'linux', 999999), null);

    const badLinkDir = join(root, 'bad-symlink-bin');
    mkdirSync(badLinkDir, { mode: 0o755 });
    symlinkSync(worldFile.file, join(badLinkDir, 'agy'));
    assert.equal(detectBinary(['agy'], { PATH: badLinkDir }, 'linux'), null);

    // Owner/sticky-dir helper predicates
    assert.equal(isTrustedPosixOwner({ uid: 500 }, null), true);
    assert.equal(isTrustedPosixOwner({ uid: 0 }, 1000), true);
    assert.equal(isTrustedPosixOwner({ uid: 1000 }, 1000), true);
    assert.equal(isTrustedPosixOwner({ uid: 2000 }, 1000), false);
    assert.equal(isSafePosixDir({ uid: 2000, mode: 0o755 }, 1000), false);
    assert.equal(isSafePosixDir({ uid: 0, mode: 0o1777 }, 1000), true);
    assert.equal(isSafePosixDir({ uid: 1000, mode: 0o1777 }, 1000), false);
    assert.equal(isSafePosixDir({ uid: 0, mode: 0o0777 }, 1000), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gemini dispatch re-verifies resolved binary before exec and blocks TOCTOU replacement races', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-toctou-'));
  try {
    const dir = join(root, 'bin');
    mkdirSync(dir, { mode: 0o755 });
    const bin = join(dir, 'agy');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const evil = join(root, 'evil.sh');
    writeFileSync(evil, '#!/bin/sh\nexit 0\n');
    chmodSync(evil, 0o777);

    let spawned = false;
    await assert.rejects(
      () => dispatch({
        worktree: root,
        prompt: 'hi',
        timeoutMs: 1000,
        env: { PATH: dir },
        resolveBinary: () => {
          // Simulate attacker replacing binary with a symlink to a world-writable target after detectBinary()
          rmSync(bin, { force: true });
          symlinkSync(evil, bin);
          return bin;
        },
        exec: async () => { spawned = true; return { status: 0, stdout: 'ok', stderr: '' }; },
      }),
      /failed pre-exec trust verification/,
    );
    assert.equal(spawned, false, 'exec must never be called when binary is tampered before launch');

    // Nonexistent stubbed command succeeds only when a custom exec stub is injected, and fails closed on defaultExec
    const stubRes = await dispatch({
      worktree: root,
      prompt: 'hi',
      timeoutMs: 1000,
      command: join(root, 'nonexistent-unit-stub'),
      exec: async () => ({ status: 0, stdout: 'stub-ok', stderr: '' }),
    });
    assert.equal(stubRes.exitCode, 0);

    await assert.rejects(
      () => dispatch({
        worktree: root,
        prompt: 'hi',
        timeoutMs: 1000,
        command: join(root, 'nonexistent-real-cmd'),
      }),
      /failed pre-exec trust verification/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
