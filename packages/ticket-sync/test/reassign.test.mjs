import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@adlc/core';
import { recordTicketEvidence, resolveOpenSegment, segmentPath, readForestEntries, canonicalJson, lineagePath, readOwnChains } from '@adlc/tickets';
import { reassignId, planManifestMigration, migrateManifestEvidence } from '../lib/reassign.mjs';

// ---- reassignId (pure, store-wide edge rewrite) ----

test('reassignId renames the ticket and rewrites every edge that pointed at it', () => {
  const tickets = [
    { id: 'T7', title: 'created', scope: ['a/**'] },
    { id: 'T8', title: 'dependent', edges: [{ to: 'T7' }, { to: 'T9' }] },
    { id: 'gh:acme/app#1', title: 'remote', edges: [{ to: 'T7', contract: 'c.json' }] },
  ];
  const out = reassignId(tickets, 'T7', 'gh:acme/app#7');
  assert.equal(out[0].id, 'gh:acme/app#7');
  assert.deepEqual(out[1].edges.map((e) => e.to), ['gh:acme/app#7', 'T9'], 'edge to T7 rewritten; T9 untouched');
  assert.equal(out[2].edges[0].to, 'gh:acme/app#7');
  assert.equal(out[2].edges[0].contract, 'c.json', 'edge metadata preserved');
});

test('reassignId is immutable (no input mutation) and leaves untouched tickets identity-equal', () => {
  const untouched = { id: 'T1', title: 'x', edges: [{ to: 'T2' }] };
  const tickets = [{ id: 'T7', title: 'c' }, untouched];
  const out = reassignId(tickets, 'T7', 'gh:r#7');
  assert.equal(tickets[0].id, 'T7', 'input not mutated');
  assert.equal(out[1], untouched, 'a ticket with no match is returned by reference (no needless copy)');
});

test('reassignId no-ops when the id is absent', () => {
  const tickets = [{ id: 'T1', title: 'x' }];
  assert.deepEqual(reassignId(tickets, 'T99', 'gh:r#99'), tickets);
});

// ---- planManifestMigration (pure) ----

const ev = (ticket, gate, seq, data) => ({ ticket, gate, seq, ts: '2026-01-01T00:00:00Z', data, files: {} });

test('planManifestMigration selects the latest entry per gate bound to the old id', () => {
  const entries = [
    ev('T7', 'prosecution', 1, { verdict: 'blocked' }),
    ev('T7', 'prosecution', 5, { verdict: 'clear' }),
    ev('T7', 'p0', 2),
    ev('T8', 'prosecution', 9, { verdict: 'clear' }), // other ticket — excluded
  ];
  const plan = planManifestMigration(entries, 'T7');
  const byGate = Object.fromEntries(plan.map((e) => [e.gate, e]));
  assert.equal(Object.keys(byGate).length, 2);
  assert.equal(byGate.prosecution.seq, 5, 'latest prosecution wins (clear, not the earlier blocked)');
  assert.equal(byGate.prosecution.data.verdict, 'clear');
  assert.ok(byGate.p0);
});

test('planManifestMigration returns nothing when the old id has no evidence', () => {
  assert.deepEqual(planManifestMigration([ev('T8', 'prosecution', 1)], 'T7'), []);
});

test('planManifestMigration picks the highest seq even when entries are out of array order', () => {
  // seq — not array position — must drive "latest wins", so a superseded verdict is
  // never resurrected by recording order.
  const entries = [
    ev('T7', 'prosecution', 5, { verdict: 'clear' }),
    ev('T7', 'prosecution', 1, { verdict: 'blocked' }),
  ];
  const plan = planManifestMigration(entries, 'T7');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].seq, 5);
  assert.equal(plan[0].data.verdict, 'clear', 'seq drives selection, not array order');
});

test('legacy re-attestation without a source hash does not hide newer old-id evidence', () => {
  const old = ev('T7', 'prosecution', 1, { verdict: 'clear' });
  const legacy = { ...ev('gh:r#2', 'prosecution', 2, { verdict: 'clear', migratedFrom: 'T7' }) };
  const newer = ev('T7', 'prosecution', 3, { verdict: 'reject' });
  assert.deepEqual(planManifestMigration([old, legacy, newer], 'T7', 'gh:r#2'), [newer]);
});

// ---- migrateManifestEvidence (append-only, chain-safe) ----

