/**
 * Authorize exactly one successor for an open deny.
 *
 * The ordering is the whole point, so it lives in one place rather than inside
 * a CLI branch: mint the signed auth, make the evidence durable, re-check that
 * the marker is still the one we preflighted on, and only then flip it. Every
 * failure removes the auth this run minted, so nothing half-authorized ever
 * outlives the run that created it.
 *
 * The marker re-check after the evidence append is not paranoia about our own
 * processes — the session lock already covers those. It covers a writer that
 * never took the lock (a hand-edited marker, an older CLI, a restored backup)
 * landing in the window while the manifest was being written. Without it, this
 * run would clobber that writer's record with a `consumed` built from a marker
 * that no longer exists.
 */

import { existsSync } from 'node:fs';
import { consumeDenyRecord } from './deny-lifecycle.mjs';
import { markerUnchanged, writeDenyRecord } from './deny-persist.mjs';
import { removeResumeAuth, writeResumeAuth } from './resume-auth.mjs';
import { resumeAuthPath } from './paths.mjs';

/**
 * @param {object} opts
 * @param {string} opts.root repo root
 * @param {string} opts.denySessionId the denied session
 * @param {string} opts.successorId the session being authorized
 * @param {string} opts.ticketId
 * @param {string} opts.contentHash the capture hash the auth binds to
 * @param {string} opts.key manifest signing key
 * @param {object} opts.expected the deny record the caller preflighted on
 * @param {() => object} opts.recordEvidence appends durable evidence; throwing
 *        means the run is unauditable and everything here is rolled back
 *
 * `ownedAuth` says whether THIS invocation minted the successor's resume-auth.
 * A caller's rollback must not delete an authorization it never issued — the
 * collision refusal below is precisely the case where one already exists and
 * belongs to somebody else.
 *
 * @returns {{ ok: true, record: object, resumeAuth: object, evidence: object, ownedAuth: true }
 *          | { ok: false, error: string, exitCode?: number, ownedAuth: boolean }}
 */
export function authorizeSuccessor({
  root,
  denySessionId,
  successorId,
  ticketId,
  contentHash,
  key,
  expected,
  recordEvidence,
}) {
  // A successor that already holds an authorization is not a fresh session. Two
  // reasons to refuse rather than overwrite: the existing auth belongs to a
  // continuation this run knows nothing about, and a rollback here would delete
  // it — destroying an authorization this run never issued.
  if (existsSync(resumeAuthPath(root, successorId))) {
    return {
      ok: false,
      error: `successor session ${successorId} already holds a resume-auth — successor ids must be fresh`,
      exitCode: 2,
      ownedAuth: false,
    };
  }

  const authWrote = writeResumeAuth(
    root,
    successorId,
    { ticketId, contentHash, denySessionId },
    { key },
  );
  if (!authWrote.ok) {
    return { ok: false, error: `failed to write resume-auth: ${authWrote.error}`, ownedAuth: false };
  }
  const rollback = () => removeResumeAuth(root, successorId);

  // Authorize with the document that was actually signed and read back, not
  // with a hand-built verified:true.
  const resumeAuth = authWrote.resumeAuth;
  if (!resumeAuth?.verified) {
    rollback();
    return { ok: false, error: 'resume-auth failed HMAC verification after write', ownedAuth: true };
  }

  const consumed = consumeDenyRecord(expected, successorId, { resumeAuth });
  if (!consumed.ok) {
    rollback();
    return { ok: false, error: consumed.error, exitCode: consumed.exitCode, ownedAuth: true };
  }

  let evidence;
  try {
    evidence = recordEvidence();
  } catch (err) {
    rollback();
    return { ok: false, error: `failed to record evidence: ${err.message}`, ownedAuth: true };
  }

  const stillOurs = markerUnchanged(root, denySessionId, expected);
  if (!stillOurs.ok) {
    rollback();
    return { ok: false, error: stillOurs.error, exitCode: stillOurs.exitCode, ownedAuth: true };
  }

  const persisted = writeDenyRecord(root, consumed.record);
  if (!persisted.ok) {
    rollback();
    return { ok: false, error: `failed to persist consumed deny: ${persisted.error}`, ownedAuth: true };
  }

  return { ok: true, record: persisted.record, resumeAuth, evidence, ownedAuth: true };
}
