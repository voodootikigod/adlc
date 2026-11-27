// sign.mjs — keyed signing for manifest entries (HMAC-SHA256, zero-dep).
//
// WHY: the hash chain (`prev` = sha256(previous raw line)) is keyless. Anyone
// who can write the ledger file can recompute every `prev` and forge a clean
// chain from scratch — sha256 is a public function with no secret. To make the
// chain a real *provenance* signal (in-toto/SLSA-style), each entry is signed
// with HMAC-SHA256 under a secret key (env ADLC_MANIFEST_KEY). An attacker
// without the key cannot produce a valid `sig`, so a forged chain fails verify.
//
// CANONICAL BYTES SIGNED — must be byte-identical on record and verify:
//   Legacy gate records use the fixed v1 field set. Generalized runner evidence
//   carries sigVersion:2 and signs canonical JSON for every field except `sig`,
//   so ticket/revision/provenance fields on the final ledger entry are covered.
//   canonicalEntryBytes is single-sourced from @adlc/tickets/lib/manifest-primitives.mjs.

import { createHmac } from 'node:crypto';
import {
  ADMIN_PUB_FILENAME,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
  entrySigValid,
} from '@adlc/tickets/lib/manifest-primitives.mjs';
import { PRIVATE_KEY_ENV, resolveKeyFromEnv } from '@adlc/tickets/lib/key-contract.mjs';

export {
  ADMIN_PUB_FILENAME,
  PRIVATE_KEY_ENV,
  ED25519_PRIV_PREFIX,
  SIG_ALG_ED25519,
  canonicalEntryBytes,
  generateEd25519KeyPair,
  isEd25519PrivateKey,
  derivePublicKeyPem,
  signEntryEd25519,
  verifyEntryEd25519,
  readAdminPublicKey,
};

/** Env var holding the legacy symmetric signing key. */
export const KEY_ENV = 'ADLC_MANIFEST_KEY';

/**
 * Read the signing key from the environment.
 * Prefers ADLC_MANIFEST_PRIVATE_KEY (with explicit-empty fail-closed semantics)
 * over ADLC_MANIFEST_KEY. Returns the key string, or null when unset/empty.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function getKey(env = process.env) {
  return resolveKeyFromEnv(env);
}

/**
 * Compute the signature (hex) of an entry under a signing key.
 * Uses Ed25519 when `key` carries the `ed25519-priv:` prefix, otherwise HMAC-SHA256.
 * @param {string} key
 * @param {object} entry
 * @returns {string} hex signature
 */
export function signEntry(key, entry) {
  if (isEd25519PrivateKey(key)) {
    return signEntryEd25519(key, entry);
  }
  return createHmac('sha256', key).update(canonicalEntryBytes(entry)).digest('hex');
}

/**
 * Verify `entry.sig` under `key` (HMAC-SHA256 or Ed25519 private key) and/or
 * an explicit Ed25519 `publicKey`. Returns false when sig is missing, malformed, or wrong.
 * @param {string|null} key
 * @param {object} entry
 * @param {{ publicKey?: string|null }} [opts]
 * @returns {boolean}
 */
export function verifyEntrySig(key, entry, opts) {
  return entrySigValid(key, entry, opts);
}

/**
 * Verify that an Ed25519 private signing key is valid and matches `<dir>/admin.pub`
 * when present. Fails closed on corrupt/symlinked `admin.pub` or key mismatch.
 * No-op for non-Ed25519 keys (HMAC or null).
 * @param {string} dir
 * @param {string|null} key
 */
export function assertEd25519KeyMatchesAdminPub(dir, key) {
  if (!isEd25519PrivateKey(key)) return;
  const derivedPub = derivePublicKeyPem(key);
  const adminPub = readAdminPublicKey(dir);
  if (adminPub.status === 'error') {
    throw new Error(`${ADMIN_PUB_FILENAME}: ${adminPub.reason}`);
  }
  if (adminPub.status === 'ok' && adminPub.publicKey !== derivedPub) {
    throw new Error(`Ed25519 private key does not match ${ADMIN_PUB_FILENAME}`);
  }
}