function fakeLedger(initial = []) {
  const lines = initial.map((e) => JSON.stringify(e));
  return {
    appendBatch: (_name, factory) => {
      const entries = lines.map((line) => JSON.parse(line));
      const additions = factory({ entries, skipped: [], rawLines: [...lines], lastRawLine: lines.at(-1) ?? null });
      for (const entry of additions) lines.push(JSON.stringify(entry));
      return additions;
    },
    get all() { return lines.map((l) => JSON.parse(l)); },
  };
}

test('migrateManifestEvidence appends (never rewrites) re-attestation entries under the new id', () => {
  const base = [ev('T7', 'prosecution', 3, { verdict: 'clear' })];
  const lg = fakeLedger(base);
  const appended = [];
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:acme/app#7', {
    now: '2026-06-27T00:00:00Z',
    key: null,
    appendBatch: (name, factory) => {
      const additions = lg.appendBatch(name, factory);
      appended.push(...additions);
      return additions;
    },
  });
  assert.equal(r.migrated, 1);
  // The original entry is untouched; a NEW entry is appended.
  assert.equal(lg.all[0].ticket, 'T7', 'history is immutable — old entry unchanged');
  const re = appended[0];
  assert.equal(re.ticket, 'gh:acme/app#7');
  assert.equal(re.gate, 'prosecution');
  assert.equal(re.data.verdict, 'clear', 'verdict carried forward');
  assert.equal(re.data.migratedFrom, 'T7');
  assert.equal(re.seq, 4, 'seq continues the chain');
  // The chain link must be the EXACT sha256 of the prior raw ledger line — not just
  // 64 hex chars. A wrong value silently breaks the tamper-evident chain.
  assert.equal(re.prev, sha256(JSON.stringify(base[0])), 'prev = sha256(exact prior raw line)');
});

test('migrateManifestEvidence chains a multi-gate migration correctly (entry N links to N-1)', () => {
  // A real ticket can carry evidence in >1 gate (e.g. p0 + prosecution) → 2 appended
  // rows. Row 2 MUST chain off row 1's raw bytes, or the ledger is broken.
  const base = [ev('T7', 'p0', 1), ev('T7', 'prosecution', 2, { verdict: 'clear' })];
  const lg = fakeLedger(base);
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#9', {
    now: '2026-06-27T00:00:00Z', key: null, appendBatch: lg.appendBatch,
  });
  assert.equal(r.migrated, 2);
  assert.equal(r.entries[0].prev, sha256(JSON.stringify(base[base.length - 1])), 'first re-attestation links to the seeded tail');
  assert.equal(r.entries[1].prev, sha256(JSON.stringify(r.entries[0])), 'second re-attestation links to the first');
  assert.deepEqual(r.entries.map((e) => e.seq), [3, 4], 'seqs ascend without collision');
});

test('migrateManifestEvidence signs re-attestation entries when ADLC_MANIFEST_KEY is set', () => {
  const KEY = 'secret-key';
  // The source itself must be validly signed to be a migratable candidate
  // (adversarial-review finding: planManifestMigration now requires
  // entrySigValid when a key is present).
  const source = ev('T7', 'prosecution', 1, { verdict: 'clear' });
  const sourceCanonical = { seq: source.seq, gate: source.gate, ts: source.ts, ticket: source.ticket, data: source.data, files: source.files, prev: source.prev };
  source.sig = createHmac('sha256', KEY).update(JSON.stringify(sourceCanonical)).digest('hex');
  const lg = fakeLedger([source]);
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', {
    now: '2026-06-27T00:00:00Z', key: KEY, appendBatch: lg.appendBatch,
  });
  const e = r.entries[0];
  // Recompute the expected sig over the documented canonical byte order.
  const c = { seq: e.seq, gate: e.gate, ts: e.ts, ticket: e.ticket, data: e.data, files: e.files, prev: e.prev };
  const expected = createHmac('sha256', KEY).update(JSON.stringify(c)).digest('hex');
  assert.equal(e.sig, expected, 'sig matches gate-manifest canonicalEntryBytes order');
});

test('migrateManifestEvidence is a no-op (no append) when there is no evidence', () => {
  const lg = fakeLedger([ev('T8', 'prosecution', 1)]);
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', {
    now: 'T', key: null, appendBatch: lg.appendBatch,
  });
  assert.equal(r.migrated, 0);
  assert.equal(lg.all.length, 1);
});

