// active-tickets.mjs — filter completed (tombstoned) tickets out of a backlog
// enumeration. A ticket carrying `completed: true` (set by ticket-prune's
// tombstone, or by an admin completion ceremony) is finished work: it must not
// be scheduled, routed, or audited as open backlog. Completed tickets are also
// dropped as prerequisites — an edge pointing to a completed (satisfied) ticket
// is removed from the survivors so the remaining DAG stays valid and self-
// consistent (no "edge to unknown ticket" once the completed node is gone).
//
// By-id lookups (e.g. `coldstart <id>`) intentionally keep using the FULL
// ticket set — you can still act on a completed ticket when you name it; this
// helper only governs *enumeration* of open backlog.
//
// Core gap: @adlc/core (frozen, CONVENTIONS rule 2) has no completion-aware
// ticket loader, so this is implemented locally. Kept identical across
// merge-forecast / model-router / coldstart; see each README "Core gaps".
export function activeTickets(tickets) {
  const done = new Set(tickets.filter((t) => t.completed === true).map((t) => t.id));
  if (done.size === 0) return tickets;
  return tickets
    .filter((t) => !done.has(t.id))
    .map((t) =>
      Array.isArray(t.edges) && t.edges.some((e) => done.has(e.to))
        ? { ...t, edges: t.edges.filter((e) => !done.has(e.to)) }
        : t,
    );
}
