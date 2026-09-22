// segment-writer.test.mjs — the writer half of the segmented gate-manifest
// (T-MANIFEST-FOREST slice 3, docs/specs/segmented-gate-manifest.md §7).
//
// Slice 1/2's tests hand-build segments (the writer didn't exist yet); these
// tests exercise the real writer (appendManifestEntry -> segment-writer.mjs)
// against a real git repo fixture, since lineage resolution (§7.1) depends on
// the current branch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, chmodSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { tmp, gitRepo } from '@adlc/core/test-kit';

import { appendManifestEntry as realAppendManifestEntry, record as realRecord } from '../lib/record.mjs';
import { verify as realVerify } from '../lib/verify.mjs';
import { discoverSegments, readManifestForest, segmentPath, ulidOf } from '../lib/forest.mjs';
import { isSegmentedRepo, markerPath, lineagePath, resolveOpenSegment, recoverOpenSegment, deriveSlug, generateSegmentUlid, currentBranch } from '../lib/lineage.mjs';
import { verifyEntrySig, signEntry, KEY_ENV } from '../lib/sign.mjs';
import { sha256 } from '@adlc/core';

// The libraries no longer read the environment (spec Layer 2, P1): `key` is an
// explicit required parameter. withKey keeps its shape — every existing test still
// says `withKey('k', () => ...)` — but now scopes the CURRENT TEST KEY that the
// wrappers below thread explicitly into each call. Mirrors gate-manifest.test.mjs.
let currentTestKey = null;
function withKey(key, fn) {
  const prev = process.env[KEY_ENV];
  const prevCurrent = currentTestKey;
  currentTestKey = key;
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  const restore = () => {
    currentTestKey = prevCurrent;
    if (prev === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = prev;
  };
  try {
    const res = fn();
    restore();
    return res;
  } catch (err) {
    restore();
    throw err;
  }
}

// Explicit-key wrappers: every call in this file goes through the new required-key
// contract, with the key scoped by withKey (null outside any withKey).
const appendManifestEntry = (payload, dir, opts = {}) =>
  realAppendManifestEntry(payload, dir, { key: currentTestKey, ...opts });
const record = (opts) => realRecord({ key: currentTestKey, ...opts });
const verify = (dir, opts = {}) => realVerify(dir, { key: currentTestKey, ...opts });

// A real git repo fixture: lineage resolution reads the current branch, which
// only means something inside an actual repository.
function repo(t, branch = 'feat/segment-writer') {
  const { dir: root, g } = gitRepo(t, {
    prefix: 'gate-manifest-segwriter-',
    branch,
    userEmail: 't@t.co',
    userName: 'tester',
  });
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

describe('isSegmentedRepo (spec §4.7)', () => {
  it('false for a plain repo with neither marker nor cutover entry', (t) => {
    const { root, dir } = repo(t);
    assert.equal(isSegmentedRepo(dir), false);
  });

  it('true once the activation marker exists', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    assert.equal(isSegmentedRepo(dir), true);
  });

  it('true when root\'s last entry is the cutover entry, even without the marker', (t) => {
    const { root, dir } = repo(t);
    record({ gate: 'manifest-cutover', dir, rawData: JSON.stringify({ reason: 'migration ceremony fixture' }) });
    assert.equal(isSegmentedRepo(dir), true);
  });

  it('a corrupted marker file does not crash — falls through to the cutover-entry test', (t) => {
    const { root, dir } = repo(t);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    writeFileSync(markerPath(dir), 'not json');
    assert.equal(isSegmentedRepo(dir), false);
  });

  it('an unsupported marker version is not honored', (t) => {
    const { root, dir } = repo(t);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    writeFileSync(markerPath(dir), JSON.stringify({ format: 'adlc-manifest-segments', version: 2 }));
    assert.equal(isSegmentedRepo(dir), false);
  });

  it('a symlinked marker (adversarial-review finding) is never followed — treated as absent, not read', (t) => {
    const { root, dir } = repo(t);
    const outsideTarget = join(tmp(t, 'outside-marker-'), 'outside-marker.txt');
    writeFileSync(outsideTarget, JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    symlinkSync(outsideTarget, markerPath(dir));
    assert.equal(isSegmentedRepo(dir), false, 'a symlinked marker must never be followed, even if its target looks valid');
  });

  it('a marker larger than the read cap is refused rather than read unbounded (adversarial-review finding)', (t) => {
    const { root, dir } = repo(t);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    const oversized = JSON.stringify({ format: 'adlc-manifest-segments', version: 1, padding: 'x'.repeat(8192) });
    writeFileSync(markerPath(dir), oversized);
    assert.equal(isSegmentedRepo(dir), false);
  });

  it('the read cap boundary is exact: a marker of exactly 4096 bytes is refused, 4095 is accepted', (t) => {
    const { root, dir } = repo(t);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    const build = (padLen) => JSON.stringify({ format: 'adlc-manifest-segments', version: 1, pad: 'x'.repeat(padLen) });
    let pad = 0;
    let json = build(pad);
    while (json.length < 4096) { pad += 1; json = build(pad); }
    assert.equal(json.length, 4096, 'test construction sanity check');
    writeFileSync(markerPath(dir), json);
    assert.equal(isSegmentedRepo(dir), false, 'exactly the cap must be refused, not treated as fitting');

    const jsonUnderCap = build(pad - 1);
    assert.equal(jsonUnderCap.length, 4095);
    writeFileSync(markerPath(dir), jsonUnderCap);
    assert.equal(isSegmentedRepo(dir), true, 'one byte under the cap must be accepted');
  });
});

describe('deriveSlug (spec §7.1)', () => {
  it('lowercases and keeps only [a-z0-9-]', (t) => {
    assert.equal(deriveSlug('Feat/Cool-Thing_42'), 'feat-cool-thing-42');
  });

  it('collapses dash runs left behind by substituted characters', (t) => {
    assert.equal(deriveSlug('a///b'), 'a-b');
  });

  it('trims leading/trailing dashes', (t) => {
    assert.equal(deriveSlug('/leading-and-trailing/'), 'leading-and-trailing');
  });

  it('falls back to "segment" when derivation yields nothing', (t) => {
    assert.equal(deriveSlug('///___'), 'segment');
    assert.equal(deriveSlug(''), 'segment');
    assert.equal(deriveSlug(undefined), 'segment');
  });

  it('truncates to 40 chars and does not leave a trailing dash at the cut', (t) => {
    const slug = deriveSlug('a'.repeat(39) + '-' + 'b'.repeat(10));
    assert.ok(slug.length <= 40, `expected <=40 chars, got ${slug.length}`);
    assert.ok(!slug.endsWith('-'), `must not end with a dash: ${slug}`);
  });
});

describe('generateSegmentUlid (spec §4.2)', () => {
  it('produces a 26-char uppercase Crockford-base32 string matching the segment grammar', (t) => {
    const ulid = generateSegmentUlid();
    assert.match(ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is distinct across calls (fresh entropy each time)', (t) => {
    const a = generateSegmentUlid();
    const b = generateSegmentUlid();
    assert.notEqual(a, b);
  });
});

describe('currentBranch', () => {
  it('returns the checked-out branch name', (t) => {
    const { root } = repo(t, 'feat/my-branch');
    assert.equal(currentBranch(root), 'feat/my-branch');
  });

  it('returns null for detached HEAD', (t) => {
    const { root, g } = repo(t);
    const sha = g('rev-parse', 'HEAD').trim();
    g('checkout', '-q', '--detach', sha);
    assert.equal(currentBranch(root), null);
  });

  it('returns null when cwd is not a git repo', (t) => {
    const dir = tmp(t, 'not-a-repo-');
    assert.equal(currentBranch(dir), null);
  });
});

describe('.lineage write path refuses to follow a symlink (adversarial-review finding)', () => {
  it('a symlinked .lineage is replaced with a regular file — never written through', (t) => {
    const { root, dir } = repo(t);
    const outsideTarget = join(tmp(t, 'outside-lineage-target-'), 'target.txt');
    writeFileSync(outsideTarget, 'untouched\n');
    activate(dir);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    symlinkSync(outsideTarget, lineagePath(dir));
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // mints a segment, writes the token
    assert.equal(readFileSync(outsideTarget, 'utf8'), 'untouched\n', 'the symlink target must never be written through');
    assert.equal(lstatSync(lineagePath(dir)).isSymbolicLink(), false, '.lineage must be replaced with a regular file');
    const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
    assert.equal(typeof token.segment, 'string');
  });

  it('a symlinked .lineage is treated as absent on read, never followed — mints fresh instead of resolving through it', (t) => {
    const { root, dir } = repo(t);
    const outsideTarget = join(tmp(t, 'outside-lineage-read-'), 'target.txt');
    writeFileSync(outsideTarget, JSON.stringify({ segment: 'not-real-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl', ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', branch: currentBranch(root) }));
    activate(dir);
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    symlinkSync(outsideTarget, lineagePath(dir));
    const resolved = resolveOpenSegment(dir, { cwd: root });
    assert.equal(resolved.isNew, true, 'a symlinked token must never be trusted, even if its content looks valid');
  });
});

describe('resolveOpenSegment (spec §7.1)', () => {
  it('root-less: mints a segment with anchor: null and writes the lineage token', (t) => {
    const { root, dir } = repo(t, 'feat/cool-thing');
    activate(dir);
    const resolved = resolveOpenSegment(dir, { cwd: root });
    assert.equal(resolved.isNew, true);
    assert.equal(resolved.anchor, null);
    assert.match(resolved.name, /^feat-cool-thing-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/);
    const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
    assert.equal(token.segment, resolved.name);
    assert.equal(token.branch, 'feat/cool-thing');
    assert.equal(token.ulid, ulidOf(resolved.name));
  });

  it('with a root: mints a segment anchored to root\'s current head line', (t) => {
    const { root, dir } = repo(t);
    record({ gate: 'evidence', dir });
    activate(dir);
    const resolved = resolveOpenSegment(dir, { cwd: root });
    assert.equal(resolved.isNew, true);
    assert.equal(resolved.anchor.segment, 'root');
    assert.equal(resolved.anchor.seq, 1);
  });

  it('a second resolution on the SAME branch reuses the already-open segment', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    const first = resolveOpenSegment(dir, { cwd: root });
    // Simulate the first entry actually having been written (resolveOpenSegment
    // itself does not write to the segment, only the lineage token).
    writeFileSync(segmentPath(dir, first.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: first.anchor })}\n`);
    const second = resolveOpenSegment(dir, { cwd: root });
    assert.equal(second.isNew, false);
    assert.equal(second.name, first.name);
  });

  it('a DIFFERENT branch mints a new segment, not the other branch\'s open one', (t) => {
    const { root, dir, g } = repo(t, 'feat/branch-a');
    activate(dir);
    const a = resolveOpenSegment(dir, { cwd: root });
    writeFileSync(segmentPath(dir, a.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: a.anchor })}\n`);
    g('checkout', '-q', '-b', 'feat/branch-b');
    const b = resolveOpenSegment(dir, { cwd: root });
    assert.equal(b.isNew, true);
    assert.notEqual(b.name, a.name);
  });

  it('detached HEAD never matches a cached token and never persists a new one', (t) => {
    const { root, dir, g } = repo(t);
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
  });

  // T-MANIFEST-FOREST follow-up (gap 1, ticket T-01KYTQ4BADHSDJNBFNZHB2ZG5V):
  // a WRITE that happens before any read on a fresh clone (no local .lineage
  // token) used to mint a needless duplicate segment rather than continuing a
  // real, unambiguous, already-committed one for this branch — permanently
  // hiding the older evidence once the fresh segment's own token existed.
  // Exercises the REAL producer end-to-end (clone -> append -> read), not just
  // the resolver: AC1 asks that evidence recorded BEFORE the write is still
  // visible to a consumer AFTER it, which a resolver-only assertion cannot show
  // (it would still pass if the append layer or the reader mishandled a
  // recovered segment). Raised by adversarial review of this very change.
  it('AC12: a fresh clone whose FIRST action is a real WRITE extends the branch\'s own committed segment, and the pre-clone evidence stays visible to a reader afterwards', (t) => {
    withKey('ac12-clone-write-key', () => {
      const { root, dir, g } = repo(t, 'feat/clone-write-first');
      activate(dir);
      // Build S1 with the REAL writer so it is signed and chained exactly as production would.
      appendManifestEntry({ gate: 'evidence', data: { note: 'original' } }, dir, { cwd: root });
      const { valid: originValid } = discoverSegments(dir);
      assert.equal(originValid.length, 1, 'precondition: origin has exactly one segment');
      const s1 = originValid[0];
      g('add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${s1}`);
      g('commit', '-q', '-m', 'segment evidence');

      const clonedRoot = tmp(t, 'gate-manifest-clone-write-');
      execFileSync('git', ['clone', '-q', '--branch', 'feat/clone-write-first', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'precondition: the fresh clone has no local .lineage token');

      // The FIRST action in this clone is a REAL WRITE through the production
      // producer — not merely a resolver call.
      appendManifestEntry({ gate: 'evidence', data: { note: 'after-clone' } }, clonedDir, { cwd: clonedRoot });

      const { valid } = discoverSegments(clonedDir);
      assert.deepEqual(valid, [s1], 'the write must EXTEND the committed segment — no needless duplicate minted');

      // ...and a real consumer read AFTER the write still surfaces the pre-clone evidence.
      const { entries } = readManifestForest(clonedDir);
      const notes = entries.map((e) => e.data?.note);
      assert.ok(notes.includes('original'), 'pre-clone evidence must remain visible to a reader AFTER the write');
      assert.ok(notes.includes('after-clone'), 'the newly written evidence must be visible too');
      assert.equal(entries.length, 2, 'exactly the two entries — the recovered segment was extended, not replaced');

      // Deliberately does NOT heal (write) the token from this UNVERIFIED
      // recovery match (adversarial-review finding): the token's downstream
      // trust value (readOwnChains's keyless "peeked" path treats a token
      // match as proof this checkout itself minted the segment) depends on
      // it being written only by a genuine mint.
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'recovering via (b) must never write the local token — it would launder an unverified match into the trusted fast path');
      // A SECOND write re-scans via (b) again (no token to fast-path through)
      // and still extends the same segment — no correctness cost, only a repeated scan.
      appendManifestEntry({ gate: 'evidence', data: { note: 'third' } }, clonedDir, { cwd: clonedRoot });
      assert.deepEqual(discoverSegments(clonedDir).valid, [s1], 'the second write must also extend, not mint');
      assert.equal(readManifestForest(clonedDir).entries.length, 3);
    });
  });

  // Keyed: recovery (and therefore its ambiguity refusal) is key-gated — a
  // keyless writer skips recovery entirely and mints fresh by design,
  // mirroring the keyless reader's refusal to trust recovered content.
  it('AC12: refuses (ambiguous) rather than mint when recovery finds more than one candidate segment for this branch', (t) => withKey('ambiguity-key', () => {
    const { root, dir, g } = repo(t, 'feat/ambiguous-write');
    activate(dir);
    const first = resolveOpenSegment(dir, { cwd: root });
    writeFileSync(segmentPath(dir, first.name), `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: first.anchor, branch: 'feat/ambiguous-write' })}\n`);
    const slug = deriveSlug('feat/ambiguous-write');
    const secondName = `${slug}-${generateSegmentUlid(Date.now() + 1000)}.jsonl`;
    writeFileSync(
      segmentPath(dir, secondName),
      `${JSON.stringify({ seq: 1, gate: 'x', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null, anchor: null, branch: 'feat/ambiguous-write' })}\n`,
    );
    g('add', `.adlc/manifest.d/${secondName}`);
    g('commit', '-q', '-m', 'second ambiguous segment');
    rmSync(lineagePath(dir), { force: true }); // no token to disambiguate

    // A REAL write must refuse — asserting on the resolver alone would not
    // show that the refusal actually propagates out through the producer.
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }),
      /ambiguous/,
      'a WRITE must refuse rather than silently pick one of two candidate segments to extend',
    );
    assert.equal(discoverSegments(dir).valid.length, 2, 'the refused write must not have minted a third segment');
  }));

  // AC13 — a keyless writer facing a committed same-branch segment FAILS
  // CLOSED (two adversarial-review rounds): extending it strands the
  // checkout (the keyless reader refuses recovered content), and minting
  // alongside it shadows the committed evidence behind the fresh token —
  // refusal is the only shape that hides nothing. Keyless GREENFIELD writes
  // (no committed candidate) still mint normally.
  it('AC13: a KEYLESS fresh clone whose first action is a write REFUSES — never extends, never shadow-mints', (t) => withKey(null, () => {
    const { root, dir, g } = repo(t, 'feat/keyless-clone');
    activate(dir);
    // Keyless greenfield mint works — this very write proves it.
    appendManifestEntry({ gate: 'evidence', data: { note: 'original' } }, dir, { cwd: root });
    const s1 = discoverSegments(dir).valid[0];
    const s1Bytes = readFileSync(segmentPath(dir, s1));
    g('add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${s1}`);
    g('commit', '-q', '-m', 'keyless segment evidence');

    const clonedRoot = tmp(t, 'gate-manifest-keyless-clone-');
    execFileSync('git', ['clone', '-q', '--branch', 'feat/keyless-clone', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
    const clonedDir = join(clonedRoot, '.adlc');

    assert.throws(
      () => appendManifestEntry({ gate: 'evidence', data: { note: 'keyless-after-clone' } }, clonedDir, { cwd: clonedRoot }),
      /shadow|neither authenticate/,
      'a keyless write must fail closed when a committed same-branch segment exists',
    );
    assert.equal(discoverSegments(clonedDir).valid.length, 1, 'nothing may have been minted');
    assert.deepEqual(readFileSync(segmentPath(clonedDir, s1)), s1Bytes, 'the committed segment stays byte-identical');
    assert.equal(existsSync(lineagePath(clonedDir)), false, 'no token may have been written');
  }));

  // A v1 signature does not cover `branch`/`anchor` — a bolted-on branch
  // claim atop a valid v1-signed entry still verifies, so authentication
  // must demand a v2-verified FIRST entry, never merely "some entry
  // verifies" (adversarial-review round-7 finding).
  it('AC13: a KEYED writer refuses a candidate whose branch claim rides a v1 signature — identity must be v2-authenticated', (t) => {
    const KEY = 'v1-forgery-key';
    const { root, dir, g } = repo(t, 'feat/v1-forged');
    activate(dir);
    // Build a v1-signed entry (canonical covers seq/gate/ts/data/files/prev
    // ONLY), then bolt on branch + anchor — the signature still verifies.
    const entry = { seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', data: { note: 'v1' }, files: {}, prev: null };
    entry.sig = signEntry(KEY, entry); // no sigVersion → v1 canonical, which omits branch/anchor
    entry.anchor = null;
    entry.branch = 'feat/v1-forged';
    const name = `${deriveSlug('feat/v1-forged')}-${generateSegmentUlid()}.jsonl`;
    writeFileSync(segmentPath(dir, name), `${JSON.stringify(entry)}\n`);
    g('add', `.adlc/manifest.d/${name}`, '.adlc/manifest.d/.store.json');
    g('commit', '-q', '-m', 'forged v1 branch claim');

    const clonedRoot = tmp(t, 'gate-manifest-v1-forged-');
    execFileSync('git', ['clone', '-q', '--branch', 'feat/v1-forged', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
    const clonedDir = join(clonedRoot, '.adlc');

    withKey(KEY, () => {
      assert.throws(
        () => appendManifestEntry({ gate: 'evidence' }, clonedDir, { cwd: clonedRoot }),
        /verified v2 signature|cannot be authenticated/,
        'a v1-signed branch claim is not an authenticated identity',
      );
    });
    assert.equal(discoverSegments(clonedDir).valid.length, 1, 'nothing may have been minted past the refused candidate');
  });

  it('AC13: a KEYED writer refuses when the single recovery candidate cannot be authenticated — no extend, no duplicate mint', (t) => {
    const { root, dir, g } = repo(t, 'feat/unauth-candidate');
    activate(dir);
    withKey(null, () => appendManifestEntry({ gate: 'evidence', data: { note: 'unsigned' } }, dir, { cwd: root }));
    const s1 = discoverSegments(dir).valid[0];
    g('add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${s1}`);
    g('commit', '-q', '-m', 'unsigned segment');

    const clonedRoot = tmp(t, 'gate-manifest-unauth-clone-');
    execFileSync('git', ['clone', '-q', '--branch', 'feat/unauth-candidate', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
    const clonedDir = join(clonedRoot, '.adlc');

    withKey('a-real-key', () => {
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence' }, clonedDir, { cwd: clonedRoot }),
      /cannot be authenticated/,
      'an unauthenticatable same-branch candidate must refuse, not fork the lineage',
    );
    });
    assert.equal(discoverSegments(clonedDir).valid.length, 1, 'no duplicate segment may have been minted');
    assert.equal(existsSync(lineagePath(clonedDir)), false, 'no token may have been written');
  });

  // AC14 — mint-time committability: a branch-derived slug can match an
  // ignore rule that enable's representative probes cannot anticipate.
  it('AC14: minting refuses when the branch-derived segment filename is gitignored — before any evidence is recorded', (t) => withKey(null, () => {
    const { root, dir } = repo(t, 'release/1.0');
    activate(dir);
    writeFileSync(join(root, '.gitignore'), '.adlc/manifest.d/release-*.jsonl\n');
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }),
      /refusing to mint/,
      'evidence written into an ignored file would be local-only — silent divergence',
    );
    assert.equal(discoverSegments(dir).valid.length, 0, 'nothing may have been recorded');
    assert.equal(existsSync(lineagePath(dir)), false, 'no token may have been written');
  }));
});

describe('appendManifestEntry routes to the segment writer once segmented (spec §7)', () => {
  it('a non-segmented repo is completely unaffected — still appends to root', (t) => {
    const { root, dir } = repo(t);
    const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.equal(entry.seq, 1);
    assert.equal(existsSync(join(dir, 'manifest.jsonl')), true);
    assert.equal(discoverSegments(dir).valid.length, 0);
  });

  // Adversarial-review finding: `cwd` must default to the TARGET repo (dir's
  // parent), not this test runner's own `process.cwd()` — which is a
  // DIFFERENT repo, on a different branch, than the fixture repo `dir` lives
  // in. Omitting `cwd` entirely below is the point: if the old
  // `process.cwd()` default were still in effect, the minted segment's slug
  // would reflect THIS repo's branch, not the fixture's.
  it('derives cwd from dir by default, not process.cwd() — the target repo\'s branch is used, not the caller\'s', (t) => {
    const { root, dir } = repo(t, 'feat/target-repo-branch');
    activate(dir);
    const entry = appendManifestEntry({ gate: 'evidence' }, dir);
    assert.equal(entry.seq, 1);
    const { valid } = discoverSegments(dir);
    assert.equal(valid.length, 1);
    assert.match(valid[0], /^feat-target-repo-branch-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/);
  });

  it('a segmented, root-less repo writes its first entry as a new, anchor:null segment', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.equal(entry.seq, 1);
    assert.equal(entry.anchor, null);
    const { valid } = discoverSegments(dir);
    assert.equal(valid.length, 1);
    assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be touched once segmented');
  });

  it('a segmented repo WITH a root anchors the first segment entry to it', (t) => {
    const { root, dir } = repo(t);
    record({ gate: 'evidence', dir }); // a real root entry, pre-cutover
    activate(dir);
    const rootBytesBefore = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    const rootLastLine = rootBytesBefore.trim().split('\n').at(-1);
    const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.deepEqual(entry.anchor, { segment: 'root', seq: 1, lineHash: sha256(rootLastLine) });
    assert.equal(readFileSync(join(dir, 'manifest.jsonl'), 'utf8'), rootBytesBefore, 'root bytes must not change');
  });

  it('a second append on the same branch continues the same segment: seq 2, no anchor', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    const first = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const second = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(Object.hasOwn(second, 'anchor'), false);
    assert.equal(discoverSegments(dir).valid.length, 1, 'must not mint a second segment for the same branch');
  });

  // T-MANIFEST-FOREST, fourth round: the first (anchor-carrying) entry must
  // also carry the EXACT minting branch, alongside `anchor` — this is what
  // recoverOpenSegment now matches on instead of the lossy filename slug.
  it('the anchor-carrying first entry also carries the exact minting branch; continuation entries never do', (t) => {
    const { root, dir } = repo(t, 'feat/branch-field');
    activate(dir);
    const first = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const second = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.equal(first.branch, 'feat/branch-field');
    assert.equal(Object.hasOwn(second, 'branch'), false);
  });

  it('a detached-HEAD mint carries no branch field at all (not a null sentinel — there is no identity to record)', (t) => {
    const { root, dir, g } = repo(t);
    activate(dir);
    g('checkout', '-q', '--detach', 'HEAD');
    const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    assert.equal(Object.hasOwn(entry, 'branch'), false);
  });

  it('the branch field is inside the signed byte range — tampering with it invalidates the v2 signature', (t) => {
    const { root, dir } = repo(t, 'feat/branch-signed');
    activate(dir);
    withKey('branch-sig-key', () => {
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.equal(entry.branch, 'feat/branch-signed');
      const tampered = { ...entry, branch: 'feat/some-other-branch' };
      assert.equal(verifyEntrySig('branch-sig-key', tampered), false, 'a forged branch claim must invalidate the signature');
    });
  });

  it('a continuation entry (not the anchor-carrying first one) signs at the default v2, not some other version', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    withKey('seg-key', () => {
      appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // first: anchor-carrying, forced v2 regardless
      const second = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // continuation: default applies
      assert.equal(second.sigVersion, 2);
      assert.equal(verifyEntrySig('seg-key', second), true);
    });
  });

  it('tolerates a legacy unsigned root prefix when checking chain integrity before a segment append', (t) => {
    const { root, dir } = repo(t);
    record({ gate: 'evidence', dir }); // no key set yet: an honest unsigned legacy entry
    activate(dir);
    withKey('seg-key', () => {
      // A key IS present now, so this only succeeds if the integrity precondition
      // tolerates root's unsigned legacy prefix (requireSignatures:false) instead of
      // demanding every entry be signed (requireSignatures:true would reject this).
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
      assert.equal(entry.seq, 1);
    });
  });

  it('reserved field "anchor" is refused before it ever reaches the segment writer', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence', anchor: { segment: 'root', seq: 1, lineHash: 'x' } }, dir, { cwd: root }),
      /reserved chain field: anchor/,
    );
  });

  // T-MANIFEST-FOREST, fourth round, adversarial-review finding: a caller-
  // supplied `branch` used to be silently overwritten by (and, before that
  // fix, could silently OVERWRITE) the writer's own `currentBranch()` value,
  // since `normalized` (built from `...payload`) was spread AFTER the
  // writer-computed `branch`. A payload claiming a false branch, once
  // v2-signed, would authenticate a lie recoverOpenSegment later trusts.
  it('reserved field "branch" is refused before it ever reaches the segment writer', (t) => {
    const { root, dir } = repo(t, 'feat/real-branch');
    activate(dir);
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence', branch: 'main' }, dir, { cwd: root }),
      /reserved chain field: branch/,
    );
  });

  it('entries are signed when a key is present, and the anchor-carrying entry is v2 EVEN if v1 was requested', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    withKey('seg-key', () => {
      const entry = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root, signatureVersion: 1 });
      assert.equal(entry.sigVersion, 2, 'the anchor-carrying first entry must be forced to v2');
      assert.equal(verifyEntrySig('seg-key', entry), true);
    });
  });

  it('a full round trip (mint + continue) verifies clean across the forest', (t) => {
    const { root, dir } = repo(t);
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
  });

  it('refuses to append onto a forest with a broken chain', (t) => {
    const { root, dir } = repo(t);
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
  });

  // Adversarial-review finding: a rootless segmented repo's ONLY activation
  // signal (once root doesn't exist to carry a cutover entry) is the marker
  // file. If it's lost/corrupted, isSegmentedRepo silently reports "not
  // segmented", and the root-append path would have happily created
  // manifest.jsonl for the first time — retroactively making every existing
  // anchor: null segment invalid (spec §4.4 forbids anchor: null once a root
  // exists).
  it('refuses to create a root when rootless segments already exist but the marker is lost', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // a real anchor:null segment
    rmSync(markerPath(dir), { force: true }); // simulate the marker being lost/corrupted
    assert.equal(isSegmentedRepo(dir), false, 'test precondition: marker loss must make isSegmentedRepo false');
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }),
      /refusing to create the root manifest/,
    );
    assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be created when doing so would invalidate existing segments');
  });

  // Adversarial-review finding: verify()'s chain-integrity precondition used
  // to run BEFORE the checkout-wide .lineage lock was acquired. A second
  // writer's verify() could therefore observe another writer's segment file
  // in its transient, just-created-but-not-yet-written state (openSync(...,
  // 'a') creates the file before the first line is written) and fail the
  // whole forest instead of simply queuing on the lock. Proven here without
  // real concurrency: pre-hold the .lineage lock (simulating another writer
  // already inside the critical section) over a forest that is ALSO
  // genuinely broken. If verify() still ran before the lock, this would fail
  // fast with "manifest forest is invalid"; since it now runs after
  // acquiring the lock, it must instead retry-and-time-out trying to get the
  // lock first, surfacing withLedgerLock's OWN error.
  it('verify() runs INSIDE the checkout-wide lock, not before it — a held lock is what blocks, not a stale invalid-forest read', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const { valid } = discoverSegments(dir);
    const segFile = segmentPath(dir, valid[0]);
    const entry = JSON.parse(readFileSync(segFile, 'utf8').trim());
    entry.prev = 'f'.repeat(64); // break the chain — verify() would fail this forest
    writeFileSync(segFile, `${JSON.stringify(entry)}\n`);

    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    writeFileSync(`${lineagePath(dir)}.lock`, JSON.stringify({ version: 1, token: 'someone-else', pid: 99999, hostname: 'other-host', startedAt: new Date().toISOString() }));
    assert.throws(
      () => appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }),
      /could not acquire ledger lock/,
      'must retry the LOCK first (and time out on it), not fail fast on a stale-outside-the-lock verify() read',
    );
  });
});

