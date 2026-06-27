// constants.mjs — pure setup-time constants with NO dependencies (not even
// @adlc/core). The scaffolder imports from here so it can write .cursor/ config in
// a fresh checkout before `npm install` has linked the workspace packages. The
// runtime hooks still need @adlc/core, but bootstrapping must not.

// The Cursor preToolUse `matcher`: catch-all so EVERY tool reaches the guard and
// the classifier — not an allowlist matcher — is the single decision point. A
// narrower matcher would let a novel mutator name bypass the fail-closed classifier.
export const PRETOOL_MATCHER = '.*';
