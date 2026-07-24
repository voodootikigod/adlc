// GENERATED FILE — DO NOT EDIT DIRECTLY. Run `node scripts/ticket-readers/generate.mjs` after edits.
// Node built-ins only: installed hooks cannot assume a node_modules tree.
//
// The active-ticket pointer contract. This module is the ONE definition of how
// `.adlc/current-ticket.json` is read, and it is copied verbatim into every
// harness by the generator (spec §14) so no harness hand-rolls its own resolver
// again. `packages/tickets/test/pointer.test.mjs` runs every copy over one
// shared vector table and fails if any of them disagree.
//
// It returns a discriminated result rather than throwing: hooks want to branch,
// and staying free of the domain's error classes is what lets this file be
// generated into a harness that cannot resolve @adlc/tickets. `provenance.mjs`
// adapts these results back into TicketStoreError for the domain API.
//
// FAIL-CLOSED CONTRACT. If the file exists and parses to an object, the outcome
// is resolve or deny — never "no active ticket". Treating a shape we do not
// understand as "no pointer" is a fail-OPEN hole in a trust root: it silently
// disables enforcement. Deactivation is deleting the file, not writing `{}`.

import { existsSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

export const CURRENT_TICKET_FILE = '.adlc/current-ticket.json';

// The pointer is a tiny JSON object ({"id":…,"ticketHash":…}); cap the read far
// above any legitimate pointer so a hostile giant file can never be slurped whole.
const MAX_POINTER_BYTES = 64 * 1024;

// Read up to MAX_POINTER_BYTES of a REGULAR file without blocking. The pointer
// root can be untrusted (issue #341: a harness may resolve it from an event
// payload), so open O_NONBLOCK — a FIFO/device then never blocks the reader —
// verify the type on the OPEN fd (a path swap after the check cannot matter; the
// fd is bound to the inode), and read a bounded amount. Returns the text, or null
// for a non-regular file or any error; the caller fails CLOSED on null.
function readPointerFileBounded(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null; // FIFO / directory / device → refuse
    const length = Math.min(stat.size, MAX_POINTER_BYTES);
    const buf = Buffer.allocUnsafe(length);
    // Loop: POSIX read(2) may return fewer bytes than requested (network/FUSE
    // rsize caps), so a single readSync could truncate a larger pointer.
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, read);
      if (n === 0) break; // end of file
      read += n;
    }
    return buf.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    // Best-effort: a throwing close (e.g. EIO on a network/FUSE mount) must not
    // escape and break this reader's never-throw contract.
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** The canonical id key. A pointer we write always uses this one. */
export const CANONICAL_ID_KEY = 'id';

/**
 * Accepted-but-deprecated id keys, in precedence order after `id`.
 *
 * These exist because the pointer schema went undocumented: every integration
 * doc offered the file as an option without ever showing its shape, so hand-authored
 * pointers guessed. `ticketId` in particular was copied from the gate-manifest's
 * evidence field name. Readers accept them so no existing pointer bricks; writers
 * never emit them; doctor reports them; 2.0 removes them.
 */
export const DEPRECATED_ID_KEYS = Object.freeze(['ticket', 'ticketId']);

const ok = (value) => ({ ok: true, value });
const fail = (kind, code, message) => ({ ok: false, kind, code, message });
const invalid = (code, message) => fail('invalid', code, message);
const conflict = (code, message) => fail('conflict', code, message);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

function conflictMessage(envId, fileId) {
  return (
    `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE} ("${fileId}"): they name different tickets. ` +
    `The active ticket is per-worktree state — ADLC supports exactly one active ticket per worktree, ` +
    `and parallel work on a second ticket needs its own worktree ` +
    `(git worktree add <path> -b <branch>), not a second pointer in this one. ` +
    `Failing closed: which ticket governs this build cannot be determined.`
  );
}

/**
 * Parse `.adlc/current-ticket.json`.
 *
 * @returns {{ok: true, value: {present: boolean, id?: string, ticketHash?: string|null,
 *            legacyString?: boolean, deprecatedAlias?: string}}
 *          | {ok: false, kind: string, code: string, message: string}}
 */
