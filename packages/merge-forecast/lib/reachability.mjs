/**
 * DAG reachability helpers.
 *
 * Edges: t.edges[].to means "t must complete before edge.to".
 * Two tickets are parallel-eligible when neither is an ancestor of the other.
 */

/**
 * Build adjacency for forward reachability.
 * Returns a Map<id, Set<id>> of direct successors (descendants).
 */
function buildSuccessors(tickets) {
  const succ = new Map(tickets.map((t) => [t.id, new Set()]));
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (succ.has(t.id)) succ.get(t.id).add(e.to);
    }
  }
  return succ;
}

/**
 * Compute full transitive reachability from each node.
 * Returns a Map<id, Set<id>> where reachable.get(a) is the set of all
 * descendants of a (nodes reachable by following edges forward from a).
 */
export function computeReachability(tickets) {
  const succ = buildSuccessors(tickets);
  const ids = tickets.map((t) => t.id);

  // Topological order (Kahn) to process in reverse for memoisation
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const t of tickets) {
    for (const e of t.edges ?? []) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const topoOrder = [];
  const inQueue = new Set(queue);
  const q = [...queue];
  while (q.length) {
    const id = q.shift();
    topoOrder.push(id);
    for (const next of succ.get(id) ?? []) {
      const newDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newDeg);
      if (newDeg === 0 && !inQueue.has(next)) {
        q.push(next);
        inQueue.add(next);
      }
    }
  }

  // Process in reverse topological order: each node's reachable set is
  // the union of its successors' reachable sets plus the successors themselves.
  const reachable = new Map(ids.map((id) => [id, new Set()]));
  for (const id of [...topoOrder].reverse()) {
    for (const s of succ.get(id) ?? []) {
      reachable.get(id).add(s);
      for (const r of reachable.get(s) ?? []) reachable.get(id).add(r);
    }
  }
  return reachable;
}

/**
 * Returns all pairs [a, b] (a < b by id) where neither is an ancestor of the other.
 * These are the "parallel-eligible" pairs worth forecasting.
 */
export function parallelEligiblePairs(tickets) {
  const reachable = computeReachability(tickets);
  const pairs = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i];
      const b = tickets[j];
      const aId = a.id;
      const bId = b.id;
      // a is an ancestor of b if b is reachable from a, and vice-versa
      if (!reachable.get(aId)?.has(bId) && !reachable.get(bId)?.has(aId)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/**
 * Assign tickets to topological waves (each wave is a set of tickets whose
 * predecessors have all been assigned to earlier waves).
 * Returns an array of arrays of ticket ids.
 */
export function topoWaves(tickets) {
  const indegree = new Map(tickets.map((t) => [t.id, 0]));
  const succ = new Map(tickets.map((t) => [t.id, []]));
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      succ.get(t.id).push(e.to);
      indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    }
  }
  const waves = [];
  let ready = tickets.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const assigned = new Set();
  while (ready.length) {
    waves.push([...ready]);
    const nextReady = [];
    for (const id of ready) {
      assigned.add(id);
      for (const next of succ.get(id) ?? []) {
        const newDeg = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, newDeg);
        if (newDeg === 0 && !assigned.has(next)) nextReady.push(next);
      }
    }
    ready = nextReady;
  }
  return waves;
}

/**
 * Foundation-first merge order: tickets that are dependencies of others
 * should merge first. Within a tier, first-done-first-merged.
 * Returns ticket ids in merge order.
 */
export function mergeOrder(tickets) {
  const waves = topoWaves(tickets);
  return waves.flat();
}
