// manifest-segments.test.mjs — segmented gate-manifest support for ticket
// evidence (T-MANIFEST-FOREST). Covers both manifest-segments.mjs directly
// and recordTicketEvidence's routing through it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, renameSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../lib/canonical.mjs';
import { recordTicketEvidence } from '../lib/evidence.mjs';
import {
  isSegmentedRepo, resolveOpenSegment, recoverOpenSegment, readForestEntries, segmentPath,
  lineagePath, deriveSlug, generateSegmentUlid, currentBranch, readOwnChains, canonicalEntryBytes,
} from '../lib/manifest-segments.mjs';

function gitRepo(branch = 'feat/ticket-evidence') {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-segments-'));
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
  return { root, dir };
}

function activate(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

function clean(root) {
  rmSync(root, { recursive: true, force: true });
}

// The key is an EXPLICIT parameter (spec Layer 2, P1): every recordTicketEvidence
// call below passes it directly — env manipulation is inert by design.
const baseEvidence = (over = {}) => ({
  transactionId: 'tx-1', operation: 'complete', ticketId: 'A',
  ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null, ...over,
});

describe('isSegmentedRepo (mirrors @adlc/gate-manifest)', () => {
  it('false for a plain repo', () => {
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

  it('a symlinked marker is never followed — treated as absent', () => {
    const { root, dir } = gitRepo();
    const outsideTarget = join(root, '..', `outside-marker-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(outsideTarget, JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      symlinkSync(outsideTarget, join(dir, 'manifest.d', '.store.json'));
      assert.equal(isSegmentedRepo(dir), false);
    } finally { clean(root); rmSync(outsideTarget, { force: true }); }
  });

  it('the marker read cap boundary is exact: 4096 bytes is refused, 4095 is accepted', () => {
    const { root, dir } = gitRepo();
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      const markerFile = join(dir, 'manifest.d', '.store.json');
      const build = (padLen) => JSON.stringify({ format: 'adlc-manifest-segments', version: 1, pad: 'x'.repeat(padLen) });
      let pad = 0;
      let json = build(pad);
      while (json.length < 4096) { pad += 1; json = build(pad); }
      assert.equal(json.length, 4096, 'test construction sanity check');
      writeFileSync(markerFile, json);
      assert.equal(isSegmentedRepo(dir), false, 'exactly the cap must be refused');

      const jsonUnderCap = build(pad - 1);
      assert.equal(jsonUnderCap.length, 4095);
      writeFileSync(markerFile, jsonUnderCap);
      assert.equal(isSegmentedRepo(dir), true, 'one byte under the cap must be accepted');
    } finally { clean(root); }
  });
});

describe('recordTicketEvidence routes to the segment writer once segmented', () => {
  it('a non-segmented repo is unaffected — still appends to root', () => {
    const { root, dir } = gitRepo();
    try {
      const entry = recordTicketEvidence(root, baseEvidence());
      assert.equal(entry.seq, 1);
      assert.equal(existsSync(join(dir, 'manifest.jsonl')), true);
    } finally { clean(root); }
  });

  it('a segmented, root-less repo writes its first entry as a new, anchor:null segment — never touching root', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const entry = recordTicketEvidence(root, baseEvidence());
      assert.equal(entry.seq, 1);
      assert.equal(entry.anchor, null);
      assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be created once segmented');
      const { entries } = { entries: readForestEntries(dir) };
      assert.equal(entries.length, 1);
    } finally { clean(root); }
  });

  // T-MANIFEST-FOREST, fourth round: the anchor-carrying first entry also
  // carries the EXACT minting branch — what recoverOpenSegment now matches on
  // instead of the lossy filename slug. Mirrors
  // @adlc/gate-manifest/lib/segment-writer.mjs's identical coverage.
  it('the anchor-carrying first entry also carries the exact minting branch; continuation entries never do', () => {
    const { root, dir } = gitRepo('feat/branch-field');
    try {
      activate(dir);
      const first = recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1' }));
      const second = recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-2', operation: 'complete' }));
      assert.equal(first.branch, 'feat/branch-field');
      assert.equal(Object.hasOwn(second, 'branch'), false);
    } finally { clean(root); }
  });

  it('recognizes a segment whose slug contains digits 2-9 (full character-class range, not just 0-1)', () => {
    const { root, dir } = gitRepo('feat/t789-full-digit-range');
    try {
      activate(dir);
      const first = recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1' }));
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.match(resolved.name, /^feat-t789-full-digit-range-/, 'the slug must keep every digit 0-9, not just 0-1');
      assert.equal(resolved.isNew, false, 'the just-written segment must be recognized as already open, proving the grammar still matches it');
      const raw = readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n');
      assert.equal(raw.length, 1);
      assert.equal(JSON.parse(raw[0]).data.transactionId, first.data.transactionId);
    } finally { clean(root); }
  });

  it('a second evidence append on the same branch continues the same segment', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1' }));
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-2', operation: 'complete' }));
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.equal(resolved.isNew, false, 'must continue the already-open segment, not mint a second one');
      const raw = readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n');
      assert.equal(raw.length, 2);
    } finally { clean(root); }
  });

  it('idempotency: a matching retry returns the existing segment entry without appending a duplicate', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const first = recordTicketEvidence(root, baseEvidence());
      const retry = recordTicketEvidence(root, baseEvidence());
      assert.deepEqual(retry, first);
      const resolved = resolveOpenSegment(dir, { cwd: root });
      const raw = readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n');
      assert.equal(raw.length, 1, 'a matching retry must not append a second entry');
    } finally { clean(root); }
  });

  it('idempotency conflict: same transaction/action with DIFFERENT evidence is refused, in a segment', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({ storeHash: '0'.repeat(64) })),
        (error) => error.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT',
      );
    } finally { clean(root); }
  });

  it('entries are signed at v2 when a key is present (anchor coverage)', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      const entry = recordTicketEvidence(root, baseEvidence({ key: 'seg-key' }));
      assert.equal(entry.sigVersion, 2);
      assert.equal(typeof entry.sig, 'string');
    } finally { clean(root); }
  });

  it('refuses to create a root when rootless segments already exist but the marker is lost', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence()); // a real anchor:null segment
      rmSync(join(dir, 'manifest.d', '.store.json'), { force: true }); // simulate marker loss
      assert.equal(isSegmentedRepo(dir), false, 'test precondition');
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-2' })),
        (error) => error.code === 'MANIFEST_FROZEN',
      );
      assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be created when it would invalidate existing segments');
    } finally { clean(root); }
  });

  it('refuses to append when a DIFFERENT segment (not the target) has a broken chain', () => {
    const { root, dir } = gitRepo('feat/branch-a');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence()); // real segment for branch-a
      const branchASegment = resolveOpenSegment(dir, { cwd: root }).name;

      execFileSync('git', ['checkout', '-q', '-b', 'feat/branch-b'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      // Corrupt branch-a's segment — NOT the one branch-b is about to target.
      const segFile = segmentPath(dir, branchASegment);
      const entry = JSON.parse(readFileSync(segFile, 'utf8').trim());
      entry.prev = 'f'.repeat(64);
      writeFileSync(segFile, `${JSON.stringify(entry)}\n`);

      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-branch-b' })),
        (error) => error.code === 'INVALID_MANIFEST',
        'a corrupted sibling segment must block the append, not just a corrupted target',
      );
    } finally { clean(root); }
  });

  it('idempotency scan is forest-wide: a prior root entry (pre-migration) is still found once segmented', () => {
    const { root, dir } = gitRepo();
    try {
      const first = recordTicketEvidence(root, baseEvidence()); // root, pre-segmentation
      activate(dir); // simulate a migration cutover happening after this evidence was recorded
      const retry = recordTicketEvidence(root, baseEvidence());
      assert.deepEqual(retry, first, 'a segmented repo must still see root-recorded evidence for idempotency');
    } finally { clean(root); }
  });

  // Adversarial-review finding: forestChainsIntact used to check ONLY the hash
  // chain, never signatures — so with a signing key configured, an attacker who
  // can write to the checkout (a malicious branch, or a compromised recovery
  // path) could append a correctly hash-chained but UNSIGNED forged entry, and
  // the idempotency scan would trust it as genuine evidence, finalizing a
  // transaction (and deleting its recovery journal) against a claim nobody with
  // the key ever actually signed.
  it('refuses to trust a forged, correctly-chained-but-UNSIGNED entry once this chain\'s signed era has begun', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1', key: 'forge-test-key' })); // real, signed

      // Forge a SECOND entry: correctly hash-chained, but no `sig` at all —
      // exactly what an attacker without the signing key can produce.
      const resolved = resolveOpenSegment(dir, { cwd: root });
      const segFile = segmentPath(dir, resolved.name);
      const raw = readFileSync(segFile, 'utf8').trim().split('\n');
      const prevLine = raw.at(-1);
      const forged = {
        seq: 2, gate: 'ticket-complete', ts: '2026-01-01T00:00:00.000Z', ticket: 'A',
        data: {
          operation: 'complete', action: 'apply', transactionId: 'tx-forged',
          ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), bindingScope: 'ticket',
        },
        files: {},
        prev: createHash('sha256').update(prevLine).digest('hex'),
      };
      writeFileSync(segFile, `${prevLine}\n${JSON.stringify(forged)}\n`);

      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({
          transactionId: 'tx-forged', ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: 'forge-test-key',
        })),
        (error) => error.code === 'INVALID_MANIFEST',
        'the forged entry must not be trusted as genuine evidence, even though it matches the lookup exactly'
      );
    } finally { clean(root); }
  });

  // Adversarial-review finding: an ENTIRELY unsigned forged SEGMENT (as opposed
  // to an unsigned entry appended after a signed one, above) passes
  // forestChainsIntact by design — a chain with zero signed entries is
  // indistinguishable from an honest chain that predates signing, per
  // gate-manifest's own documented "legacy chain" limit. findMatchingEvidence
  // must not rely on that chain-wide tolerance alone: it must require the
  // SPECIFIC candidate entry to carry a valid signature before trusting it.
  it('refuses to trust a match found in a wholly-UNSIGNED forged segment, even though its chain passes on its own', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1', key: 'forge-test-key-2' })); // real, signed, own segment

      // A BRAND NEW segment, entirely unsigned end-to-end — never touches the
      // real segment. Its own chain is internally valid and has zero signed
      // entries, so forestChainsIntact accepts it as an honest legacy chain.
      const forgedName = `forged-${'Y'.repeat(26)}.jsonl`;
      const forged = {
        seq: 1, gate: 'ticket-complete', ts: '2026-01-01T00:00:00.000Z', ticket: 'A',
        data: {
          operation: 'complete', action: 'apply', transactionId: 'tx-forged-2',
          ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), bindingScope: 'ticket',
        },
        files: {}, prev: null, anchor: null,
      };
      writeFileSync(join(dir, 'manifest.d', forgedName), `${JSON.stringify(forged)}\n`);

      // The real write proceeds — it must NOT trust the forged entry as
      // already-recorded evidence, and must NOT refuse the whole forest either
      // (the forged segment's OWN chain is honestly legacy-unsigned).
      const result = recordTicketEvidence(root, baseEvidence({
        transactionId: 'tx-forged-2', ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: 'forge-test-key-2',
      }));
      assert.equal(typeof result.sig, 'string', 'the write that actually happened is genuinely signed');
      const resolved = resolveOpenSegment(dir, { cwd: root });
      assert.notEqual(resolved.name, forgedName, 'the real evidence lands in this checkout\'s own segment, not the forged one');
    } finally { clean(root); }
  });

  // P5 prosecution finding: this file's discoverSegmentNames used to silently
  // SKIP a non-conforming filesystem object under manifest.d/ (a symlink, a
  // nested directory, a bad-grammar name) instead of failing the whole forest
  // closed the way gate-manifest's own discoverSegments does (spec §5 item 1;
  // see packages/gate-manifest/test/forest-format.test.mjs's identical test).
  // forestChainsIntact's own doc claims to mirror gate-manifest's precondition
  // — a nested directory shadowing where a real segment (e.g. one holding a
  // needs-attention revocation) should be must block a ticket transaction the
  // same way it blocks gate-manifest's own segment-writer.mjs.
  it('rejects a nested directory under manifest.d/ — forestChainsIntact must agree with gate-manifest verify()', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      mkdirSync(join(dir, 'manifest.d', 'needs-attention-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), { recursive: true });
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence()),
        (error) => error.code === 'INVALID_MANIFEST',
        'a nested directory anywhere under manifest.d/ must block evidence recording, not be silently skipped'
      );
    } finally { clean(root); }
  });

  // P5 prosecution finding (security lens): a real segment renamed to end in
  // .lock must NOT be silently hidden by a name-only skip — mirrors gate-
  // manifest's own "a real segment renamed to end in .lock is NOT silently
  // hidden" test (forest-format.test.mjs). forestChainsIntact's own doc
  // claims to mirror gate-manifest's precondition; a name-only skip would
  // let a malicious branch vanish a real (possibly broken or revoked)
  // segment from the forest by renaming it, defeating that claim.
  it('a real segment disguised with a .lock suffix is NOT silently hidden — its content does not match a genuine lock', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-1' })); // real segment
      const resolved = resolveOpenSegment(dir, { cwd: root });
      const realSegPath = segmentPath(dir, resolved.name);
      const disguisedPath = `${realSegPath}.lock`;
      renameSync(realSegPath, disguisedPath);

      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-2' })),
        (error) => error.code === 'INVALID_MANIFEST',
        'a disguised real segment must be reported invalid, not excluded as a genuine transient lock'
      );
    } finally { clean(root); }
  });
});

// recoverOpenSegment (T-MANIFEST-FOREST lineage-durability finding) — mirrors
// @adlc/gate-manifest/lib/lineage.mjs's identical function and its own test suite
// in segment-writer.test.mjs; see that file's header comment for the full
// rationale. peekOpenSegment alone returns null whenever the local, gitignored
// `.lineage` token is absent or stale, even when a real, committed segment for
// this branch exists on disk — readOwnChains and everything built on it
// (ticket-sync push, doctor, reassignment) route through recoverOpenSegment
// instead so that stays discoverable.
describe('recoverOpenSegment (lineage-durability finding)', () => {
  it('delegates to peekOpenSegment when the token is present and matches — identical result', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      const recovered = recoverOpenSegment(dir, { cwd: root });
      assert.ok(recovered, 'the just-written segment must be found');
      assert.equal(recovered.isNew, false);
    } finally { clean(root); }
  });

  it('returns null when this branch genuinely has no segment yet (not an error)', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      assert.equal(recoverOpenSegment(dir, { cwd: root }), null);
    } finally { clean(root); }
  });

  it('AC1: finds a committed segment on a FRESH CLONE, which never has a local .lineage token', () => {
    const { root, dir } = gitRepo('feat/clone-recovery');
    let clonedRoot;
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      const resolved = resolveOpenSegment(dir, { cwd: root });
      // Commit the marker and the segment — NOT .lineage, which stays local per
      // spec §4.8/§7 point 1, exactly like a real gitignored checkout.
      execFileSync('git', ['add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${resolved.name}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'segment evidence'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      clonedRoot = mkdtempSync(join(tmpdir(), 'adlc-ticket-segments-clone-'));
      execFileSync('git', ['clone', '-q', '--branch', 'feat/clone-recovery', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'precondition: the fresh clone has no local .lineage token');

      const recovered = recoverOpenSegment(clonedDir, { cwd: clonedRoot });
      assert.ok(recovered, 'a fresh clone must still find its branch\'s committed segment');
      assert.equal(recovered.name, resolved.name);
    } finally {
      clean(root);
      if (clonedRoot) clean(clonedRoot);
    }
  });

  it('AC2: a checkout switching A -> B -> A does not lose visibility into A\'s own segment, despite B overwriting the token', () => {
    const { root, dir } = gitRepo('feat/branch-a');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      const aSegment = resolveOpenSegment(dir, { cwd: root }).name;

      execFileSync('git', ['checkout', '-q', '-b', 'feat/branch-b'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-on-b' })); // mints B's own segment, overwrites .lineage
      const bSegment = resolveOpenSegment(dir, { cwd: root }).name;
      assert.notEqual(bSegment, aSegment, 'precondition: B minted its own, separate segment');
      const token = JSON.parse(readFileSync(lineagePath(dir), 'utf8'));
      assert.equal(token.branch, 'feat/branch-b', 'precondition: the token now names B, not A');

      execFileSync('git', ['checkout', '-q', 'feat/branch-a'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.equal(currentBranch(root), 'feat/branch-a', 'precondition: checked out back to A');
      // peekOpenSegment alone would return null here: the token names branch B, not A.
      const recovered = recoverOpenSegment(dir, { cwd: root });
      assert.ok(recovered, 'recoverOpenSegment must find A\'s own segment despite the token now naming B');
      assert.equal(recovered.name, aSegment, 'must resolve to A\'s real segment, never B\'s');
    } finally { clean(root); }
  });

  it('AC3: refuses to guess when more than one committed segment declares this branch as its own', () => {
    const { root, dir } = gitRepo('feat/ambiguous');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
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
      execFileSync('git', ['add', `.adlc/manifest.d/${secondName}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'second ambiguous segment'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      rmSync(lineagePath(dir), { force: true }); // no token to disambiguate

      assert.throws(
        () => recoverOpenSegment(dir, { cwd: root }),
        /ambiguous/,
        'must refuse to silently pick one of two candidate segments',
      );
    } finally { clean(root); }
  });

  it('a branch whose derived filename slug is a PREFIX of another branch\'s never cross-matches (exact `branch`-field match only)', () => {
    const { root, dir } = gitRepo('feat');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence()); // mints "feat-<ULID>.jsonl"
      const featSegment = resolveOpenSegment(dir, { cwd: root }).name;

      execFileSync('git', ['checkout', '-q', '-b', 'feat-x'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }); // filename slug "feat-x" — "feat-" is a PREFIX of "feat-x-<ULID>.jsonl" too
      recordTicketEvidence(root, baseEvidence({ transactionId: 'tx-on-feat-x' }));

      execFileSync('git', ['checkout', '-q', 'feat'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      rmSync(lineagePath(dir), { force: true }); // force recovery, not the fast token path
      const recovered = recoverOpenSegment(dir, { cwd: root });
      assert.ok(recovered, 'branch "feat" must still find its own segment');
      assert.equal(recovered.name, featSegment, 'must resolve to "feat"\'s own segment, never "feat-x"\'s, despite the prefix overlap');
    } finally { clean(root); }
  });

  it('returns null on detached HEAD — no branch identity to recover by', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.equal(currentBranch(root), null, 'precondition: detached HEAD');
      assert.equal(recoverOpenSegment(dir, { cwd: root }), null);
    } finally { clean(root); }
  });

  // Adversarial-review finding, T-MANIFEST-FOREST sixth/seventh rounds:
  // recovery used to read and split the WHOLE segment file just to inspect
  // its first line, so scan cost grew with the total size of every
  // discovered segment. A segment whose first entry alone exceeds the
  // bounded-read cap must REFUSE (round 7 — never silently exclude it as
  // "not a candidate", since nothing on the write side caps entry size, so
  // a legitimately large evidence payload could hit this exact case and
  // silently vanish from recovery the same way the original bug worked).
  it('an oversized first entry (larger than the bounded read cap) makes recovery refuse, never silently excludes the segment', () => {
    const { root, dir } = gitRepo('feat/oversized-first-entry');
    try {
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
    } finally { clean(root); }
  });

  // Round 8 of the same finding: a MALFORMED (non-JSON) first entry hit the
  // SAME silent-exclusion bug the oversized case above already closed —
  // firstEntryOf's catch block returned `null` for a JSON.parse failure
  // exactly like it does for a genuinely empty file, so recoverOpenSegment
  // treated a corrupted segment as "not a candidate" instead of "cannot
  // determine". A truncated write, disk fault, or malicious commit can
  // produce exactly this shape; the branch is unknowable, not absent.
  it('a malformed (non-JSON) first entry makes recovery refuse, never silently excludes the segment', () => {
    const { root, dir } = gitRepo('feat/malformed-first-entry');
    try {
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
    } finally { clean(root); }
  });

  // firstEntryOf's OTHER catch — openSync itself failing — is a distinct code
  // path from the JSON.parse failure above: discoverSegments already
  // confirmed this name exists as a regular file at discovery time (its own
  // lstatSync), so the only way open can still fail here is a permissions
  // change or a TOCTOU race between discovery and this read. A chmod'd-
  // unreadable file exercises exactly that gap deterministically.
  it('a segment that exists but cannot be opened (permission denied) makes recovery refuse, never silently excludes it', { skip: process.platform === 'win32' }, () => {
    const { root, dir } = gitRepo('feat/unreadable-first-entry');
    try {
      activate(dir);
      const slug = deriveSlug('feat/unreadable-first-entry');
      const unreadableName = `${slug}-${generateSegmentUlid()}.jsonl`;
      const unreadablePath = segmentPath(dir, unreadableName);
      writeFileSync(unreadablePath, `${JSON.stringify({ seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: {}, files: {}, prev: null, branch: 'feat/unreadable-first-entry' })}\n`);
      chmodSync(unreadablePath, 0o000);
      rmSync(lineagePath(dir), { force: true });

      try {
        assert.throws(
          () => recoverOpenSegment(dir, { cwd: root }),
          /first entry could not be read or parsed/,
          'a segment that cannot be opened must refuse the whole recovery attempt, not be silently excluded as a non-candidate',
        );
      } finally { chmodSync(unreadablePath, 0o644); } // restore before clean()'s rmSync
    } finally { clean(root); }
  });

  // Pins the EXACT bounded-read cap value (64 KiB), not just "very large":
  // a first line whose JSON body is exactly 65536 bytes places its trailing
  // newline at byte offset 65536 — the 65537th byte, one past a 65536-byte
  // read window. A cap even one byte larger would read far enough to see
  // that newline and successfully parse this line; the real cap must not.
  it('the bounded-read cap is exactly 64 KiB: a first line whose newline sits one byte past it makes recovery refuse', () => {
    const { root, dir } = gitRepo('feat/exact-cap-boundary');
    try {
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
    } finally { clean(root); }
  });

  // Round 9 of the same finding: recoverOpenSegment only ever scanned
  // discoverSegments(dir).valid, silently ignoring .invalid — a real segment
  // renamed to a bad-grammar name, replaced with a symlink, or otherwise
  // turned into a non-conforming filesystem object became indistinguishable
  // from "never existed", the same silent-exclusion bug already closed for
  // oversized/malformed/unreadable first entries, just at the discovery
  // layer instead of the read layer. forestChainsIntact (the write-time
  // precondition) already refuses on ANY invalid object anywhere in the
  // forest; recovery had no equivalent.
  it('recoverOpenSegment refuses when an INVALID filesystem object exists under manifest.d/, never silently excludes it', () => {
    const { root, dir } = gitRepo('feat/invalid-object-present');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
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
    } finally { clean(root); }
  });

  // Round 9 of the same finding: a genuinely EMPTY (zero-byte) segment file
  // is not a legitimate "nothing here" state the way an empty ROOT is —
  // gate-manifest's own verifyChain treats an empty segment as INVALID
  // ("has no first entry to carry the required anchor"), since every real
  // segment's mint atomically writes its anchor-carrying first entry. A
  // zero-byte segment can only mean a crash between file creation and first
  // append, or truncation/tampering — recovery must refuse it, not silently
  // skip it as a non-candidate the way a merely-absent file would be.
  it('recoverOpenSegment refuses when a real segment file exists but is empty, never silently excludes it', () => {
    const { root, dir } = gitRepo('feat/empty-segment-present');
    try {
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
    } finally { clean(root); }
  });

  // T-MANIFEST-FOREST follow-up (gap 1, ticket T-01KYTQ4BADHSDJNBFNZHB2ZG5V):
  // a WRITE that happens before any read on a fresh clone (no local .lineage
  // token) used to mint a needless duplicate segment rather than continuing a
  // real, unambiguous, already-committed one for this branch. Mirrors
  // @adlc/gate-manifest/lib/lineage.mjs's identical test.
  // Exercises the REAL producer end-to-end (clone -> recordTicketEvidence ->
  // readOwnChains), not just the resolver: AC1 asks that evidence recorded
  // BEFORE the write is still visible to a consumer AFTER it, which a
  // resolver-only assertion cannot show. Raised by adversarial review.
  it('AC12: a fresh clone whose FIRST action is a real WRITE extends the branch\'s own committed segment, and the pre-clone evidence stays visible to a reader afterwards', () => {
    const KEY = 'ac12-clone-write-key';
    const { root, dir } = gitRepo('feat/clone-write-first');
    let clonedRoot;
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY, ticketId: 'ORIGINAL' }));
      const first = resolveOpenSegment(dir, { cwd: root });
      execFileSync('git', ['add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${first.name}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'segment evidence'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      clonedRoot = mkdtempSync(join(tmpdir(), 'adlc-ticket-segments-clone-write-'));
      execFileSync('git', ['clone', '-q', '--branch', 'feat/clone-write-first', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'precondition: the fresh clone has no local .lineage token');

      // The FIRST action in this clone is a REAL WRITE through the production
      // producer — not merely a resolver call.
      recordTicketEvidence(clonedRoot, baseEvidence({ key: KEY, ticketId: 'AFTER-CLONE', transactionId: 'tx-2' }));

      const segs = readdirSync(join(clonedDir, 'manifest.d')).filter((n) => n.endsWith('.jsonl'));
      assert.deepEqual(segs, [first.name], 'the write must EXTEND the committed segment — no needless duplicate minted');

      // ...and a real consumer read AFTER the write still surfaces the pre-clone evidence.
      const chains = readOwnChains(clonedDir, { cwd: clonedRoot, allowRecovery: true, key: KEY });
      assert.equal(chains.length, 2, 'root + the single recovered segment');
      const tickets = chains[1].map((e) => e.ticket);
      assert.ok(tickets.includes('ORIGINAL'), 'pre-clone evidence must remain visible to a reader AFTER the write');
      assert.ok(tickets.includes('AFTER-CLONE'), 'the newly written evidence must be visible too');
      assert.equal(chains[1].length, 2, 'exactly the two entries — the recovered segment was extended, not replaced');

      // Deliberately does NOT heal (write) the token from this UNVERIFIED
      // recovery match (adversarial-review finding) — see the sibling
      // gate-manifest test for the full rationale.
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'recovering via (b) must never write the local token — it would launder an unverified match into the trusted fast path');
      // A SECOND write re-scans via (b) again and still extends the same segment.
      recordTicketEvidence(clonedRoot, baseEvidence({ key: KEY, ticketId: 'THIRD', transactionId: 'tx-3' }));
      assert.deepEqual(readdirSync(join(clonedDir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')), [first.name], 'the second write must also extend, not mint');
    } finally {
      clean(root);
      if (clonedRoot) clean(clonedRoot);
    }
  });

  // Keyed: recovery (and its ambiguity refusal) is key-gated — a keyless
  // writer skips recovery and mints fresh by design, mirroring the keyless
  // reader's refusal to trust recovered content.
  it('AC12: refuses (ambiguous) rather than mint when recovery finds more than one candidate segment for this branch', () => {
    const KEY = 'ambiguity-key';
    const { root, dir } = gitRepo('feat/ambiguous-write');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY }));
      const slug = deriveSlug('feat/ambiguous-write');
      const secondName = `${slug}-${generateSegmentUlid(Date.now() + 1000)}.jsonl`;
      writeFileSync(
        segmentPath(dir, secondName),
        `${JSON.stringify({ seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: {}, files: {}, prev: null, anchor: null, branch: 'feat/ambiguous-write' })}\n`,
      );
      execFileSync('git', ['add', `.adlc/manifest.d/${secondName}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'second ambiguous segment'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      rmSync(lineagePath(dir), { force: true }); // no token to disambiguate

      // A REAL write must refuse — asserting on the resolver alone would not
      // show that the refusal actually propagates out through the producer.
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence({ key: KEY, transactionId: 'tx-ambiguous' })),
        /ambiguous/,
        'a WRITE must refuse rather than silently pick one of two candidate segments to extend',
      );
      assert.equal(readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 2, 'the refused write must not have minted a third segment');
    } finally { clean(root); }
  });

  // AC13 — a keyless writer facing a committed same-branch segment FAILS
  // CLOSED: extending strands the checkout (the keyless reader refuses
  // recovered content) and minting shadows the committed evidence behind
  // the fresh token — refusal hides nothing. Keyless greenfield writes
  // still mint normally (the origin repo's own first write proves it).
  it('AC13: a KEYLESS fresh clone whose first action is a write REFUSES — never extends, never shadow-mints', () => {
    const { root, dir } = gitRepo('feat/keyless-clone');
    let clonedRoot;
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ ticketId: 'ORIGINAL' })); // keyless greenfield mint works
      const s1 = readdirSync(join(dir, 'manifest.d')).find((n) => n.endsWith('.jsonl'));
      execFileSync('git', ['add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${s1}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'keyless evidence'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      clonedRoot = mkdtempSync(join(tmpdir(), 'adlc-ticket-keyless-clone-'));
      execFileSync('git', ['clone', '-q', '--branch', 'feat/keyless-clone', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');
      const s1Bytes = readFileSync(join(clonedDir, 'manifest.d', s1));

      assert.throws(
        () => recordTicketEvidence(clonedRoot, baseEvidence({ ticketId: 'KEYLESS-AFTER-CLONE', transactionId: 'tx-2' })),
        /shadow|neither authenticate/,
        'a keyless write must fail closed when a committed same-branch segment exists',
      );
      assert.equal(readdirSync(join(clonedDir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 1, 'nothing may have been minted');
      assert.deepEqual(readFileSync(join(clonedDir, 'manifest.d', s1)), s1Bytes, 'the committed segment stays byte-identical');
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'no token may have been written');
    } finally {
      clean(root);
      if (clonedRoot) clean(clonedRoot);
    }
  });

  // v1 signatures omit branch/anchor — a bolted-on branch claim still
  // verifies, so identity must be v2-authenticated (round-7 finding).
  it('AC13: a KEYED writer refuses a candidate whose branch claim rides a v1 signature', () => {
    const KEY = 'v1-forgery-key';
    const { root, dir } = gitRepo('feat/v1-forged');
    let clonedRoot;
    try {
      activate(dir);
      const entry = { seq: 1, gate: 'evidence', ts: '2026-01-01T00:00:00.000Z', data: { note: 'v1' }, files: {}, prev: null };
      entry.sig = createHmac('sha256', KEY).update(canonicalEntryBytes(entry)).digest('hex'); // no sigVersion → v1 canonical
      entry.anchor = null;
      entry.branch = 'feat/v1-forged';
      const name = `${deriveSlug('feat/v1-forged')}-${generateSegmentUlid()}.jsonl`;
      writeFileSync(segmentPath(dir, name), `${JSON.stringify(entry)}\n`);
      execFileSync('git', ['add', `.adlc/manifest.d/${name}`, '.adlc/manifest.d/.store.json'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'forged v1 branch claim'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      clonedRoot = mkdtempSync(join(tmpdir(), 'adlc-ticket-v1-forged-'));
      execFileSync('git', ['clone', '-q', '--branch', 'feat/v1-forged', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');

      assert.throws(
        () => recordTicketEvidence(clonedRoot, baseEvidence({ key: KEY, ticketId: 'AFTER', transactionId: 'tx-2' })),
        /verified v2 signature|cannot be authenticated|unsigned/,
        'a v1-signed branch claim is not an authenticated identity',
      );
      assert.equal(readdirSync(join(clonedDir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 1, 'nothing may have been minted past the refused candidate');
    } finally {
      clean(root);
      if (clonedRoot) clean(clonedRoot);
    }
  });

  it('AC13: a KEYED writer refuses an unauthenticatable single candidate — no extend, no duplicate mint', () => {
    const { root, dir } = gitRepo('feat/unauth-candidate');
    let clonedRoot;
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ ticketId: 'UNSIGNED' })); // keyless → unsigned entries
      const s1 = readdirSync(join(dir, 'manifest.d')).find((n) => n.endsWith('.jsonl'));
      execFileSync('git', ['add', '.adlc/manifest.d/.store.json', `.adlc/manifest.d/${s1}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      execFileSync('git', ['commit', '-q', '-m', 'unsigned segment'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });

      clonedRoot = mkdtempSync(join(tmpdir(), 'adlc-ticket-unauth-clone-'));
      execFileSync('git', ['clone', '-q', '--branch', 'feat/unauth-candidate', root, clonedRoot], { stdio: ['ignore', 'pipe', 'ignore'] });
      const clonedDir = join(clonedRoot, '.adlc');

      assert.throws(
        () => recordTicketEvidence(clonedRoot, baseEvidence({ key: 'a-real-key', ticketId: 'AFTER', transactionId: 'tx-2' })),
        /cannot be authenticated|no signed entries|unsigned/,
        'an unauthenticatable same-branch candidate must refuse, not fork the lineage',
      );
      assert.equal(readdirSync(join(clonedDir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 1, 'no duplicate segment may have been minted');
      assert.equal(existsSync(lineagePath(clonedDir)), false, 'no token may have been written');
    } finally {
      clean(root);
      if (clonedRoot) clean(clonedRoot);
    }
  });

  // AC15 — the marker's persisted auth mode is enforced by THIS package's
  // resolver too (twin of gate-manifest's): a keyed forest written keylessly
  // by any producer would strand keyed clones permanently.
  it('AC15: a keyed-mode marker refuses a keyless ticket-evidence write before touching anything', () => {
    const { root, dir } = gitRepo('feat/keyed-forest');
    try {
      mkdirSync(join(dir, 'manifest.d'), { recursive: true });
      writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' }));
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence()),
        /keyed mode/,
        'a keyless write into a keyed forest must refuse',
      );
      assert.deepEqual(readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')), [], 'nothing may have been minted');
      // The keyed write works.
      recordTicketEvidence(root, baseEvidence({ key: 'twin-persist-key' }));
      assert.equal(readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 1);
    } finally { clean(root); }
  });

  // AC14 — mint-time committability, mirroring the gate-manifest twin.
  it('AC14: minting refuses when the branch-derived segment filename is gitignored — before any evidence is recorded', () => {
    const { root, dir } = gitRepo('release/1.0');
    try {
      activate(dir);
      writeFileSync(join(root, '.gitignore'), '.adlc/manifest.d/release-*.jsonl\n');
      assert.throws(
        () => recordTicketEvidence(root, baseEvidence()),
        /refusing to mint/,
        'evidence written into an ignored file would be local-only — silent divergence',
      );
      assert.equal(readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl')).length, 0, 'nothing may have been recorded');
      assert.equal(existsSync(lineagePath(dir)), false, 'no token may have been written');
    } finally { clean(root); }
  });
});

// readOwnChains's `allowRecovery` flag (distinct-provider adversarial-review
// finding, second round): recovery must be OPT-IN, not the default, and every
// caller that turns "recovered" content into a FRESH SIGNED entry (reassignment,
// prosecute carry-forward) must NOT opt in — see readOwnChains's own doc for the
// full rationale (derived slugs are a lossy, attacker-controllable identity).
describe('readOwnChains: allowRecovery is opt-in, defaults to strict token-only (lineage-durability finding)', () => {
  it('default (no allowRecovery): does not recover — returns root-only once the token is lost, even with a real committed segment AND a key that could verify it', () => {
    const { root, dir } = gitRepo();
    const KEY = 'default-allow-recovery-key';
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY }));
      rmSync(lineagePath(dir), { force: true });
      // `key` is passed but `allowRecovery` is NOT — proves the default is
      // genuinely `false`, not merely absorbed by key-gating (a real,
      // signature-verifiable segment exists here, so a flipped default would
      // otherwise go unnoticed).
      const chains = readOwnChains(dir, { cwd: root, key: KEY });
      assert.equal(chains.length, 1, 'must fall back to root-only, never guess at a segment via the caller-controlled slug');
    } finally { clean(root); }
  });

  // `key` is required for recovery to trust anything it finds (adversarial-
  // review finding, T-MANIFEST-FOREST fourth round): exact branch matching
  // proves identity, not authenticity — an unsigned segment can still claim
  // any branch by name. Without a key nothing can be signature-verified, so
  // recovery is disabled entirely and this still falls back to root-only.
  // T-MANIFEST-FOREST, seventh round: `key: null` is a fully supported,
  // common configuration (e.g. ordinary local dev without
  // ADLC_MANIFEST_KEY) — it must not silently disable recovery and look
  // like "no evidence" when a real candidate segment EXISTS. Existence is
  // checked (never trusting content) and this refuses rather than guess.
  it('allowRecovery: true with NO key REFUSES when a candidate segment exists — never silently treats it as absent', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence());
      rmSync(lineagePath(dir), { force: true });
      assert.throws(
        () => readOwnChains(dir, { cwd: root, allowRecovery: true, key: null }),
        /a candidate segment for this branch exists but cannot be verified/,
        'a real candidate segment must never be silently treated as absent just because there is no key to verify it',
      );
    } finally { clean(root); }
  });

  it('allowRecovery: true with NO key returns root-only when genuinely no candidate segment exists', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir); // segmented, but no evidence recorded — no segment exists yet
      const chains = readOwnChains(dir, { cwd: root, allowRecovery: true, key: null });
      assert.equal(chains.length, 1, 'nothing exists to miss, so this is safe even without a key');
    } finally { clean(root); }
  });

  // T-MANIFEST-FOREST, seventh round: detached HEAD (a common CI checkout
  // shape — e.g. a PR SHA checked out directly) has no branch identity to
  // recover by AT ALL. This must not silently look like "no evidence" when
  // committed segments exist that could belong to the checkout — only a
  // genuinely segment-free forest is safe to treat as "nothing to miss".
  it('allowRecovery: true on detached HEAD REFUSES when committed segments exist — never silently treats them as absent', () => {
    const { root, dir } = gitRepo('feat/detach-me');
    const KEY = 'detached-key';
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY })); // a real, signed segment for feat/detach-me
      execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      rmSync(lineagePath(dir), { force: true });
      assert.equal(currentBranch(root), null, 'precondition: detached HEAD');

      assert.throws(
        () => readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY }),
        /detached HEAD has no branch identity/,
        'a detached checkout must refuse rather than assume no committed segment belongs to it',
      );
    } finally { clean(root); }
  });

  it('allowRecovery: true on detached HEAD returns root-only when genuinely no segments exist anywhere', () => {
    const { root, dir } = gitRepo();
    try {
      activate(dir); // segmented, but nothing committed yet
      execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
      assert.equal(currentBranch(root), null, 'precondition: detached HEAD');
      const chains = readOwnChains(dir, { cwd: root, allowRecovery: true, key: 'irrelevant-key' });
      assert.equal(chains.length, 1, 'nothing exists to miss, so a detached checkout is safe here too');
    } finally { clean(root); }
  });

  it('allowRecovery: true WITH a key opts into the exact branch-field recovery scan, trusting only signature-verified entries', () => {
    const { root, dir } = gitRepo();
    const KEY = 'recovery-trust-key';
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY }));
      rmSync(lineagePath(dir), { force: true });
      const chains = readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY });
      assert.equal(chains.length, 2, 'root + the recovered segment');
      assert.equal(chains[1].length, 1, 'the real, signed entry must be recovered');
    } finally { clean(root); }
  });

  // The exploit an unauthenticated recovery would enable (adversarial-review
  // finding): a segment can be hand-planted with an EXACT branch match but no
  // valid signature — identity claimed, authenticity absent. Recovery must
  // refuse the WHOLE read (round 5: not silently filter the one bad entry —
  // see readOwnChains's own doc for why a per-entry filter is unsafe) even
  // though the branch field matches perfectly.
  it('allowRecovery: true WITH a key refuses the whole read when a signed segment is followed by an unsigned entry, even with an exact branch match', () => {
    const { root, dir } = gitRepo('feat/forged-branch');
    const KEY = 'recovery-trust-key';
    try {
      activate(dir);
      // A real signed entry establishes the segment...
      recordTicketEvidence(root, baseEvidence({ key: KEY }));
      // ...then a SECOND, UNSIGNED entry is appended by hand, simulating an
      // attacker with commit access who lacks the signing key.
      const segDir = join(dir, 'manifest.d');
      const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
      const segPath = join(segDir, segName);
      const firstRaw = readFileSync(segPath, 'utf8').trim();
      const forged = {
        seq: 2, gate: 'prosecution', ts: new Date().toISOString(), ticket: 'A',
        data: { verdict: 'clear' }, files: {}, prev: sha256(firstRaw),
      };
      writeFileSync(segPath, `${firstRaw}\n${JSON.stringify(forged)}\n`);
      rmSync(lineagePath(dir), { force: true });

      assert.throws(
        () => readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY }),
        /failed chain or signature verification/,
        'a signed-then-unsigned segment must refuse the whole read, never silently drop just the bad entry',
      );
    } finally { clean(root); }
  });

  // Round 5's exact exploit: entrySigValid alone (a per-entry filter) let an
  // attacker WITHOUT the key tamper with the segment's LATEST entry (breaking
  // only ITS signature) and have it silently vanish, resurrecting an EARLIER,
  // still-validly-signed verdict as if it were the latest. chainIsIntact's
  // hash-chain check catches this: tampering with any entry's content (even
  // just to break its own signature) does not, by itself, break `prev`
  // linkage for entries BEFORE it — but the ATTACKER can't recompute a valid
  // sig without the key, so the tampered entry's OWN check fails, and
  // chainIsIntact refuses the whole chain rather than silently accepting a
  // truncated one that ends at the earlier, untampered entry.
  it('allowRecovery: true refuses the whole read when a segment\'s LATEST signed entry is tampered, never resurrecting an earlier stale verdict', () => {
    const { root, dir } = gitRepo('feat/resurrection');
    const KEY = 'resurrection-key';
    const sign = (entry) => createHmac('sha256', KEY).update(canonicalEntryBytes(entry)).digest('hex');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY }));
      const segDir = join(dir, 'manifest.d');
      const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
      const segPath = join(segDir, segName);
      const firstRaw = readFileSync(segPath, 'utf8').trim();
      // A REAL, validly-signed "clear" verdict...
      const clear = {
        seq: 2, gate: 'prosecution', ts: '2026-01-01T00:00:00.000Z', ticket: 'A',
        data: { verdict: 'clear' }, files: {}, prev: sha256(firstRaw),
      };
      clear.sig = sign(clear);
      const clearLine = JSON.stringify(clear);
      // ...followed by a REAL, validly-signed later "blocked" revocation...
      const blocked = {
        seq: 3, gate: 'prosecution', ts: '2026-01-02T00:00:00.000Z', ticket: 'A',
        data: { verdict: 'blocked' }, files: {}, prev: sha256(clearLine),
      };
      blocked.sig = sign(blocked);

      // ...then an attacker WITHOUT the key tampers with the blocked entry's
      // verdict, invalidating (but not removing) its own signature.
      const tampered = { ...blocked, data: { verdict: 'clear' } };
      writeFileSync(segPath, `${firstRaw}\n${clearLine}\n${JSON.stringify(tampered)}\n`);
      rmSync(lineagePath(dir), { force: true });

      assert.throws(
        () => readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY }),
        /failed chain or signature verification/,
        'a tampered later entry must refuse the whole read, never silently resurrect an earlier stale verdict as the latest',
      );
    } finally { clean(root); }
  });

  // An ENTIRELY unsigned segment is hash-chain-consistent (chainIsIntact
  // alone tolerates it — the same tolerance that lets an honest chain
  // predating signing still verify), but nothing proves anyone who held the
  // key ever touched it. Recovery must still refuse it.
  it('allowRecovery: true refuses an ENTIRELY unsigned recovered segment, even though its hash chain is perfectly consistent', () => {
    const { root, dir } = gitRepo('feat/wholly-unsigned');
    const KEY = 'wholly-unsigned-key';
    try {
      activate(dir);
      // Recorded WITHOUT a key — hash-chain-consistent, zero signatures.
      recordTicketEvidence(root, baseEvidence());
      const segDir = join(dir, 'manifest.d');
      const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
      const first = JSON.parse(readFileSync(join(segDir, segName), 'utf8').trim());
      assert.equal(first.branch, 'feat/wholly-unsigned', 'precondition: exact branch match');
      assert.equal(Object.hasOwn(first, 'sig'), false, 'precondition: entirely unsigned');
      rmSync(lineagePath(dir), { force: true });

      // A real key IS available at read time (the normal CI configuration) —
      // the segment itself just happens to have none.
      assert.throws(
        () => readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY }),
        /failed chain or signature verification/,
        'a wholly unsigned segment must never be trusted just because its hash chain is consistent and its branch matches',
      );
    } finally { clean(root); }
  });

  // Round 8 of the same finding: chainIsIntact's legacy-unsigned-PREFIX
  // tolerance (needed so an honest chain that predates signing can still
  // verify) combined with "at least one signed entry anywhere" let an
  // attacker without the key plant an unsigned forged entry FIRST, then have
  // it laundered into trust by ANY unrelated, later, genuinely signed append
  // to the SAME chain — signing entry 2 proves only entry 2's own
  // provenance, not that anyone reviewed entry 1's content. Unlike the
  // signed-then-unsigned tests above (already caught by chainIsIntact's
  // "once signed, stays signed" rule), unsigned-then-signed is the exact
  // legacy-prefix shape chainIsIntact is DESIGNED to tolerate structurally —
  // the forged entry must still never reach a trust-consuming caller.
  it('allowRecovery: true never returns an unsigned forged entry, even once a later, unrelated entry in the same chain is genuinely signed', () => {
    const { root, dir } = gitRepo('feat/laundered-prefix');
    const KEY = 'laundered-prefix-key';
    const sign = (entry) => createHmac('sha256', KEY).update(canonicalEntryBytes(entry)).digest('hex');
    try {
      activate(dir);
      // An attacker WITHOUT the key commits a forged P5 "clear" verdict for
      // ticket A as this segment's FIRST entry — unsigned, but the exact
      // branch match and hash-chain-from-genesis are both perfectly valid.
      const forged = {
        seq: 1, gate: 'prosecution', ts: '2026-01-01T00:00:00.000Z', ticket: 'A',
        data: { verdict: 'clear' }, files: {}, prev: null, branch: 'feat/laundered-prefix',
      };
      const forgedLine = JSON.stringify(forged);
      // Later, a real key holder appends a genuine, validly-signed entry —
      // for an UNRELATED ticket/gate, as would happen in ordinary operation
      // once the project starts signing (no forgery-awareness required).
      const genuine = {
        seq: 2, gate: 'p1', ts: '2026-01-02T00:00:00.000Z', ticket: 'B',
        data: {}, files: {}, prev: sha256(forgedLine),
      };
      genuine.sig = sign(genuine);
      const segDir = join(dir, 'manifest.d');
      mkdirSync(segDir, { recursive: true });
      const segPath = join(segDir, `${deriveSlug('feat/laundered-prefix')}-${generateSegmentUlid()}.jsonl`);
      writeFileSync(segPath, `${forgedLine}\n${JSON.stringify(genuine)}\n`);

      const chains = readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY });
      assert.equal(chains.length, 2, 'root + the recovered segment');
      const ticketAEntries = chains[1].filter((e) => e.ticket === 'A');
      assert.equal(
        ticketAEntries.length, 0,
        'the unsigned forged ticket-A verdict must never be returned, even though the chain has a later, unrelated valid signature',
      );
    } finally { clean(root); }
  });

  // Round 6 of the same finding: the whole-chain verification added for
  // RECOVERED segments (rounds 4-5) did not apply to the ordinary, non-
  // recovery paths — root, and a segment reached via a valid `.lineage`
  // token (peekOpenSegment's fast path) — even when a real key was passed
  // in. Neither is identity-ambiguous the way a recovered segment is (root
  // is canonically root; the token proves this checkout minted the peeked
  // segment), but both must still refuse a TAMPERED chain — an attacker
  // with commit-but-not-key access could otherwise append an unsigned
  // forged entry after a real signed one and have it trusted.
  it('a valid token (peeked, not recovered) still refuses a signed-then-unsigned segment when a key is available', () => {
    const { root, dir } = gitRepo('feat/peeked-tamper');
    const KEY = 'peeked-tamper-key';
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence({ key: KEY })); // signed, real token stays valid
      const segDir = join(dir, 'manifest.d');
      const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
      const segPath = join(segDir, segName);
      const firstRaw = readFileSync(segPath, 'utf8').trim();
      const forged = {
        seq: 2, gate: 'prosecution', ts: new Date().toISOString(), ticket: 'A',
        data: { verdict: 'clear' }, files: {}, prev: sha256(firstRaw),
      };
      writeFileSync(segPath, `${firstRaw}\n${JSON.stringify(forged)}\n`); // appended WITHOUT the key — unsigned

      assert.throws(
        () => readOwnChains(dir, { cwd: root, key: KEY }), // no allowRecovery — the plain token path
        /failed chain or signature verification/,
        'the token proves identity, but an unsigned entry after a signed one is still a tampered/forged chain',
      );
    } finally { clean(root); }
  });

  it('root itself still refuses a signed-then-unsigned chain when a key is available, independent of segmentation', () => {
    const { root, dir } = gitRepo();
    const KEY = 'root-tamper-key';
    try {
      recordTicketEvidence(root, baseEvidence({ key: KEY })); // pre-cutover: lands in root, signed
      const rootPath = join(dir, 'manifest.jsonl');
      const firstRaw = readFileSync(rootPath, 'utf8').trim();
      const forged = {
        seq: 2, gate: 'prosecution', ts: new Date().toISOString(), ticket: 'A',
        data: { verdict: 'clear' }, files: {}, prev: sha256(firstRaw),
      };
      writeFileSync(rootPath, `${firstRaw}\n${JSON.stringify(forged)}\n`); // appended WITHOUT the key

      assert.throws(
        () => readOwnChains(dir, { cwd: root, key: KEY }),
        /root manifest failed chain or signature verification/,
        'an unsigned entry after a signed one in root is a tampered chain, even in a non-segmented repo',
      );
    } finally { clean(root); }
  });

  // T-MANIFEST-FOREST, seventh round: chainIsIntact alone tolerates a chain
  // with NO signed entries at all (correct for its OTHER callers' legacy-
  // unsigned-prefix case). A commit-capable attacker without the key can
  // append an unsigned but perfectly hash-chained forged entry to a chain
  // that has simply never adopted signing — root must refuse to be trusted
  // for that reason too, once a key IS available to the reader.
  it('root itself refuses when ENTIRELY unsigned but a key is available, even with a perfectly consistent hash chain', () => {
    const { root, dir } = gitRepo();
    const KEY = 'root-wholly-unsigned-key';
    try {
      recordTicketEvidence(root, baseEvidence()); // pre-cutover: lands in root, UNSIGNED
      assert.throws(
        () => readOwnChains(dir, { cwd: root, key: KEY }),
        /root manifest has no signed entries/,
        'an entirely unsigned root must never be trusted just because its hash chain is consistent',
      );
    } finally { clean(root); }
  });

  it('root with ZERO entries is safe even with a key available — empty is not "unsigned"', () => {
    const { root, dir } = gitRepo();
    const KEY = 'root-empty-key';
    try {
      mkdirSync(dir, { recursive: true }); // segmented-or-not, root genuinely has nothing
      const chains = readOwnChains(dir, { cwd: root, key: KEY });
      assert.deepEqual(chains, [[]], 'an empty root has nothing to distrust, so this must not refuse');
    } finally { clean(root); }
  });

  // Round 9 of the same finding: unlike an empty ROOT (deliberately safe —
  // see the test above), a segment reached via the local `.lineage` token is
  // never legitimately empty — every real segment's mint atomically writes
  // its anchor-carrying first entry (gate-manifest's verifyChain: an empty
  // segment "has no first entry to carry the required anchor"). This is
  // checked UNCONDITIONALLY, even with no key at all, because it is a
  // structural fact about the segment, not a trust decision.
  it('a token-resolved (peeked) segment that is empty on disk refuses, with or without a key', () => {
    const { root, dir } = gitRepo('feat/peeked-empty');
    try {
      activate(dir);
      recordTicketEvidence(root, baseEvidence()); // mints a real segment + token
      const resolved = resolveOpenSegment(dir, { cwd: root });
      writeFileSync(segmentPath(dir, resolved.name), ''); // truncate to empty, as if crashed mid-mint

      assert.throws(
        () => readOwnChains(dir, { cwd: root, key: 'irrelevant-key' }),
        /is empty — a real segment always has a first entry/,
        'an empty token-resolved segment must refuse, not be silently treated as having no evidence',
      );
      assert.throws(
        () => readOwnChains(dir, { cwd: root, key: null }),
        /is empty — a real segment always has a first entry/,
        'the empty-segment refusal is structural, not gated on whether a key is available',
      );
    } finally { clean(root); }
  });
});

// Mirrors @adlc/gate-manifest/lib/lineage.mjs's identical describe block. Now
// exported for the lineage-durability tests above; the same validation applies.
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

  it('rejects entropy that is not exactly 10 bytes', () => {
    assert.throws(() => generateSegmentUlid(Date.now(), Buffer.alloc(9)), TypeError);
    assert.throws(() => generateSegmentUlid(Date.now(), Buffer.alloc(11)), TypeError);
  });

  it('rejects an out-of-range timestamp', () => {
    assert.throws(() => generateSegmentUlid(-1), RangeError);
  });
});
