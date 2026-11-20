import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertGitDirTreeSafe, assertMirrorConfigPristine, MIRROR_CONFIG_ALLOWED_KEYS, HOST_SAFE_GIT_FLAGS, DEFAULT_MAX_MIRROR_DEPTH, DEFAULT_MAX_MIRROR_ENTRIES, DEFAULT_MAX_MIRROR_BYTES } from '../lib/git-mirror.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-escape-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('assertGitDirTreeSafe rejects symlinks, hardlinks, FIFOs, objects/info/alternates, shallow, and core.logallrefupdates', () => {
  withDir((dir) => { mkdirSync(join(dir, 'refs')); writeFileSync(join(dir, 'HEAD'), 'x'); assert.doesNotThrow(() => assertGitDirTreeSafe(dir)); });
  withDir((dir) => {
    mkdirSync(join(dir, 'refs'));
    symlinkSync('/etc/passwd', join(dir, 'refs', 'link'));
    assert.throws(() => assertGitDirTreeSafe(dir), /Unsafe git mirror entry: refs\/link/);
  });
  withDir((dir) => {
    writeFileSync(join(dir, 'a'), 'x');
    linkSync(join(dir, 'a'), join(dir, 'b'));
    assert.throws(() => assertGitDirTreeSafe(dir), /Unsafe git mirror entry: [ab]$/);
  });
  withDir((dir) => {
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    assert.throws(() => assertGitDirTreeSafe(dir), /Unsafe git mirror entry: fifo/);
  });
  withDir((dir) => {
    mkdirSync(join(dir, 'objects', 'info'), { recursive: true });
    writeFileSync(join(dir, 'objects', 'info', 'alternates'), '/x');
    assert.throws(() => assertGitDirTreeSafe(dir), /Unsafe git mirror entry: objects\/info\/alternates/);
  });
  withDir((dir) => {
    writeFileSync(join(dir, 'shallow'), '');
    assert.throws(() => assertGitDirTreeSafe(dir), /Unsafe git mirror entry: shallow/);
  });
  assert.ok(!MIRROR_CONFIG_ALLOWED_KEYS.includes('core.logallrefupdates'));
  assert.deepEqual([...HOST_SAFE_GIT_FLAGS], ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=/bin/false', '-c', 'core.logallrefupdates=false']);
  withDir((dir) => {
    execFileSync('git', ['init', '-q', '--bare', dir]);
    execFileSync('git', ['config', '--file', join(dir, 'config'), 'core.logallrefupdates', 'true']);
    assert.throws(() => assertMirrorConfigPristine({ mirror: dir }), /core\.logallrefupdates/);
  });
});

test('assertGitDirTreeSafe enforces bounded depth, entry count, and total byte limits', () => {
  assert.equal(DEFAULT_MAX_MIRROR_DEPTH, 32);
  assert.equal(DEFAULT_MAX_MIRROR_ENTRIES, 65536);
  assert.equal(DEFAULT_MAX_MIRROR_BYTES, 512 * 1024 * 1024);
  withDir((dir) => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f'), 'abcd');
    assert.doesNotThrow(() => assertGitDirTreeSafe(dir, { maxDepth: 2, maxEntries: 3, maxBytes: 4 }));
    assert.throws(() => assertGitDirTreeSafe(dir, { maxDepth: 1 }), /directory depth exceeds 1/);
    assert.throws(() => assertGitDirTreeSafe(dir, { maxEntries: 2 }), /entry count exceeds 2/);
    assert.throws(() => assertGitDirTreeSafe(dir, { maxBytes: 3 }), /total size exceeds 3 bytes/);
  });
});
