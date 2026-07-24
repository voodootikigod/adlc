// resolveRepoRoot against real git repos: it must return the toplevel path
// (not a commit sha — `--show-toplevel` is load-bearing) from any subdir, and
// null outside a repo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoRoot, clearRepoRootCache, resolveOnPath, evictIfFull, repoRootFromCwd } from '../lib/repo-root.mjs';
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

test('a negative result is cached within the TTL (no re-spawn) but re-probed after it', () => {
  const later = join(dir, 'later');
  mkdirSync(later, { recursive: true });
  let clock = 1_000;
  const now = () => clock;
  assert.equal(resolveRepoRoot(later, now), null); // not a repo yet
  execFileSync('git', ['init', '-q', later]);
  // Within the 30s negative TTL: still served as null, git NOT re-probed.
  clock += 10_000;
  assert.equal(resolveRepoRoot(later, now), null);
  // After the TTL: re-probed, now sees the repo.
  clock += 30_000;
  assert.equal(realpathSync(resolveRepoRoot(later, now)), realpathSync(later));
});

test('a positive resolution is cached permanently', () => {
  const repo = join(dir, 'perm');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  let clock = 1_000;
  const first = resolveRepoRoot(repo, () => clock);
  rmSync(join(repo, '.git'), { recursive: true, force: true }); // repo gone
  clock += 10 * 60_000; // well past any TTL
  assert.equal(resolveRepoRoot(repo, () => clock), first); // still the cached toplevel
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

test('repoRootFromCwd finds the nearest ancestor with .adlc or .git by a pure walk (no subprocess)', () => {
  const root = join(dir, 'proj');
  const deep = join(root, 'a', 'b', 'c');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  mkdirSync(deep, { recursive: true });
  assert.equal(realpathSync(repoRootFromCwd(deep, 64)), realpathSync(root));
  // a .git-only root is also recognized
  const gitRoot = join(dir, 'g');
  mkdirSync(join(gitRoot, '.git', 'x'), { recursive: true });
  assert.equal(realpathSync(repoRootFromCwd(join(gitRoot, '.git'), 64)), realpathSync(gitRoot));
});

test('repoRootFromCwd follows symlinks to the PHYSICAL repo root', () => {
  const real = join(dir, 'realproj');
  mkdirSync(join(real, '.adlc'), { recursive: true });
  const sub = join(real, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const link = join(dir, 'link-to-sub');
  symlinkSync(sub, link); // pane cwd reached via a symlink
  assert.equal(realpathSync(repoRootFromCwd(link, 64)), realpathSync(real));
});

test('repoRootFromCwd returns null outside any repo, and fails closed on a bad start', () => {
  // Empty start with a VALID depth: must fail closed, NOT resolve('') = cwd and
  // walk the current repo (pins the length===0 guard).
  assert.equal(repoRootFromCwd('', 64), null);
  assert.equal(repoRootFromCwd(null, 64), null);
  assert.equal(repoRootFromCwd('/x', 0), null); // non-positive depth → nothing checked
});

test('repoRootFromCwd honors maxLevels precisely (counts the start dir as level 1)', () => {
  const root = join(dir, 'lvl');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const child = join(root, 'sub');
  mkdirSync(child, { recursive: true });
  // maxLevels=1 checks ONLY the start dir: found when .adlc is right there...
  assert.equal(realpathSync(repoRootFromCwd(root, 1)), realpathSync(root));
  // ...but not when the root is one level up and only 1 level is allowed.
  assert.equal(repoRootFromCwd(child, 1), null);
  // 2 levels reaches the parent.
  assert.equal(realpathSync(repoRootFromCwd(child, 2)), realpathSync(root));
});

test('evictIfFull drops the oldest entry at/over the bound, and is a no-op below it', () => {
  const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
  evictIfFull(m, 3); // at the bound → evict oldest ('a')
  assert.deepEqual([...m.keys()], ['b', 'c']);
  evictIfFull(m, 5); // below the bound → no change
  assert.deepEqual([...m.keys()], ['b', 'c']);
});
