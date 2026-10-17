// packages/core/test/wave3-primitives.test.mjs
// Unit and boundary tests for inflight crash-recovery and clustering primitives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  statSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  makeTempPath,
  writeInflightAtomic,
  probeOwner,
  ownerStateFor,
  isContainedRelPath,
  resolveTarget,
  sweepStaleTemps,
  clearRecord,
  BASE_STOPWORDS,
  jaccard,
  clusterByTokenSets,
} from '@adlc/core';

// ---------------------------------------------------------------------------
// Inflight crash-recovery primitives
// ---------------------------------------------------------------------------

test('makeTempPath: generates unpredictable temp path containing pid and random hex', () => {
  const target = '/path/to/file.js';
  const path1 = makeTempPath(target, 12345);
  const path2 = makeTempPath(target, 12345);

  assert.match(path1, /^\/path\/to\/file\.js\.tmp-12345-[0-9a-f]{16}$/);
  assert.match(path2, /^\/path\/to\/file\.js\.tmp-12345-[0-9a-f]{16}$/);
  assert.notStrictEqual(path1, path2);

  // Default pid is process.pid
  const defaultPath = makeTempPath(target);
  assert.match(defaultPath, new RegExp(`^/path/to/file\\.js\\.tmp-${process.pid}-[0-9a-f]{16}$`));
});

test('probeOwner: validates pid and handles signals correctly', () => {
  // Non-integers and invalid types
  assert.strictEqual(probeOwner(null), 'unknown');
  assert.strictEqual(probeOwner(undefined), 'unknown');
  assert.strictEqual(probeOwner('123'), 'unknown');
  assert.strictEqual(probeOwner(NaN), 'unknown');
  assert.strictEqual(probeOwner(Infinity), 'unknown');
  assert.strictEqual(probeOwner(1.5), 'unknown');
  assert.strictEqual(probeOwner(0), 'unknown');
  assert.strictEqual(probeOwner(-1), 'unknown');
  assert.strictEqual(probeOwner(-999), 'unknown');

  // Alive process (process.pid with default killFn)
  assert.strictEqual(probeOwner(process.pid), 'alive');

  // Custom killFn scenarios
  const mockAlive = () => {};
  assert.strictEqual(probeOwner(42, mockAlive), 'alive');

  const mockDead = () => {
    const err = new Error('No such process');
    err.code = 'ESRCH';
    throw err;
  };
  assert.strictEqual(probeOwner(42, mockDead), 'dead');

  const mockEperm = () => {
    const err = new Error('Operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  assert.strictEqual(probeOwner(42, mockEperm), 'alive');

  const mockOtherErr = () => {
    const err = new Error('Invalid argument');
    err.code = 'EINVAL';
    throw err;
  };
  assert.strictEqual(probeOwner(42, mockOtherErr), 'unknown');

  const mockNonError = () => {
    throw 'unexpected error';
  };
  assert.strictEqual(probeOwner(42, mockNonError), 'unknown');
});

test('ownerStateFor: detects self pid as dead (pid reuse) and delegates others', () => {
  const currentPid = 9999;
  const mockProbe = (pid) => (pid === 1234 ? 'alive' : 'dead');

  // Same PID as current process: always 'dead'
  assert.strictEqual(ownerStateFor(currentPid, currentPid, mockProbe), 'dead');

  // Different PID delegates to probe
  assert.strictEqual(ownerStateFor(1234, currentPid, mockProbe), 'alive');
  assert.strictEqual(ownerStateFor(5678, currentPid, mockProbe), 'dead');

  // Default selfPid is process.pid
  assert.strictEqual(ownerStateFor(process.pid), 'dead');
});

test('isContainedRelPath: strictly validates paths within repo boundary', () => {
  assert.strictEqual(isContainedRelPath(null), false);
  assert.strictEqual(isContainedRelPath(undefined), false);
  assert.strictEqual(isContainedRelPath(123), false);
  assert.strictEqual(isContainedRelPath(''), false);
  assert.strictEqual(isContainedRelPath('/'), false);
  assert.strictEqual(isContainedRelPath('/absolute/path'), false);
  assert.strictEqual(isContainedRelPath('.'), false);
  assert.strictEqual(isContainedRelPath('..'), false);
  assert.strictEqual(isContainedRelPath('../foo'), false);
  assert.strictEqual(isContainedRelPath('foo/../../bar'), false);
  assert.strictEqual(isContainedRelPath('a/b/../../../escape'), false);

  assert.strictEqual(isContainedRelPath('foo'), true);
  assert.strictEqual(isContainedRelPath('foo/bar'), true);
  assert.strictEqual(isContainedRelPath('src/lib/index.js'), true);
  assert.strictEqual(isContainedRelPath('a/b/../c'), true);
});

test('resolveTarget: resolves real absolute path inside repo root', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-resolvetarget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const validFile = join(dir, 'file.txt');
  writeFileSync(validFile, 'hello');

  // Valid relative path
  assert.strictEqual(resolveTarget(dir, 'file.txt'), validFile);

  // Invalid relative paths
  assert.strictEqual(resolveTarget(dir, ''), null);
  assert.strictEqual(resolveTarget(dir, '../outside.txt'), null);
  assert.strictEqual(resolveTarget(dir, '/absolute.txt'), null);
  assert.strictEqual(resolveTarget(dir, 'nonexistent.txt'), null);

  // Path resolving to root itself
  assert.strictEqual(resolveTarget(dir, '.'), null);

  // Symlink pointing outside repo
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  const outsideFile = join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, 'secret');

  const symlinkOutside = join(dir, 'symlink-outside.txt');
  symlinkSync(outsideFile, symlinkOutside);
  assert.strictEqual(resolveTarget(dir, 'symlink-outside.txt'), null);

  // Symlink pointing inside repo
  const symlinkInside = join(dir, 'symlink-inside.txt');
  symlinkSync(validFile, symlinkInside);
  assert.strictEqual(resolveTarget(dir, 'symlink-inside.txt'), validFile);
});

