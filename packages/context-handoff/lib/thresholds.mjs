// Shared absolute band thresholds. Adapters MUST import these (no local copies).
// Inclusive band edges (>=) are intentional in evaluateBands; see bands.mjs.

export const WARN_PCT = 50;
export const HANDOFF_PCT = 60;
export const HARD_PCT = 80;

export const WARN_DEPTH = 20;
export const HANDOFF_DEPTH = 30;
export const HARD_DEPTH = 40;

export const WARN_BYTES = 128 * 1024;
export const HANDOFF_BYTES = 192 * 1024;
export const HARD_BYTES = 256 * 1024;

/**
 * Phase 0 hotfix (context-rot-threshold-calibration spec §1.2.2): the transcript
 * scan's only two budgets. The prior MAX_SCAN_BYTES constant equaled HARD_BYTES
 * (256 KiB) and its overrun set depth to +Infinity — a routine fresh-session
 * baseline with several plugins/skills loaded already exceeds 256 KiB, so this
 * was the actual production lockout, not an edge case. MAX_SCAN_BYTES is
 * retired entirely (no adapter may re-declare a local constant under either
 * name); these two budgets replace it. A scan that exceeds either before
 * reaching start-of-file reports the depth accumulated so far — a finite lower
 * bound, never +Infinity.
 */
export const MAX_ACTIVE_CONTEXT_BYTES = 8 * 1024 * 1024;
/**
 * Wall-clock ceiling for a transcript scan. Sequential reads of a few MB
 * complete in low tens of milliseconds on ordinary storage; this budget is
 * generous headroom above that for slower disks/filesystems, not a target.
 */
export const MAX_SCAN_WALL_MS = 500;

/**
 * Round-11 review (T-01M03J291182MXD1KEKM2PRKTS): before this, `handoff
 * bypass --write` only appended an audit-trail manifest entry — the adapter's
 * mutation gate hardcoded `bypassForSession: false` and never read it back,
 * so the recovery command every deny diagnostic instructs the operator to
 * run had no actual effect on the next mutation. This TTL bounds the signed
 * grant file (lib/bypass-grant.mjs) that closes that gap. Phase 0 has no
 * ledger, lock, or host-authenticated expiry (spec §1.3's "stronger fix" is
 * explicitly Phase 1 target hardening) — the grant is consumed (deleted) by
 * the first mutation it authorizes, and this TTL is only a defense-in-depth
 * ceiling against a failed delete leaving a stale grant file readable, not
 * the primary bound. 10 minutes is generous enough for an operator to read
 * the diagnostic, copy-paste the command, and retry their mutation, while
 * still keeping a residual grant's exposure window short.
 */
export const BYPASS_GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * Round-13 review: every bypass-grant reader (canonical + both host trusted
 * twins) called readFileSync/JSON.parse on the grant path with no size or
 * file-type check — a large regular file wastes memory on every hook
 * invocation, and a FIFO/blocking device reached at that path would stall a
 * synchronous hook read before any gate logic runs. A real grant document is
 * always tiny (a session id, an ISO timestamp, a 64-hex-char signature); this
 * is a generous ceiling, not a target. Readers use `lstatSync` (never follows
 * a symlink) and require `isFile()`, so a symlink at the grant path is
 * rejected outright, not merely size-capped.
 */
export const MAX_BYPASS_GRANT_BYTES = 4096;

/**
 * Supervisor timings (lib/supervise.mjs). Declared here for the same reason as
 * every band edge above: a wrapper that polls on its own copied literal stops
 * agreeing with the loop it supervises the day one of these moves.
 *
 * The deny marker is written by a hook in a separate process, so the supervisor
 * learns about a deny by polling for the file. `fs.watch` is deliberately not
 * used: it is unreliable across platforms and network filesystems, and a missed
 * event here means the wrapper never continues at all. Two seconds is well
 * inside a human's tolerance for "it noticed" while costing one `existsSync`
 * per tick.
 */
export const SUPERVISE_DENY_POLL_MS = 2_000;
/**
 * How long a transcript must stop growing before the denied session counts as
 * quiescent. The deny lands on the model's tool call, but the message that
 * matters — the handoff summary it is instructed to write — is still being
 * streamed after that. Capturing at the deny would take the transcript mid-turn
 * and hand the successor a truncated narrative.
 */
export const SUPERVISE_QUIESCENCE_MS = 5_000;
/**
 * Grace between SIGTERM and SIGKILL for a superseded child. Long enough for a
 * harness to flush its transcript and restore the terminal, short enough that a
 * wedged child cannot hold the loop open.
 */
export const SUPERVISE_TERMINATE_GRACE_MS = 10_000;

export const HANDOFF_COOLDOWN_TOOLS = 15;
/**
 * Suppress advisory nags when remaining-to-hard is BELOW this fraction
 * (near-hard / handoff zone — deny/handoff owns the signal). Never mutation deny.
 */
export const MIN_REMAINING_TO_HARD = 0.25;
export const HANDOFF_MAX_AGE_HOURS = 72;

/** @returns {boolean} */
export function thresholdsOrdered() {
  return (
    WARN_PCT < HANDOFF_PCT &&
    HANDOFF_PCT < HARD_PCT &&
    WARN_DEPTH < HANDOFF_DEPTH &&
    HANDOFF_DEPTH < HARD_DEPTH &&
    WARN_BYTES < HANDOFF_BYTES &&
    HANDOFF_BYTES < HARD_BYTES
  );
}
