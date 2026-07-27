// Structural comparisons the gate uses to say "this trusted value did not weaken" (#140).
//
// Both CI steps ask the same family of questions about .adlc/config.json — did a PR
// remove a revoked key, relax a bound, grant itself a signer role — and both used to
// answer them with their own near-copy of these helpers. One copy, one meaning.

import { fail } from './errors.mjs';

/**
 * A canonical string for a JSON value: object keys sorted at every depth, so two values
 * that differ only in key ORDER compare equal. Every "did this change" question in the
 * gate is asked through this, because raw JSON.stringify would report a reordered but
 * semantically identical ticket or signer entry as a contract change.
 */
export function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  }
  return JSON.stringify(value);
}

/**
 * A trusted array's entries must all survive at HEAD. Additions are fine; REMOVALS are
 * not — these arrays (revokedKeys, securitySensitivePatterns) only ever grow the
 * protected surface, so dropping an entry is always a weakening.
 *
 * A non-array trusted value means the base never declared it, so there is nothing to
 * preserve; that is the caller's "field absent" case, not an error.
 */
export function assertArraySuperset(name, trustedValue, headValue) {
  if (!Array.isArray(trustedValue)) return;
  if (!Array.isArray(headValue)) fail(`${name} must remain an array`);
  const headSet = new Set(headValue.map(stable));
  for (const item of trustedValue) {
    if (!headSet.has(stable(item))) fail(`${name} cannot remove trusted entry ${stable(item)}`);
  }
}

/** The role set of one signer entry, tolerating both the `role` and `roles` spellings. */
export function signerRoles(entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`signer ${key} must remain an object`);
  }
  return new Set((Array.isArray(entry.roles) ? entry.roles : [entry.role]).filter((role) => role !== undefined));
}

/**
 * An EXISTING signer is frozen: same fields, same values, same roles.
 *
 * Not "superset" — exact. A PR that could add a field to an existing signer could add a
 * second role spelling or a key override, so the only safe rule for an already-trusted
 * identity is that nothing about it moves. Changing one goes through the protected-base
 * admin ceremony.
 */
export function assertExistingSignersUnchanged(trustedSigners, headSigners) {
  if (!trustedSigners || typeof trustedSigners !== 'object' || Array.isArray(trustedSigners)) return;
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) fail('signers must remain an object');
  for (const key of Object.keys(trustedSigners)) {
    const trustedEntry = trustedSigners[key];
    const headEntry = headSigners[key];
    if (!headEntry || typeof headEntry !== 'object' || Array.isArray(headEntry)) {
      fail(`signers.${key} must remain an object`);
    }
    for (const field of Object.keys(trustedEntry)) {
      if (!Object.prototype.hasOwnProperty.call(headEntry, field)) {
        fail(`signers.${key}.${field} cannot remove trusted signer property`);
      }
      if (stable(headEntry[field]) !== stable(trustedEntry[field])) {
        fail(`signers.${key}.${field} cannot change trusted signer property`);
      }
    }
    for (const field of Object.keys(headEntry)) {
      if (!Object.prototype.hasOwnProperty.call(trustedEntry, field)) {
        fail(`signers.${key}.${field} is an undeclared signer property`);
      }
    }
    const trustedRoles = signerRoles(trustedEntry, key);
    const headRoles = signerRoles(headEntry, key);
    if (trustedRoles.size !== headRoles.size) fail(`existing signer ${key} roles cannot change`);
    for (const role of trustedRoles) {
      if (!headRoles.has(role)) fail(`existing signer ${key} roles cannot change`);
    }
  }
}

// A NEW signer introduced during first bootstrap may only be a builder or a critic.
// `approver` is what satisfies review requirements, so granting it is the one thing a
// self-served config change must never be able to do.
const BOOTSTRAP_NEW_SIGNER_ROLES = new Set(['builder', 'critic']);
const BOOTSTRAP_NEW_SIGNER_FIELDS = new Set(['role', 'roles']);

/**
 * Validate signers a PR ADDS, during first bootstrap only (there is no base config yet
 * to compare against, so the constraint is on the shape and the privilege).
 */
export function validateNewSigners(trustedSigners, headSigners) {
  if (headSigners === undefined) return;
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) fail('signers must be an object or absent');
  for (const key of Object.keys(headSigners)) {
    if (trustedSigners && Object.prototype.hasOwnProperty.call(trustedSigners, key)) continue;
    const entry = headSigners[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`new signer ${key} must be an object`);
    for (const field of Object.keys(entry)) {
      if (!BOOTSTRAP_NEW_SIGNER_FIELDS.has(field)) fail(`new signer ${key} has undeclared property ${field}`);
    }
    if (entry.role === undefined && entry.roles === undefined) fail(`new signer ${key} must declare a role or roles field`);
    if (entry.role !== undefined && entry.roles !== undefined) fail(`new signer ${key} must use either role or roles, not both`);
    const roles = Array.isArray(entry.roles) ? entry.roles : [entry.role];
    if (!roles.length || roles.some((role) => typeof role !== 'string' || !BOOTSTRAP_NEW_SIGNER_ROLES.has(role))) {
      fail(`new signer ${key} can only use builder or critic roles in this CI path; grant approver roles through the protected-base admin ceremony`);
    }
  }
}

/**
 * POST-bootstrap, a PR may not add a signer at all — not even a builder.
 *
 * Once a base config exists, the signer table is a trust root: adding any identity to it
 * is a change to who the system believes, and that belongs to the protected-base admin
 * ceremony rather than to whoever opened the PR.
 */
export function rejectNewSigners(trustedSigners, headSigners) {
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) {
    fail('signers must remain an object');
  }
  for (const key of Object.keys(headSigners)) {
    if (!trustedSigners || !Object.prototype.hasOwnProperty.call(trustedSigners, key)) {
      fail(`new signer ${key} requires the protected-base admin ceremony`);
    }
  }
}
