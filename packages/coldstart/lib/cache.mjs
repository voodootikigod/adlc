// cache.mjs — content-addressed gate-result cache (issue #278).
//
// ADLC Principle 10: "every artifact the next agent reads is a cache" — a
// coldstart PASS/FAIL for a given ticket-hash is valid exactly as long as
// that hash is unchanged. Pure lookup logic lives here (testable with plain
// fixture arrays, no real gate-manifest I/O); gate.mjs wires it to the real
// ledger and to ticketHash().

export const GATE_NAME = 'coldstart';

/**
 * Build the `data.cache` shape recorded into a gate-manifest entry for one
 * audited ticket.
 *
 * @param {object} opts
 * @param {string} opts.ticketHash
 * @param {string} opts.model - resolved model id, not the abstract tier
 * @param {object[]} opts.gaps
 * @returns {{ticketHash:string, model:string, gaps:object[]}}
 */
export function buildCacheData({ ticketHash, model, gaps }) {
  return { ticketHash, model, gaps: gaps ?? [] };
}

/**
 * Find the most recent cached coldstart verdict matching `ticketHash` +
 * `model` among manifest entries already scoped to one ticket (the caller
 * filters by `ticket` when loading — see gate.mjs's loadCacheEntriesFn).
 *
 * Walks newest-first so a later re-audit (e.g. after `--force`) shadows an
 * older entry for the same hash+model rather than the lookup depending on
 * array order elsewhere.
 *
 * @param {object[]} entries - manifest entries (as returned by gate-manifest's loadFiltered)
 * @param {object} opts
 * @param {string} opts.ticketHash
 * @param {string} opts.model
 * @param {number|null} [opts.maxAgeMs] - null = no age limit
 * @param {number} [opts.now] - ms since epoch; defaults to Date.now()
 * @returns {{gaps:object[]}|null}
 */
export function findCachedVerdict(entries, { ticketHash, model, maxAgeMs = null, now = Date.now() } = {}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.gate !== GATE_NAME) continue;
    const cache = entry.data?.cache;
    if (!cache || cache.ticketHash !== ticketHash || cache.model !== model) continue;
    if (maxAgeMs != null) {
      const ageMs = now - Date.parse(entry.ts);
      if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) continue;
    }
    return { gaps: Array.isArray(cache.gaps) ? cache.gaps : [] };
  }
  return null;
}
