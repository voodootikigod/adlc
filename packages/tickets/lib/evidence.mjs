import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { conflict } from './errors.mjs';
import { sha256, canonicalJson } from './canonical.mjs';
import { fsyncDirectory } from './durability.mjs';
import { isSegmentedRepo, resolveOpenSegment, readForestEntries, forestChainsIntact, segmentPath, lineagePath, entrySigValid } from './manifest-segments.mjs';
import { validateKeyParam } from './key-contract.mjs';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function withManifestLock(path, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try { descriptor = openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt < retries) sleep(delayMs);
      continue;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    try { return fn(); }
    finally {
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (current.token === owner.token) unlinkSync(lockPath);
      } catch {}
    }
  }
  throw conflict('MANIFEST_LOCK_TIMEOUT', `could not acquire manifest lock: ${lockPath}`);
}

function lastLine(content) {
  return content.split('\n').reverse().find((line) => line.trim()) ?? null;
}

function sign(key, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac('sha256', key).update(JSON.stringify(canonical)).digest('hex');
}

// v2 signing (all fields except sig/segment, canonically sorted) — required
// for a segment's anchor-carrying first entry (spec §4.4: the anchor is
// tamper-evident only under v2; this file's v1 sign() above has a fixed
// field set that predates segments and never covered `anchor`). Mirrors
// @adlc/gate-manifest/lib/sign.mjs's canonicalEntryBytes/signEntry exactly.
function signV2(key, entry) {
  const { sig: _sig, segment: _segment, ...signed } = entry;
  return createHmac('sha256', key).update(canonicalJson(signed)).digest('hex');
}

// `key`, when provided (adversarial-review finding): a candidate matching
// transactionId/action is trusted as genuine ONLY if it also carries a valid
// signature — forestChainsIntact's per-chain legacy-unsigned-prefix tolerance
// (needed so an honest chain that predates signing can still verify) is
// deliberately NOT enough on its own to authenticate ONE specific entry as
// real evidence: a wholly-unsigned forged segment (no signed entry anywhere
// in it) passes that chain-wide check by design, so without this, an
// attacker could still forge a specific idempotency match even with signing
// active. An unsigned/invalid-signed candidate is treated as absent (not a
// match, not a conflict) — the real write proceeds and appends genuine
// evidence instead of trusting the forgery or refusing outright.
/**
 * Does an existing entry describe EXACTLY the record this call would write?
 *
 * The audit payload is part of the comparison, not just the transaction identity:
 * an entry carrying the same gate and hashes but LACKING `bypass`/`storeHashBefore`
 * (an older unaudited record, or one an attacker appended) would otherwise satisfy
 * the idempotency scan, and the mutation would finalize as though it had been
 * audited when the manifest holds no audit for it.
 */
const AUDIT_FIELDS = ['bypass', 'op', 'ticketId', 'storeHashBefore', 'storeHashAfter', 'ticketIds'];

function auditFieldsMatch(entry, data, acceptLegacyMatch) {
  // `acceptLegacyMatch` is for ONE caller: a recovery replaying the apply evidence of
  // a transaction that was interrupted BEFORE this feature existed. Such an entry
  // carries no audit payload at all and never can — demanding one turns a resumable
  // recovery into a permanent EVIDENCE_IDEMPOTENCY_CONFLICT with no way out. It is
  // deliberately narrow: only a candidate carrying NONE of the fields qualifies, so
  // an entry that disagrees on any of them is still a conflict, and a fresh mutation
  // is never waved through by an unaudited entry.
  if (acceptLegacyMatch && AUDIT_FIELDS.every((field) => entry.data?.[field] === undefined)) return true;
  for (const field of AUDIT_FIELDS) {
    if (canonicalJson(entry.data?.[field] ?? null) !== canonicalJson(data[field] ?? null)) return false;
  }
  return true;
}

function findMatchingEvidence(entries, { gate, data, operation, action, ticketId, ticketHash, storeHash, archiveHash, transactionId, key = null, acceptLegacyMatch = false }) {
  for (const entry of entries) {
    if (entry?.data?.transactionId === transactionId && entry?.data?.action === action) {
      if (key !== null && !entrySigValid(key, entry)) continue;
      const matches = entry.gate === gate
        && (entry.ticket ?? null) === ticketId
        && entry.data.operation === operation
        && (entry.data.ticketHash ?? null) === ticketHash
        && entry.data.storeHash === storeHash
        && (entry.data.archiveHash ?? null) === archiveHash
        && entry.data.bindingScope === (ticketId ? 'ticket' : 'store')
        && auditFieldsMatch(entry, data, acceptLegacyMatch);
      if (!matches) throw conflict('EVIDENCE_IDEMPOTENCY_CONFLICT', `transaction ${transactionId}/${action} already has different evidence`);
      return entry;
    }
  }
  return null;
}

