// key-contract.mjs — the shared validation contract for a manifest signing/verifying
// key parameter (spec: .adlc/specs/manifest-key-hermeticity.md, Layer 2).
//
// WHY THIS LIVES IN @adlc/tickets: the primitive must be importable by every package
// that signs or verifies manifest entries, including this one (the evidence writer).
// The dependency graph runs @adlc/gate-manifest -> @adlc/core -> @adlc/tickets, and
// tickets has NO dependencies — it is the leaf. Placing the helper here lets
// gate-manifest, prosecute, and every other consumer import it acyclically, while a
// tickets -> gate-manifest import would close the exact cycle the tickets package
// deliberately avoids (it duplicates signing logic today for that reason).
//
// THE CONTRACT (invariant P1 — a set environment key never changes the outcome of an
// operation that did not explicitly receive it):
//   non-empty string  -> the key, returned unchanged;
//   null              -> "no key, deterministically", returned unchanged;
//   undefined         -> THROWS. Omission is a programming error, never a request to
//                        consult process.env — `{ ...opts, key: undefined }` must fail
//                        fast instead of silently re-enabling ambient lookup;
//   ''                -> THROWS. A zero-length HMAC key is publicly guessable, and an
//                        explicitly-empty ADLC_MANIFEST_KEY means "deliberate
//                        fail-closed" everywhere else in this system — a library that
//                        treated '' as a usable key would invert its meaning;
//   any non-string    -> THROWS.
//
// Environment resolution (getKey / loadManifestKeyFromEnvLocal) happens ONLY in bins,
// once, at the top; the resolved value is threaded down through this contract.

/**
 * Validate a manifest-key parameter. Returns the value for the two legal forms,
 * throws a TypeError for everything else.
 *
 * @param {string|null} key  a non-empty key string, or null for "no key"
 * @returns {string|null}
 */
export function validateKeyParam(key) {
  if (key === null) return null;
  if (typeof key === 'string' && key.length > 0) return key;
  throw new TypeError(
    'manifest key parameter must be a non-empty string (a key) or null (explicitly no key); ' +
    `got ${key === '' ? "'' (empty string)" : typeof key}. ` +
    'Resolve the environment in the bin (getKey()) and thread the value down — ' +
    'library code never reads process.env.',
  );
}

/**
 * Resolve the manifest key from an environment map — the BIN-side counterpart of
 * validateKeyParam. Returns the key when set non-empty, else null. This is the only
 * sanctioned env read in this package; libraries receive the resolved value.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolveKeyFromEnv(env = process.env) {
  const k = env.ADLC_MANIFEST_KEY;
  return typeof k === 'string' && k.length > 0 ? k : null;
}