test('migrateManifestEvidence is idempotent after evidence append but before sidecar cleanup', () => {
  const lg = fakeLedger([ev('T7', 'prosecution', 1, { verdict: 'clear' })]);
  const first = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', { now: 'T1', key: null, appendBatch: lg.appendBatch });
  const retry = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', { now: 'T2', key: null, appendBatch: lg.appendBatch });
  assert.equal(first.migrated, 1);
  assert.equal(retry.migrated, 0);
  assert.equal(lg.all.length, 2);
  assert.match(lg.all[1].data.migratedEvidenceHash, /^[0-9a-f]{64}$/);
});

test('migrateManifestEvidence derives sequence and prev from state observed inside the batch lock', () => {
  const lg = fakeLedger([ev('T7', 'prosecution', 1)]);
  const external = ev('OTHER', 'p0', 2);
  const appendBatch = (name, factory) => {
    lg.appendBatch(name, () => [external]);
    return lg.appendBatch(name, factory);
  };
  const result = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', { now: 'T', key: null, appendBatch });
  assert.equal(result.entries[0].seq, 3);
  assert.equal(result.entries[0].prev, sha256(JSON.stringify(external)));
});

// ---- migrateManifestEvidence: segmented repo (T-MANIFEST-FOREST) ----
// Real filesystem + git repo, unlike the fake-ledger tests above: segment
// routing shells out to `git rev-parse` to resolve the branch.

