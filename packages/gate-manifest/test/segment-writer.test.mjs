// segment-writer.test.mjs — the writer half of the segmented gate-manifest
// (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §7).
//
// Slice 1/2's tests hand-build segments (the writer didn't exist yet); these
// tests exercise the real writer (appendManifestEntry -> segment-writer.mjs)
// against a real git repo fixture, since lineage resolution (§7.1) depends on
// the current branch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendManifestEntry, record } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';
import { discoverSegments, readManifestForest, segmentPath, ulidOf } from '../lib/forest.mjs';
import { isSegmentedRepo, markerPath, lineagePath, resolveOpenSegment, deriveSlug, generateSegmentUlid, currentBranch } from '../lib/lineage.mjs';
import { verifyEntrySig, KEY_ENV } from '../lib/sign.mjs';
import { sha256 } from '@adlc/core';

function withKey(key, fn) {
  const prev = process.env[KEY_ENV];
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  }
}

// A real git repo fixture: lineage resolution reads the current branch, which
// only means something inside an actual repository.
function gitRepo(branch = 'feat/segment-writer') {
  const root = mkdtempSync(join(tmpdir(), 'gate-manifest-segwriter-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', branch);
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  const dir = join(root, '.adlc');
  mkdirSync(dir, { recursive: true });
  return { root, dir, g };
}

function activate(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(markerPath(dir), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

function clean(root) {
  rmSync(root, { recursive: true, force: true });
}

describe('isSegmentedRepo (spec §4.7)', () => {
  it('false for a plain repo with neither marker nor cutover entry', () => {
    const { root, dir } = gitRepo();
    try {
      assert.equal(isSegmentedRepo(dir), false);
    } finally { clean(root); }
  });

  it('true once the activation marker exists', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      assert.equal(isSegmentedRepo(dir), true);
    } finally { clean(root); }
  });

  it('true when root\'s last entry is the cutover entry, even without the marker', () => {
    const { root, dir } = gitRepo();
    try {
      record({ gate: 'manifest-cutover', dir, rawData: JSON.stringify({ reason: 'migration ceremony fixture' }) });
      assert.equal(isSegmentedRepo(dir), true);
    } finally { clean(root); }
  });

  it('a corrupted marker file does not crash — falls through to the cutover-entry test', () => {
    const { root, dir } = gitRepo();
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      writeFileSync(markerPath(dir), 'not json');
      assert.equal(isSegmentedRepo(dir), false);
    } finally { clean(root); }
  });
});

describe('deriveSlug (spec §7.1)', () => {
  it('lowercases and keeps only [a-z0-9-]', () => {
    assert.equal(deriveSlug('Feat/Cool-Thing_42'), 'feat-cool-thing-42');
  });

  it('collapses dash runs left behind by substituted characters', () => {
    assert.equal(deriveSlug('a///b'), 'a-b');
  });

  it('trims leading/trailing dashes', () => {
    assert.equal(deriveSlug('/leading-and-trailing/'), 'leading-and-trailing');
  });

  it('falls back to "segment" when derivation yields nothing', () => {
    assert.equal(deriveSlug('///___'), 'segment');
    assert.equal(deriveSlug(''), 'segment');
    assert.equal(deriveSlug(undefined), 'segment');
  });

  it('truncates to 40 chars and does not leave a trailing dash at the cut', () => {
    const slug = deriveSlug('a'.repeat(39) + '-' + 'b'.repeat(10));
    assert.ok(slug.length <= 40, `expected <=40 chars, got ${slug.length}`);
    assert.ok(!slug.endsWith('-'), `must not end with a dash: ${slug}`);
  });
});

describe('generateSegmentUlid (spec §4.2)', () => {
  it('produces a 26-char uppercase Crockford-base32 string matching the segment grammar', () => {
    const ulid = generateSegmentUlid();
    assert.match(ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is distinct across calls (fresh entropy each time)', () => {
    const a = generateSegmentUlid();
    const b = generateSegmentUlid();
    assert.notEqual(a, b);
  });
});

describe('currentBranch', () => {
  it('returns the checked-out branch name', () => {
    const { root } = gitRepo('feat/my-branch');
    try {
      assert.equal(currentBranch(root), 'feat/my-branch');
    } finally { clean(root); }
  });

  it('returns null for detached HEAD', () => {
    const { root, g } = gitRepo();
    try {
      const sha = g('rev-parse', 'HEAD').trim();
      g('checkout', '-q', '--detach', sha);
      assert.equal(currentBranch(root), null);
    } finally { clean(root); }
  });

  it('returns null when cwd is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      assert.equal(currentBranch(dir), null);
    } finally { clean(dir); }
  });
});

