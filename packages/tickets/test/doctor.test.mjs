import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
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

/**
 * A multi-entry ledger, written as a real hash chain. `specs` is one object per
 * entry: `{ storeHash?, sign?, forgeSig? }`. `sign: false` writes an entry with
 * no `sig` field at all (an honest pre-signing entry); `forgeSig` writes a `sig`
 * that will not verify (tampering). Chain links are computed the way the ledger
 * writer computes them, so these fixtures are indistinguishable from real ones.
 */
function writeChainedManifest(root, key, specs) {
  let prev = null;
  const lines = specs.map((spec, i) => {
    const entry = {
      seq: i + 1,
      gate: 'ticket-complete',
      ts: `2026-01-0${i + 1}T00:00:00.000Z`,
      data: spec.storeHash ? { storeHash: spec.storeHash, bindingScope: 'store' } : {},
      files: {},
      prev,
    };
    if (spec.noData) delete entry.data;
    if (spec.rawSig !== undefined) entry.sig = spec.rawSig;
    else if (spec.forgeSig) entry.sig = 'a'.repeat(64);
    else if (spec.sign !== false) entry.sig = signManifestEntry(key, entry);
    const line = JSON.stringify(entry);
    prev = createHash('sha256').update(line).digest('hex');
    return line;
  });
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), `${lines.join('\n')}\n`);
  return lines;
}

function writeSignedManifest(root, key, { storeHash }) {
  const entry = { seq: 1, gate: 'ticket-complete', ts: '2026-01-01T00:00:00.000Z', data: { storeHash, bindingScope: 'store' }, files: {}, prev: null };
  entry.sig = signManifestEntry(key, entry);
  writeFileSync(join(root, '.adlc', 'manifest.jsonl'), `${JSON.stringify(entry)}\n`);
  return entry;
}

// ---------------------------------------------------------------------------
// An HONEST legacy prefix: entries written before HMAC signing was enabled carry
// no `sig` at all. This repo's own ledger has 95 such entries (2026-07-23..26)
// before its first signed entry, so a blanket "with a key, every entry must be
// signed" rule made a shipped diagnostic permanently red on honest history.
//
// The rule is `seenSignedEntry`, already implemented by gate-manifest's verify.mjs
// and by chainIsIntact in this package's own manifest-segments.mjs: tolerate a
// MISSING signature only on the contiguous prefix before this chain's first valid
// signature, and never tolerate a PRESENT-but-invalid one.
// ---------------------------------------------------------------------------

