// pull.mjs — orchestrates `adlc ticket pull` and the Validity Gate. Network is
// confined to the injected provider/runner, so the whole flow is offline-testable.
//
// Flow: load config → resolve repo → provider.listIssues → per-issue parse + 3-way
// reconcile + rail/scope guard → union with local → Validity Gate → dry-run plan or
// atomic write (tickets.json + sidecar). Fails closed (exit 2) on any invalid
// block, unresolved conflict, rail-narrowing, or Validity-Gate violation.

import { join } from 'node:path';
import { topoSort } from '@adlc/core';
import { loadConfig, resolveRepo } from './config.mjs';
import { parseBlock } from './block.mjs';
import { reconcileBlock } from './reconcile.mjs';
import { railScopeGuard, describeViolations } from './rails-guard-sync.mjs';
import { validateTicket } from './validate.mjs';
import { canonicalHash } from './canonical.mjs';
import { acquireLock, releaseLock, writeTicketsAtomic, readSidecar, writeSidecar } from './store.mjs';
import { loadTicketSnapshot } from '@adlc/tickets';

const BLOCK_KEYS = ['scope', 'rails', 'edges', 'duration', 'category', 'budget'];

/** Extract the block-field subset from a ticket/object, or null if none present. */
export function pickBlock(obj) {
  if (!obj) return null;
  const out = {};
  let any = false;
  for (const k of BLOCK_KEYS) if (obj[k] !== undefined) { out[k] = obj[k]; any = true; }
  return any ? out : null;
}

function loadLocalState(dir) {
  try {
    const snapshot = loadTicketSnapshot({ root: dir });
    return { tickets: snapshot.mutableTickets(), hash: snapshot.hash, absent: false };
  } catch (error) {
    if (error.code === 'STORE_NOT_FOUND') return { tickets: [], hash: null, absent: true };
    throw error;
  }
}

/**
 * Rebuild a ticket from what the remote carries, PRESERVING everything it does
 * not.
 *
 * The remote block is authoritative for the synced contract — title, body and
 * BLOCK_KEYS — and a key absent from the block is still removed, which is the
 * point of syncing. But this used to construct the ticket from nothing and then
 * overwrite the local one wholesale, so every field outside that contract was
 * silently deleted by an ordinary converged pull. `completed` is the one that
 * matters: a ticket finished with `adlc ticket complete` came back from the next
 * pull as unfinished, and every consumer reading `completed === true` (fleet,
 * model-router, coldstart, ticket-prune) queued the work again. Extension fields
 * went the same way.
 *
 * Local-only fields are therefore carried across. Sync owns the synced fields;
 * it does not own the whole record.
 */
function buildTicket(id, title, prose, block, localTicket) {
  const t = { id, title };
  for (const [key, value] of Object.entries(localTicket ?? {})) {
    if (key === 'id' || key === 'title' || key === 'body') continue; // remote is authoritative
    if (BLOCK_KEYS.includes(key)) continue;                          // ditto, and absence means delete
    t[key] = value;
  }
  if (prose) t.body = prose;
  if (block) for (const k of BLOCK_KEYS) if (block[k] !== undefined) t[k] = block[k];
  return t;
}

const normId = (id) => (typeof id === 'string' && id.startsWith('gh:') ? id.toLowerCase() : id);

/**
 * The Validity Gate. Normalizes ids/edges into one space, then runs the
 * loadTickets-level relational checks. Unresolved edges FAIL CLOSED (never
 * dropped). The returned `tickets` is exactly what gets written (resolution-
 * checked == persisted).
 */