describe('.lineage write path refuses to follow a symlink (adversarial-review finding)', () => {
  it('a symlinked .lineage is replaced with a regular file — never written through', () => {
    const { root, dir } = gitRepo();
    const outsideTarget = join(root, '..', `outside-lineage-target-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(outsideTarget, 'untouched\n');
    try {
      activate(dir);
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      symlinkSync(outsideTarget, lineagePath(dir));
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // mints a segment, writes the token
      assert.equal(readFileSync(outsideTarget, 'utf8'), 'untouched\n', 'the symlink target must never be written through');
      assert.equal(lstatSync(lineagePath(dir)).isSymbolicLink(), false, '.lineage must be replaced with a regular file');
      const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
      assert.equal(typeof token.segment, 'string');
    } finally {
      clean(root);
      rmSync(outsideTarget, { force: true });
    }
  });

  it('a symlinked .lineage is treated as absent on read, never followed — mints fresh instead of resolving through it', () => {
    const { root, dir } = gitRepo();
    const outsideTarget = join(root, '..', `outside-lineage-read-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(outsideTarget, JSON.stringify({ segment: 'not-real-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', branch: currentBranch(root) }));
    try {
      activate(dir);
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      symlinkSync(outsideTarget, lineagePath(dir));
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.equal(resolved.isNew, true, 'a symlinked token must never be trusted, even if its content looks valid');
    } finally {
      clean(root);
      rmSync(outsideTarget, { force: true });
    }
  });
});

describe('resolveOpenSegment (spec §7.1)', () => {
  it('root-less: mints a segment with anchor: null and writes the lineage token', () => {
    const { root, dir } = gitRepo('feat/cool-thing');
    try {
      activate(dir);
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.equal(resolved.isNew, true);
      assert.equal(resolved.anchor, null);
      assert.match(resolved.name, /^feat-cool-thing-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/);
      const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
      assert.equal(token.segment, resolved.name);
      assert.equal(token.branch, 'feat/cool-thing');
      assert.equal(token.ulid, ulidOf(resolved.name));
    } finally { clean(root); }
  });

  it('with a root: mints a segment anchored to root\'s current head line', () => {
    const { root, dir } = gitRepo();
    try {
      record({ gate: 'evidence', dir });
      activate(dir);
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.equal(resolved.isNew, true);
      assert.equal(resolved.anchor.segment, 'root');
      assert.equal(resolved.anchor.seq, 1);
    } finally { clean(root); }
  });

  it('a second resolution on the SAME branch reuses the already-open segment', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const first = resolveOpenSegment(dir, { cwd: root });
      // Simulate the first entry actually having been written (resolveOpenSegment
      // itself does not write to the segment, only the lineage token).
      writeFileSync(segmentPath(dir, first.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: first.anchor })}\n`);
      const second = resolveOpenSegment(dir, { cwd: root });
      assert.equal(second.isNew, false);
      assert.equal(second.name, first.name);
    } finally { clean(root); }
  });

  it('a DIFFERENT branch mints a new segment, not the other branch\'s open one', () => {
    const { root, dir, g } = gitRepo('feat/branch-a');
    try {
      activate(dir);
      const a = resolveOpenSegment(dir, { cwd: root });
      writeFileSync(segmentPath(dir, a.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: a.anchor })}\n`);
      g('checkout', '-q', '-b', 'feat/branch-b');
      const b = resolveOpenSegment(dir, { cwd: root });
      assert.equal(b.isNew, true);
      assert.notEqual(b.name, a.name);
    } finally { clean(root); }
  });

  it('detached HEAD never matches a cached token and never persists a new one', () => {
    const { root, dir, g } = gitRepo();
    try {
      activate(dir);
      const onBranch = resolveOpenSegment(dir, { cwd: root });
      writeFileSync(segmentPath(dir, onBranch.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: onBranch.anchor })}\n`);
      const sha = g('rev-parse', 'HEAD').trim();
      g('checkout', '-q', '--detach', sha);
      const detached = resolveOpenSegment(dir, { cwd: root });
      assert.equal(detached.isNew, true);
      assert.notEqual(detached.name, onBranch.name);
      // The on-branch token must survive untouched — detached HEAD must not clobber it.
      const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
      assert.equal(token.segment, onBranch.name);
    } finally { clean(root); }
  });
});

describe('appendManifestEntry routes to the segment writer once segmented (spec §7)', () => {
  it('a non-segmented repo is completely unaffected — still appends to root', () => {
    const { root, dir } = gitRepo();
    try {
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.equal(entry.seq, 1);
      assert.equal(existsSync(join(dir, 'manifest.jsonl')), true);
      assert.equal(discoverSegments(dir).valid.length, 0);
    } finally { clean(root); }
  });

  it('a segmented, root-less repo writes its first entry as a new, anchor:null segment', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.equal(entry.seq, 1);
      assert.equal(entry.anchor, null);
      const { valid } = discoverSegments(dir);
      assert.equal(valid.length, 1);
      assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be touched once segmented');
    } finally { clean(root); }
  });

  it('a segmented repo WITH a root anchors the first segment entry to it', () => {
    const { root, dir } = gitRepo();
    try {
      record({ gate: 'evidence', dir }); // a real root entry, pre-cutover
      activate(dir);
      const rootBytesBefore = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
      const rootLastLine = rootBytesBefore.trim().split('\n').at(-1);
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.deepEqual(entry.anchor, { segment: 'root', seq: 1, lineHash: sha256(rootLastLine) });
      assert.equal(readFileSync(join(dir, 'manifest.jsonl'), 'utf8'), rootBytesBefore, 'root bytes must not change');
    } finally { clean(root); }
  });

  it('a second append on the same branch continues the same segment: seq 2, no anchor', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const first = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      const second = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.equal(first.seq, 1);
      assert.equal(second.seq, 2);
      assert.equal(Object.hasOwn(second, 'anchor'), false);
      assert.equal(discoverSegments(dir).valid.length, 1, 'must not mint a second segment for the same branch');
    } finally { clean(root); }
  });

  it('a continuation entry (not the anchor-carrying first one) signs at the default v2, not some other version', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      withKey('seg-key', () => {
        appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // first: anchor-carrying, forced v2 regardless
        const second = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // continuation: default applies
        assert.equal(second.sigVersion, 2);
        assert.equal(verifyEntrySig('seg-key', second), true);
      });
    } finally { clean(root); }
  });

  it('tolerates a legacy unsigned root prefix when checking chain integrity before a segment append', () => {
    const { root, dir } = gitRepo();
    try {
      record({ gate: 'evidence', dir }); // no key set yet: an honest unsigned legacy entry
      activate(dir);
      withKey('seg-key', () => {
        // A key IS present now, so this only succeeds if the integrity precondition
        // tolerates root's unsigned legacy prefix (requireSignatures:false) instead of
        // demanding every entry be signed (requireSignatures:true would reject this).
        const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
        assert.equal(entry.seq, 1);
      });
    } finally { clean(root); }
  });

  it('reserved field "anchor" is refused before it ever reaches the segment writer', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      assert.throws(
        () => appendManifestEntry({ gate: 'evidence', anchor: { segment: 'root', seq: 1, lineHash: 'x' } }, dir, { cwd: root }),
        /reserved chain field: anchor/,
      );
    } finally { clean(root); }
  });

  it('entries are signed when a key is present, and the anchor-carrying entry is v2 EVEN if v1 was requested', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      withKey('seg-key', () => {
        const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root, signatureVersion: 1 });
        assert.equal(entry.sigVersion, 2, 'the anchor-carrying first entry must be forced to v2');
        assert.equal(verifyEntrySig('seg-key', entry), true);
      });
    } finally { clean(root); }
  });

  it('a full round trip (mint + continue) verifies clean across the forest', () => {
    const { root, dir } = gitRepo();
    try {
      withKey('seg-key', () => {
        record({ gate: 'evidence', dir }); // root entry signed too, so the whole forest can verify signed:true
        activate(dir);
        appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
        appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
        appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
        const result = verify(dir);
        assert.equal(result.valid, true, result.message);
        assert.equal(result.segments, 1);
        assert.equal(result.signed, true);
      });
      const { entries } = readManifestForest(dir);
      assert.equal(entries.length, 4); // 1 root + 3 segment entries
    } finally { clean(root); }
  });

  it('refuses to append onto a forest with a broken chain', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      const { valid } = discoverSegments(dir);
      const segFile = segmentPath(dir, valid[0]);
      // Corrupt the segment: rewrite its only line with a bad prev hash.
      const entry = JSON.parse(readFileSync(segFile, 'utf8').trim());
      entry.prev = 'f'.repeat(64);
      writeFileSync(segFile, `${JSON.stringify(entry)}\n`);
      assert.throws(
        () => appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }),
        /manifest forest is invalid/,
      );
    } finally { clean(root); }
  });
});