test('writeInflightAtomic: writes atomically and preserves mode and symlinks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-atomic-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const target = join(dir, 'target.txt');

  // 1. Initial write to new file
  writeInflightAtomic(target, 'content v1');
  assert.strictEqual(readFileSync(target, 'utf8'), 'content v1');

  // 2. Overwrite and preserve mode (0o755)
  chmodSync(target, 0o755);
  writeInflightAtomic(target, 'content v2');
  assert.strictEqual(readFileSync(target, 'utf8'), 'content v2');
  const mode = statSync(target).mode & 0o777;
  assert.strictEqual(mode, 0o755);

  // 3. Custom tempPath
  const customTemp = join(dir, 'custom.tmp');
  writeInflightAtomic(target, 'content v3', { tempPath: customTemp });
  assert.strictEqual(readFileSync(target, 'utf8'), 'content v3');
  assert.strictEqual(existsSync(customTemp), false);

  // 4. Writes through symlink preserving link
  const linkTarget = join(dir, 'real-file.txt');
  writeFileSync(linkTarget, 'real content');
  const symlinkPath = join(dir, 'link-file.txt');
  symlinkSync(linkTarget, symlinkPath);

  writeInflightAtomic(symlinkPath, 'updated via symlink');
  assert.strictEqual(readFileSync(linkTarget, 'utf8'), 'updated via symlink');
  assert.strictEqual(lstatSync(symlinkPath).isSymbolicLink(), true);

  // 5. Cleans up temp file on failure
  const badTemp = join(dir, 'nonexistent-sub', 'bad.tmp');
  assert.throws(() => {
    writeInflightAtomic(target, 'fail', { tempPath: badTemp });
  });
});

test('sweepStaleTemps: sweeps matching temp files of dead owners', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const target = join(dir, 'file.txt');
  writeFileSync(target, 'base');

  const deadPid = 1001;
  const alivePid = 1002;
  const selfPid = 1003;

  // Stale temp for dead pid
  const tempDead = join(dir, `file.txt.tmp-${deadPid}-0123456789abcdef`);
  writeFileSync(tempDead, 'dead');

  // Stale temp for selfPid (simulating crash before PID reuse)
  const tempSelf = join(dir, `file.txt.tmp-${selfPid}-0123456789abcdef`);
  writeFileSync(tempSelf, 'self');

  // Temp for alive pid
  const tempAlive = join(dir, `file.txt.tmp-${alivePid}-0123456789abcdef`);
  writeFileSync(tempAlive, 'alive');

  // Unrelated file
  const unrelated = join(dir, 'file.txt.tmp-unrelated');
  writeFileSync(unrelated, 'keep');

  const mockProbe = (pid) => (pid === alivePid ? 'alive' : 'dead');

  const swept = sweepStaleTemps(target, { probe: mockProbe, selfPid });
  assert.strictEqual(swept, 2);

  assert.strictEqual(existsSync(tempDead), false);
  assert.strictEqual(existsSync(tempSelf), false);
  assert.strictEqual(existsSync(tempAlive), true);
  assert.strictEqual(existsSync(unrelated), true);

  // Sweep on symlinked target
  const symlinkTarget = join(dir, 'symlink-target.txt');
  symlinkSync(target, symlinkTarget);
  const tempDead2 = join(dir, `file.txt.tmp-${deadPid}-abcdef0123456789`);
  writeFileSync(tempDead2, 'dead2');

  const swept2 = sweepStaleTemps(symlinkTarget, { probe: mockProbe, selfPid });
  assert.strictEqual(swept2, 1);
  assert.strictEqual(existsSync(tempDead2), false);

  // Sweeping non-existent directory returns 0
  assert.strictEqual(sweepStaleTemps('/nonexistent/path/file.txt'), 0);
});

