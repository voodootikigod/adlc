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

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, resolveRepo } from './config.mjs';
import { parseBlock, serializeBlock, blocksEqual } from './block.mjs';
import { pickBlock } from './pull.mjs';
import { canonicalHash } from './canonical.mjs';
import { reduceTicketOutcomes } from './outcomes.mjs';
import { renderStatus } from './status-render.mjs';
import { reassignId, migrateManifestEvidence } from './reassign.mjs';
import { acquireLock, releaseLock, writeTicketsAtomic, readSidecar, writeSidecar } from './store.mjs';
import { assertSignableTrustRootWrite, exitCodeFor, loadTicketSnapshot, readOwnChains } from '@adlc/tickets';

const SYNCED_RE = /^gh:[^#]+#(\d+)$/;
/**
 * A ticket id that has not been published to the tracker yet.
 *
 * TWO shapes, not one. `T<n>` is the legacy hand-authored form; `T-<26 ULID
 * chars>` is what TicketService mints when `create` omits the id — which
 * `adlc ticket create --help` now recommends as the normal path. Matching only
 * the legacy form filtered every generated ticket out of the create pass AND
 * out of orderLocalByDependency, so `push --write` exited 0 having created no
 * issue, and a legacy ticket could publish an edge to an id that would never
 * be synced.
 *
 * Duplicated from @adlc/tickets' isGeneratedTicketId rather than imported —
 * CONVENTIONS rule 1 keeps this package free of cross-package runtime deps —
 * and drift-gated by scripts/test/ticket-help-contract.test.mjs.
 */
const LEGACY_LOCAL_RE = /^T\d+$/;
const GENERATED_LOCAL_RE = /^T-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LOCAL_RE = { test: (id) => LEGACY_LOCAL_RE.test(id) || GENERATED_LOCAL_RE.test(id) };
const KEY_RE = /<!--\s*adlc:begin\b[^>]*\bkey=(\S+)/;

/** Best-effort sentinel-key extraction for the adoption scan — robust to an
 *  otherwise-malformed block (a corrupt body must never hide an existing create). */
export function extractSentinelKey(body) {
  const m = KEY_RE.exec(String(body ?? ''));
  return m ? m[1].replace(/-->$/, '') : null;
}

function loadLocalState(dir, { allowInvalid = false } = {}) {
  try {
    const snapshot = loadTicketSnapshot({ root: dir });
    return { tickets: snapshot.mutableTickets(), hash: snapshot.hash, absent: false };
  } catch (error) {
    if (error.code === 'STORE_NOT_FOUND') return { tickets: [], hash: null, absent: true };
    if (allowInvalid) return { tickets: [], hash: null, absent: false };
    throw error;
  }
}

const blockHash = (block) => (block ? canonicalHash(block, { omit: ['$schema'] }) : null);

/**
 * Order the local-only (`T<n>`) tickets so each ticket comes AFTER every local
 * ticket it references via `edges[].to` (dependency-first). This guarantees a
 * referenced ticket already holds its `gh:` id when the referrer's body is
 * serialized, so a forward edge never publishes a stale `T<n>` id (Finding B).
 * Pure; the `seen` guard tolerates the (gate-rejected) cyclic input without
 * looping. Non-local edge targets (already `gh:` or external) are simply ignored.
 */
export function orderLocalByDependency(tickets) {
  const locals = tickets.filter((t) => LOCAL_RE.test(t.id));
  const byId = new Map(locals.map((t) => [t.id, t]));
  const order = [];
  const seen = new Set();
  const visit = (t) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const e of t.edges ?? []) {
      const dep = byId.get(e?.to);
      if (dep) visit(dep);
    }
    order.push(t);
  };
  for (const t of locals) visit(t);
  return order;
}

