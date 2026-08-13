/**
 * Final checkpoint + deny rebind, as one undoable step.
 *
 * `write` and `continue` both have to leave the final and the marker agreeing
 * on the same binds, and both have to be able to put them back when the
 * evidence append fails afterwards. Two copies of that ordering is two chances
 * for one of them to leave a bind nothing attests to, so it lives here once.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { ensureDenyMarker, readDenyMarker } from './deny-marker.mjs';
import { writeDenyRecord, repairDenyBinds } from './deny-persist.mjs';
import { readFinal, writeFinal } from './final.mjs';
import { finalPath } from './paths.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

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
      host: planned.host,
    });
  }
  // Still-unbound refresh: repairDenyBinds demands both binds, and an unbound
  // deny is the stricter state (only an unbound bypass clears it), so persist
  // the marker directly rather than refusing a legitimate no-ticket refresh.
  return writeDenyRecord(root, {
    ...record,
    ticket_id: null,
    content_hash: planned.content_hash,
    host: planned.host,
    status: 'open',
  });
}

/**
 * Write the final FIRST, then ensure + rebind the marker, so a failed final can
 * never leave a rebound (or freshly created) deny with no checkpoint behind it.
 *
 * A failure restores the final before returning: the caller's own rollback only
 * has to cover what it did after this step.
 *
 * @param {object} planned — a `buildFinal()` result
 * @returns {{ ok: true, final: object, denyReason: string, rebound: boolean,
 *            priorFinal: object, priorRecord: object|null }
 *          | { ok: false, error: string }}
 */
export function writeCheckpoint(root, sessionId, planned) {
  const priorFinal = readFinal(root, sessionId);
  const written = writeFinal(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    host: planned.host,
  });
  if (!written.ok) return { ok: false, error: `failed to write final: ${written.error}` };

  const deny = ensureDenyMarker(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    host: planned.host,
  });
  if (!deny.ok) {
    restoreFinal(root, sessionId, priorFinal);
    return { ok: false, error: `failed to ensure deny marker: ${deny.reason}` };
  }

  // Rebind whatever ensure left in place, so final and marker agree.
  const marker = readDenyMarker(root, sessionId);
  if (!marker.ok) {
    restoreFinal(root, sessionId, priorFinal);
    return { ok: false, error: `deny marker unreadable after ensure: ${marker.reason}` };
  }
  const stale =
    marker.record.ticket_id !== planned.ticket_id ||
    marker.record.content_hash !== planned.content_hash;
  let priorRecord = null;
  if (stale) {
    const rebound = rebindOpenDeny(root, sessionId, marker.record, planned);
    if (!rebound.ok) {
      restoreFinal(root, sessionId, priorFinal);
      return { ok: false, error: `failed to rebind deny marker: ${rebound.error}` };
    }
    priorRecord = marker.record;
  }

  return {
    ok: true,
    final: written.final,
    denyReason: deny.reason,
    rebound: stale,
    priorFinal,
    priorRecord,
  };
}

/**
 * Undo a `writeCheckpoint`. A marker created fresh by this run stays — the
 * sentinel already names the session, so deleting it would trade an open deny
 * for an unclearable D3.
 * @param {{ priorFinal: object, priorRecord: object|null }} checkpoint
 */
export function rollbackCheckpoint(root, sessionId, checkpoint) {
  restoreFinal(root, sessionId, checkpoint?.priorFinal);
  if (checkpoint?.priorRecord) writeDenyRecord(root, checkpoint.priorRecord);
}
