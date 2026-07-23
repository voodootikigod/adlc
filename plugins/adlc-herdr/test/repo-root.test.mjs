// resolveRepoRoot against real git repos: it must return the toplevel path
// (not a commit sha — `--show-toplevel` is load-bearing) from any subdir, and
// null outside a repo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRepoRoot, clearRepoRootCache, resolveOnPath, evictIfFull } from '../lib/repo-root.mjs';
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

test('evictIfFull drops the oldest entry at/over the bound, and is a no-op below it', () => {
  const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
  evictIfFull(m, 3); // at the bound → evict oldest ('a')
  assert.deepEqual([...m.keys()], ['b', 'c']);
  evictIfFull(m, 5); // below the bound → no change
  assert.deepEqual([...m.keys()], ['b', 'c']);
});
