// push.mjs — orchestrates `adlc ticket push` (local → tracker): update synced
// issues, create local-only tickets idempotently, then render display status
// (labels + comment). Network is confined to the injected provider/runner, so the
// whole flow is offline-testable. Dry-run by default; --write performs mutations.
//
// Idempotency is the whole game (re-running push must converge, not duplicate):
//   - UPDATE only writes the body when the canonical block actually changed, only
//     touches labels that differ, and only rewrites the comment when it differs.
//   - CREATE is keyed: a stable sentinel `key` + a pre-create adoption scan of the
//     already-paginated list + a `pendingCreates` crash-recovery handle mean a lost
//     local write re-adopts the existing issue instead of making a second one.
//   - On create the `T<n>` id is reassigned to `gh:<owner>/<repo>#<n>` with a
//     store-wide edge rewrite + append-only manifest re-attestation (reassign.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEntries } from '@adlc/core';
import { loadConfig, resolveRepo } from './config.mjs';
import { parseBlock, serializeBlock, blocksEqual } from './block.mjs';
import { pickBlock } from './pull.mjs';
import { canonicalHash } from './canonical.mjs';
import { reduceTicketOutcomes } from './outcomes.mjs';
import { renderStatus } from './status-render.mjs';
import { reassignId, migrateManifestEvidence } from './reassign.mjs';
import { acquireLock, releaseLock, writeTicketsAtomic, readSidecar, writeSidecar } from './store.mjs';

const SYNCED_RE = /^gh:[^#]+#(\d+)$/;
const LOCAL_RE = /^T\d+$/;
const KEY_RE = /<!--\s*adlc:begin\b[^>]*\bkey=(\S+)/;

/** Best-effort sentinel-key extraction for the adoption scan — robust to an
 *  otherwise-malformed block (a corrupt body must never hide an existing create). */
export function extractSentinelKey(body) {
  const m = KEY_RE.exec(String(body ?? ''));
  return m ? m[1].replace(/-->$/, '') : null;
}

function loadLocalTickets(dir) {
  const p = join(dir, '.adlc', 'tickets.json');
  if (!existsSync(p)) return [];
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(d.tickets) ? d.tickets : [];
  } catch {
    return [];
  }
}

const blockHash = (block) => (block ? canonicalHash(block, { omit: ['$schema'] }) : null);

