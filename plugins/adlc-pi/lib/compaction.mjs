// compaction.mjs — deterministic post-compaction ADLC-state re-assertion
// (spec 4.4).
//
// Compaction replaces the live context with an LLM-generated summary we do NOT
// want to own. What that summary reliably LOSES is OPEN ENFORCEMENT STATE — the
// recent gate denies/reverts/overrides, the degraded flag, and the active
// ticket the doctrine relies on. Rather than customize the summary, this module
// re-ASSERTS the deterministic slice: after a `session_compact`, it reads the
// session's own 'adlc-gate-event' entries (recorded by evidence.mjs via
// pi.appendEntry) plus the degraded flag, and builds ONE bounded digest that
// extension.mjs delivers as a `nextTurn` message so the post-compaction context
// cannot silently drop enforcement history. Applies to ALL compaction reasons
// (manual included — state loss is state loss).
//
// The digest builder is PURE (entries in, string|null out) so it is fully
// unit-testable; the listener wires it to pi.sendMessage.

const DIGEST_MAX_EVENTS = 10;
const DIGEST_MAX_CHARS = 1200;

// Event `type`s that represent UNRESOLVED enforcement state worth re-asserting:
// denies and reverts (something the agent tried and was stopped from), human
// overrides, and a TICKET-BLOCKED signal. Pure pass rows ('adlc-gate-run' with
// an exit code, 'unvetted-tool' notes, 'prosecute-run', 'ticket-done-claimed')
// are informational, not enforcement history — excluded so the digest stays a
// signal, not a log.
function isUnresolved(type) {
  return typeof type === 'string' && (/(-deny|-revert|-override)$/.test(type) || type === 'ticket-blocked');
}

/**
 * Pull the recorded 'adlc-gate-event' payloads out of a session entry list.
 * Each is a pi CustomEntry: { type: 'custom', customType: 'adlc-gate-event',
 * data: { type, ticketId, at, …detail } }. Returns the `data` payloads in
 * session order.
 */
export function extractGateEvents(entries) {
  const out = [];
  for (const e of entries ?? []) {
    if (e && e.type === 'custom' && e.customType === 'adlc-gate-event' && e.data && typeof e.data === 'object') {
      out.push(e.data);
    }
  }
  return out;
}

/**
 * Build the post-compaction re-assertion digest, or null when there is nothing
 * to re-assert. Fires ONLY when unresolved enforcement events exist (a session
 * with no ADLC events re-asserts nothing); the degraded flag and active ticket
 * are included in the digest CONTENT when it fires. Bounded to the last
 * DIGEST_MAX_EVENTS events and DIGEST_MAX_CHARS characters.
 *
 * @param {object} opts
 * @param {object[]} opts.entries   session entries (from getBranch()/getEntries())
 * @param {boolean} [opts.degraded] the build-gate degraded flag
 * @param {string|null} [opts.ticketId]
 * @returns {string|null}
 */
export function buildCompactionDigest({ entries, degraded = false, ticketId = null } = {}) {
  const events = extractGateEvents(entries);
  const unresolved = events.filter((d) => isUnresolved(d.type));
  if (unresolved.length === 0) return null;

  // Keep the last N events, then list them NEWEST FIRST so the character cap
  // (which trims the tail) drops the OLDEST rather than the most recent state.
  const recent = unresolved.slice(-DIGEST_MAX_EVENTS).reverse();
  const lines = [];
  lines.push(`ADLC state re-assertion (post-compaction). Active ticket: ${ticketId ?? '(none)'}.`);
  if (degraded) {
    lines.push('Context is DEGRADED (compaction/overflow) — the build gate may deny high-risk structured edits until an audited override.');
  }
  lines.push(
    `Unresolved enforcement events (${recent.length}${unresolved.length > recent.length ? ` of ${unresolved.length}` : ''}, newest first):`
  );
  for (const d of recent) {
    const where = d.path || (Array.isArray(d.paths) ? d.paths.join(',') : d.tool) || '';
    const reason = typeof d.reason === 'string' ? d.reason : '';
    lines.push(`- ${d.type}${where ? ` ${where}` : ''}${reason ? `: ${reason}` : ''}`);
  }
  lines.push('Frozen rails and the ticket scope remain in force. Do not retry denied edits; the CI rails-guard gate is the backstop.');

  let text = lines.join('\n');
  if (text.length > DIGEST_MAX_CHARS) text = `${text.slice(0, DIGEST_MAX_CHARS - 1).trimEnd()}…`;
  return text;
}

/**
 * Read the current session's entries from a pi event ctx. Prefers the branch
 * path (what survives into the post-compaction leaf) over the full entry set.
 * Fail-safe: returns [] when no sessionManager is present (fake/older ctx).
 */
export function readSessionEntries(ctx) {
  const sm = ctx?.sessionManager;
  if (!sm) return [];
  try {
    if (typeof sm.getBranch === 'function') return sm.getBranch() ?? [];
    if (typeof sm.getEntries === 'function') return sm.getEntries() ?? [];
  } catch {
    return [];
  }
  return [];
}

/**
 * Build the `session_compact` listener. On compaction it re-asserts unresolved
 * ADLC enforcement state as a single `nextTurn` message. Best-effort: a
 * sendMessage failure never throws into pi's compact handler.
 *
 * @param {object} deps
 * @param {object} deps.pi                          ExtensionAPI (sendMessage)
 * @param {() => {ticketId: string|null}} deps.getActive
 * @param {(ctx: object) => object[]} [deps.getEntries]  defaults to readSessionEntries
 * @param {() => boolean} [deps.isDegraded]
 * @returns {(event: object, ctx: object) => Promise<undefined>}
 */
export function makeCompactionListener({ pi, getActive, getEntries = readSessionEntries, isDegraded } = {}) {
  return async function onSessionCompact(_event, ctx) {
    let entries = [];
    try { entries = getEntries(ctx) ?? []; } catch { entries = []; }
    const active = getActive?.() ?? { ticketId: null };
    const digest = buildCompactionDigest({
      entries,
      degraded: Boolean(isDegraded?.()),
      ticketId: active?.ticketId ?? null,
    });
    if (!digest) return undefined;
    try {
      pi.sendMessage(
        {
          customType: 'adlc-state-reassertion',
          content: digest,
          display: true,
          details: { ticketId: active?.ticketId ?? null },
        },
        { deliverAs: 'nextTurn' }
      );
    } catch {
      // Re-assertion is best-effort — never throw into the compact handler.
    }
    return undefined;
  };
}
