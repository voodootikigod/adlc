// resolveRepoRoot against real git repos: it must return the toplevel path
// (not a commit sha — `--show-toplevel` is load-bearing) from any subdir, and
// null outside a repo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoRoot, clearRepoRootCache } from '../lib/repo-root.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adlc-herdr-git-')); clearRepoRootCache(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('resolves the repo toplevel from a nested subdirectory', () => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'a', 'b'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const resolved = resolveRepoRoot(join(repo, 'a', 'b'));
  assert.equal(realpathSync(resolved), realpathSync(repo));
});

test('resolves null outside any git repository', () => {
  const plain = join(dir, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(resolveRepoRoot(plain), null);
});

test('resolves null for a nonexistent directory instead of throwing', () => {
  assert.equal(resolveRepoRoot(join(dir, 'missing')), null);
});
