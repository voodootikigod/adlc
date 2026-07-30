// shutdown.mjs — session_shutdown open-ticket capture (spec 4.5).
//
// `session_shutdown` fires as the extension runtime is torn down (quit, reload,
// session replacement). It is CLEANUP-ONLY: the session file may already be
// closing and there are no UI guarantees. We use it for exactly one durable
// signal — if a ticket is still active AND the session ended carrying gate
// denies/reverts that were never followed by a clean gate pass or an
// acceptance, we append ONE 'session-shutdown-open-ticket' evidence entry so the
// manifest records that this session walked away from unresolved enforcement
// state. The manifest mirror is the durable half; a session-side write failure
// is tolerated silently (the file may be gone). This NEVER blocks shutdown.
//
// buildShutdownEvidence is PURE (entries in, payload|null out) so AC2 can assert
// the unresolved/clean split without a live pi runtime.

import { extractGateEvents, readSessionEntries } from './compaction.mjs';
import { recordGateEvent } from './evidence.mjs';

const SHUTDOWN_MAX_EVENTS = 10;

// A gate event that RESOLVES prior denies/reverts: a clean gate pass
// ('adlc-gate-run' with exit code 0) or a recorded acceptance ('adlc-accept'
// that succeeded). Everything after the last such event is still "open".
function resolvesState(d) {
  if (!d || typeof d.type !== 'string') return false;
  if (d.type === 'adlc-gate-run' && d.code === 0) return true;
  if (d.type === 'adlc-accept' && d.ok === true) return true;
  return false;
}

function isStop(type) {
  return typeof type === 'string' && /(-deny|-revert)$/.test(type);
}

/**
 * Build the shutdown open-ticket evidence payload, or null when the session ends
 * clean. "Open" = one or more deny/revert gate events occur AFTER the last
 * resolving event (a passing gate run or an acceptance). A session with no gate
 * events, or whose denies/reverts were all superseded by a later pass/accept,
 * returns null (nothing to record).
 *
 * @param {object} opts
 * @param {object[]} opts.entries   session entries (from getBranch()/getEntries())
 * @param {string|null} [opts.ticketId]
 * @returns {{ticketId: string|null, unresolvedCount: number, events: object[]}|null}
 */
export function buildShutdownEvidence({ entries, ticketId = null } = {}) {
  const events = extractGateEvents(entries);
  let lastResolvedIdx = -1;
  events.forEach((d, i) => {
    if (resolvesState(d)) lastResolvedIdx = i;
  });
  const unresolved = events.filter((d, i) => i > lastResolvedIdx && isStop(d.type));
  if (unresolved.length === 0) return null;

  const recent = unresolved.slice(-SHUTDOWN_MAX_EVENTS);
  return {
    ticketId,
    unresolvedCount: unresolved.length,
    events: recent.map((d) => ({
      type: d.type,
      at: typeof d.at === 'string' ? d.at : null,
      where: d.path || (Array.isArray(d.paths) ? d.paths.join(',') : d.tool) || null,
      reason: typeof d.reason === 'string' ? d.reason : null,
    })),
  };
}

/**
 * Build the session_shutdown listener. On teardown, if a ticket is active and
 * the session carries unresolved denies/reverts, append one
 * 'session-shutdown-open-ticket' evidence entry (manifest = durable half; ctx is
 * passed as null so a failed write degrades silently rather than notifying into
 * a closing UI). Never throws into pi's shutdown path.
 *
 * @param {object} deps
 * @param {object} deps.pi                        ExtensionAPI (appendEntry)
 * @param {() => {ticketId: string|null}} deps.getActive
 * @param {() => string} deps.getCwd              repo root for the manifest mirror
 * @param {(ctx: object) => object[]} [deps.getEntries]  defaults to readSessionEntries
 * @returns {(event: object, ctx: object) => Promise<undefined>}
 */
export function makeShutdownListener({ key = null, pi, getActive, getCwd, getEntries = readSessionEntries } = {}) {
  return async function onSessionShutdown(_event, ctx) {
    try {
      const active = getActive?.() ?? { ticketId: null };
      const ticketId = active?.ticketId ?? null;
      if (!ticketId) return undefined;

      let entries = [];
      try { entries = getEntries(ctx) ?? []; } catch { entries = []; }

      const payload = buildShutdownEvidence({ entries, ticketId });
      if (!payload) return undefined;

      const root = typeof getCwd === 'function' ? getCwd() : process.cwd();
      // ctx: null → recordGateEvent stays silent on failure (no notify into a
      // torn-down UI); the manifest mirror is what we care about here.
      recordGateEvent({ key, pi, ctx: null, root, ticketId, type: 'session-shutdown-open-ticket', detail: payload });
    } catch {
      // session_shutdown must never throw — a failed capture just means no entry.
    }
    return undefined;
  };
}
