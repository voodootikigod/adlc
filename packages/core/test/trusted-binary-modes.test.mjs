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

  // User Private Group (gid === selfGid): group-writable 0775 is allowed, world-writable 0777 and foreign-group 0775 are rejected
  assert.equal(
    ownershipRejection(
      { file: { uid: 1000, gid: 1000, mode: 0o100775 }, link: selfLink, dir: { uid: 1000, gid: 1000, mode: 0o040775 } },
      1000,
      1000,
    ),
    null,
  );
  assert.match(
    ownershipRejection(
      { file: { uid: 1000, gid: 1000, mode: 0o100777 }, link: selfLink, dir: { uid: 1000, gid: 1000, mode: 0o040775 } },
      1000,
      1000,
    ),
    /writable by group or others/,
  );
  assert.match(
    ownershipRejection(
      { file: { uid: 1000, gid: 2000, mode: 0o100775 }, link: selfLink, dir: { uid: 1000, gid: 1000, mode: 0o040775 } },
      1000,
      1000,
    ),
    /writable by group or others/,
  );
  assert.match(
    ownershipRejection(
      { file: { uid: 1000, gid: 1000, mode: 0o100755 }, link: selfLink, dir: { uid: 1000, gid: 2000, mode: 0o040775 } },
      1000,
      1000,
    ),
    /its directory is writable by group or others/,
  );

  // Default selfGid derivation when omitted: matches process.getgid() only for process.getuid()
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    const uid = process.getuid();
    const gid = process.getgid();
    assert.equal(
      ownershipRejection(
        { file: { uid, gid, mode: 0o100775 }, link: { uid, mode: 0o100755 }, dir: { uid, gid, mode: 0o040775 } },
        uid,
      ),
      null,
    );
    assert.match(
      ownershipRejection(
        { file: { uid: uid + 1, gid, mode: 0o100775 }, link: { uid: uid + 1, mode: 0o100755 }, dir: { uid: uid + 1, gid, mode: 0o040775 } },
        uid + 1,
      ),
      /writable by group or others/,
    );
  }
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