export function readActiveTicketPointer(root = '.') {
  const path = join(root, CURRENT_TICKET_FILE);
  if (!existsSync(path)) return ok({ present: false });

  const raw = readPointerFileBounded(path);
  if (raw === null) {
    return fail('operational', 'INVALID_CURRENT_TICKET', `cannot read ${CURRENT_TICKET_FILE} as a bounded regular file`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid('INVALID_CURRENT_TICKET', `cannot parse ${CURRENT_TICKET_FILE}: ${error.message}`);
  }

  // Legacy bare-string pointer ("T1"). Carries no hash, so it is bridge-only.
  if (typeof parsed === 'string') {
    const id = parsed.trim();
    if (!id) return invalid('INVALID_CURRENT_TICKET', `${CURRENT_TICKET_FILE} is an empty string pointer`);
    return ok({ present: true, id, ticketHash: null, legacyString: true });
  }

  if (!isPlainObject(parsed)) {
    return invalid(
      'INVALID_CURRENT_TICKET',
      `${CURRENT_TICKET_FILE} must be an object like {"id":"T1","ticketHash":"<64 hex>"} ` +
        `(got ${Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)}). To deactivate, delete the file.`,
    );
  }

  let usedKey = null;
  for (const key of [CANONICAL_ID_KEY, ...DEPRECATED_ID_KEYS]) {
    if (Object.hasOwn(parsed, key)) {
      usedKey = key;
      break;
    }
  }

  // The fail-open hole, closed: an object with no id key we recognize is
  // malformed, NOT "no active ticket".
  if (usedKey === null) {
    const found = Object.keys(parsed);
    return invalid(
      'INVALID_CURRENT_TICKET',
      `${CURRENT_TICKET_FILE} declares no ticket id: expected "${CANONICAL_ID_KEY}" ` +
        `(or deprecated ${DEPRECATED_ID_KEYS.map((k) => `"${k}"`).join('/')}), ` +
        `found ${found.length ? found.map((k) => `"${k}"`).join(', ') : 'no keys'}. ` +
        `Failing closed rather than treating an unrecognized pointer as "no active ticket". ` +
        `To deactivate, delete the file.`,
    );
  }

  const id = trimmed(parsed[usedKey]);
  if (!id) {
    return invalid(
      'INVALID_CURRENT_TICKET',
      `${CURRENT_TICKET_FILE} has a "${usedKey}" that is not a non-empty string`,
    );
  }

  const value = { present: true, id, ticketHash: trimmed(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY) value.deprecatedAlias = usedKey;
  return ok(value);
}

/**
 * Resolve which ticket id is active from ADLC_TICKET + the pointer file, without
 * consulting a ticket store. `value === null` means inert: no active ticket, which
 * is the ONLY allow-with-no-ticket outcome and requires no pointer file.
 */
export function resolveActiveTicketId({ root = '.', env = process.env } = {}) {
  const pointer = readActiveTicketPointer(root);
  if (!pointer.ok) return pointer; // a malformed pointer denies even if env names a ticket

  const envId = trimmed(env.ADLC_TICKET) || null;
  const file = pointer.value;
  const fileId = file.present ? file.id : null;

  if (envId && fileId && envId !== fileId) return conflict('ACTIVE_TICKET_CONFLICT', conflictMessage(envId, fileId));

  const id = envId ?? fileId;
  if (!id) return ok(null);

  return ok({
    id,
    pointerPresent: file.present,
    ticketHash: file.present ? file.ticketHash : null,
    legacyString: file.present ? Boolean(file.legacyString) : false,
    ...(file.deprecatedAlias ? { deprecatedAlias: file.deprecatedAlias } : {}),
  });
}

/**
 * Resolve the active ticket against a loaded snapshot, verifying the pinned hash.
 *
 * @param {object} snapshot - anything with get(id) and ticketHashes
 * @param {object} [options]
 * @param {boolean} [options.allowLegacyPointer=false] - the documented 1.x bridge.
 *   Strict (the default, used by @adlc/tickets) denies a pointer that pins no
 *   ticketHash. The bridge downgrades that to a warning, because the schema was
 *   never documented and hash-less pointers are the expected state in the wild.
 *   A ticketHash that IS present is always verified — the bridge never skips it.
 */
export function resolveActiveTicketAgainst(snapshot, { root = '.', env = process.env, allowLegacyPointer = false } = {}) {
  const resolved = resolveActiveTicketId({ root, env });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);

  const { id, pointerPresent, ticketHash, legacyString, deprecatedAlias } = resolved.value;
  const ticket = snapshot.get(id);
  if (!ticket) {
    return invalid('ACTIVE_TICKET_MISSING', `active ticket "${id}" is not in the ticket store`);
  }

  const expected = snapshot.ticketHashes[id];
  const warnings = [];

  if (deprecatedAlias) {
    warnings.push(
      `${CURRENT_TICKET_FILE} uses the deprecated "${deprecatedAlias}" key; ` +
        `rewrite it as {"id":"${id}","ticketHash":"${expected}"} ("${deprecatedAlias}" is removed in 2.0).`,
    );
  }

  // Only a pointer file pins a hash. Env-only selection has nothing to verify.
  if (pointerPresent) {
    if (!ticketHash) {
      const detail = legacyString ? 'a legacy bare-string pointer pins no ticketHash' : `${CURRENT_TICKET_FILE} pins no ticketHash`;
      if (!allowLegacyPointer) {
        return invalid(
          'ACTIVE_TICKET_HASH_MISSING',
          `${detail}; it must pin ticketHash so a ticket changing after selection is detectable. ` +
            `Expected {"id":"${id}","ticketHash":"${expected}"}.`,
        );
      }
      warnings.push(`${detail}; a ticket changing after selection cannot be detected. Expected ticketHash "${expected}". Strict in 2.0.`);
    } else if (ticketHash !== expected) {
      return conflict(
        'ACTIVE_TICKET_STALE',
        `active ticket "${id}" changed after selection (pointer pins ${ticketHash}, store has ${expected}). ` +
          `Re-select the ticket to confirm you intend to build against the new contract.`,
      );
    }
  }

  return ok({
    id,
    ticket,
    ticketHash: expected,
    storeHash: snapshot.hash,
    warnings,
    ...(deprecatedAlias ? { deprecatedAlias } : {}),
  });
}