export function validityGate(tickets) {
  const errors = [];
  const out = tickets.map((t) => {
    const next = { ...t, id: normId(t.id) };
    if (t.edges !== undefined) next.edges = t.edges.map((e) => ({ ...e, to: normId(e.to) }));
    return next;
  });
  const ids = new Set();
  for (const t of out) {
    for (const e of validateTicket(t)) errors.push(e);
    if (ids.has(t.id)) errors.push(`duplicate ticket id: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of out) {
    for (const e of t.edges ?? []) {
      if (!ids.has(e.to)) errors.push(`${t.id}: edge to unknown ticket "${e.to}" — unresolved (pull the referenced issue or fix the reference)`);
    }
  }
  if (errors.length === 0) {
    const { cycle } = topoSort(out);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return { ok: errors.length === 0, errors, tickets: out };
}

export async function pull({
  dir = '.', provider, runner, gitRemoteUrl,
  write = false, force = false, allowRailNarrowing = false, limit,
  now = new Date().toISOString(),
} = {}) {
  const cfg = loadConfig(dir);
  if (!cfg.ok) return { exitCode: 1, errors: cfg.errors };
  const ts = cfg.config.ticketSync;
  const rr = resolveRepo(ts, { gitRemoteUrl });
  if (!rr.ok) return { exitCode: 1, errors: [rr.error] };
  const repo = rr.repo.toLowerCase();

  const res = await provider.listIssues({ runner, repo, ticketSync: ts, ...(limit ? { limit } : {}) });
  if (!res.ok) return { exitCode: 1, errors: [res.error] };

  const localState = loadLocalState(dir);
  const localTickets = localState.tickets;
  const localById = new Map(localTickets.map((t) => [t.id, t]));
  const sidecar = readSidecar(dir, { strict: write });

  const errors = [];
  const plan = [];
  const proposed = new Map();
  const sidecarUpdates = {};

  for (const issue of res.issues) {
    const id = `gh:${repo}#${issue.number}`;
    const parsed = parseBlock(issue.body);
    if (!parsed.ok) { errors.push(`${id}: invalid block — ${parsed.errors.join('; ')}`); continue; }
    const remoteBlock = parsed.block; // null = no block
    const prose = (parsed.block ? `${parsed.prefix ?? ''}${parsed.suffix ?? ''}` : issue.body ?? '').trim();
    const localTicket = localById.get(id);
    const baseHash = sidecar.tickets[id]?.syncedHash ?? null;
    // 3-way reconcile only applies when the ticket EXISTS locally (detecting
    // divergence). A remote issue with no local ticket is simply a create —
    // adopt it (the "no base → conflict" fail-safe is for existing tickets only).
    const decision = localTicket
      ? reconcileBlock({ baseHash, local: pickBlock(localTicket), remote: remoteBlock })
      : { action: 'take-remote' };

    if (decision.action === 'conflict' && !force) {
      errors.push(`${id}: ${decision.reason} — rerun with --force to take remote`);
      continue;
    }
    if (decision.action === 'keep-local') { plan.push({ id, action: 'keep-local' }); continue; }

    // adopt remote (take-remote | converged | conflict+force)
    if (localTicket && remoteBlock) {
      const g = railScopeGuard({ localRails: localTicket.rails, incomingRails: remoteBlock.rails, localScope: localTicket.scope, incomingScope: remoteBlock.scope });
      if (!g.ok && !allowRailNarrowing) {
        errors.push(`${id}: ${describeViolations(g.violations)} — rerun with --allow-rail-narrowing`);
        continue;
      }
    }
    proposed.set(id, buildTicket(id, issue.title, prose, remoteBlock, localTicket));
    sidecarUpdates[id] = {
      provider: 'github', repo, number: issue.number, nodeId: issue.nodeId, url: issue.url,
      syncedHash: remoteBlock ? canonicalHash(remoteBlock, { omit: ['$schema'] }) : null,
    };
    plan.push({ id, action: localTicket ? 'update' : 'create-local', decision: decision.action });
  }

  if (errors.length) return { exitCode: 2, errors, plan }; // fail closed

  // Union: preserve local-only and out-of-selection tickets; overlay proposed.
  const merged = localTickets.map((t) => proposed.get(t.id) ?? t);
  for (const [id, t] of proposed) if (!localById.has(id)) merged.push(t);

  const gate = validityGate(merged);
  if (!gate.ok) return { exitCode: 2, errors: gate.errors, plan };

  if (!write) return { exitCode: 0, plan, dryRun: true, tickets: gate.tickets };

  if (!acquireLock(dir)) return { exitCode: 1, errors: ['could not acquire .adlc/tickets.lock — another ticket op is in progress'] };
  try {
    writeTicketsAtomic(dir, { tickets: gate.tickets }, {
      expectedSnapshotHash: localState.hash,
      expectedStoreAbsent: localState.absent,
    });
    const newSidecar = { ...sidecar, tickets: { ...sidecar.tickets } };
    for (const [id, u] of Object.entries(sidecarUpdates)) newSidecar.tickets[id] = { ...u, syncedAt: now };
    writeSidecar(dir, newSidecar);
  } finally {
    releaseLock(dir);
  }
  return { exitCode: 0, plan, applied: true };
}
