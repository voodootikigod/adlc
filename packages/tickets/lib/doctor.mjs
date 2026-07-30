import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ARCHIVE_DIRECTORY, CURRENT_TICKET_FILE, LOCK_DIRECTORY } from './constants.mjs';
import { readTicketLock } from './lock.mjs';
import { readActiveTicketPointer, resolveActiveTicketAgainst } from './pointer.mjs';
import { pendingTransactions } from './store.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { isSegmentedRepo, recoverOpenSegment, segmentPath, entrySigValid } from './manifest-segments.mjs';
import { validateKeyParam } from './key-contract.mjs';

/**
 * Validate `.adlc/current-ticket.json` the way the gates read it.
 *
 * This used to be `{ok: true, present: existsSync(...)}` — presence only, never
 * parsed, resolved, or hash-checked — so a pointer naming already-merged work, or
 * one whose key no reader recognized, passed doctor clean right up until a hook
 * failed closed on it. Doctor now answers the question that matters: would the
 * gates accept this pointer?
 *
 * Read-only and offline, like every other doctor check.
 */
function currentTicketCheck(root, snapshot) {
  const check = { name: 'current-ticket', ok: true, present: existsSync(join(root, CURRENT_TICKET_FILE)) };
  if (!check.present) return check; // absent is inert, not broken
  if (!snapshot) return { ...check, ok: false, code: 'ACTIVE_STORE_UNREADABLE', message: 'cannot validate the pointer: the ticket store did not load' };

  const pointer = readActiveTicketPointer(root);
  if (!pointer.ok) return { ...check, ok: false, code: pointer.code, message: pointer.message };
  if (pointer.value.deprecatedAlias) check.deprecatedAlias = pointer.value.deprecatedAlias;

  // Strict: doctor reports what 2.0 will enforce, so a hash-less pointer that the
  // 1.x bridge still resolves is surfaced here rather than discovered at the cliff.
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env: {}, allowLegacyPointer: false });
  if (!resolved.ok) return { ...check, ok: false, id: pointer.value.id, code: resolved.code, message: resolved.message };

  check.id = resolved.value.id;
  if (resolved.value.warnings.length) check.warnings = resolved.value.warnings;
  return check;
}

/**
 * Bind the live storeHash to the last evidence-required manifest entry (T77).
 *
 * `.adlc/tickets/.store.json` is a FORMAT marker, not a content bind, so a silent
 * shard hand-edit between transactions changed the store with nothing to catch it.
 * Every evidence-required transaction (complete/archive/reassign/sensitive update)
 * records `storeHash` AND, for ticket-scoped ops, the ticket's hash. This check
 * reads that ledger (read-only, offline like every other doctor check) and asks:
 *
 *   - live storeHash == the last recorded storeHash → clean, bound;
 *   - it drifted, but every ticket that carries evidence still hashes to its
 *     recorded value → unevidenced non-sensitive op(s) (a plain create/discard of
 *     OTHER tickets); a legitimate state — REPORTED, not failed;
 *   - a ticket that carries evidence is PRESENT but no longer hashes to its
 *     recorded value → it was altered outside a recorded transaction (a
 *     hand-edited shard) → FLAGGED.
 *
 * An ABSENT evidenced ticket is not treated as tamper: a legitimate `discard`
 * removes the shard the same way a hand-delete would and records no evidence
 * either, so absence is inherently ambiguous and left to the archive/graph checks.
 */
// entrySigValid now lives in manifest-segments.mjs — shared with
// forestChainsIntact's own signature-aware chain check, and still the only
// place in this package that mirrors @adlc/gate-manifest's sign.mjs
// byte-for-byte (see that file's header for why this cannot be imported
// from gate-manifest directly: tickets ← core ← gate-manifest would cycle).

// Verify one chain's (root OR one segment) unbroken hash-link + (with a key)
// per-entry signature, same rules as before this was factored out for
// T-MANIFEST-FOREST — extracted so root and a segment can run the identical
// algorithm. Returns the last `data.storeHash` seen, or null if none did.
// `chainLabel` names the chain in error messages ('manifest ledger' for root,
// 'segment <name>' otherwise) so a break is attributable.
function walkChainForStoreHash(lines, key, chainLabel) {
  let boundStoreHash = null;
  let prevLine = null;
  let prevSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch {
      return { ok: false, code: 'MANIFEST_MALFORMED', reason: `${chainLabel} has a malformed entry at line ${i + 1}; integrity check FAILED` };
    }
    const expectedPrev = prevLine === null ? null : createHash('sha256').update(prevLine).digest('hex');
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) {
      return { ok: false, code: 'MANIFEST_CHAIN_INVALID', reason: `${chainLabel} hash chain breaks at line ${i + 1}; integrity check FAILED` };
    }
    // With a key configured EVERY entry must carry a valid signature. The backward
    // hash chain alone leaves the FINAL entry unprotected — nothing links forward
    // from it — so its data.storeHash could be edited in place undetected.
    if (key !== null && !entrySigValid(key, entry)) {
      return { ok: false, code: 'MANIFEST_SIGNATURE_INVALID', reason: `${chainLabel} entry at line ${i + 1} is unsigned or its signature does not verify; integrity check FAILED` };
    }
    if (entry?.data && typeof entry.data.storeHash === 'string') boundStoreHash = entry.data.storeHash;
    prevLine = lines[i];
    prevSeq = entry.seq;
  }
  return { ok: true, boundStoreHash };
}

