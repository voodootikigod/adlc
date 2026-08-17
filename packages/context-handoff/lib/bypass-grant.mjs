/**
 * Bypass-grant cache: `.adlc/handoffs/<session_id>.bypass-grant.json`
 *
 * Signed with HMAC-SHA256 under ADLC_MANIFEST_KEY over canonical JSON of the
 * bind fields, mirroring resume-auth.mjs's cache/signature pattern. Written by
 * `handoff bypass --write` (bin/handoff.mjs), read and CONSUMED (deleted) by
 * the adapter the first time it authorizes a mutation — see
 * evaluateHandoffPreToolUse in adapter.mjs. Unverifiable ≡ absent, same as
 * resume-auth. A grant older than BYPASS_GRANT_TTL_MS is also treated as
 * absent, a defense-in-depth ceiling for the case consumption itself fails
 * (see thresholds.mjs's BYPASS_GRANT_TTL_MS comment for the full rationale).
 *
 * Hook hosts (Claude Code, Codex) resolve this package from the PROJECT's
 * node_modules and therefore never pass the manifest key into it. They verify
 * a grant with their own trusted twin of `readBypassGrant` (pre-secret-scrub,
 * before this package is even imported) and hand the adapter only the verdict
 * via `evaluateHandoffPreToolUse`'s `verifiedBypassGrant` option. Those twins
 * are pinned against this file by cc-helper-drift.test.mjs /
 * codex-helper-drift.test.mjs — keep them in sync when editing here.
 *
 * Honest scope of "one-shot" (Round-15 review, disclosed not silently
 * accepted — same posture as spec §1.3's other residuals): `removeBypassGrant`
 * guarantees exactly one WINNER per directory-entry incarnation, not
 * cryptographic single-use. The signed payload carries no per-issuance nonce
 * and this file keeps no consumed-grant ledger (Phase 0 has none — spec
 * §1.3), so a process that captured the exact signed bytes before consumption
 * could, in principle, recreate the file and have it re-verify for the
 * remainder of BYPASS_GRANT_TTL_MS. In practice this requires first defeating
 * `isProtectedHandoffPath`'s denial of ordinary Edit/Write/Bash writes to
 * this exact path — itself already a disclosed, best-effort defense (see
 * adapter.mjs's `path_protected_shell` comment: "cannot see through
 * variables, expansion, or an interpreter one-liner"), not a hole this file
 * introduces on its own. Closing this fully needs the same host-owned,
 * non-tool-writable integrity anchor Phase 1 target-hardens for the recovery
 * script itself (spec §1.3) — out of Phase 0's reach for the same reason.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { unlinkSync, openSync, fstatSync, closeSync, readFileSync, constants } from 'node:fs';
import { canonicalJson } from '@adlc/core';
import { bypassGrantPath } from './paths.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';
import { BYPASS_GRANT_TTL_MS, MAX_BYPASS_GRANT_BYTES } from './thresholds.mjs';

export const BYPASS_GRANT_SCHEMA = 2;

/**
 * `written_at` is INSIDE the signed payload (schema 2). Schema 1 signed only
 * {schema, session_id, unbound_reason}, leaving the one field the TTL check
 * reads editable by anyone with filesystem write access — a validly-signed
 * grant could be kept alive forever by nudging its unsigned timestamp
 * forward. Signing it makes the TTL tamper-evident; a schema-1 document can
 * no longer verify (its sig covers a different payload) and reads as absent.
 */
function payloadBytes({ session_id, unbound_reason, written_at }) {
  return canonicalJson({ schema: BYPASS_GRANT_SCHEMA, session_id, unbound_reason, written_at });
}

/**
 * @param {string} key
 * @param {object} fields
 * @returns {string} hex HMAC
 */
export function signBypassGrant(key, fields) {
  return createHmac('sha256', key).update(payloadBytes(fields)).digest('hex');
}

/**
 * @param {string} key
 * @param {object} doc
 * @returns {boolean}
 */
