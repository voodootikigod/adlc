// prosecutor.mjs — re-export shim over @adlc/core's prosecutor module (T17,
// issue-#97 pattern). The single implementation of the P5 prosecution registry
// and pure orchestration helpers (dedupe, verifier-majority, loop-until-dry)
// lives in packages/core/lib/prosecutor.mjs; this file only re-exposes it at
// the path the plugin's tests and docs reference ('@adlc/core' is a declared
// dependency of this package). Reference-equality with @adlc/core is asserted
// by test/prosecutor-delegation.test.mjs, so a reintroduced local copy fails CI.

export {
  LENSES,
  VERIFIER,
  ALL_AGENTS,
  findingKey,
  dedupeFindings,
  survivesVerification,
  shouldContinue,
} from '@adlc/core';