function gitRepo(branch = 'feat/reassign-test') {
  const root = mkdtempSync(join(tmpdir(), 'adlc-reassign-segments-'));
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

test('migrateManifestEvidence routes to the segment writer once segmented — root is never created', () => {
  const { root, dir } = gitRepo();
  try {
    activate(dir);
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });
    const result = migrateManifestEvidence(root, 'T7', 'gh:acme/app#7', { now: '2026-06-27T00:00:00Z', key: null });
    assert.equal(result.migrated, 1);
    assert.equal(result.entries[0].ticket, 'gh:acme/app#7');
    assert.equal(result.entries[0].data.migratedFrom, 'T7');
    assert.equal(existsSync(join(dir, 'manifest.jsonl')), false, 'root must never be created once segmented');
    const { entries } = { entries: readForestEntries(dir) };
    assert.equal(entries.filter((e) => e.ticket === 'gh:acme/app#7').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T-MANIFEST-FOREST lineage-durability finding — DELIBERATELY NOT "fixed" by
// recovering here (distinct-provider adversarial-review finding, second round):
// migrateSegmentedSet stays on readOwnChains's strict default (no allowRecovery),
// never the slug-based recovery. Recovering across a lost `.lineage` token here
// would re-sign whatever a lossy, attacker-controllable branch-slug match finds
// as a FRESH re-attestation under the new id — a malicious branch could launder
// an unrelated lineage's evidence into a validly-signed entry nobody actually
// approved for this ticket.
//
// T-MANIFEST-FOREST, fourth round: migrateManifestEvidence now recovers real
// evidence across a lost `.lineage` token (recoverOpenSegment matches on the
// EXACT `branch` field every segment's first entry carries, not the lossy
// filename slug — see recoverOpenSegment's own doc), so this no longer
// strands T7's real evidence under the abandoned old id. A key is required
// (recovery filters to only signature-verified entries — see readOwnChains's
// own doc; an unsigned source is never trusted regardless of identity match).
test('migrateManifestEvidence recovers real evidence across a lost .lineage token (fresh-clone/branch-switch case) — never strands it', () => {
  const { root, dir } = gitRepo();
  const KEY = 'reassign-recovery-key';
  try {
    activate(dir);
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: KEY,
    });
    rmSync(lineagePath(dir), { force: true });
    const segsBefore = readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl'));
    const result = migrateManifestEvidence(root, 'T7', 'gh:acme/app#7', { now: '2026-06-27T00:00:00Z', key: KEY });
    assert.equal(result.migrated, 1, 'a lost token must not hide real, committed evidence');
    assert.equal(result.entries[0].data.migratedFrom, 'T7');
    // Round-6 adversarial-review regression: the WRITE half of reassignment
    // must recover with the same key the READ half used — a keyless resolver
    // call here minted a SECOND segment and pointed the fresh token at it,
    // hiding the just-recovered segment from every later branch-local read.
    const segsAfter = readdirSync(join(dir, 'manifest.d')).filter((n) => n.endsWith('.jsonl'));
    assert.deepEqual(segsAfter, segsBefore, 'reassignment must EXTEND the recovered segment — never mint a duplicate');
    const chains = readOwnChains(dir, { cwd: root, allowRecovery: true, key: KEY });
    const tickets = chains.flat().map((e) => e.ticket);
    assert.ok(tickets.includes('gh:acme/app#7'), 'the re-attestation lands in the SAME segment later reads see');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Adversarial-review finding: an UNSIGNED source entry (recorded without a key —
// indistinguishable, on the wire, from an attacker's forgery written by anyone
// with local filesystem access) must never be trusted as a genuine candidate to
// re-attest once a signing key IS available at migration time. Without the
// entrySigValid check, this function would sign the copied data FRESH under the
// new id, laundering an unsigned claim into a validly HMAC-signed attestation.
//
// T-MANIFEST-FOREST, seventh round: this segment is entirely unsigned, and
// readOwnChains now refuses the WHOLE read for an entirely-unsigned
// token-matched segment when a key is available (not just filter out its
// entries downstream) — a commit-capable attacker without the key could
// otherwise append forged entries to a chain that simply never adopted
// signing, and nothing would ever refuse it just because it's "always been
// like that". This subsumes the original per-entry protection: the call
// now refuses outright rather than silently returning 0 migrated sources.
test('migrateManifestEvidence refuses (never signs) when this checkout\'s own segment is entirely unsigned but a key is available', () => {
  const { root, dir } = gitRepo();
  try {
    activate(dir);
    // Recorded with NO key active — an honest legacy entry, or indistinguishable
    // from a forgery planted by anyone with local write access to the checkout.
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });

    assert.throws(
      () => migrateManifestEvidence(root, 'T7', 'gh:acme/app#9', { now: '2026-06-27T00:00:00Z', key: 'migration-time-key' }),
      /has no signed entries/,
      'an entirely unsigned segment must never be trusted for a fresh signed re-attestation, even for entries that individually fail their own check',
    );
    const resolved = resolveOpenSegment(dir, { cwd: root });
    const raw = readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n');
    assert.equal(raw.length, 1, 'nothing was appended for the refused migration');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateManifestEvidence in a segmented repo signs the re-attestation and continues the open segment', () => {
  const { root, dir } = gitRepo();
  const KEY = 'reassign-segment-key';
  try {
    activate(dir);
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: KEY,
    });
    const before = resolveOpenSegment(dir, { cwd: root });
    assert.equal(before.isNew, false);
    migrateManifestEvidence(root, 'T7', 'gh:r#9', { now: '2026-06-27T00:00:00Z', key: KEY });
    const after = resolveOpenSegment(dir, { cwd: root });
    assert.equal(after.name, before.name, 'the re-attestation continues the same open segment, not a new one');
    const raw = readFileSync(segmentPath(dir, after.name), 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
    const reattestation = JSON.parse(raw[1]);
    assert.equal(typeof reattestation.sig, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrateManifestEvidence mints a segment whose FIRST entry carries an anchor into root, v2-signed', () => {
  const { root, dir } = gitRepo();
  const KEY = 'rootless-anchor-key'; // source evidence must itself be signed to be a migratable candidate
  try {
    // Evidence recorded BEFORE cutover lands in root; activation then opens this
    // branch's first segment, which the re-attestation itself mints and anchors.
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: KEY,
    });
    activate(dir);

    const result = migrateManifestEvidence(root, 'T7', 'gh:r#3', {
      now: '2026-06-27T00:00:00Z', key: KEY,
    });
    assert.equal(result.migrated, 1);
    const resolved = resolveOpenSegment(dir, { cwd: root });
    const raw = readFileSync(segmentPath(dir, resolved.name), 'utf8').trim().split('\n');
    const first = JSON.parse(raw[0]);
    assert.equal(Object.hasOwn(first, 'anchor'), true, 'the segment\'s first entry must carry the anchor');
    assert.equal(first.branch, 'feat/reassign-test', 'the segment\'s first entry must also carry the exact minting branch (T-MANIFEST-FOREST, fourth round)');
    assert.equal(first.data.migratedFrom, 'T7', 'it re-attests the ROOT evidence forward, not a no-op mint');
    assert.equal(first.sigVersion, 2, 'an anchor-carrying entry must be signed at v2');
    const { sig: _sig, segment: _segment, ...signed } = first;
    const expectedSig = createHmac('sha256', KEY).update(canonicalJson(signed)).digest('hex');
    assert.equal(first.sig, expectedSig, 'sig must be a real v2 HMAC over every field but sig/segment, not a placeholder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrateManifestEvidence never resurrects a stale root verdict over a causally-later segment one (adversarial-review finding)', () => {
  const { root, dir } = gitRepo();
  try {
    // A root approval recorded at a HIGH seq before cutover...
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });
    for (let i = 0; i < 20; i += 1) {
      recordTicketEvidence(root, {
        transactionId: `tx-pad-${i}`, operation: 'complete', ticketId: `PAD${i}`,
        ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
      });
    }
    activate(dir);
    // ...then a causally-LATER segment entry for the SAME gate, at a low seq
    // (segments restart their own seq counter at 1) — this must win.
    recordTicketEvidence(root, {
      transactionId: 'tx-2', operation: 'complete', ticketId: 'T7',
      ticketHash: 'i'.repeat(64), storeHash: 't'.repeat(64), key: null,
    });
    const resolvedBefore = resolveOpenSegment(dir, { cwd: root });
    assert.equal(resolvedBefore.isNew, false, 'precondition: the segment entry already landed');

    const result = migrateManifestEvidence(root, 'T7', 'gh:r#4', { now: '2026-06-27T00:00:00Z', key: null });
    assert.equal(result.migrated, 1);
    assert.equal(result.entries[0].data.migratedFrom, 'T7');
    // The re-attested storeHash must be the SEGMENT entry's, not root's stale one.
    assert.match(result.entries[0].data.migratedEvidenceHash, /^[0-9a-f]{64}$/);
    const raw = readFileSync(segmentPath(dir, resolvedBefore.name), 'utf8').trim().split('\n');
    const carried = JSON.parse(raw.at(-1));
    assert.equal(carried.data.migratedFrom, 'T7');
    const segmentSourceLine = JSON.parse(raw[0]);
    assert.equal(segmentSourceLine.data.storeHash, 't'.repeat(64), 'the segment\'s own T7 entry (causally later) is the one carried forward');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateManifestEvidence ignores an UNRELATED lineage\'s segment — no total order across independent segments', () => {
  const { root, dir } = gitRepo();
  try {
    activate(dir);
    // A hand-built segment simulating a DIFFERENT branch/lineage's evidence —
    // never opened via this checkout's .lineage token.
    const foreignName = 'foreign-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
    const foreignEntry = {
      seq: 1, gate: 'ticket-complete', ts: '2026-01-01T00:00:00.000Z', ticket: 'T7',
      data: { verdict: 'clear' }, files: {}, prev: null, anchor: null,
    };
    writeFileSync(join(dir, 'manifest.d', foreignName), `${JSON.stringify(foreignEntry)}\n`);

    const result = migrateManifestEvidence(root, 'T7', 'gh:r#5', { now: '2026-06-27T00:00:00Z', key: null });
    assert.equal(result.migrated, 0, 'an unrelated lineage\'s evidence must never be picked up — no total order across independent segments');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// P5 prosecution finding: forestChainsIntact must fail closed on a nested
// directory anywhere under manifest.d/ (spec §5 item 1), matching
// gate-manifest's own verify() — see manifest-segments.test.mjs's identical
// test for the direct evidence-recording path.
test('migrateManifestEvidence refuses to append when a nested directory shadows a segment name under manifest.d/', () => {
  const { root, dir } = gitRepo();
  try {
    activate(dir);
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });
    mkdirSync(join(dir, 'manifest.d', 'evil-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl'), { recursive: true });

    assert.throws(
      () => migrateManifestEvidence(root, 'T7', 'gh:r#6', { now: '2026-06-27T00:00:00Z', key: null }),
      /manifest forest is invalid/,
      'a nested directory anywhere under manifest.d/ must block re-attestation, not be silently skipped'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migrateManifestEvidence refuses to append when a segment chain is broken', () => {
  const { root, dir } = gitRepo();
  try {
    activate(dir);
    recordTicketEvidence(root, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T7',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });
    const resolved = resolveOpenSegment(dir, { cwd: root });
    const segFile = segmentPath(dir, resolved.name);
    const entry = JSON.parse(readFileSync(segFile, 'utf8').trim());
    entry.prev = 'f'.repeat(64);
    writeFileSync(segFile, `${JSON.stringify(entry)}\n`);

    assert.throws(
      () => migrateManifestEvidence(root, 'T7', 'gh:r#4', { now: '2026-06-27T00:00:00Z', key: null }),
      /manifest forest is invalid/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