function storeHashBindingCheck(root, snapshot, key) {
  const check = { name: 'storehash-manifest-bind', ok: true };
  // No live storeHash to compare — the active-store check already carries that
  // failure; stay inert here rather than double-reporting or throwing.
  if (!snapshot) return { ...check, bound: false, reason: 'active store did not load; storeHash binding not checked' };

  const manifestPath = join(root, '.adlc/manifest.jsonl');
  let boundStoreHash = null;

  // Verify the manifest is a well-formed, unbroken hash chain BEFORE trusting any
  // storeHash it records. Otherwise a forged or tampered ledger could assert an
  // arbitrary "bound" hash, and a malformed line silently skipped could hide a break.
  // The chain format is the ledger writer's (evidence.mjs / ledger.mjs): each entry's
  // `prev` is sha256 of the previous raw line, and `seq` increments from 1.
  if (existsSync(manifestPath)) {
    let lines;
    try {
      lines = readFileSync(manifestPath, 'utf8').split('\n').filter((line) => line.trim());
    } catch (error) {
      return { ...check, ok: false, code: 'MANIFEST_UNREADABLE', message: `cannot read the evidence ledger: ${error.message}` };
    }
    const rootResult = walkChainForStoreHash(lines, key, 'manifest ledger');
    if (!rootResult.ok) return { ...check, ok: false, code: rootResult.code, reason: rootResult.reason };
    if (rootResult.boundStoreHash !== null) boundStoreHash = rootResult.boundStoreHash;
  }

  // T-MANIFEST-FOREST: once segmented, THIS branch's evidence-required
  // transactions land in its own open segment, not root (root is frozen or
  // was never used at all in a greenfield repo). Scoped deliberately to just
  // the ONE segment this checkout's lineage token resolves to — not "the
  // whole forest" — because there is no total order across independent
  // segments to pick a single "latest" from (the same reason
  // carryForwardCrossModelReview and ticket-sync's outcomes reducer stay
  // scoped rather than guessing); root-then-this-branch's-segment IS a well
  // defined order, since the segment can only exist anchored after root's
  // state at mint time.
  const dir = join(root, '.adlc');
  if (isSegmentedRepo(dir)) {
    // recoverOpenSegment (never mints), NOT resolveOpenSegment — this is a
    // read-only doctor check with no writer lock held; resolveOpenSegment's
    // minting branch writes the .lineage token as a side effect, which could
    // race a genuine writer that already minted its own token but has not yet
    // created the segment file, splitting that writer's evidence across two
    // segments (adversarial-review finding).
    //
    // recoverOpenSegment (T-MANIFEST-FOREST, fourth round — supersedes the
    // round-3 strict-only reasoning): finds this branch's segment even when
    // the local `.lineage` token is lost (fresh clone, or a branch switch
    // that overwrote it), so doctor no longer reports a stale "not bound"
    // when a real, committed checkpoint exists. Safe now because
    // recoverOpenSegment matches on the EXACT `branch` field every segment's
    // first entry carries (spec §4.4) — non-lossy, and part of the signed
    // content once a key is configured — not the old lossy filename slug
    // that could report a FOREIGN lineage's checkpoint as this branch's own;
    // see recoverOpenSegment's own doc. walkChainForStoreHash below still
    // independently verifies every signature in the recovered segment before
    // trusting its storeHash, so an unsigned/forged recovered segment cannot
    // report a false "authenticated" binding regardless.
    //
    // A genuinely ambiguous recovery (two committed segments both declaring
    // this branch) is reported as a real check failure, not silently ignored.
    let resolved;
    try {
      resolved = recoverOpenSegment(dir, { cwd: root });
    } catch (error) {
      return { ...check, ok: false, code: 'SEGMENT_AMBIGUOUS', message: error.message };
    }
    if (resolved) {
      const segFile = segmentPath(dir, resolved.name);
      let segLines;
      try {
        segLines = existsSync(segFile) ? readFileSync(segFile, 'utf8').split('\n').filter((line) => line.trim()) : [];
      } catch (error) {
        return { ...check, ok: false, code: 'MANIFEST_UNREADABLE', message: `cannot read segment ${resolved.name}: ${error.message}` };
      }
      const segResult = walkChainForStoreHash(segLines, key, `segment ${resolved.name}`);
      if (!segResult.ok) return { ...check, ok: false, code: segResult.code, reason: segResult.reason };
      if (segResult.boundStoreHash !== null) boundStoreHash = segResult.boundStoreHash;
    }
    // resolved === null means this branch genuinely has no committed segment
    // (yet, or ever) — root's own boundStoreHash (if any) still stands as the
    // latest known checkpoint for this checkout.
  }

  if (!boundStoreHash) return { ...check, bound: false, reason: 'no evidence-required transaction recorded yet' };

  check.bound = true;
  check.storeHash = snapshot.hash;
  check.boundStoreHash = boundStoreHash;
  // Be honest about the STRENGTH of the binding, not just that one exists. With a key, every
  // entry's signature was verified above, so the final checkpoint cannot be edited in place
  // undetected. WITHOUT a key only the backward hash chain was checked — and nothing links
  // forward from the FINAL entry, so an editor can change a ticket shard, recompute the
  // (public) store hash, and rewrite that entry's data.storeHash: the chain still validates,
  // no drift shows, and this check would otherwise present a fully forgeable checkpoint as a
  // clean, bound one. Surface that limitation loudly (the emitted object is what the operator
  // and any CI consumer see) instead of implying an attestation we did not make.
  check.signaturesVerified = key !== null;
  check.authenticated = key !== null;
  if (key === null) {
    check.warning =
      'manifest checkpoint is NOT cryptographically authenticated: ADLC_MANIFEST_KEY is not set, so only the backward hash chain was verified. The final checkpoint is therefore forgeable — a coordinated ticket-shard edit + recomputed final-entry storeHash would pass undetected (no signature to break, no drift to show). Set ADLC_MANIFEST_KEY to make the storeHash binding tamper-evident.';
  }

  // This check does NOT attribute drift to specific tickets or claim tampering.
  // The ticket model permits ordinary UNEVIDENCED create/update between checkpoints,
  // so a per-ticket "changed since its evidence" signal is unsound in both
  // directions: false positives (an evidenced ticket later edited legitimately) and
  // false negatives (a never-evidenced ticket hand-edited). Sound out-of-band tamper
  // detection needs a store hash recorded on EVERY transaction — tracked as a
  // follow-up. Here we report an honest fact: is the store at its last evidenced
  // checkpoint, or has it drifted (unverified) since?
  if (snapshot.hash !== boundStoreHash) {
    check.drift = true;
    check.message =
      'live storeHash differs from the last evidenced checkpoint — unevidenced change(s) since. This check does not verify those (git history is the record for those shards); reported, not failed';
  }
  return check;
}

