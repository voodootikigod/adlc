// Ticket schema + DAG math (topological order, critical path, float).
// The ticket file is the shared contract between model-router,
// merge-forecast, coldstart, rails-guard, and flail-detector.
//
// .adlc/tickets.json:
// {
//   "tickets": [
//     {
//       "id": "T1",                      // required, unique
//       "title": "…",                    // required
//       "body": "full self-contained ticket text",
//       "scope": ["src/auth/**"],        // declared file globs this ticket may touch
//       "rails": ["test/auth/**"],       // frozen paths during build
//       "edges": [{ "to": "T2", "contract": "src/types/auth.d.ts" }],  // T1 → T2 dependency
//       "duration": 1,                   // relative build-time estimate (default 1)
//       "category": "feature",           // routing category (free-form)
//       "budget": 200000                 // optional token budget
//     }
//   ]
// }

import { existsSync, readFileSync } from 'node:fs';

export const TICKETS_PATH = '.adlc/tickets.json';

/** Validate one ticket. Returns an array of error strings (empty = valid). */
export function validateTicket(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['ticket is not an object'];
  if (!t.id || typeof t.id !== 'string') errors.push('missing string id');
  if (!t.title || typeof t.title !== 'string') errors.push(`${t.id ?? '?'}: missing string title`);
  if (t.scope !== undefined && !Array.isArray(t.scope)) errors.push(`${t.id}: scope must be an array of globs`);
  if (t.rails !== undefined && !Array.isArray(t.rails)) errors.push(`${t.id}: rails must be an array of paths`);
  if (t.edges !== undefined) {
    if (!Array.isArray(t.edges)) errors.push(`${t.id}: edges must be an array`);
    else for (const e of t.edges) {
      if (!e || typeof e.to !== 'string') errors.push(`${t.id}: edge missing string "to"`);
    }
  }
  if (t.duration !== undefined && (typeof t.duration !== 'number' || t.duration <= 0)) {
    errors.push(`${t.id}: duration must be a positive number`);
  }
  return errors;
}

/** Load + validate a tickets file. Returns { tickets, errors }. */
export function loadTickets(path = TICKETS_PATH) {
  if (!existsSync(path)) return { tickets: [], errors: [`tickets file not found: ${path}`] };
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { tickets: [], errors: [`invalid JSON in ${path}: ${err.message}`] };
  }
  const tickets = data.tickets ?? [];
  const errors = [];
  const seen = new Set();
  for (const t of tickets) {
    errors.push(...validateTicket(t));
    if (t.id) {
      if (seen.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
      seen.add(t.id);
    }
  }
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      if (e.to && !seen.has(e.to)) errors.push(`${t.id}: edge to unknown ticket ${e.to}`);
    }
  }
  return { tickets, errors };
}

/**
 * Topological order. Edges mean "this ticket must complete before edge.to".
 * Returns { order: [ids…], cycle: [ids…] | null }.
 */
export function topoSort(tickets) {
  const ids = tickets.map((t) => t.id);
  const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const t of tickets) {
    for (const e of t.edges ?? []) {
      out[t.id].push(e.to);
      indegree[e.to] += 1;
    }
  }
  const queue = ids.filter((id) => indegree[id] === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out[id]) {
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  if (order.length !== ids.length) {
    return { order, cycle: ids.filter((id) => !order.includes(id)) };
  }
  return { order, cycle: null };
}

/**
 * Critical-path-method float per ticket (classic CPM forward/backward pass).
 * duration defaults to 1. Returns { floats: {id: number}, criticalPath: [ids…],
 * makespan: number } or { error } when the DAG has a cycle.
 */
export function computeFloat(tickets) {
  const { order, cycle } = topoSort(tickets);
  if (cycle) return { error: `cycle in ticket DAG: ${cycle.join(', ')}` };
  const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const dur = (id) => byId[id].duration ?? 1;
  const preds = Object.fromEntries(tickets.map((t) => [t.id, []]));
  for (const t of tickets) for (const e of t.edges ?? []) preds[e.to].push(t.id);

  const earliestFinish = {};
  for (const id of order) {
    const start = Math.max(0, ...preds[id].map((p) => earliestFinish[p]));
    earliestFinish[id] = start + dur(id);
  }
  const makespan = Math.max(0, ...Object.values(earliestFinish));

  const succs = Object.fromEntries(tickets.map((t) => [t.id, (t.edges ?? []).map((e) => e.to)]));
  const latestFinish = {};
  for (const id of [...order].reverse()) {
    latestFinish[id] = succs[id].length
      ? Math.min(...succs[id].map((s) => latestFinish[s] - dur(s)))
      : makespan;
  }

  const floats = {};
  for (const id of order) floats[id] = latestFinish[id] - earliestFinish[id];
  const criticalPath = order.filter((id) => floats[id] === 0);
  return { floats, criticalPath, makespan };
}

/**
 * Minimal glob match supporting '*' (within a segment) and '**' (across
 * segments). Enough for declared-scope checks; not a full glob engine.
 */
export function globMatch(pattern, path) {
  const regex = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === '**/') return '(?:.*/)?';
          if (part === '**') return '.*';
          if (part === '*') return '[^/]*';
          return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('') +
      '$'
  );
  return regex.test(path);
}

/** Does a file path fall inside a ticket's declared scope? */
export function inScope(ticket, path) {
  return (ticket.scope ?? []).some((g) => globMatch(g, path));
}

/** Do two tickets' declared scopes overlap (shared glob territory)? */
export function scopesOverlap(a, b) {
  const as = a.scope ?? [];
  const bs = b.scope ?? [];
  // Conservative: overlap if any glob from one matches the other's glob
  // treated as a literal-ish path, or globs are identical prefixes.
  for (const ga of as) {
    for (const gb of bs) {
      if (ga === gb) return true;
      const aBase = ga.split('*')[0];
      const bBase = gb.split('*')[0];
      if (aBase && bBase && (aBase.startsWith(bBase) || bBase.startsWith(aBase))) return true;
    }
  }
  return false;
}
