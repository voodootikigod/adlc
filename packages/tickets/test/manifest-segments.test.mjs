// manifest-segments.test.mjs — segmented gate-manifest support for ticket
// evidence (T-MANIFEST-FOREST). Covers both manifest-segments.mjs directly
// and recordTicketEvidence's routing through it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

function withKey(key, fn) {
  const prev = process.env.ADLC_MANIFEST_KEY;
  process.env.ADLC_MANIFEST_KEY = key;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prev;
  }
}

const baseEvidence = (over = {}) => ({
  transactionId: 'tx-1', operation: 'complete', ticketId: 'A',
  ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), ...over,
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
      withKey('seg-key', () => {
        const entry = recordTicketEvidence(root, baseEvidence());
        assert.equal(entry.sigVersion, 2);
        assert.equal(typeof entry.sig, 'string');
      });
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

  it('idempotency scan is forest-wide: a prior root entry (pre-migration) is still found once segmented', () => {
    const { root, dir } = gitRepo();
    try {
      const first = recordTicketEvidence(root, baseEvidence()); // root, pre-segmentation
      activate(dir); // simulate a migration cutover happening after this evidence was recorded
      const retry = recordTicketEvidence(root, baseEvidence());
      assert.deepEqual(retry, first, 'a segmented repo must still see root-recorded evidence for idempotency');
    } finally { clean(root); }
  });
});
