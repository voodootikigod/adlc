import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterByTokenSets, ownershipRejection } from '../index.mjs';

test('ownershipRejection: enforces group/world-writable checks on self-owned files and directories', () => {
  const selfFile = { uid: 1000, mode: 0o100755 };
  const selfDir = { uid: 1000, mode: 0o040755 };
  const selfLink = { uid: 1000, mode: 0o100755 };

  assert.equal(ownershipRejection({ file: selfFile, link: selfLink, dir: selfDir }, 1000), null);
  assert.equal(
    ownershipRejection({ file: { uid: 1000, mode: 0o100700 }, link: selfLink, dir: { uid: 1000, mode: 0o040700 } }, 1000),
    null,
  );
  assert.match(
    ownershipRejection({ file: { uid: 1000, mode: 0o100775 }, link: selfLink, dir: selfDir }, 1000),
    /writable by group or others/,
  );
  assert.match(
    ownershipRejection({ file: { uid: 1000, mode: 0o100757 }, link: selfLink, dir: selfDir }, 1000),
    /writable by group or others/,
  );
  assert.match(
    ownershipRejection({ file: selfFile, link: selfLink, dir: { uid: 1000, mode: 0o040775 } }, 1000),
    /its directory is writable by group or others/,
  );
  assert.match(
    ownershipRejection({ file: selfFile, link: selfLink, dir: { uid: 1000, mode: 0o040777 } }, 1000),
    /its directory is writable by group or others/,
  );
});

test('clusterByTokenSets: inverted-token pre-filtering preserves empty-set, zero-threshold, and transitive semantics', () => {
  // Empty sets merge with each other when threshold <= 1, stay separate when threshold > 1
  assert.deepEqual(clusterByTokenSets([new Set(), new Set(['a']), new Set()], 0.5), [[0, 2], [1]]);
  assert.deepEqual(clusterByTokenSets([new Set(), new Set()], 1.0), [[0, 1]]);
  assert.deepEqual(clusterByTokenSets([new Set(), new Set()], 1.1), [[0], [1]]);

  // threshold <= 0 merges every set regardless of token overlap
  assert.deepEqual(clusterByTokenSets([new Set(['a']), new Set(['b']), new Set()], 0), [[0, 1, 2]]);

  // Sparse disjoint sets scale cleanly without false merges
  const sparse = Array.from({ length: 200 }, (_, i) => new Set([`tok-${i}`]));
  sparse.push(new Set(['tok-42']));
  const clusters = clusterByTokenSets(sparse, 0.5);
  assert.equal(clusters.length, 200);
  assert.deepEqual(clusters[42], [42, 200]);
});