test('doctor storehash-manifest-bind: an honest unsigned legacy prefix followed by signed entries verifies', () => {
  const { root, store } = storeWithEvidence();
  try {
    const live = store.load().hash;
    // entry 1 predates signing; entry 2 is signed and carries the checkpoint
    writeChainedManifest(root, 'test-signing-key', [
      { sign: false },
      { sign: true, storeHash: live },
    ]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, true, 'an honest legacy prefix does not fail the check');
    assert.equal(check.boundStoreHash, live, 'and the signed entry supplies the checkpoint');
    assert.notEqual(check.drift, true, 'the bound hash matches the live store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: an unsigned entry AFTER a signed one is still rejected', () => {
  const { root, store } = storeWithEvidence();
  try {
    // the regression this tolerance must not introduce: an attacker who controls
    // the tail of a signed chain regressing it to unsigned by appending.
    writeChainedManifest(root, 'test-signing-key', [
      { sign: true },
      { sign: false, storeHash: store.load().hash },
    ]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, false, 'signing cannot be regressed once it has begun');
    assert.equal(check.code, 'MANIFEST_SIGNATURE_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a PRESENT-but-invalid signature inside the prefix is still rejected', () => {
  const { root, store } = storeWithEvidence();
  try {
    // leniency means "an honest unsigned prefix is OK", never "tampered
    // signatures are OK" — a sig that does not verify is tampering at any position.
    writeChainedManifest(root, 'test-signing-key', [
      { forgeSig: true },
      { sign: true, storeHash: store.load().hash },
    ]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, false, 'a bad signature is tampering, not legacy');
    assert.equal(check.code, 'MANIFEST_SIGNATURE_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: an UNSIGNED entry may not supply the bound checkpoint when a key is set', () => {
  const { root, store } = storeWithEvidence();
  try {
    const live = store.load().hash;
    // The whole ledger predates signing. Tolerating the prefix must not promote an
    // unverifiable checkpoint into an "authenticated" binding — that would convert
    // this fix's false-RED into a false-GREEN.
    writeChainedManifest(root, 'test-signing-key', [{ sign: false, storeHash: live }]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    // Tolerated as a chain — an all-unsigned ledger is indistinguishable from one
    // that honestly predates signing, so calling it tamper would be a false
    // accusation (verify.mjs documents the same HONEST LIMIT).
    assert.equal(check.ok, true, 'an all-legacy chain is not adjudicated as tampering');
    // ...but never promoted to a binding, which is the half that must not regress.
    assert.notEqual(check.bound, true, 'an unsigned checkpoint is not a binding');
    assert.notEqual(check.authenticated, true, 'and authentication is never claimed over it');
    assert.notEqual(check.boundStoreHash, live, 'the unsigned storeHash is not adopted');
    assert.match(check.reason ?? '', /sign/i, 'and the reason names why it could not bind');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a one-character signature is tampering, not a legacy entry', () => {
  const { root, store } = storeWithEvidence();
  try {
    // A `sig` of ANY non-zero length is a present signature and must verify.
    // Treating a short one as "absent" would let a forger opt back into the
    // legacy-prefix tolerance simply by truncating the field.
    writeChainedManifest(root, 'test-signing-key', [
      { rawSig: 'a' },
      { sign: true, storeHash: store.load().hash },
    ]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, false, 'a present-but-unverifiable sig is rejected however short');
    assert.equal(check.code, 'MANIFEST_SIGNATURE_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: the failure reason names the OFFENDING line, 1-indexed', () => {
  const { root, store } = storeWithEvidence();
  try {
    // An operator jumps straight to this line number; an off-by-one sends them
    // to an innocent entry. Two shapes, so both message paths are pinned.
    writeChainedManifest(root, 'test-signing-key', [
      { sign: true },
      { sign: true },
      { forgeSig: true },
    ]);
    const tampered = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(tampered.code, 'MANIFEST_SIGNATURE_INVALID');
    assert.match(tampered.reason, /line 3\b/, `bad-signature reason names line 3: ${tampered.reason}`);

    writeChainedManifest(root, 'test-signing-key', [
      { sign: true },
      { sign: false },
    ]);
    const regressed = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(regressed.code, 'MANIFEST_SIGNATURE_INVALID');
    assert.match(regressed.reason, /line 2\b/, `unsigned-after-signed reason names line 2: ${regressed.reason}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: an entry carrying no `data` field at all is walked, not thrown on', () => {
  const { root, store } = storeWithEvidence();
  try {
    const live = store.load().hash;
    // Not every gate records data. Reading storeHash off a missing `data` must
    // not crash the diagnostic — a doctor that throws reports nothing at all.
    writeChainedManifest(root, 'test-signing-key', [
      { sign: true, noData: true },
      { sign: true, storeHash: live },
    ]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.equal(check.ok, true, 'a data-less entry is skipped, not fatal');
    assert.equal(check.boundStoreHash, live, 'and the later checkpoint still binds');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: with no checkpoint recorded at all, the reason does not blame signing', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Distinct from the all-unsigned case: here nothing was ever recorded, so
    // the operator must not be told signatures were the obstacle.
    writeChainedManifest(root, 'test-signing-key', [{ sign: true }]);
    const check = bindCheck(doctorTicketStore(store, { root, key: 'test-signing-key' }));
    assert.notEqual(check.bound, true, 'nothing to bind to');
    assert.equal(check.reason, 'no evidence-required transaction recorded yet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

// T-MANIFEST-FOREST, fourth round: storeHashBindingCheck now recovers across
// a lost `.lineage` token (recoverOpenSegment matches on the EXACT `branch`
// field every segment's first entry carries, not the lossy filename slug —
// see recoverOpenSegment's own doc), so a fresh clone or a branch switch no
// longer reports a stale "not bound" when a real, committed checkpoint exists.
test('doctor storehash-manifest-bind: recovers a real checkpoint across a lost .lineage token (fresh-clone/branch-switch case)', () => {
  const { root, store } = gitStoreWithSegmentedEvidence();
  try {
    rmSync(join(root, '.adlc', 'manifest.d', '.lineage'), { force: true });
    const check = bindCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.bound, true, 'a lost token must not hide a real, committed checkpoint');
    assert.equal(check.storeHash, check.boundStoreHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A genuinely ambiguous recovery (two committed segments both declaring this
// branch as their own — spec §7 point 1) must surface as a real check
// failure, never a silent "not bound" or a guessed-at binding.
test('doctor storehash-manifest-bind: a genuinely ambiguous recovery fails closed as SEGMENT_AMBIGUOUS, never guesses', () => {
  const { root, store } = gitStoreWithSegmentedEvidence();
  try {
    const segDir = join(root, '.adlc', 'manifest.d');
    const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
    const first = JSON.parse(readFileSync(join(segDir, segName), 'utf8').trim());
    const secondName = segName.replace(/-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/, '-01ARZ3NDEKTSV4RRFFQ69G5FAX.jsonl');
    writeFileSync(
      join(segDir, secondName),
      `${JSON.stringify({ seq: 1, gate: 'evidence', ts: new Date().toISOString(), data: {}, files: {}, prev: null, anchor: null, branch: first.branch })}\n`,
    );
    rmSync(join(root, '.adlc', 'manifest.d', '.lineage'), { force: true });
    const check = bindCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.code, 'SEGMENT_AMBIGUOUS');
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

// ---------------------------------------------------------------------------
// manifest-forest: dangling references nothing else reports (spec §12 AC10).
//
// An orphaned anchor and a stale `.lineage` token are both invisible to the
// rest of the system by design. Every resolver swallows a broken token —
// peekOpenSegment falls through and the next writer mints a fresh segment,
// which is right for a writer and silent for an operator — and an orphaned
// anchor surfaces only under a full verify(), which `adlc ticket doctor` does
// not run. Both then fail somewhere far from the cause.
//
// The existing chain-integrity codes answer the OTHER question: whether what
// IS there verifies, not whether something it points at is gone.
// ---------------------------------------------------------------------------

const forestCheck = (report) => report.checks.find((c) => c.name === 'manifest-forest');

/**
 * A repo whose root carries real evidence and whose branch then opened a
 * segment anchored into it — the ordinary shape since the root was frozen.
 * Segments only capture appends once `.store.json` exists, so the marker is
 * written between the two transactions.
 */
function gitStoreWithAnchoredSegment() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-forest-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'feat/doctor-forest-test');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  writeDirectory(root, []);
  const store = new DirectoryTicketStore(join(root, '.adlc', 'tickets'));
  const service = new TicketService(store, { root });
  service.apply(service.planCreate(ticket('A')));
  service.apply(service.planComplete('A')); // evidence-required → lands in ROOT
  mkdirSync(join(root, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
  service.apply(service.planCreate(ticket('B')));
  service.apply(service.planComplete('B')); // → mints a segment anchored at root's tip
  // A SECOND evidenced transaction, so the segment is more than one line long.
  // Only the first entry carries the anchor (§4.4), so a reader that took the
  // last entry instead — or any entry but the first — would find no anchor at
  // all and report a genuinely orphaned segment as healthy.
  service.apply(service.planCreate(ticket('C')));
  service.apply(service.planComplete('C'));
  const segments = readdirSync(join(root, '.adlc', 'manifest.d')).filter((n) => n.endsWith('.jsonl'));
  const lines = readFileSync(join(root, '.adlc', 'manifest.d', segments[0]), 'utf8').split('\n').filter((l) => l.trim());
  assert.ok(lines.length > 1, 'the fixture segment must carry more than one entry');
  assert.equal(JSON.parse(lines[0]).anchor?.segment, 'root', 'only the FIRST entry carries the anchor');
  assert.equal(JSON.parse(lines.at(-1)).anchor, undefined, 'a later entry carries none');
  return { root, store, segment: segments[0] };
}

const segFile = (root, name) => join(root, '.adlc', 'manifest.d', name);

// Every byte under .adlc/, so "read-only" is asserted against the whole store
// and manifest rather than a directory listing that would miss an in-place edit.
function fingerprint(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else out.push(`${next}:${createHash('sha256').update(readFileSync(join(dir, next))).digest('hex')}`);
    }
  };
  walk('');
  return out.join('\n');
}

test('doctor manifest-forest: a healthy forest reports the check ok', () => {
  const { root, store, segment } = gitStoreWithAnchoredSegment();
  try {
    const check = forestCheck(doctorTicketStore(store, { root }));
    assert.ok(check, 'the manifest-forest check is present');
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.segmented, true);
    assert.equal(check.segments, 1);
    assert.deepEqual(check.orphanedAnchors, []);
    assert.equal(check.staleLineage, null);
    assert.ok(segment, 'the fixture opened a segment');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: a repo that never segmented is inert, not a failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-forest-flat-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const check = forestCheck(doctorTicketStore(new DirectoryTicketStore(path), { root }));
    assert.equal(check.ok, true);
    assert.equal(check.segmented, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: reports an anchor whose root line no longer exists', () => {
  const { root, store } = gitStoreWithAnchoredSegment();
  try {
    // Drop root's last entry — the exact line the segment forked from.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim());
    writeFileSync(manifestPath, lines.slice(0, -1).join('\n') + '\n');

    const check = forestCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.orphanedAnchors.length, 1);
    assert.equal(check.orphanedAnchors[0].anchor.segment, 'root');
    assert.match(check.orphanedAnchors[0].reason, /no longer exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: reports an anchor naming a segment that is not in the forest', () => {
  const { root, store, segment } = gitStoreWithAnchoredSegment();
  try {
    const lines = readFileSync(segFile(root, segment), 'utf8').split('\n').filter((l) => l.trim());
    const first = JSON.parse(lines[0]);
    first.anchor = { segment: `gone-${'0'.repeat(26)}.jsonl`, seq: 1, lineHash: 'a'.repeat(64) };
    writeFileSync(segFile(root, segment), [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');

    const check = forestCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.orphanedAnchors.length, 1);
    assert.equal(check.orphanedAnchors[0].segment, segment);
    assert.match(check.orphanedAnchors[0].reason, /not a segment in this forest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: reports a .lineage token whose segment no longer exists', () => {
  const { root, store, segment } = gitStoreWithAnchoredSegment();
  try {
    rmSync(segFile(root, segment));

    const check = forestCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.staleLineage.segment, segment);
    assert.match(check.staleLineage.reason, /no longer exists/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: reports a .lineage token whose cached ULID no longer matches the segment file', () => {
  const { root, store, segment } = gitStoreWithAnchoredSegment();
  try {
    const tokenPath = join(root, '.adlc', 'manifest.d', '.lineage');
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    writeFileSync(tokenPath, JSON.stringify({ ...token, ulid: 'Z'.repeat(26) }));

    const check = forestCheck(doctorTicketStore(store, { root }));
    assert.equal(check.ok, false);
    assert.equal(check.staleLineage.segment, segment);
    assert.equal(check.staleLineage.ulid, 'Z'.repeat(26));
    assert.match(check.staleLineage.reason, /whose own ULID is/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor manifest-forest: reports both faults and repairs neither — every byte under .adlc/ is unchanged', () => {
  const { root, store, segment } = gitStoreWithAnchoredSegment();
  try {
    // Fault 1: the root line this segment forked from is gone.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim());
    writeFileSync(manifestPath, lines.slice(0, -1).join('\n') + '\n');
    // Fault 2: the token caches a ULID the segment file does not carry.
    const tokenPath = join(root, '.adlc', 'manifest.d', '.lineage');
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    writeFileSync(tokenPath, JSON.stringify({ ...token, ulid: 'Z'.repeat(26) }));

    const before = fingerprint(join(root, '.adlc'));
    const report = doctorTicketStore(store, { root, archive: true });
    const check = forestCheck(report);

    assert.equal(check.ok, false);
    assert.equal(check.orphanedAnchors.length, 1);
    assert.equal(check.staleLineage.segment, segment);
    assert.equal(report.ok, false, 'a faulty forest fails the overall report');
    assert.equal(fingerprint(join(root, '.adlc')), before, 'doctor reports; it never repairs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
