import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTrackedFiles, scopeShipped } from '../lib/detect.mjs';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-git-'));
  try {
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    mkdirSync(join(dir, 'plugins', 'adlc-widget'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'adlc-widget', 'index.mjs'), '// shipped\n');
    writeFileSync(join(dir, 'README.md'), '# scratch\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'initial'], dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('listTrackedFiles lists files tracked at a given ref', () => {
  withScratchRepo((dir) => {
    const files = listTrackedFiles('HEAD', dir);
    assert.ok(files.includes('plugins/adlc-widget/index.mjs'));
    assert.ok(files.includes('README.md'));
  });
});

test('listTrackedFiles does not see untracked working-tree files', () => {
  withScratchRepo((dir) => {
    writeFileSync(join(dir, 'scratch.txt'), 'untracked\n');
    const files = listTrackedFiles('HEAD', dir);
    assert.equal(files.includes('scratch.txt'), false);
  });
});

test('listTrackedFiles throws a clear error for an unresolvable ref', () => {
  withScratchRepo((dir) => {
    assert.throws(() => listTrackedFiles('not-a-real-ref', dir), /not-a-real-ref/);
  });
});

test('listTrackedFiles uses -z and splitNulPaths so newline-bearing paths with core.quotePath=false do not split into bogus entries (#785)', () => {
  withScratchRepo((dir) => {
    git(['config', 'core.quotePath', 'false'], dir);
    const newlineDir = join(dir, 'a\nb');
    mkdirSync(newlineDir, { recursive: true });
    writeFileSync(join(newlineDir, 'frozen.mjs'), '// tricky\n');
    writeFileSync(join(dir, 'café.mjs'), '// utf8\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'add tricky paths'], dir);

    const files = listTrackedFiles('HEAD', dir);
    assert.ok(files.includes('a\nb/frozen.mjs'));
    assert.ok(files.includes('café.mjs'));
    assert.equal(files.includes('b/frozen.mjs'), false);
    assert.equal(scopeShipped({ scope: ['b/frozen.mjs'] }, files), false);
  });
});
