// manifest-segments.test.mjs — segmented gate-manifest support for ticket
// evidence (T-MANIFEST-FOREST). Covers both manifest-segments.mjs directly
// and recordTicketEvidence's routing through it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTicketEvidence } from '../lib/evidence.mjs';
import { isSegmentedRepo, resolveOpenSegment, readForestEntries, segmentPath } from '../lib/manifest-segments.mjs';

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
