// ticket-check.mjs — validate --ticket against the local ticket store before
// appending to the gate manifest (#893).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTickets, ADLC_DIR } from '@adlc/core';

/**
 * Bounded Levenshtein edit distance between strings `a` and `b`.
 * Returns `cap + 1` as soon as the distance is proven to exceed `cap`.
 */
export function editDistance(a, b, cap = 2) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = [0, ...Array.from(b, (_, j) => j + 1)];
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    if (Math.min(...curr) > cap) return cap + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Return up to `limit` candidate ticket IDs from `ids` within edit distance `cap`
 * of `id` (case-insensitive), ordered by ascending edit distance.
 */
export function nearMissIds(id, ids, { cap = 2, limit = 5 } = {}) {
  const target = String(id).toUpperCase();
  return ids
    .map((candidate) => ({
      candidate,
      distance: editDistance(target, String(candidate).toUpperCase(), cap),
    }))
    .filter((item) => item.distance <= cap)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((item) => item.candidate);
}

/**
 * Validate `ticket` against the ticket store in `dir` before recording a
 * manifest entry (#893).
 */
export function validateRecordTicket({
  ticket,
  dir = ADLC_DIR,
  allowUnknownTicket = false,
} = {}) {
  if (!ticket) return { ok: true, status: 0, message: null };
  const ticketsPath = join(dir, 'tickets.json');
  const storePresent = existsSync(ticketsPath) || existsSync(join(dir, 'tickets'));
  if (!storePresent) return { ok: true, status: 0, message: null };
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors.length > 0) {
    return {
      ok: false,
      status: 1,
      message: `could not load tickets from ${ticketsPath}: ${errors.join('; ')}`,
    };
  }
  if (allowUnknownTicket) return { ok: true, status: 0, message: null };
  const ids = tickets.map((t) => t.id);
  if (!ids.includes(ticket)) {
    const near = nearMissIds(ticket, ids);
    const nearSuffix = near.length > 0 ? ` (near-miss id(s): ${near.join(', ')})` : '';
    return {
      ok: false,
      status: 2,
      message: `ticket "${ticket}" not found in ${ticketsPath}${nearSuffix} — pass --allow-unknown-ticket to record a store-external id deliberately`,
    };
  }
  return { ok: true, status: 0, message: null };
}