/**
 * Append `entry`'s data to the currently-open segment (T-MANIFEST-FOREST,
 * spec §7), minting one when needed. Mirrors
 * @adlc/gate-manifest/lib/segment-writer.mjs's appendToSegment — see
 * manifest-segments.mjs's header for why this is duplicated rather than
 * imported. Locks on .lineage (checkout-wide, so resolving AND writing the
 * segment is one atomic transaction — two first-ever writers on one branch
 * must not mint two different segments) and then on the target segment
 * itself (protects the segment's bytes against anything else that might
 * ever write to it directly).
 */
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash, storeHash, archiveHash, key, acceptLegacyMatch = false }) {
  return withManifestLock(lineagePath(dir), () => {
    // Adversarial-review finding: a corrupted OTHER segment (crash, manual
    // edit, or a malicious branch) must not let a ticket transaction finalize
    // — and delete its recovery journal — against evidence appended to an
    // already-invalid forest. Mirrors gate-manifest's own segment-writer.mjs
    // precondition. Passing `key` (when configured) additionally rejects an
    // unsigned-after-signed forgery: without it, an attacker's correctly
    // hash-chained but UNSIGNED entry naming a real transactionId/action
    // would pass this check and get trusted as genuine by the idempotency
    // scan below, even with signing active (adversarial-review finding).
    if (!forestChainsIntact(dir, { key })) {
      throw conflict('INVALID_MANIFEST', 'manifest forest is invalid: a segment or root chain is broken, or an entry is unsigned/forged — refusing to append or trust the idempotency scan');
    }
    const existing = findMatchingEvidence(readForestEntries(dir), { gate, data, transactionId, operation, action, ticketId, ticketHash, storeHash, archiveHash, key, acceptLegacyMatch });
    if (existing) return existing;

    const resolved = resolveOpenSegment(dir, { cwd: dirname(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync(dirname(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
      const rawLines = content.split('\n').filter((line) => line.trim() !== '');
      if (resolved.isNew && rawLines.length > 0) {
        throw conflict('INVALID_MANIFEST', `segment ${resolved.name} was expected to be new but already has content`);
      }
      if (!resolved.isNew && rawLines.length === 0) {
        throw conflict('INVALID_MANIFEST', `segment ${resolved.name} was expected to already be open with content but is empty or missing`);
      }
      let previous = null;
      for (const line of rawLines) {
        try { previous = JSON.parse(line); }
        catch { throw conflict('INVALID_MANIFEST', `segment ${resolved.name} contains malformed JSON`); }
      }
      const prevRawLine = rawLines.at(-1) ?? null;
      const entry = {
        seq: typeof previous?.seq === 'number' ? previous.seq + 1 : 1,
        // `branch` (T-MANIFEST-FOREST, fourth round): the EXACT git branch
        // that minted this segment, alongside `anchor` — the non-lossy
        // identity recoverOpenSegment matches on. Mirrors
        // @adlc/gate-manifest/lib/segment-writer.mjs's identical addition.
        ...(resolved.isNew ? { anchor: resolved.anchor, ...(resolved.branch !== undefined ? { branch: resolved.branch } : {}) } : {}),
        gate,
        ts: new Date().toISOString(),
        ...(ticketId ? { ticket: ticketId } : {}),
        data,
        files: {},
        prev: prevRawLine === null ? null : sha256(prevRawLine),
      };
      if (key) {
        if (resolved.isNew) entry.sigVersion = 2; // forced: v1 never covers `anchor`
        entry.sig = entry.sigVersion === 2 ? signV2(key, entry) : sign(key, entry);
      }
      const descriptor = openSync(targetPath, 'a');
      try {
        writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      fsyncDirectory(dirname(targetPath));
      return entry;
    });
  });
}

/**
 * Append an idempotent, hash-bound transaction/recovery record to gate-manifest.
 *
 * `bypass` (T-01M0122WMF8EJTB7ERHTEG8HMJ) marks a mutation of a FROZEN TRUST ROOT
 * — a store in which some ticket declares a rail, so the store itself is frozen
 * and changing it is a deliberate override rather than ordinary authoring. It adds
 * the audit fields the override needs and nothing else: an entry recorded with
 * `bypass: false` (every pre-existing caller) is byte-identical to what this writer
 * produced before, so the behavior change is confined to frozen trust roots.
 *
 * `gate` defaults to this operation's own gate, which keeps a sensitive mutation's
 * existing `ticket-<operation>` entry exactly where consumers expect it. The
 * bypass audit for a mutation that had NO gate of its own passes `ticket-mutation`.
 */
export function recordTicketEvidence(root, {
  key,
  transactionId,
  operation,
  action = 'apply',
  ticketId = null,
  ticketHash = null,
  storeHash,
  archiveHash = null,
  revision = process.env.ADLC_REVISION ?? null,
  gate = `ticket-${operation}`,
  bypass = false,
  storeHashBefore = null,
  ticketIds = null,
  acceptLegacyMatch = false,
} = {}) {
  // Validate FIRST: the idempotent-retry early return must not bypass the key
  // contract — an invalid key is a caller bug on every path, retries included.
  const signingKey = validateKeyParam(key);
  const dir = join(root, '.adlc');
  // Built ONCE, here, so the root and segmented writers cannot drift in what they
  // sign. Key order is the insertion order both paths already produced.
  const data = {
    operation,
    action,
    transactionId,
    revision,
    ticketHash,
    storeHash,
    ...(archiveHash ? { archiveHash } : {}),
    bindingScope: ticketId ? 'ticket' : 'store',
    ...(bypass ? {
      op: operation,
      ticketId,
      // A write that moves SEVERAL tickets at once (a prune sweep) names them all:
      // store hashes prove that something changed, not what this entry authorized.
      ...(ticketIds ? { ticketIds } : {}),
      storeHashBefore,
      storeHashAfter: storeHash,
      bypass: true,
    } : {}),
  };
  // spec §7: once segmented, every append routes to the current lineage's
  // segment instead of root (adversarial-review finding: this writer used to
  // be entirely separate from @adlc/gate-manifest's own root-vs-segment
  // routing, so ticket completion/updates would silently append behind a
  // frozen cutover, or create a root for the first time in a rootless
  // segmented repo — retroactively invalidating every existing anchor:null
  // segment, spec §4.4).
  if (isSegmentedRepo(dir)) {
    return recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash, storeHash, archiveHash, key: signingKey, acceptLegacyMatch });
  }
  const path = join(root, '.adlc/manifest.jsonl');
  return withManifestLock(path, () => {
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = content.split('\n').filter((line) => line.trim());
    // RACE (mirrors @adlc/gate-manifest/lib/record.mjs's identical recheck):
    // isSegmentedRepo above runs BEFORE this lock is acquired. Re-check now
    // that the lock (and therefore an up-to-date view of root) is held.
    if (isSegmentedRepo(dir)) {
      throw conflict('MANIFEST_FROZEN', 'manifest chain is frozen; this repo uses .adlc/manifest.d/ — upgrade adlc if you are seeing this locally');
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.data?.transactionId === transactionId && entry.data?.action === action) {
          // `signingKey`, when configured, means the candidate must carry a valid
          // signature to be trusted as genuine (P5 prosecution finding —
          // mirrors the segmented path's findMatchingEvidence): an attacker
          // able to append an unsigned line to root with fabricated-but-
          // computable transactionId/action/hash fields would otherwise get
          // it silently accepted as "already recorded", even with signing
          // active. An unsigned/invalid candidate here is treated as absent,
          // not a match — the real write proceeds below instead.
          if (signingKey !== null && !entrySigValid(signingKey, entry)) continue;
          const matches = entry.gate === gate
            && (entry.ticket ?? null) === ticketId
            && entry.data.operation === operation
            && (entry.data.ticketHash ?? null) === ticketHash
            && entry.data.storeHash === storeHash
            && (entry.data.archiveHash ?? null) === archiveHash
            && entry.data.bindingScope === (ticketId ? 'ticket' : 'store')
            && auditFieldsMatch(entry, data, acceptLegacyMatch);
          if (!matches) throw conflict('EVIDENCE_IDEMPOTENCY_CONFLICT', `transaction ${transactionId}/${action} already has different evidence`);
          return entry;
        }
      } catch (error) {
        if (error?.code === 'EVIDENCE_IDEMPOTENCY_CONFLICT') throw error;
        throw conflict('INVALID_MANIFEST', 'cannot append ticket evidence to a malformed manifest');
      }
    }
    if (lines.length === 0) {
      // Adversarial-review finding (mirrors gate-manifest/lib/record.mjs's
      // identical guard): a rootless segmented repo's ONLY signal, once the
      // activation marker is lost/corrupted, is this empty-root branch.
      // Creating a root now would retroactively invalidate every existing
      // anchor: null segment (spec §4.4).
      let hasExistingSegments;
      try {
        hasExistingSegments = readForestEntries(dir).length > 0; // root is empty here, so any entry at all means a segment exists
      } catch { hasExistingSegments = false; }
      if (hasExistingSegments) {
        throw conflict('MANIFEST_FROZEN', 'refusing to create the root manifest: manifest.d/ already holds segment(s) anchored to nothing (anchor: null), legal only in a rootless forest — this usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted');
      }
    }
    const previous = lastLine(content);
    const prior = previous ? JSON.parse(previous) : null;
    const entry = {
      seq: typeof prior?.seq === 'number' ? prior.seq + 1 : 1,
      gate,
      ts: new Date().toISOString(),
      ...(ticketId ? { ticket: ticketId } : {}),
      data,
      files: {},
      prev: previous ? sha256(previous) : null,
    };
    if (signingKey) entry.sig = sign(signingKey, entry);
    const descriptor = openSync(path, 'a');
    try {
      writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    fsyncDirectory(dirname(path));
    return entry;
  });
}