test('clearRecord: unlinks record path, ignores ENOENT, and rethrows others', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-clear-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const record = join(dir, 'record.json');
  writeFileSync(record, '{}');

  // Clears existing file
  clearRecord(record);
  assert.strictEqual(existsSync(record), false);

  // Ignoring ENOENT
  assert.doesNotThrow(() => clearRecord(record));

  // Rethrows other errors (e.g. attempting to unlink a directory with unlinkSync)
  const subDir = join(dir, 'subdir');
  mkdirSync(subDir);
  assert.throws(() => clearRecord(subDir));
});

// ---------------------------------------------------------------------------
// Clustering and similarity primitives
// ---------------------------------------------------------------------------

test('BASE_STOPWORDS: is a frozen set containing common stopwords', () => {
  assert(BASE_STOPWORDS instanceof Set);
  assert.strictEqual(Object.isFrozen(BASE_STOPWORDS), true);
  assert(BASE_STOPWORDS.has('the'));
  assert(BASE_STOPWORDS.has('is'));
  assert(BASE_STOPWORDS.has('and'));
  assert(BASE_STOPWORDS.has('before'));
});

test('jaccard: calculates set similarity correctly under all boundary conditions', () => {
  // Both empty -> 1
  assert.strictEqual(jaccard(new Set(), new Set()), 1);

  // One empty -> 0
  assert.strictEqual(jaccard(new Set(['a']), new Set()), 0);
  assert.strictEqual(jaccard(new Set(), new Set(['b'])), 0);

  // Disjoint sets -> 0
  assert.strictEqual(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])), 0);

  // Identical sets -> 1
  assert.strictEqual(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);

  // Partial overlap
  const s1 = new Set(['a', 'b', 'c']);
  const s2 = new Set(['b', 'c', 'd']);
  // intersection: {b, c} (2), union: {a, b, c, d} (4) -> 0.5
  assert.strictEqual(jaccard(s1, s2), 0.5);

  // Asymmetric set sizes (testing smaller/larger branch)
  const small = new Set(['x']);
  const large = new Set(['x', 'y', 'z', 'w']);
  assert.strictEqual(jaccard(small, large), 0.25);
  assert.strictEqual(jaccard(large, small), 0.25);
});

test('clusterByTokenSets: clusters sets via union-find with threshold', () => {
  // Empty
  assert.deepStrictEqual(clusterByTokenSets([]), []);

  // Single set
  assert.deepStrictEqual(clusterByTokenSets([new Set(['foo'])]), [[0]]);

  // Disjoint sets
  const disjoint = [new Set(['a']), new Set(['b']), new Set(['c'])];
  assert.deepStrictEqual(clusterByTokenSets(disjoint, 0.5), [[0], [1], [2]]);

  // Overlapping pairs above threshold
  const sets = [
    new Set(['apple', 'banana', 'cherry']),
    new Set(['apple', 'banana', 'date']), // Jaccard with 0: 2/4 = 0.5
    new Set(['zebra', 'zoo']),             // Disjoint from 0 and 1
  ];
  assert.deepStrictEqual(clusterByTokenSets(sets, 0.5), [[0, 1], [2]]);

  // Higher threshold keeps them apart
  assert.deepStrictEqual(clusterByTokenSets(sets, 0.8), [[0], [1], [2]]);

  // Transitive clustering: 0~1 and 1~2 merges {0, 1, 2}
  const chained = [
    new Set(['a', 'b']),
    new Set(['b', 'c']),
    new Set(['c', 'd']),
  ];
  // With threshold 0.33, 1/3 >= 0.33
  assert.deepStrictEqual(clusterByTokenSets(chained, 0.33), [[0, 1, 2]]);
});
