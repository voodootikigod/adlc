// resolveRepoRoot against real git repos: it must return the toplevel path
// (not a commit sha — `--show-toplevel` is load-bearing) from any subdir, and
// null outside a repo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoRoot, clearRepoRootCache, resolveOnPath } from '../lib/repo-root.mjs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

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

test('a null resolution is NOT cached — a dir that becomes a repo is re-probed', () => {
  const later = join(dir, 'later');
  mkdirSync(later, { recursive: true });
  assert.equal(resolveRepoRoot(later), null); // not a repo yet
  execFileSync('git', ['init', '-q', later]);
  // Without a cached null, the second probe sees the new repo.
  assert.equal(realpathSync(resolveRepoRoot(later)), realpathSync(later));
});

test('resolveOnPath returns the first PATH entry that actually contains the binary', () => {
  const empty = join(dir, 'empty');
  const hit = join(dir, 'hit');
  mkdirSync(empty, { recursive: true });
  mkdirSync(hit, { recursive: true });
  writeFileSync(join(hit, 'somebin'), '#!/bin/sh\n');
  const path = ['', empty, hit].join(delimiter);
  assert.equal(resolveOnPath('somebin', path), join(hit, 'somebin'));
});

test('resolveOnPath returns null when the binary is nowhere on PATH (fail closed)', () => {
  assert.equal(resolveOnPath('nope-not-here', join(dir, 'empty')), null);
  assert.equal(resolveOnPath('nope-not-here', undefined), null);
});