/** Serialize a ticket's body: prose + canonical block (or prose-only when no block). */
function ticketBody(prose, block, key) {
  return block ? serializeBlock(prose, block, { key }) : `${prose.prefix ?? ''}${prose.suffix ?? ''}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.dir]
 * @param {object} opts.provider   provider implementing the write contract
 * @param {Function} opts.runner   injected gh runner
 * @param {string} [opts.gitRemoteUrl]
 * @param {boolean} [opts.write]
 * @param {string} [opts.now]      ISO timestamp (sidecar/manifest stamps)
 * @param {Function} [opts.uuid]   create-key generator (injected for tests)
 * @param {Array} [opts.manifestEntries]  override the manifest read (tests)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.limit]
 */
export async function push({
  dir = '.', provider, runner, gitRemoteUrl, write = false,
  now = new Date().toISOString(), uuid = randomUUID, manifestEntries, env = process.env, limit,
} = {}) {
  const cfg = loadConfig(dir);
  if (!cfg.ok) return { exitCode: 1, errors: cfg.errors };
  const ts = cfg.config.ticketSync;
  const rr = resolveRepo(ts, { gitRemoteUrl });
  if (!rr.ok) return { exitCode: 1, errors: [rr.error] };
  const repo = rr.repo.toLowerCase();
  const statusLabels = ts.statusLabels ?? {};
  const createLabel = ts.createLabel ?? null;

  // Pre-flight permission probe (doubles as the authenticated-login resolver for
  // the status-comment author check). Fail early (operational) if auth is broken.
  const who = await provider.whoami({ runner });
  if (!who.ok) return { exitCode: 1, errors: [`gh auth probe failed: ${who.error}`] };
  const ctx = { runner, repo, dryRun: !write, login: who.login };

  const list = await provider.listIssues({ runner, repo, ticketSync: ts, ...(limit ? { limit } : {}) });
  if (!list.ok) return { exitCode: 1, errors: [list.error] };
  const issuesByNumber = new Map(list.issues.map((i) => [i.number, i]));

  const localTickets = loadLocalTickets(dir);
  const sidecar = readSidecar(dir);
  const outcomes = reduceTicketOutcomes(manifestEntries ?? readEntries('manifest', join(dir, '.adlc')).entries);

  // Mutable working state (reassignment rewrites tickets store-wide).
  let tickets = localTickets.map((t) => ({ ...t }));
  const state = { ...sidecar, tickets: { ...sidecar.tickets }, pendingCreates: { ...sidecar.pendingCreates } };

  const plan = [];
  const errors = [];
  let blocked = false; // exit 2 (validity)
  let failed = false; // exit 1 (operational/partial)
  let ticketsDirty = false;

  // Lock the trust root for the whole write phase so interleaving /adlc-ticket
  // writes can't corrupt the multi-step create→reassign sequence.
  if (write && !acquireLock(dir)) {
    return { exitCode: 1, errors: ['could not acquire .adlc/tickets.lock — another ticket op is in progress'] };
  }

  try {
    // ---- labels + comment for an issue we own (shared by update + create) ----
    const renderAndPush = async (ref, currentLabels, status, opLabel) => {
      const render = renderStatus(status, { statusLabels });
      const wantAdd = [...render.add, ...(createLabel ? [createLabel] : [])].filter((l, i, a) => a.indexOf(l) === i);
      const add = wantAdd.filter((l) => !currentLabels.includes(l));
      const remove = render.remove.filter((l) => currentLabels.includes(l));
      if (add.length || remove.length) {
        plan.push({ kind: 'labels', id: opLabel, add, remove });
        const r = await provider.ensureLabels(ctx, ref, { add, remove });
        if (!r.ok) { errors.push(`${opLabel}: labels — ${r.error}`); failed = true; }
      }
      const c = await provider.upsertStatusComment(ctx, ref, render.comment);
      if (!c.ok) { errors.push(`${opLabel}: comment — ${c.error}`); failed = true; }
      else if (c.changed) plan.push({ kind: 'comment', id: opLabel });
    };

    // ---- Pass 1: UPDATE synced tickets ----
    for (const t of tickets) {
      const m = SYNCED_RE.exec(t.id);
      if (!m) continue;
      const number = Number(m[1]);
      const issue = issuesByNumber.get(number);
      if (!issue) { plan.push({ kind: 'skip', id: t.id, reason: 'issue not in the current selection' }); continue; }
      if (issue.state === 'closed') { plan.push({ kind: 'skip', id: t.id, reason: 'issue is closed' }); continue; }

      const parsed = parseBlock(issue.body);
      if (!parsed.ok) {
        // We own this block; an unparseable one is not silently clobbered.
        errors.push(`${t.id}: remote block is invalid (${parsed.errors.join('; ')}) — fix the issue body or re-pull`);
        blocked = true;
        continue;
      }
      const desired = pickBlock(t);
      const ref = { number, nodeId: state.tickets[t.id]?.nodeId ?? issue.nodeId };
      if (!blocksEqual(parsed.block, desired)) {
        const body = ticketBody({ prefix: parsed.prefix, suffix: parsed.suffix }, desired, parsed.key);
        plan.push({ kind: 'update-body', id: t.id });
        const r = await provider.updateIssueBody(ctx, ref, body);
        if (!r.ok) { errors.push(`${t.id}: body — ${r.error}`); failed = true; continue; }
      }
      await renderAndPush(ref, issue.labels ?? [], outcomes.get(t.id)?.status ?? null, t.id);
    }

    // ---- Pass 2: CREATE local-only tickets (idempotent) ----
    for (const t of localTickets) {
      if (!LOCAL_RE.test(t.id)) continue;
      const desired = pickBlock(t);

      // Reuse a stable key across runs: a surviving pendingCreates entry for this
      // local id (crash recovery) wins; else mint one.
      const pendingKey = Object.entries(state.pendingCreates).find(([, v]) => v?.localId === t.id)?.[0];
      const createKey = pendingKey ?? uuid();

      // Adoption scan over the authoritative paginated list (not the search index).
      const matches = list.issues.filter((i) => extractSentinelKey(i.body) === createKey);
      if (matches.length > 1) {
        errors.push(`${t.id}: ${matches.length} issues already carry create key ${createKey} (#${matches.map((i) => i.number).join(', #')}) — reconcile by hand`);
        blocked = true;
        continue;
      }

      let number;
      let nodeId;
      let url;
      let created = false;
      let currentLabels = [];

      if (matches.length === 1) {
        ({ number, nodeId, url } = matches[0]);
        currentLabels = matches[0].labels ?? [];
      } else if (!write) {
        plan.push({ kind: 'create', id: t.id, createKey });
        continue; // no remote id available in dry-run
      } else {
        const body = ticketBody({ prefix: t.body ? `${t.body}\n\n` : '', suffix: '' }, desired, createKey);
        // Persist the recovery handle BEFORE the remote call so a crash leaves a
        // body-key we can re-adopt; update it with nodeId the instant we have one.
        state.pendingCreates[createKey] = { localId: t.id, title: t.title };
        writeSidecar(dir, state);
        const res = await provider.createIssue(ctx, { title: t.title, body });
        if (!res.ok) { errors.push(`${t.id}: create — ${res.error}`); failed = true; continue; }
        ({ number, nodeId, url } = res);
        state.pendingCreates[createKey] = { localId: t.id, title: t.title, nodeId, number };
        writeSidecar(dir, state);
        created = true;
      }

      // Defense in depth: never reassign onto a non-numeric id. A misbehaving
      // provider (or a create that "succeeded" without a parseable number) must
      // fail the ticket, not corrupt the store with a `gh:<repo>#undefined` id.
      if (!Number.isInteger(number)) {
        errors.push(`${t.id}: provider returned no usable issue number — not reassigning`);
        failed = true;
        continue;
      }

      const newId = `gh:${repo}#${number}`;
      plan.push({ kind: created ? 'create' : 'adopt', id: t.id, newId });

      if (write) {
        tickets = reassignId(tickets, t.id, newId);
        migrateManifestEvidence(dir, t.id, newId, { now, env });
        state.tickets[newId] = {
          provider: 'github', repo, number, nodeId, url: url ?? null,
          syncedHash: blockHash(desired), syncedAt: now, createKey,
        };
        delete state.pendingCreates[createKey];
        ticketsDirty = true;
        writeTicketsAtomic(dir, { tickets });
        writeSidecar(dir, state);
        await renderAndPush({ number, nodeId }, currentLabels, outcomes.get(t.id)?.status ?? null, newId);
      }
    }

    if (write && !ticketsDirty) {
      // No reassignment happened, but sidecar pendingCreates churn may have left
      // a clean state already written; nothing more to flush here.
    }
  } finally {
    if (write) releaseLock(dir);
  }

  const exitCode = blocked ? 2 : failed ? 1 : 0;
  return { exitCode, plan, errors: errors.length ? errors : undefined, ...(write ? { applied: true } : { dryRun: true }) };
}
