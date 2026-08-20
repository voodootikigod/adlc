/**
 * Final checkpoint + deny rebind, as one undoable step.
 *
 * `write` and `continue` both have to leave the final and the marker agreeing
 * on the same binds, and both have to be able to put them back when the
 * evidence append fails afterwards. Two copies of that ordering is two chances
 * for one of them to leave a bind nothing attests to, so it lives here once.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { ensureDenyMarker, readDenyMarker, denyPath } from './deny-marker.mjs';
import { writeDenyRecord, repairDenyBinds, markerUnchanged } from './deny-persist.mjs';
import { readFinal, writeFinal } from './final.mjs';
import { finalPath } from './paths.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';
import { currentBytes, restoreIfOurs } from './rollback.mjs';

/**
 * Put a final back the way we found it. Evidence is what makes a mutation
 * legible, so a final whose evidence never landed is state nobody can audit.
 * @param {{ ok: boolean, final?: object }} prior — readFinal() from before the write
 */
export function restoreFinal(root, sessionId, prior) {
  const path = finalPath(root, sessionId);
  try {
    if (prior?.ok) writeJsonAtomic(path, prior.final);
    else if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort: the operator already sees the evidence failure
  }
}

/**
 * Point an open deny at the binds of the final we just wrote. `ensureDenyMarker`
 * is idempotent by contract and never rebinds, so a refresh without this leaves
 * the marker on the previous hash and every later resume is refused.
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function rebindOpenDeny(root, sessionId, record, planned) {
  if (planned.ticket_id != null) {
    return repairDenyBinds(root, sessionId, {
      ticketId: planned.ticket_id,
      contentHash: planned.content_hash,
      contentKind: planned.content_kind ?? null,
      host: planned.host,
    });
  }
  // Still-unbound refresh: repairDenyBinds demands both binds, and an unbound
  // deny is the stricter state (only an unbound bypass clears it), so persist
  // the marker directly rather than refusing a legitimate no-ticket refresh.
  const next = {
    ...record,
    ticket_id: null,
    content_hash: planned.content_hash,
    host: planned.host,
    status: 'open',
  };
  // Same rule as repair: the kind describes the hash, so it never outlives it.
  if (planned.content_kind) next.content_kind = planned.content_kind;
  else delete next.content_kind;
  return writeDenyRecord(root, next);
}

/**
 * Write the final FIRST, then ensure + rebind the marker, so a failed final can
 * never leave a rebound (or freshly created) deny with no checkpoint behind it.
 *
 * A failure restores the final before returning: the caller's own rollback only
 * has to cover what it did after this step.
 *
 * `expected` makes the rebind a compare-and-swap. The caller claimed a record
 * before it started writing, and the rebind happens several I/O steps later; a
 * writer that never took the lock can land in between, and rebinding onto
 * whatever is on disk would silently overwrite it. When the claim no longer
 * matches, this aborts with exitCode 2 and writes no marker at all.
 *
 * @param {object} planned — a `buildFinal()` result
 * @param {{ expected?: object|null }} [opts] — the record the caller claimed
 * @returns {{ ok: true, final: object, denyReason: string, rebound: boolean,
 *            priorFinal: object, priorRecord: object|null }
 *          | { ok: false, error: string, exitCode?: number }}
 */
export function writeCheckpoint(root, sessionId, planned, { expected = null } = {}) {
  const priorFinal = readFinal(root, sessionId);
  // Bytes, not parsed values: a rollback has to prove the file still holds what
  // THIS run put there before it puts anything back.
  const priorFinalBytes = currentBytes(finalPath(root, sessionId));
  const priorRecordBytes = currentBytes(denyPath(root, sessionId));
  const written = writeFinal(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    contentKind: planned.content_kind ?? null,
    host: planned.host,
  });
  if (!written.ok) return { ok: false, error: `failed to write final: ${written.error}` };
  // What THIS run left at the final path — carried from the write itself, not
  // sampled from disk afterwards: a replacement landing in a post-write sample
  // window would be adopted as "ours" and a later undo would destroy it. Every
  // internal failure below undoes the write, and each undo has to prove the
  // bytes are still ours: the branch that fires BECAUSE a concurrent writer was
  // detected must not then overwrite that writer's final on the way out.
  const wroteFinalBytes = written.bytes;
  const undoFinal = () =>
    restoreIfOurs({
      path: finalPath(root, sessionId),
      wroteBytes: wroteFinalBytes,
      priorBytes: priorFinalBytes,
      label: 'final',
    });

  const deny = ensureDenyMarker(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    host: planned.host,
  });
  if (!deny.ok) {
    undoFinal();
    return { ok: false, error: `failed to ensure deny marker: ${deny.reason}` };
  }

  // Rebind whatever ensure left in place, so final and marker agree.
  const marker = readDenyMarker(root, sessionId);
  if (!marker.ok) {
    undoFinal();
    return { ok: false, error: `deny marker unreadable after ensure: ${marker.reason}` };
  }
  const stale =
    marker.record.ticket_id !== planned.ticket_id ||
    marker.record.content_hash !== planned.content_hash ||
    (marker.record.content_kind ?? null) !== (planned.content_kind ?? null);
  let priorRecord = null;
  let wroteRecordBytes = null;
  if (stale) {
    if (expected) {
      // Compare-and-swap: the claim was taken before the final was written.
      const unchanged = markerUnchanged(root, sessionId, expected);
      if (!unchanged.ok) {
        undoFinal();
        return { ok: false, error: unchanged.error, exitCode: unchanged.exitCode };
      }
    }
    const rebound = rebindOpenDeny(root, sessionId, marker.record, planned);
    if (!rebound.ok) {
      undoFinal();
      return { ok: false, error: `failed to rebind deny marker: ${rebound.error}` };
    }
    priorRecord = marker.record;
    // Ownership carried from the rebind's own write, same as the final above.
    wroteRecordBytes = rebound.bytes ?? null;
  }

  return {
    ok: true,
    final: written.final,
    denyReason: deny.reason,
    rebound: stale,
    priorFinal,
    priorRecord,
    sessionId,
    priorFinalBytes,
    priorRecordBytes,
    // The rebind does not touch the final, so what we wrote above is still
    // there — no second read.
    wroteFinalBytes,
    wroteRecordBytes,
  };
}

/**
 * Undo a `writeCheckpoint`, artifact by artifact, and only where this run's
 * bytes are still the ones on disk. A marker created fresh by this run stays —
 * the sentinel already names the session, so deleting it would trade an open
 * deny for an unclearable D3.
 *
 * @param {object} checkpoint a `writeCheckpoint` result
 * @returns {{ restored: boolean, conflict: boolean, label: string }[]}
 */
export function rollbackCheckpoint(root, sessionId, checkpoint) {
  if (!checkpoint) return [];
  const results = [
    restoreIfOurs({
      path: finalPath(root, sessionId),
      wroteBytes: checkpoint.wroteFinalBytes ?? null,
      priorBytes: checkpoint.priorFinalBytes ?? null,
      label: 'final',
    }),
  ];
  // Only a rebind moved the marker; a run that left it alone has nothing to put
  // back and must not write one.
  if (checkpoint.priorRecord) {
    results.push(
      restoreIfOurs({
        path: denyPath(root, sessionId),
        wroteBytes: checkpoint.wroteRecordBytes ?? null,
        priorBytes: checkpoint.priorRecordBytes ?? null,
        label: 'deny marker',
      }),
    );
  }
  return results;
}