export function doctorTicketStore(store, { root = '.', archive = false, key: keyParam = null } = {}) {
  const checks = [];
  let snapshot = null;
  try {
    snapshot = store.load();
    checks.push({ name: 'active-store', ok: true, backend: snapshot.backend, ticketCount: snapshot.tickets.length, storeHash: snapshot.hash });
  } catch (error) {
    checks.push({ name: 'active-store', ok: false, code: error.code ?? 'UNEXPECTED', message: error.message });
  }
  const transactions = pendingTransactions(root);
  checks.push({ name: 'transactions', ok: transactions.length === 0, pending: transactions });
  const lockPath = join(root, LOCK_DIRECTORY);
  checks.push({ name: 'writer-lock', ok: !existsSync(lockPath), present: existsSync(lockPath), metadata: readTicketLock(root) });
  checks.push(currentTicketCheck(root, snapshot));
  checks.push(storeHashBindingCheck(root, snapshot, validateKeyParam(keyParam)));
  if (archive) {
    const path = join(root, ARCHIVE_DIRECTORY);
    if (!existsSync(path)) checks.push({ name: 'archive', ok: true, present: false, ticketCount: 0 });
    else {
      try {
        const archived = new DirectoryTicketStore(path, { archive: true }).load();
        const collisions = snapshot ? archived.tickets.filter((ticket) => snapshot.get(ticket.id)).map((ticket) => ticket.id) : [];
        checks.push({ name: 'archive', ok: collisions.length === 0, present: true, ticketCount: archived.tickets.length, collisions });
      } catch (error) { checks.push({ name: 'archive', ok: false, code: error.code ?? 'UNEXPECTED', message: error.message }); }
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
