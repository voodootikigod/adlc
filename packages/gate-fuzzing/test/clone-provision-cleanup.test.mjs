// provisionClone owns the clone it mints until it returns: any throw after the
// clone directory exists removes it before propagating, because the caller never
// receives the path and so cannot destroy it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, gitRepo } from '@adlc/core/test-kit';

import { provisionClone } from '../lib/clone.mjs';

function sourceRepo(t) {
  const { dir, git } = gitRepo(t, { prefix: 'gf-cleanup-src-' });
  writeFileSync(join(dir, 'rail.txt'), 'frozen\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('refusing to run setup without a sandbox removes the populated clone', (t) => {
  const tmpRoot = tmp(t, 'gf-cleanup-root-');
  const candidate = { diff: '', setup: [['node', '-e', '0']] };
  assert.throws(
    () => provisionClone(candidate, { repoRoot: sourceRepo(t), sandboxType: null, unsafeNoSandbox: false, tmpRoot }),
    /No OS sandbox binary/i,
  );
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('a throw while writing the candidate patch removes the clone', (t) => {
  const tmpRoot = tmp(t, 'gf-cleanup-root-');
  // Stands in for `git clone`: populates the clone and occupies the patch path
  // with a directory, so writing the patch throws EISDIR.
  const spawnFn = (_cmd, args) => {
    const cloneDir = args[args.length - 1];
    writeFileSync(join(cloneDir, 'rail.txt'), 'frozen\n');
    mkdirSync(join(cloneDir, '.gf-candidate.patch'));
    return { status: 0, stdout: '', stderr: '', signal: null };
  };
  assert.throws(
    () => provisionClone({ diff: 'x', setup: [] }, { repoRoot: '/unused', sandboxType: null, tmpRoot, spawnFn }),
    { code: 'EISDIR' },
  );
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('a successful provisioning hands the clone to the caller intact', (t) => {
  const tmpRoot = tmp(t, 'gf-cleanup-root-');
  const { cloneDir, applyFailed } = provisionClone({ diff: '', setup: [] }, { repoRoot: sourceRepo(t), sandboxType: null, tmpRoot });
  assert.equal(applyFailed, false);
  assert.deepEqual(readdirSync(tmpRoot), [cloneDir.slice(tmpRoot.length + 1)]);
  assert.ok(readdirSync(cloneDir).includes('rail.txt'));
});

test('a failed git clone throws and removes the clone directory', (t) => {
  const tmpRoot = tmp(t, 'gf-cleanup-root-');
  const spawnFn = () => ({ status: 128, stdout: '', stderr: 'fatal: not a repo\n', signal: null });
  assert.throws(
    () => provisionClone({ diff: '', setup: [] }, { repoRoot: '/unused', sandboxType: null, tmpRoot, spawnFn }),
    /git clone --local --no-hardlinks failed \(exit 128\): fatal: not a repo/,
  );
  assert.deepEqual(readdirSync(tmpRoot), []);
});
