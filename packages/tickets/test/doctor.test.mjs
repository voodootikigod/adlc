import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService, doctorTicketStore, prettyCanonicalJson, ticketFilename } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('doctor is read-only and reports active/archive/runtime health', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-doctor-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const before = readdirSync(join(root, '.adlc')).sort();
    const report = doctorTicketStore(new DirectoryTicketStore(path), { root, archive: true });
    assert.equal(report.ok, true);
    assert.deepEqual(readdirSync(join(root, '.adlc')).sort(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// current-ticket validation.
//
// This check used to be `{ok: true, present: existsSync(...)}` — it never parsed,
// resolved, or hash-checked, so a pointer naming already-merged work reported
// healthy right up until a hook failed closed on it. Doctor must answer the
// question that matters: would the gates accept this pointer?
// ---------------------------------------------------------------------------

function doctorWith(pointer, { raw = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-pointer-'));
  const path = writeDirectory(root, [ticket('A'), ticket('B')]);
  const store = new DirectoryTicketStore(path);
  const snapshot = store.load();
  if (pointer !== undefined) {
    const value = typeof pointer === 'function' ? pointer(snapshot) : pointer;
    writeFileSync(join(root, '.adlc/current-ticket.json'), raw ? value : JSON.stringify(value));
  }
  const report = doctorTicketStore(store, { root });
  return { report, check: report.checks.find((c) => c.name === 'current-ticket'), snapshot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('doctor current-ticket: absent pointer is healthy, not broken', () => {
  const d = doctorWith(undefined);
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.present, false);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a canonical pointer is healthy and names the ticket', () => {
  const d = doctorWith((s) => ({ id: 'A', ticketHash: s.ticketHashes.A }));
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.id, 'A');
    assert.equal(d.check.deprecatedAlias, undefined);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a deprecated alias resolves but is reported', () => {
  // The exact shape this repo's own pointer had. It must resolve (so nothing
  // bricks) AND be visible (so it gets migrated before 2.0 removes it).
  const d = doctorWith((s) => ({ ticketId: 'A', ticketHash: s.ticketHashes.A }));
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.id, 'A');
    assert.equal(d.check.deprecatedAlias, 'ticketId');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a stale hash is reported, not called healthy', () => {
  const d = doctorWith({ id: 'A', ticketHash: 'f'.repeat(64) });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_STALE');
    assert.equal(d.report.ok, false, 'a broken pointer must fail the whole report');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a pointer naming an absent ticket is reported', () => {
  const d = doctorWith({ id: 'GONE', ticketHash: 'f'.repeat(64) });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_MISSING');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: an unrecognized id key is reported, not treated as absent', () => {
  // The fail-open shape. Doctor must not shrug at a pointer the gates will deny.
  const d = doctorWith({ tickett: 'A' });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'INVALID_CURRENT_TICKET');
    assert.equal(d.check.present, true);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: an unparseable pointer is reported', () => {
  const d = doctorWith('{not json', { raw: true });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'INVALID_CURRENT_TICKET');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a pointer pinning no ticketHash is reported (strict, as 2.0 will enforce)', () => {
  const d = doctorWith({ id: 'A' });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_HASH_MISSING');
  } finally { d.cleanup(); }
});

// ---------------------------------------------------------------------------
// storeHash ↔ manifest evidence binding (T77).
//
// doctor reported the live storeHash but never compared it to the storeHash the
// last evidence-required transaction bound in .adlc/manifest.jsonl. The check now
// binds the store to that last evidenced CHECKPOINT and reports honestly — it does
// NOT adjudicate per-ticket tamper (unsound in this model: the ticket layer permits
// ordinary unevidenced updates, so a "changed since its evidence" signal both
// false-flags legitimately-edited evidenced tickets and misses hand-edits to
// never-evidenced ones — sound tamper-detection needs a store hash per transaction,
// a follow-up). Contract:
//   - clean store (hash == last bound storeHash) → pass, no drift;
//   - hash differs from the checkpoint → drift, REPORTED not failed (git history is
//     the record for the changed shards).
// ---------------------------------------------------------------------------

/** A directory store with ticket A authored and COMPLETED (so A carries manifest evidence). */
function storeWithEvidence(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-bind-'));
  writeDirectory(root, []); // empty directory store (.store.json only)
  const store = new DirectoryTicketStore(join(root, '.adlc', 'tickets'));
  const service = new TicketService(store, { root });
  service.apply(service.planCreate(ticket('A')));
  for (const t of extra) service.apply(service.planCreate(t));
  service.apply(service.planComplete('A')); // evidence-required → records bound storeHash + A's hash
  return { root, store, service };
}

const bindCheck = (report) => report.checks.find((c) => c.name === 'storehash-manifest-bind');

test('doctor storehash-manifest-bind: a clean store (unchanged since the last evidence) passes and binds', () => {
  const { root, store } = storeWithEvidence();
  try {
    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.ok(check, 'the storeHash↔manifest check is present');
    assert.equal(check.ok, true);
    assert.equal(check.bound, true);
    assert.notEqual(check.drift, true, 'no drift on a clean store');
    // No ADLC_MANIFEST_KEY here → the binding is NOT cryptographically authenticated, and
    // the check must say so rather than implying an attestation it did not make.
    assert.equal(check.authenticated, false, 'without a key the checkpoint is not authenticated');
    assert.match(check.warning ?? '', /not cryptographically authenticated|forgeable/i, 'and the unauthenticated risk is surfaced');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: WITHOUT a key, a coordinated shard+final-entry edit hides drift — but is flagged UNAUTHENTICATED', () => {
  // The reviewer's exploit (round-34): with no key, an editor changes a shard, recomputes the
  // public store hash, and rewrites the FINAL manifest entry's data.storeHash to match. The
  // backward chain still validates and no drift shows, so a naive reading is "bound + clean".
  // Doctor cannot DETECT this without a signing key — but it must not present it as attested:
  // authenticated:false + a warning are the honest signal (WITH a key this same edit fails the
  // signature check, proven separately).
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  delete process.env.ADLC_MANIFEST_KEY;
  const { root, store } = storeWithEvidence();
  try {
    // 1) Tamper with A's shard.
    const shard = join(root, '.adlc', 'tickets', ticketFilename('A'));
    writeFileSync(shard, prettyCanonicalJson({ ...JSON.parse(readFileSync(shard, 'utf8')), title: 'Coordinated tamper' }));
    const forgedHash = store.load().hash; // the new, public store hash

    // 2) Rewrite the final manifest entry's bound storeHash to match — hiding the drift.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const mlines = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim());
    const last = JSON.parse(mlines[mlines.length - 1]);
    last.data = { ...last.data, storeHash: forgedHash };
    mlines[mlines.length - 1] = JSON.stringify(last);
    writeFileSync(manifestPath, mlines.join('\n') + '\n');

    const check = bindCheck(doctorTicketStore(store, { root }));
    assert.notEqual(check.drift, true, 'the coordinated edit hides drift (why signatures are needed)');
    assert.equal(check.authenticated, false, 'so doctor must NOT present it as authenticated');
    assert.match(check.warning ?? '', /not cryptographically authenticated|forgeable/i, 'the forgeability is surfaced, not hidden');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prevKey;
  }
});

test('doctor storehash-manifest-bind: a hand-edited shard surfaces as drift, deliberately NOT adjudicated as tamper', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Hand-edit A's shard directly, bypassing the transaction machinery. The store
    // hash now diverges from the last evidenced checkpoint. This check reports the
    // drift but must NOT claim tamper — a per-ticket tamper signal is unsound here
    // (see the file header), so the honest output is drift, with git history as the
    // record for the changed shard.
    const shard = join(root, '.adlc', 'tickets', ticketFilename('A'));
    const edited = { ...JSON.parse(readFileSync(shard, 'utf8')), title: 'Silently edited' };
    writeFileSync(shard, prettyCanonicalJson(edited));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.drift, true, 'the divergence from the checkpoint is surfaced');
    assert.notEqual(check.code, 'STOREHASH_MANIFEST_MISMATCH', 'but no false tamper claim is made');
    assert.equal(check.ok, true, 'and it is not failed — this check does not adjudicate tamper');
    assert.equal(report.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a legit later update of an EVIDENCED ticket is NOT flagged as tamper (no false positive)', () => {
  // The round-2 adversarial-review finding: an evidenced ticket that later receives
  // an ordinary non-sensitive update (permitted, unevidenced) must not be reported
  // as tampering. It is drift, reported, never a failure.
  const { root, store, service } = storeWithEvidence();
  try {
    const current = store.load().get('A');
    service.apply(service.planUpdate('A', { ...current, title: 'Legitimately edited later' }));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true, 'a legit unevidenced update of an evidenced ticket does not fail');
    assert.notEqual(check.code, 'STOREHASH_MANIFEST_MISMATCH', 'no false tamper claim');
    assert.equal(check.drift, true, 'it is surfaced as drift');
    assert.equal(report.ok, true, 'the report stays green on a valid repo');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a legitimate unevidenced op (create) is reported as drift, not failed', () => {
  const { root, store, service } = storeWithEvidence();
  try {
    // Creating B is a non-sensitive op that records NO manifest evidence, so the
    // live storeHash drifts from the last bound one — but A (the evidenced ticket)
    // is untouched. That is a legitimate state: reported, never failed.
    service.apply(service.planCreate(ticket('B')));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true, 'a legitimate unevidenced op does not fail the check');
    assert.equal(check.drift, true, 'but the drift is surfaced');
    assert.equal(report.ok, true, 'and the report stays green');
    // The message is honest that the drift is unverified by this check, not a claim
    // that the store is confirmed clean.
    assert.match(check.message, /does not verify|git history/i, 'the drift is reported as unverified, not adjudicated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a forged / chain-broken manifest is NOT trusted (no arbitrary checkpoint)', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Append a forged entry asserting an arbitrary storeHash but with a broken
    // prev-link and out-of-sequence seq. The check must verify the hash chain and
    // refuse to adopt the forged hash — reporting the ledger unverifiable instead of
    // silently trusting the last syntactically-valid storeHash.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const forged = JSON.stringify({ seq: 999, gate: 'forged', ts: '2026-01-01T00:00:00.000Z', data: { storeHash: 'deadbeefdeadbeef', bindingScope: 'store' }, prev: 'not-a-real-hash' });
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + forged + '\n');

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, false, 'a chain-invalid manifest FAILS the integrity check');
    assert.equal(report.ok, false, 'and fails the overall report — a detected corruption is never reported healthy');
    assert.notEqual(check.boundStoreHash, 'deadbeefdeadbeef', 'the forged storeHash is never adopted');
    assert.match(check.reason ?? '', /chain|FAILED|malformed/i, 'the broken chain is reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a manifest line that is not valid JSON FAILS the integrity check', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Not a chain break, not a bad signature — the line itself does not parse.
    // Distinct failure mode from the forged/chain-broken case above; must not be
    // silently skipped or treated as an ignorable trailing line.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + 'not-json-at-all\n');

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, false, 'a malformed manifest line FAILS the integrity check');
    assert.equal(check.code, 'MANIFEST_MALFORMED', 'the malformed-entry code is reported, not miscategorized as a chain break');
    assert.equal(report.ok, false, 'and fails the overall report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Signature verification (adversarial-review round 6): the backward hash chain
// leaves the FINAL entry unprotected, so with a key configured every entry must
// also carry a valid HMAC or the last entry's storeHash could be edited in place.
function signManifestEntry(key, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac('sha256', key).update(JSON.stringify(canonical)).digest('hex');
}

function writeSignedManifest(root, key, { storeHash }) {
  const entry = { seq: 1, gate: 'ticket-complete', ts: '2026-01-01T00:00:00.000Z', data: { storeHash, bindingScope: 'store' }, files: {}, prev: null };
  entry.sig = signManifestEntry(key, entry);
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), `${JSON.stringify(entry)}\n`);
  return entry;
}

test('doctor storehash-manifest-bind: with a key set, a validly-signed manifest verifies (signaturesVerified)', () => {
  const { root, store } = storeWithEvidence();
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  try {
    const live = store.load().hash;
    writeSignedManifest(root, 'test-signing-key', { storeHash: live });

    // The key is an EXPLICIT parameter now — env manipulation is inert by design
    // (spec Layer 2, P1): doctor consults only what it is handed.
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, true, 'a correctly-signed ledger verifies');
    assert.equal(check.signaturesVerified, true, 'and reports that signatures WERE checked');
    assert.notEqual(check.drift, true, 'the bound hash matches the live store');
  } finally {
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor storehash-manifest-bind: an in-place edit of the FINAL entry storeHash fails signature verification', () => {
  const { root, store } = storeWithEvidence();
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  try {
    const entry = writeSignedManifest(root, 'test-signing-key', { storeHash: store.load().hash });
    // The exploit: rewrite the last entry's storeHash but leave its signature (and
    // the chain, which does not protect the final line) untouched.
    const forged = { ...entry, data: { ...entry.data, storeHash: 'deadbeefdeadbeef' } };
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), `${JSON.stringify(forged)}\n`);

    const report = doctorTicketStore(store, { root, key: 'test-signing-key' });
    const check = bindCheck(report);
    assert.equal(check.ok, false, 'the tampered final entry fails verification');
    assert.equal(check.code, 'MANIFEST_SIGNATURE_INVALID');
    assert.equal(report.ok, false, 'and fails the overall report');
    assert.notEqual(check.boundStoreHash, 'deadbeefdeadbeef', 'the forged storeHash is never adopted');
  } finally {
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY; else process.env.ADLC_MANIFEST_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor storehash-manifest-bind: with NO key configured, it reports signatures were not verified', () => {
  const { root, store } = storeWithEvidence();
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  try {
    delete process.env.ADLC_MANIFEST_KEY;
    const check = bindCheck(doctorTicketStore(store, { root }));
    assert.equal(check.signaturesVerified, false, 'no false assurance — only the structural chain was checked');
  } finally {
    if (prevKey !== undefined) process.env.ADLC_MANIFEST_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor storehash-manifest-bind: a store with no recorded evidence yet is inert (not a failure)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-noevidence-'));
  try {
    const path = writeDirectory(root, [ticket('A')]); // shards written directly; no manifest
    const report = doctorTicketStore(new DirectoryTicketStore(path), { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true);
    assert.equal(check.bound, false, 'nothing to bind against yet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T-MANIFEST-FOREST (adversarial-review finding): storeHashBindingCheck must
// bind to evidence recorded in this branch's own segment, not just root —
// needs a real git repo, since segment resolution reads the current branch.
function gitStoreWithSegmentedEvidence({ key = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-segment-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'feat/doctor-segment-test');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  writeDirectory(root, []);
  mkdirSync(join(root, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  const store = new DirectoryTicketStore(join(root, '.adlc', 'tickets'));
  const service = new TicketService(store, { root, key });
  service.apply(service.planCreate(ticket('A')));
  service.apply(service.planComplete('A')); // evidence-required → recorded into the segment
  return { root, store, service };
}

test('doctor storehash-manifest-bind: binds to evidence recorded in a segment (segmented repo), not just root', () => {
  const { root, store } = gitStoreWithSegmentedEvidence();
  try {
    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.bound, true, 'must bind to the segment-recorded checkpoint, not report "no evidence yet"');
    assert.equal(check.storeHash, check.boundStoreHash);
    assert.notEqual(check.drift, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a signed segment checkpoint is authenticated the same as a signed root one', () => {
  // The key is an EXPLICIT parameter now — env manipulation is inert by design
  // (spec Layer 2, P1): both evidence recording and doctor consult only what
  // they are handed.
  const { root, store } = gitStoreWithSegmentedEvidence({ key: 'doctor-segment-test-key' });
  try {
    const check = bindCheck(doctorTicketStore(store, { root, key: 'doctor-segment-test-key' }));
    assert.equal(check.bound, true);
    assert.equal(check.authenticated, true);
    assert.equal(check.signaturesVerified, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a corrupted segment chain fails closed, not silently ignored', () => {
  const { root, store } = gitStoreWithSegmentedEvidence();
  try {
    const segDir = join(root, '.adlc', 'manifest.d');
    const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
    const segPath = join(segDir, segName);
    const entry = JSON.parse(readFileSync(segPath, 'utf8').trim());
    entry.prev = 'f'.repeat(64); // break the chain
    writeFileSync(segPath, `${JSON.stringify(entry)}\n`);

    const check = bindCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.code, 'MANIFEST_CHAIN_INVALID');
    assert.match(check.reason, new RegExp(segName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Adversarial-review finding: a read-only doctor check must never mint a segment
// as a side effect. resolveOpenSegment (mint-capable) writes .lineage even when
// it decides not to create anything else — a race against a real writer that
// already minted its own token but had not yet created the segment file would
// overwrite that token, splitting the writer's evidence across two segments.
test('doctor storehash-manifest-bind: never mints a segment or writes .lineage (read-only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-segment-nomint-'));
  try {
    const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'feat/doctor-nomint-test');
    g('config', 'user.email', 't@t.co');
    g('config', 'user.name', 'tester');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    const path = writeDirectory(root, [ticket('A')]);
    mkdirSync(join(root, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    // Segmented, but nothing has recorded evidence into a segment yet.

    const before = readdirSync(join(root, '.adlc', 'manifest.d')).sort();
    const check = bindCheck(doctorTicketStore(new DirectoryTicketStore(path), { root }));
    assert.equal(check.bound, false, 'no evidence recorded yet');
    assert.deepEqual(
      readdirSync(join(root, '.adlc', 'manifest.d')).sort(), before,
      'doctor must not mint a segment or write .lineage as a side effect of a read-only check'
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor current-ticket: reports that it could not validate when the store is unreadable', () => {
  // Bounded (the active-store check already failed, so the verdict is ok:false
  // either way) but report-only silence here would mislead: the operator must see
  // WHY the pointer was not validated, not an absent check.
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-nostore-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'A', ticketHash: 'x'.repeat(64) }));
    const broken = new DirectoryTicketStore(join(root, '.adlc/tickets'));
    const report = doctorTicketStore(broken, { root });
    const check = report.checks.find((c) => c.name === 'current-ticket');
    assert.equal(check.ok, false);
    assert.equal(check.code, 'ACTIVE_STORE_UNREADABLE');
    assert.equal(report.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
