// verify.mjs — delegates whole-forest verification to @adlc/tickets/lib/manifest-primitives.mjs
// so @adlc/tickets and @adlc/gate-manifest share one canonical forest verifier without cycles.

import { ADLC_DIR } from '@adlc/core';
import { verifyChain, verifyManifestForest } from '@adlc/tickets/lib/manifest-primitives.mjs';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';

export { verifyChain };

/**
 * Verify the manifest ledger's hash chain — and, when ADLC_MANIFEST_KEY is
 * set, the HMAC signature of every entry that carries one — across the whole
 * chain forest: the root plus every valid segment under `manifest.d/`.
 *
 * @param {string} [dir]  ledger directory (default ADLC_DIR)
 * @param {object} [opts]
 * @param {boolean} [opts.requireSignatures=true]  see verifyChain
 * @param {boolean} [opts.requireEntries=false]    when true, fail closed on an empty or absent ledger
 * @param {string|null} [opts.key]                 explicit signing key (validated via validateKeyParam)
 * @param {string|null} [opts.publicKey]           explicit Ed25519 SPKI PEM public key (undefined auto-reads <dir>/admin.pub; null disables)
 */
export function verify(dir = ADLC_DIR, { requireSignatures = true, requireEntries = false, key: keyParam, publicKey } = {}) {
  const key = validateKeyParam(keyParam);
  return verifyManifestForest(dir, { requireSignatures, requireEntries, key, publicKey });
}
