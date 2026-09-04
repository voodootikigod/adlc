// Input grammar (spec §4 "Input grammar", AC 73) — normative BEFORE any
// filesystem, git or GitHub operation.
//
// Every value that arrives from outside the process — an issue number, an OID,
// a ticket id, a path component — is accepted only when it matches a closed
// grammar, and a branch name is NEVER taken from input: it is constructed from
// a validated number. A path is constructed by joining a validated root with
// validated components and then verified with `realpath` to still lie under
// that root. Anything else → exit 1 `bad-input:<field>` with no side effect.

import { realpathSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { active } from './mutations.mjs';

/** Mutation seam `input.acceptAnything`: every grammar accepts every value. */
const lenient = () => active('input.acceptAnything');

export class InputError extends Error {
  constructor(field, detail) {
    super(`bad-input:${field}${detail ? ` (${detail})` : ''}`);
    this.name = 'InputError';
    this.code = `bad-input:${field}`;
    this.field = field;
    this.exitCode = 1;
  }
}

const ISSUE_RE = /^[1-9][0-9]{0,9}$/;
const OID_SHA1_RE = /^[0-9a-f]{40}$/;
const OID_SHA256_RE = /^[0-9a-f]{64}$/;
// Crockford base32 ULID, upper-case only — a lower-case ULID is a different string
// and is refused, never case-folded (AC 73).
const TICKET_RE = /^T-[0-9A-HJKMNP-TV-Z]{26}$/;
// `--model` grammar (AC 64): a model alias/id can never carry a shell metacharacter.
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const BRANCH_PREFIX = 'adlc/autopilot/';

/** Accept an issue number as a string or integer; return the validated integer. */
export function validateIssueNumber(value, field = 'issue') {
  const s = typeof value === 'number' ? String(value) : value;
  if (lenient()) return Number(s) || 0;
  if (typeof s !== 'string' || !ISSUE_RE.test(s)) throw new InputError(field, 'expected a positive integer');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new InputError(field, 'exceeds Number.MAX_SAFE_INTEGER');
  return n;
}

/** Accept a full object id; `sha256` selects the 64-hex grammar of a SHA-256 repository. */
export function validateOid(value, { field = 'oid', sha256 = false } = {}) {
  if (lenient()) return value;
  if (typeof value !== 'string' || !(sha256 ? OID_SHA256_RE : OID_SHA1_RE).test(value)) {
    throw new InputError(field, `expected ${sha256 ? 64 : 40} lower-case hex characters`);
  }
  return value;
}

export function validateTicketId(value, field = 'ticket') {
  if (lenient()) return value;
  if (typeof value !== 'string' || !TICKET_RE.test(value)) throw new InputError(field, 'expected T-<26-char upper-case Crockford ULID>');
  return value;
}

export function validateModel(value, field = 'model') {
  if (lenient()) return value;
  if (typeof value !== 'string' || !MODEL_RE.test(value)) throw new InputError(field, 'expected [a-z0-9][a-z0-9.-]{0,63}');
  return value;
}

/** `owner/name` — the operator-local repository identity (§9.1a). */
export function validateRepoSpec(value, field = 'repo') {
  if (typeof value !== 'string' || !REPO_RE.test(value)) throw new InputError(field, 'expected owner/name');
  return value;
}

export function validateHost(value, field = 'host') {
  if (typeof value !== 'string' || value.length > 253 || !HOST_RE.test(value)) throw new InputError(field, 'expected a DNS host name');
  return value.toLowerCase();
}

/** The ONLY way a branch name comes into existence: constructed from a validated number. */
export function branchFor(issueNumber) {
  return `${BRANCH_PREFIX}issue-${validateIssueNumber(issueNumber)}`;
}

/** The token-named staging branch of §6.1. */
export function stagingBranchFor(token) {
  return `${BRANCH_PREFIX}staging-${validateToken(token)}`;
}

/** 32 random bytes as hex — the ownership token of §6.1 / lock token of §2.2. */
export function validateToken(value, field = 'token') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new InputError(field, 'expected 64 hex characters');
  return value;
}

/**
 * A single path component: no separators, no `.`/`..`, printable ASCII only.
 * Used for every filename the autopilot derives from an identifier.
 */
export function validateComponent(value, field = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) throw new InputError(field, 'empty or too long');
  if (value === '.' || value === '..' || /[\\/\0]/.test(value) || !/^[\x21-\x7e]+$/.test(value)) throw new InputError(field, 'illegal path component');
  return value;
}

/**
 * Join validated components under `root` and prove, with `realpath`, that the
 * result still lies under `root` (a symlinked component that escapes is refused).
 * When the target does not exist yet, the deepest EXISTING ancestor is what is
 * realpath'd — a not-yet-created leaf cannot escape by itself.
 */
export function underRoot(root, components, { field = 'path', realpath = realpathSync } = {}) {
  const rootReal = realpath(root);
  const parts = components.map((c) => validateComponent(c, field));
  const target = join(rootReal, ...parts);
  let probe = target;
  let real = null;
  for (;;) {
    try { real = realpath(probe); break; } catch { /* ascend */ }
    const parent = dirname(probe);
    if (parent === probe) throw new InputError(field, 'no existing ancestor');
    probe = parent;
  }
  // `real` is the realpath of the deepest existing ancestor; re-append the missing tail.
  const tail = target.slice(probe.length);
  const resolved = resolve(real + tail);
  if (!lenient() && resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new InputError(field, `escapes ${rootReal}`);
  }
  return resolved;
}

/** True iff `path` equals `root` or lies under it (string prefix over resolved paths). */
export function isUnder(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r + sep);
}