// Root + THIS checkout's own open segment (T-MANIFEST-FOREST), never any OTHER
// lineage's — same scoping as reassign.mjs's planManifestMigration.
//
// allowRecovery: true (T-MANIFEST-FOREST, fourth round — supersedes the
// round-2/round-3 strict-only reasoning) lets this find the segment even when
// this checkout's own `.lineage` token is lost (fresh clone, or a branch
// switch that overwrote it). Earlier rounds kept this strict because
// publishing a GitHub label/comment is a remote trust-boundary mutation, and
// the OLD recovery matched on the derived filename slug — a LOSSY,
// attacker-controllable identity that could publish a FOREIGN lineage's
// status as this branch's own. Recovery now matches on the EXACT `branch`
// field every segment's first entry carries (spec §4.4) — non-lossy — but
// exact identity is not authenticity (adversarial-review finding, round 2):
// an UNSIGNED segment can still claim any branch by name. `key` is passed
// through so readOwnChains filters recovered entries to only those that are
// actually signature-verified, and disables recovery entirely when no key is
// available (push has no field to mark a rendered label "unauthenticated"
// the way doctor.mjs does, so an unverifiable recovery must not be trusted
// at all here — see readOwnChains's own doc). A genuinely ambiguous recovery
// (two committed segments both declaring this branch) propagates as a real
// thrown error rather than silently rendering a status computed from root
// alone, which could remove a real, earned status label.
function readOwnChainsOrRefuse(adlcDir, cwd, key) {
  return readOwnChains(adlcDir, { cwd, allowRecovery: true, key });
}

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
  key = null, allowUnsigned = false,
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
  const selectLabels = Array.isArray(ts.select?.labels) ? ts.select.labels : [];
  // Labels to attach AT create so the new issue matches the configured selector
  // immediately (every required selector label, not just createLabel) — Finding A.
  const createTimeLabels = [...new Set([createLabel, ...selectLabels].filter(Boolean))];

  // Pre-flight permission probe (doubles as the authenticated-login resolver for
  // the status-comment author check). Fail early (operational) if auth is broken.
  const who = await provider.whoami({ runner });
  if (!who.ok) return { exitCode: 1, errors: [`gh auth probe failed: ${who.error}`] };
  const ctx = { runner, repo, dryRun: !write, login: who.login };

  const list = await provider.listIssues({ runner, repo, ticketSync: ts, ...(limit ? { limit } : {}) });
  if (!list.ok) return { exitCode: 1, errors: [list.error] };
  const issuesByNumber = new Map(list.issues.map((i) => [i.number, i]));

  const localState = loadLocalState(dir, { allowInvalid: !write });
  const localTickets = localState.tickets;
  // Ahead of any REMOTE write. A push that adopts issues and then hits the local
  // store's frozen-trust-root refusal has already created issues upstream, leaving
  // remote and local disagreeing for a reason the operator can do nothing about
  // mid-flight. The same refusal, asked first, costs nothing and leaves both sides
  // untouched. A store that is not a trust root answers false and this is a no-op.
  //
  // An EARLY-OUT, not the enforcement point. It runs before the store lock, because
  // the alternative — holding that lock across every network round trip below —
  // blocks every other writer for the length of a remote sync. So a concurrent
  // writer can still add a rail in the gap; the authoritative check is the one
  // inside the transaction, under the lock, which re-evaluates and refuses there.
  // What this removes is the common case, not the race.
  // Only when a LOCAL write is possible at all. The local store is touched by one
  // thing here: reassigning a local-only ticket to the remote id it was just created
  // or adopted under. A push whose tickets are all already remote ids updates labels
  // and status comments and never writes the store, so demanding a key for it would
  // refuse remote-only work that owes no audit. Deliberately conservative — it asks
  // "could a local write happen", not "will it" — because the alternative is doing
  // the remote half first and finding out afterwards.
  const mayWriteLocally = localTickets.some((t) => !String(t?.id ?? '').startsWith('gh:'));
  if (write && mayWriteLocally) {
    try {
      assertSignableTrustRootWrite(localTickets, { key, allowUnsigned, root: dir });
    } catch (error) {
      // A trust-root refusal is a deliberate BLOCK, not a transient failure — the
      // CLI documents exit 2 for that, and automation needs to tell "this may not
      // happen" apart from "this did not work, try again".
      return { exitCode: exitCodeFor(error), errors: [error.message] };
    }
  }
  let expectedSnapshotHash = localState.hash;
  let expectedStoreAbsent = localState.absent;
  const sidecar = readSidecar(dir, { strict: write });
  // outcomes drives every label/comment this run publishes — see
  // readOwnChainsOrRefuse's doc above for why recovery is safe here now, and
  // why a genuinely ambiguous recovery must still refuse rather than silently
  // render from root alone.
  let outcomes;
  try {
    outcomes = reduceTicketOutcomes(manifestEntries ?? readOwnChainsOrRefuse(join(dir, '.adlc'), dir, key));
  } catch (error) {
    return { exitCode: 1, errors: [`cannot determine gate status: ${error.message}`] };
  }

  // Mutable working state (reassignment rewrites tickets store-wide).
  let tickets = localTickets.map((t) => ({ ...t }));
  const state = { ...sidecar, tickets: { ...sidecar.tickets }, pendingCreates: { ...sidecar.pendingCreates } };

  const plan = [];
  const errors = [];
  let blocked = false; // exit 2 (validity)
  let failed = false; // exit 1 (operational/partial)
  let ticketsDirty = false;
  const unresolvedReassignments = new Set();

  // Lock the trust root for the whole write phase so interleaving /adlc-ticket
  // writes can't corrupt the multi-step create→reassign sequence.
  if (write && !acquireLock(dir)) {
    return { exitCode: 1, errors: ['could not acquire .adlc/tickets.lock — another ticket op is in progress'] };
  }

  try {
    // A create/adoption handle is deliberately retained until BOTH the ticket ID
    // rewrite and manifest re-attestation are durable. Resume that second half when
    // a prior run committed the gh: ID but failed before sidecar cleanup.
    if (write) {
      let recoveredEvidence = false;
      for (const [createKey, pending] of Object.entries(state.pendingCreates)) {
        if (!pending?.localId || !Number.isInteger(pending.number)) continue;
        const newId = `gh:${repo}#${pending.number}`;
        const oldPresent = tickets.some((ticket) => ticket.id === pending.localId);
        const syncedTicket = tickets.find((ticket) => ticket.id === newId);
        if (oldPresent || !syncedTicket) continue;
        try {
          migrateManifestEvidence(dir, pending.localId, newId, { now, key });
          const issue = issuesByNumber.get(pending.number);
          state.tickets[newId] = state.tickets[newId] ?? {
            provider: 'github', repo, number: pending.number,
            nodeId: pending.nodeId ?? issue?.nodeId ?? null,
            url: pending.url ?? issue?.url ?? null,
            syncedHash: blockHash(pickBlock(syncedTicket)), syncedAt: now, createKey,
          };
          delete state.pendingCreates[createKey];
          writeSidecar(dir, state);
          plan.push({ kind: 'resume-reassignment', id: pending.localId, newId });
          recoveredEvidence = true;
        } catch (error) {
          unresolvedReassignments.add(newId);
          errors.push(`${newId}: could not resume evidence re-attestation from ${pending.localId} — ${error.message}`);
          failed = true;
        }
      }
      if (recoveredEvidence && manifestEntries === undefined) {
        // Re-read for the same reason as the initial load above (a resumed
        // migration just re-attested evidence, possibly into a segment).
        // Same recover-or-refuse rule as the initial load — see
        // readOwnChainsOrRefuse's doc above.
        try {
          outcomes = reduceTicketOutcomes(readOwnChainsOrRefuse(join(dir, '.adlc'), dir, key));
        } catch (error) {
          // Adversarial-review finding: a failure here used to just set `failed`
          // and fall through into Pass 1/2, which still render remote labels and
          // comments from the STALE pre-migration `outcomes` map. Since a resumed
          // migration moves evidence from the local id to the GitHub id, the
          // stale map commonly has NO entry for the now-current ticket id —
          // renderAndPush would then remove a real status label and publish a
          // false "no evidence recorded yet" comment, even though the function
          // ultimately returns exitCode 1. Abort before any remote mutation
          // instead: a status we cannot verify must never be published.
          return { exitCode: 1, errors: [...errors, `cannot determine gate status after resuming evidence re-attestation: ${error.message}`] };
        }
      }
    }

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
      if (unresolvedReassignments.has(t.id)) continue;
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
    // Finding B: create in DEPENDENCY-FIRST order — a ticket is created only after
    // every local ticket it references (edges[].to) already has its gh: id. Then when
    // its body is serialized the working set is fully rewritten, so a FORWARD edge
    // (T7→T8 created later) never publishes a stale `T<n>` edge. Cycles are impossible
    // (the Validity Gate rejects them); the `seen` guard makes visit terminate anyway.
    const createOrder = orderLocalByDependency(localTickets);
    for (const t of createOrder) {
      // Finding 2: derive the block from the CURRENT working ticket (its edges may
      // already have been rewritten by an earlier create in this same loop), NOT the
      // stale localTickets snapshot — else the remote body + syncedHash publish a
      // dangling `T<n>` edge while tickets.json holds the rewritten `gh:` edge.
      const current = tickets.find((x) => x.id === t.id) ?? t;
      const desired = pickBlock(current);

      // Reuse a stable key across runs: a surviving pendingCreates entry for this
      // local id (crash recovery) wins; else mint one.
      const pendingKey = Object.entries(state.pendingCreates).find(([, v]) => v?.localId === t.id)?.[0];
      const createKey = pendingKey ?? uuid();
      const pending = state.pendingCreates[createKey];

      let number;
      let nodeId;
      let url;
      let created = false;
      let currentLabels = [];

      // Finding 1 (primary): selector-INDEPENDENT crash recovery. If a prior create
      // for this ticket persisted a {number} handle, adopt that issue DIRECTLY via
      // `issue view` — the selector-scoped scan below can't see an orphan that was
      // never labeled, so relying on it duplicates the issue.
      if (pending && Number.isInteger(pending.number)) {
        const got = await provider.getIssue(ctx, pending.number);
        if (got.ok) {
          ({ number, url } = got);
          nodeId = got.nodeId ?? pending.nodeId ?? null;
          currentLabels = got.labels ?? [];
        } else if (!got.notFound) {
          // Finding C: a transient/unknown read failure is NOT proof the issue is
          // gone. We hold a create handle proving one exists, so recreating would
          // DUPLICATE it (the selector-scoped scan below may not see an unlabeled
          // orphan). Fail closed (operational) — retry; a genuinely deleted issue
          // returns notFound and is safely recreated, and a stale handle is flagged
          // by `doctor` (stale pendingCreates).
          errors.push(`${t.id}: could not verify pending issue #${pending.number} (${got.error}) — retry; if it was truly deleted, clear pendingCreates in .adlc/ticket-sync.state.json`);
          failed = true;
          continue;
        }
        // got.notFound → the issue is genuinely gone; fall through to scan/create.
      }

      if (number === undefined) {
        // Adoption scan over the authoritative paginated list (not the search index).
        const matches = list.issues.filter((i) => extractSentinelKey(i.body) === createKey);
        if (matches.length > 1) {
          errors.push(`${t.id}: ${matches.length} issues already carry create key ${createKey} (#${matches.map((i) => i.number).join(', #')}) — reconcile by hand`);
          blocked = true;
          continue;
        }
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
          // Finding 1/A (defense): attach EVERY selector label ATOMICALLY at create so
          // even an orphan from a crash before the post-create sidecar write is inside
          // the (possibly multi-label) selection and findable by the scan.
          const res = await provider.createIssue(ctx, { title: t.title, body, labels: createTimeLabels });
          if (!res.ok) { errors.push(`${t.id}: create — ${res.error}`); failed = true; continue; }
          ({ number, nodeId, url } = res);
          currentLabels = createTimeLabels;
          state.pendingCreates[createKey] = { localId: t.id, title: t.title, nodeId, number };
          writeSidecar(dir, state);
          created = true;
        }
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
        const ticketsBeforeWrite = tickets;
        const dirtyBeforeWrite = ticketsDirty;
        tickets = reassignId(tickets, t.id, newId);
        // Persist a resumable localId→newId handle for adopted issues too. The
        // existing create path already has one, but adoption previously did not.
        state.pendingCreates[createKey] = { localId: t.id, title: t.title, nodeId, number, url: url ?? null };
        writeSidecar(dir, state);
        ticketsDirty = true;
        let after;
        try {
          after = writeTicketsAtomic(dir, { tickets }, { expectedSnapshotHash, expectedStoreAbsent, key, allowUnsigned });
        } catch (error) {
          // The preflight above is an early-out, not the enforcement point, and the
          // gap between them is real: a concurrent writer can freeze the trust root
          // WITHOUT touching the active ticket set — archiving a railed ticket, or
          // the rail hook recording an override — so the snapshot hash still agrees
          // and only this write refuses. By then the remote issue exists.
          //
          // Letting that throw unwound the whole run, discarding the report of every
          // ticket that DID land and leaving the operator with an issue nobody
          // mentioned. It is not an unrecoverable orphan: the sidecar handle written
          // just above carries the issue number, so the next run adopts that exact
          // issue instead of opening a second one. Say all of that, keep the handle,
          // and undo only the in-memory reassignment — carrying it forward would let
          // a LATER ticket's successful write persist this id with no evidence
          // migration behind it.
          tickets = ticketsBeforeWrite;
          ticketsDirty = dirtyBeforeWrite;
          errors.push(
            `${t.id}: issue #${number} exists remotely, but the local id could not be committed — ${error.message}. `
            + 'The ticket store is unchanged, and the create handle is saved: re-run after resolving this and '
            + `#${number} is adopted rather than duplicated.`,
          );
          // A refusal needs a human, so it blocks rather than merely failing.
          blocked = true;
          continue;
        }
        expectedSnapshotHash = after.hash;
        expectedStoreAbsent = false;
        try {
          migrateManifestEvidence(dir, t.id, newId, { now, key });
        } catch (error) {
          errors.push(`${newId}: ticket ID was committed but evidence re-attestation is pending — ${error.message}`);
          failed = true;
          continue;
        }
        state.tickets[newId] = {
          provider: 'github', repo, number, nodeId, url: url ?? null,
          syncedHash: blockHash(desired), syncedAt: now, createKey,
        };
        delete state.pendingCreates[createKey];
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
