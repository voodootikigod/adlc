// archive-order.mjs (T75) — order archive candidates so an edge SOURCE is
// archived before the ticket it points to (its TARGET).
//
// archiveTicket fails closed on inbound edges (ARCHIVE_INBOUND_EDGE): archiving
// removes a ticket from the active store, so if A holds an edge `{to: B}` and
// both A and B are being archived, B still shows an inbound edge from A until A
// is gone. Archiving B first would falsely block it. Processing SOURCES before
// TARGETS lets the whole eligible batch archive in one sweep.
//
// Only edges BETWEEN candidates constrain the order. An edge from a
// non-candidate (an active ticket that stays) can never be satisfied by
// reordering — that is a genuine block the caller reports and continues past.

/**
 * @param {string[]} candidateIds  ids to archive, in their discovered order
 * @param {Map<string, object>} ticketsById  id → ticket (read for `edges`)
 * @returns {string[]} the same ids, reordered sources-before-targets (stable on ties)
 */
export function orderArchiveCandidates(candidateIds, ticketsById) {
  const candidates = candidateIds.filter((id) => ticketsById.has(id));
  const inBatch = new Set(candidates);

  // edge A→B (A holds `{to: B}`) ⇒ A must precede B.
  const mustPrecede = new Map(candidates.map((id) => [id, []])); // A → [B, …]
  const indegree = new Map(candidates.map((id) => [id, 0]));     // # of in-batch sources referencing it
  for (const a of candidates) {
    for (const edge of ticketsById.get(a)?.edges ?? []) {
      const b = edge?.to;
      if (typeof b === 'string' && b !== a && inBatch.has(b)) {
        mustPrecede.get(a).push(b);
        indegree.set(b, indegree.get(b) + 1);
      }
    }
  }

  // Kahn's algorithm, stable: among ready nodes keep the input order so the
  // sweep is deterministic regardless of filesystem read order.
  const ordered = [];
  const emitted = new Set();
  const ready = candidates.filter((id) => indegree.get(id) === 0);
  while (ready.length) {
    const id = ready.shift();
    if (emitted.has(id)) continue;
    emitted.add(id);
    ordered.push(id);
    for (const b of mustPrecede.get(id)) {
      indegree.set(b, indegree.get(b) - 1);
      if (indegree.get(b) === 0) ready.push(b);
    }
  }

  // The ticket DAG is validated acyclic, but never silently drop a node if a
  // cycle ever slips through — append leftovers in their input order.
  for (const id of candidates) if (!emitted.has(id)) ordered.push(id);
  return ordered;
}