export function verifyBypassGrantSig(key, doc) {
  if (!doc || typeof doc.sig !== 'string' || doc.sig.length === 0) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  const expected = signBypassGrant(key, doc);
  const a = Buffer.from(doc.sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build a signed bypass-grant document for the session cache.
 */
export function buildBypassGrantDoc({ sessionId, unboundReason = null, key, now = () => new Date().toISOString() }) {
  const fields = {
    session_id: sessionId,
    unbound_reason: typeof unboundReason === 'string' && unboundReason.trim().length > 0 ? unboundReason : null,
    written_at: now(),
  };
  return {
    schema: BYPASS_GRANT_SCHEMA,
    ...fields,
    sig: signBypassGrant(key, fields),
  };
}

/**
 * Read the bypass grant for a session. Unverifiable, session-mismatched, or
 * past BYPASS_GRANT_TTL_MS since written_at ⇒ treated as absent (null).
 * @returns {{ session_id: string, unbound_reason: string|null, written_at: string, verified: boolean } | null}
 */
export function readBypassGrant(
  root,
  sessionId,
  { key = null, now = () => Date.now(), open = openSync, fstat = fstatSync, close = closeSync, readFile = readFileSync } = {},
) {
  const path = bypassGrantPath(root, sessionId);
  // Round-17 review: a separate lstat-then-readFileSync(path) had a TOCTOU —
  // a concurrent writer could swap the checked regular file for a FIFO or
  // oversized file between the two path-based operations. Opening ONCE
  // (O_NOFOLLOW so a symlink at this exact path throws ELOOP rather than
  // being followed; O_NONBLOCK so a FIFO/device swapped in can't hang this
  // OPEN either) and doing every subsequent check/read against that SAME fd
  // closes the window entirely — nothing after the open can be swapped out
  // from under it.
  let fd;
  try {
    fd = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null; // missing, permission denied, or a symlink (ELOOP) — all read as absent
  }
  let doc;
  try {
    const stat = fstat(fd);
    if (!stat.isFile() || stat.size > MAX_BYPASS_GRANT_BYTES) return null;
    const raw = readFile(fd, 'utf8');
    doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  } catch {
    return null;
  } finally {
    try {
      close(fd);
    } catch {
      // best-effort
    }
  }
  // A schema other than the current one can never verify (the sig covers the
  // schema number), so reject it outright — a schema-1 residual reads as absent.
  if (doc.schema !== BYPASS_GRANT_SCHEMA) return null;
  const session_id = doc.session_id;
  const unbound_reason = doc.unbound_reason ?? null;
  const written_at = doc.written_at;
  if (typeof session_id !== 'string' || session_id !== sessionId) return null;
  if (unbound_reason !== null && typeof unbound_reason !== 'string') return null;
  if (typeof written_at !== 'string') return null;
  const writtenMs = Date.parse(written_at);
  if (!Number.isFinite(writtenMs)) return null;
  if (now() - writtenMs > BYPASS_GRANT_TTL_MS) return null;
  const verified = key != null && verifyBypassGrantSig(key, doc) === true;
  return { session_id, unbound_reason, written_at, verified };
}

/**
 * Persist a signed bypass grant for the session.
 */
export function writeBypassGrant(root, sessionId, { unboundReason = null } = {}, { key, fs } = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, error: 'missing signing key' };
  }
  const doc = buildBypassGrantDoc({ sessionId, unboundReason, key });
  const path = bypassGrantPath(root, sessionId);
  // Round-16 review: writeJsonAtomic serializes as `JSON.stringify(doc, null,
  // 2) + '\n'` — matching that exactly here, not a compact stringify, so this
  // check agrees with what every reader's lstat.size will actually see.
  // unboundReason is operator-supplied free text with no length limit at the
  // CLI's own parseArgs layer; without this, a long --unbound-reason would
  // report `bypass --write` as successful (and audited) while persisting a
  // grant every reader's MAX_BYPASS_GRANT_BYTES cap silently rejects as
  // absent — recording success for a recovery that never took effect.
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  if (serializedBytes > MAX_BYPASS_GRANT_BYTES) {
    return { ok: false, error: `grant document (${serializedBytes} bytes) exceeds MAX_BYPASS_GRANT_BYTES (${MAX_BYPASS_GRANT_BYTES}) — no reader would ever accept it; shorten --unbound-reason` };
  }
  const wrote = writeJsonAtomic(path, doc, fs ? { fs } : {});
  if (!wrote.ok) return { ok: false, error: wrote.error };
  return { ok: true, path, doc };
}

/**
 * Atomic claim of a bypass grant — the ONE-SHOT consumption primitive under
 * concurrent hook processes (Phase 0 has no lock — spec §1.3). `unlinkSync`
 * on a single filesystem gives exactly one caller a successful removal; every
 * other caller racing the same path — or arriving after — gets ENOENT. The
 * adapter calls this to DECIDE whether THIS evaluation gets to use the
 * grant, not merely to tidy up after a decision already made: only a `true`
 * return means this call actually removed the file, i.e. won the claim.
 * Deliberately no `existsSync` pre-check — that would reintroduce the exact
 * TOCTOU window this function exists to close.
 * @returns {boolean} true only when THIS call performed the removal
 */
export function removeBypassGrant(root, sessionId, { fs = { unlinkSync } } = {}) {
  const path = bypassGrantPath(root, sessionId);
  try {
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