// recoverOpenSegment (T-MANIFEST-FOREST lineage-durability finding): peekOpenSegment
// alone returns null whenever the local, gitignored `.lineage` token is absent or
// stale — a fresh clone (the token never travels with `git clone`) or a checkout
// that switched away and back to this branch (another branch's open-segment
// resolution overwrites the single token file) — even when a real, COMMITTED
// segment for this branch exists on disk. recoverOpenSegment adds a read-only
// fallback: scan committed segments for one whose derived slug matches this
// branch's, exact match only (never a prefix match, which would wrongly cross-match
// e.g. branch "feat" against branch "feat-x"'s segment).
describe('recoverOpenSegment (lineage-durability finding)', () => {
  it('delegates to peekOpenSegment when the token is present and matches — identical result', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    const first = appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const recovered = recoverOpenSegment(dir, { cwd: root });
    assert.ok(recovered, 'the just-written segment must be found');
    assert.equal(recovered.isNew, false);
    const raw = readFileSync(segmentPath(dir, recovered.name), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(raw[0]).data?.transactionId, first.data?.transactionId ?? undefined);
  });

  it('returns null when this branch genuinely has no segment yet (not an error)', (t) => {
    const { root, dir } = repo(t);
    activate(dir);
    assert.equal(recoverOpenSegment(dir, { cwd: root }), null);
  });

  it('AC1: finds a committed segment on a FRESH CLONE, which never has a local .lineage token', (t) => {
    const { root, dir, g } = repo(t, 'feat/clone-recovery');
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const { valid } = discoverSegments(dir);
    assert.equal(valid.length, 1, 'precondition: exactly one segment was minted');
    // Commit the marker and the segment — NOT .lineage, which stays local per
    // spec §4.8/§7 point 1, exactly like a real gitignored checkout.
    g('add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${valid[0]}`);
    g('commit', '-q', '-m', 'segment evidence');

    const clonedRoot = tmp(t, 'gate-manifest-clone-');
    execFileSync('git', ['clone', '-q', '--branch', 'feat/clone-recovery', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
    const clonedDir = join(clonedRoot, '.adlc');
    assert.equal(existsSync(lineagePath(clonedDir)), false, 'precondition: the fresh clone has no local .lineage token');

    const recovered = recoverOpenSegment(clonedDir, { cwd: clonedRoot });
    assert.ok(recovered, 'a fresh clone must still find its branch\'s committed segment');
    assert.equal(recovered.name, valid[0]);
  });

  it('AC2: a checkout switching A -> B -> A does not lose visibility into A\'s own segment, despite B overwriting the token', (t) => {
    const { root, dir, g } = repo(t, 'feat/branch-a');
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const { valid: segmentsOnA } = discoverSegments(dir);
    assert.equal(segmentsOnA.length, 1);
    const aSegment = segmentsOnA[0];

    g('checkout', '-q', '-b', 'feat/branch-b');
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // mints B's own segment, overwrites .lineage
    const { valid: segmentsOnB } = discoverSegments(dir);
    assert.equal(segmentsOnB.length, 2, 'precondition: branch B minted its own, separate segment');
    const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
    assert.equal(token.branch, 'feat/branch-b', 'precondition: the token now names B, not A');

    g('checkout', '-q', 'feat/branch-a');
    assert.equal(currentBranch(root), 'feat/branch-a', 'precondition: checked out back to A');
    // peekOpenSegment alone would return null here: the token names branch B, not A.
    const recovered = recoverOpenSegment(dir, { cwd: root });
    assert.ok(recovered, 'recoverOpenSegment must find A\'s own segment despite the token now naming B');
    assert.equal(recovered.name, aSegment, 'must resolve to A\'s real segment, never B\'s');
  });

  it('AC3: refuses to guess when more than one committed segment declares this branch as its own', (t) => {
    const { root, dir, g } = repo(t, 'feat/ambiguous');
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const { valid: before } = discoverSegments(dir);
    assert.equal(before.length, 1);
    const slug = deriveSlug('feat/ambiguous');
    // A second, independently-minted segment genuinely owned by the SAME branch —
    // legitimate per spec §7 point 1 (two branches forked from the same rootless
    // state can each mint independently without coordinating; the same branch can
    // equally end up with two if a token was lost mid-stream and a second mint
    // happened). Simulated here by hand-writing a second well-formed segment whose
    // first entry declares the SAME `branch` field the real one does, then
    // discarding the token so neither is preferred by the fast path.
    const secondName = `${slug}-${generateSegmentUlid(Date.now() + 1000)}.jsonl`;
    writeFileSync(
      segmentPath(dir, secondName),
      `${JSON.stringify({ seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: {}, files: {}, prev: null, anchor: null, branch: 'feat/ambiguous' })}\n`,
    );
    g('add', `.adlc/manifest.d/${secondName}`);
    g('commit', '-q', '-m', 'second ambiguous segment');
    rmSync(lineagePath(dir), { force: true }); // no token to disambiguate

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /ambiguous/,
      'must refuse to silently pick one of two candidate segments',
    );
  });

  it('a branch whose derived filename slug is a PREFIX of another branch\'s never cross-matches (exact `branch`-field match only)', (t) => {
    const { root, dir, g } = repo(t, 'feat');
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root }); // mints "feat-<ULID>.jsonl"
    const { valid: onFeat } = discoverSegments(dir);
    assert.equal(onFeat.length, 1);

    g('checkout', '-q', '-b', 'feat-x'); // filename slug "feat-x" — "feat-" is a PREFIX of "feat-x-<ULID>.jsonl" too
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const { valid: onFeatX } = discoverSegments(dir);
    assert.equal(onFeatX.length, 2);

    g('checkout', '-q', 'feat');
    rmSync(lineagePath(dir), { force: true }); // force recovery, not the fast token path
    const recovered = recoverOpenSegment(dir, { cwd: root });
    assert.ok(recovered, 'branch "feat" must still find its own segment');
    assert.equal(recovered.name, onFeat[0], 'must resolve to "feat"\'s own segment, never "feat-x"\'s, despite the prefix overlap');
  });

  it('returns null on detached HEAD — no branch identity to recover by', (t) => {
    const { root, dir, g } = repo(t);
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    g('checkout', '-q', '--detach', 'HEAD');
    assert.equal(currentBranch(root), null, 'precondition: detached HEAD');
    assert.equal(recoverOpenSegment(dir, { cwd: root }), null);
  });

  // Adversarial-review finding, T-MANIFEST-FOREST sixth/seventh rounds:
  // recovery used to read and split the WHOLE segment file just to inspect
  // its first line, so scan cost grew with the total size of every
  // discovered segment. A segment whose first entry alone exceeds the
  // bounded-read cap must REFUSE (round 7 — never silently exclude it as
  // "not a candidate", since nothing on the write side caps entry size, so
  // a legitimately large evidence payload could hit this exact case and
  // silently vanish from recovery the same way the original bug worked).
  it('an oversized first entry (larger than the bounded read cap) makes recovery refuse, never silently excludes the segment', (t) => {
    const { root, dir } = repo(t, 'feat/oversized-first-entry');
    activate(dir);
    const slug = deriveSlug('feat/oversized-first-entry');
    const oversizedName = `${slug}-${generateSegmentUlid()}.jsonl`;
    // A first "entry" whose JSON alone is well over 64 KiB — real segment
    // entries are a few hundred bytes; nothing legitimate is ever this large.
    const oversized = {
      seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: { padding: 'x'.repeat(200_000) },
      files: {}, prev: null, anchor: null, branch: 'feat/oversized-first-entry',
    };
    writeFileSync(segmentPath(dir, oversizedName), `${JSON.stringify(oversized)}\n`);
    rmSync(lineagePath(dir), { force: true });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /exceeds the .+-byte bounded-read cap/,
      'an oversized first entry must refuse the whole recovery attempt, not be silently excluded as a non-candidate',
    );
  });

  // Round 8 of the same finding: a MALFORMED (non-JSON) first entry hit the
  // SAME silent-exclusion bug the oversized case above already closed —
  // firstEntryOf's catch block returned `null` for a JSON.parse failure
  // exactly like it does for a genuinely empty file, so recoverOpenSegment
  // treated a corrupted segment as "not a candidate" instead of "cannot
  // determine". A truncated write, disk fault, or malicious commit can
  // produce exactly this shape; the branch is unknowable, not absent.
  it('a malformed (non-JSON) first entry makes recovery refuse, never silently excludes the segment', (t) => {
    const { root, dir } = repo(t, 'feat/malformed-first-entry');
    activate(dir);
    const slug = deriveSlug('feat/malformed-first-entry');
    const malformedName = `${slug}-${generateSegmentUlid()}.jsonl`;
    writeFileSync(segmentPath(dir, malformedName), '{not valid json at all\n');
    rmSync(lineagePath(dir), { force: true });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /first entry could not be read or parsed/,
      'a malformed first entry must refuse the whole recovery attempt, not be silently excluded as a non-candidate',
    );
  });

  // firstEntryOf's OTHER catch — openSync itself failing — is a distinct code
  // path from the JSON.parse failure above: discoverSegments already
  // confirmed this name exists as a regular file at discovery time (its own
  // lstatSync), so the only way open can still fail here is a permissions
  // change or a TOCTOU race between discovery and this read. A chmod'd-
  // unreadable file exercises exactly that gap deterministically.
  it('a segment that exists but cannot be opened (permission denied) makes recovery refuse, never silently excludes it', { skip: process.platform === 'win32' }, (t) => {
    const { root, dir } = repo(t, 'feat/unreadable-first-entry');
    activate(dir);
    const slug = deriveSlug('feat/unreadable-first-entry');
    const unreadableName = `${slug}-${generateSegmentUlid()}.jsonl`;
    const unreadablePath = segmentPath(dir, unreadableName);
    writeFileSync(unreadablePath, `${JSON.stringify({ seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: {}, files: {}, prev: null, anchor: null, branch: 'feat/unreadable-first-entry' })}\n`);
    chmodSync(unreadablePath, 0o000);
    rmSync(lineagePath(dir), { force: true });

    t.after(() => {
      try { chmodSync(unreadablePath, 0o644); } catch {}
    });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /first entry could not be read or parsed/,
      'a segment that cannot be opened must refuse the whole recovery attempt, not be silently excluded as a non-candidate',
    );
  });

  // Defect check: recoverOpenSegment must not only scan
  // discoverSegments(dir).valid while silently ignoring .invalid — a real segment
  // renamed to a bad-grammar name, replaced with a symlink, or otherwise
  // turned into a non-conforming filesystem object must not become indistinguishable
  // from "never existed", preventing silent exclusion at the discovery
  // layer rather than only at the read layer.
  it('recoverOpenSegment refuses when an INVALID filesystem object exists under manifest.d/, never silently excludes it', (t) => {
    const { root, dir } = repo(t, 'feat/invalid-object-present');
    activate(dir);
    appendManifestEntry({ gate: 'evidence' }, dir, { cwd: root });
    const segDir = join(dir, 'manifest.d');
    const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
    // Rename the real, valid segment to a bad-grammar name — discoverSegments
    // now reports it under `invalid`, not `valid`.
    renameSync(join(segDir, segName), join(segDir, 'not-a-conforming-name.jsonl.bak'));
    rmSync(lineagePath(dir), { force: true });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /non-conforming filesystem object/,
      'an invalid object anywhere under manifest.d/ must refuse recovery, not be silently treated as absent',
    );
  });

  // A genuinely EMPTY (zero-byte) segment file is not a legitimate "nothing here"
  // state — this package's own verifyChain treats an empty segment as INVALID
  // ("has no first entry to carry the required anchor"), since every real segment's
  // mint atomically writes its anchor-carrying first entry. A zero-byte segment can
  // only mean a crash between file creation and first append, or truncation.
  it('recoverOpenSegment refuses when a real segment file exists but is empty, never silently excludes it', (t) => {
    const { root, dir } = repo(t, 'feat/empty-segment-present');
    activate(dir);
    const slug = deriveSlug('feat/empty-segment-present');
    const emptyName = `${slug}-${generateSegmentUlid()}.jsonl`;
    writeFileSync(segmentPath(dir, emptyName), '');
    rmSync(lineagePath(dir), { force: true });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /first entry could not be read or parsed/,
      'an empty segment file must refuse recovery, not be silently treated as a non-candidate',
    );
  });

  // Pins the EXACT bounded-read cap value (64 KiB), not just "very large":
  // a first line whose JSON body is exactly 65536 bytes places its trailing
  // newline at byte offset 65536 — the 65537th byte, one past a 65536-byte
  // read window. A cap even one byte larger would read far enough to see
  // that newline and successfully parse this line; the real cap must not.
  it('the bounded-read cap is exactly 64 KiB: a first line whose newline sits one byte past it makes recovery refuse', (t) => {
    const { root, dir } = repo(t, 'feat/exact-cap-boundary');
    activate(dir);
    const branch = 'feat/exact-cap-boundary';
    const slug = deriveSlug(branch);
    const boundaryName = `${slug}-${generateSegmentUlid()}.jsonl`;
    const base = { seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', data: { padding: '' }, files: {}, prev: null, anchor: null, branch };
    const baseLength = JSON.stringify(base).length;
    const CAP = 65536;
    assert.ok(baseLength < CAP, 'precondition: padding must be able to grow, not shrink, to hit the cap exactly');
    base.data.padding = 'x'.repeat(CAP - baseLength);
    const firstLine = JSON.stringify(base);
    assert.equal(firstLine.length, CAP, 'precondition: the first line body is exactly at the cap — its trailing newline is the (CAP+1)th byte');
    writeFileSync(segmentPath(dir, boundaryName), `${firstLine}\n`);
    rmSync(lineagePath(dir), { force: true });

    assert.throws(
      () => recoverOpenSegment(dir, { cwd: root }),
      /exceeds the .+-byte bounded-read cap/,
      'a first line landing its newline exactly one byte past the cap must refuse, not parse',
    );
  });
});
