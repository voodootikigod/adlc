/**
 * Capture store: `.adlc/handoffs/content/<session_id>.md`
 *
 * The narrative half of a handoff. Written ONLY by host-privileged code (CLI /
 * supervisor / hook host) — `isProtectedHandoffPath` keeps agent tools out of
 * the directory, because a session that can rewrite its own capture can rewrite
 * the content the successor's authorization is bound to.
 *
 * CANONICALIZATION (load-bearing — this is what `content_hash` covers):
 * line endings normalize to `\n` and trailing spaces/tabs are stripped per
 * line. Those two are the transformations an editor, a CRLF checkout, or a
 * formatter applies without changing what the capture SAYS; everything else —
 * a reordered line, an appended instruction, a deleted paragraph — moves the
 * hash and breaks the bind. Hashing the raw bytes instead would make the bind
 * fragile in exactly the cases where the content is unchanged.
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { contentPath } from './paths.mjs';
import { readTextFile, writeTextAtomic } from './atomic-json.mjs';
import { truncateUtf8 } from './text-cap.mjs';

/** Stored capture bodies are capped; a transcript is not a repository. */
export const MAX_CAPTURE_BYTES = 64 * 1024;

/** Appended when a body is clipped — truncation must be visible to a reader. */
export const CAPTURE_TRUNCATION_MARKER =
  '\n\n---\n_[adlc: capture truncated — the session narrative continues beyond this point]_\n';

/**
 * Canonical form of a capture body (see module header).
 * @param {string} body
 * @returns {string}
 */
export function canonicalizeCaptureBody(body) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/**
 * sha256 over the canonicalized body — the value a final / deny record /
 * resume-auth binds to when a capture exists.
 * @param {string} body
 * @returns {string} hex digest
 */
export function hashCaptureBody(body) {
  return createHash('sha256').update(canonicalizeCaptureBody(body), 'utf8').digest('hex');
}

/**
 * Cap a body for storage. Separate from the write so a caller can hash exactly
 * what will land on disk before deciding to write it.
 * @param {string} body
 * @returns {{ body: string, truncated: boolean }}
 */
export function capCaptureBody(body) {
  const capped = truncateUtf8(String(body ?? ''), {
    maxBytes: MAX_CAPTURE_BYTES,
    marker: CAPTURE_TRUNCATION_MARKER,
  });
  return { body: capped.text, truncated: capped.truncated };
}

/**
 * Persist a capture body atomically.
 * @returns {{ ok: true, path: string, body: string, hash: string, truncated: boolean }
 *          | { ok: false, error: string }}
 */
export function writeCapture(root, sessionId, body, opts = {}) {
  const path = contentPath(root, sessionId);
  const { body: stored, truncated } = capCaptureBody(body);
  const wrote = writeTextAtomic(path, stored, opts);
  if (!wrote.ok) return { ok: false, error: wrote.error };
  // `bytes` is the atomic writer's own token (see atomic-json.mjs) — rollback
  // ownership must come from here, never from a later disk read.
  return { ok: true, path, body: stored, bytes: wrote.bytes, hash: hashCaptureBody(stored), truncated };
}

/**
 * Read a stored capture body.
 *
 * A file larger than the write path can produce did not come from this store,
 * so it is refused rather than slurped: the reader is a host process holding
 * the manifest key, and `oversize` is a tamper signal, not a parse problem.
 * @returns {{ ok: true, path: string, body: string } | { ok: false, error: string }}
 */
export function readCapture(root, sessionId, { fs = { existsSync, statSync } } = {}) {
  const path = contentPath(root, sessionId);
  if (!fs.existsSync(path)) return { ok: false, error: 'missing' };
  try {
    if (fs.statSync(path).size > MAX_CAPTURE_BYTES) return { ok: false, error: 'oversize' };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || 'unreadable' };
  }
  const got = readTextFile(path);
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, path, body: got.text };
}

/**
 * Best-effort removal — used to roll back a capture this run created.
 * @returns {boolean} true when the capture is gone afterwards
 */
export function removeCapture(root, sessionId, { fs = { existsSync, unlinkSync } } = {}) {
  const path = contentPath(root, sessionId);
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a capture ONLY when it still hashes to the value it is bound to.
 *
 * This is the API every consumer must use — supervisors, the SessionStart
 * injector, anything that puts capture text in front of a model. A signature
 * over `content_hash` proves the hash was authorized; it says nothing about the
 * bytes on disk now, and re-deriving the hash is the only thing that does.
 * Every failure — absent, oversize, altered — is one refusal to hand back
 * content, never a body with a warning attached.
 *
 * @returns {{ ok: true, path: string, body: string, hash: string }
 *          | { ok: false, error: string, actual?: string }}
 */
export function readVerifiedCapture(root, sessionId, expectedHash) {
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
    return { ok: false, error: 'missing expected content_hash' };
  }
  const got = readCapture(root, sessionId);
  if (!got.ok) return { ok: false, error: got.error };
  const actual = hashCaptureBody(got.body);
  if (actual !== expectedHash) {
    return { ok: false, error: 'content_hash mismatch', actual };
  }
  return { ok: true, path: got.path, body: got.body, hash: actual };
}

/**
 * Verify without taking the body — for callers that only need the verdict.
 * @returns {{ ok: true, hash: string } | { ok: false, error: string, actual?: string }}
 */
export function verifyCaptureHash(root, sessionId, expectedHash) {
  const got = readVerifiedCapture(root, sessionId, expectedHash);
  return got.ok ? { ok: true, hash: got.hash } : got;
}

/**
 * Write a capture and prove the bytes that landed hash to what we will bind to.
 *
 * The verification lives INSIDE the write rather than at the call site on
 * purpose: a guard a caller can forget is a guard that is eventually forgotten,
 * and "wrote a capture without checking what landed" is not a state this store
 * should be able to express. It re-reads through the real filesystem, so an
 * injected writer cannot vouch for itself.
 *
 * @returns {{ ok: true, path: string, body: string, hash: string, truncated: boolean }
 *          | { ok: false, error: string }}
 */
export function writeVerifiedCapture(root, sessionId, body, opts = {}) {
  const wrote = writeCapture(root, sessionId, body, opts);
  if (!wrote.ok) return wrote;
  const verified = readVerifiedCapture(root, sessionId, wrote.hash);
  if (!verified.ok) {
    return {
      ok: false,
      error: `capture does not match its content_hash after write (${verified.error})`,
    };
  }
  return wrote;
}
