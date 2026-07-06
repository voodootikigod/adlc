// constants.mjs — pure setup-time constants with NO dependencies (not even
// @adlc/core). The scaffolder imports from here so it can write .cursor/ config in
// a fresh checkout before `npm install` has linked the workspace packages. The
// runtime hooks still need @adlc/core, but bootstrapping must not.

// The Cursor preToolUse `matcher`: catch-all so EVERY tool reaches the guard and
// the classifier — not an allowlist matcher — is the single decision point. A
// narrower matcher would let a novel mutator name bypass the fail-closed classifier.
export const PRETOOL_MATCHER = '.*';

// Session-scoping TTL for the hook-persisted per-session state files below
// (T18 / ADR 0006). Cursor hook payloads are NOT pinned to carry a
// conversation/session id, so "session" is approximated by write-recency: a
// state file whose last update is older than this window is treated as a
// PREVIOUS session and reset. 30 minutes of inactivity is the documented
// staleness window; the TODO to pin a real session id lives in ADR 0006.
export const SESSION_TTL_MS = 30 * 60 * 1000;

// Hook-persisted session state under the target repo's .adlc/ directory.
// HONESTY: all three are agent-writable local files — they are advisory
// signals, not tamper-proof evidence, and nothing backstops them.
export const DEPTH_COUNTER_FILE = 'cursor-buildgate-depth.json'; // buildgate tool-call counter
export const RECENT_EDITS_FILE = 'cursor-recent-edits.jsonl';    // flail recent-edits window
export const PREFLIGHT_MARKER_FILE = 'cursor-preflight-marker.json'; // once-per-session preflight marker
