// Fleet observer decisions (plan §5.5), pinned by test/fleet-bridge.test.mjs.
// The watcher reads `.adlc/fleet-status.json` (a versioned read-only observation
// surface, t-herdr-8) and calls planFleetBridge; this module owns WHAT to do —
// open a run tab once, tail in-flight ticket logs, notify on terminal
// transitions, summarize on the board — and the glue only executes. Pure: no I/O.
// Untrusted input (the status file is writer-owned but unsandboxed here): an
// unknown schema degrades to polling, and hostile ids never reach a path/argv.
import { sanitizeToken } from './sanitize.mjs';

// The fleet-status.json schemaVersion this plugin was built to understand. It is
// deliberately a plugin-local copy (the installed plugin is zero-dep and cannot
// import @adlc/fleet): when fleet bumps its version past this, the observer sees
// a mismatch and degrades to polling rather than misreading a newer shape.
export const KNOWN_FLEET_SCHEMA_VERSION = 1;

const IN_FLIGHT = new Set(['building', 'gating', 'prosecuting', 'fixing', 'merging']);
const TERMINAL = new Set(['merged', 'failed', 'blocked']);
// Hard cap on live tail panes per run. fleet-status.json is UNTRUSTED: a file
// padded with thousands of in-flight tickets (well within the 8MB read bound)
// must not make the executor spawn thousands of `herdr agent start` processes and
// block the global watcher event loop. Board rows are NOT capped (cheap, no
// spawn) so the summary stays complete; only the process-spawning panes are
// bounded. Exported for the test.
export const MAX_TAIL_PANES = 24;
// A safe run/ticket id is a plain token: no '/', no '..', no leading '-' — so it
// can never traverse a path or be read as a CLI flag.
const ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const safeId = (id) => typeof id === 'string' && ID_RE.test(id) && !id.includes('..');

// `observed` marks a plan built from a VALID status this beat — the only case in
// which absence of a ticket is evidence it left the in-flight set. A null status
// (no run / transient read error) or a degrade yields observed:false, so the
// executor never tears panes down on missing data (that would churn the UI and
// lose scrollback on a one-beat read blip).
const EMPTY = () => ({ degrade: false, observed: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] });

/**
 * Plan the observer's side effects for a fleet-status transition.
 * @returns {{degrade:boolean, observed:boolean, openTab:{runId:string,title:string}|null,
 *   tailPanes:Array, notifications:Array, boardRows:Array}}
 */
export function planFleetBridge({ prev, curr, knownSchemaVersion, seenRunIds }) {
  if (!curr || typeof curr !== 'object') return EMPTY(); // no run in progress (observed:false)
  if (curr.schemaVersion !== knownSchemaVersion) return { ...EMPTY(), degrade: true };
  if (!safeId(curr.runId)) return { ...EMPTY(), degrade: true }; // malformed run → can't observe safely
  const runId = curr.runId;

  const tickets = curr.tickets && typeof curr.tickets === 'object' ? curr.tickets : {};
  // `prev.tickets &&` is load-bearing: typeof null === 'object', so without the
  // truthiness check a `"tickets": null` in a prior (untrusted) status would make
  // prevTickets null and the later prevTickets[id] throw. planFleetBridge parses
  // an untrusted file and MUST be total — a throw here poisons prev forever (it
  // never advances past the beat that threw), paralysing the observer for the repo.
  const prevTickets = prev && prev.tickets && typeof prev.tickets === 'object' ? prev.tickets : {};
  // Notify only on a transition observed WITHIN THE SAME run: the first beat of a
  // run (no prev, or prev belongs to a different runId) is a baseline, not
  // transitions — else a watcher starting mid-run, or a restarted run, storms one
  // notification per already-terminal ticket.
  const sameRun = Boolean(prev && typeof prev === 'object' && prev.runId === runId);
  const seen = seenRunIds instanceof Set ? seenRunIds : new Set();

  const out = EMPTY();
  out.observed = true; // a valid status: absence of a tracked ticket now means it left in-flight
  out.openTab = seen.has(runId) ? null : { runId, title: `fleet: run-${sanitizeToken(runId)}` };

  // Retained FAILED/BLOCKED panes are collected separately and appended AFTER the
  // in-flight ones, so the shared MAX_TAIL_PANES quota is filled by ACTIVE builds
  // first — a heavily-failing run must never let zombie failed panes starve a
  // still-building ticket of its live log (and then have the executor close it).
  const retained = [];
  for (const [id, rec] of Object.entries(tickets)) {
    if (!safeId(id)) continue; // hostile id → never reaches a log path, argv, or the board
    const state = rec && typeof rec.state === 'string' ? rec.state : null;
    if (!state) continue;
    if (IN_FLIGHT.has(state)) {
      if (out.tailPanes.length < MAX_TAIL_PANES) out.tailPanes.push({ ticketId: id, state, logPath: `.adlc/fleet-logs/${id}.log`, runId });
    } else if (TERMINAL.has(state)) {
      out.boardRows.push({ ticketId: id, state });
      // RETAIN the tail pane for a FAILED/BLOCKED ticket so its final output (the
      // error / stack trace) stays visible — closing it the instant a build fails
      // hides exactly what the developer needs to read. A merged ticket has nothing
      // more to show, so its pane is released. (Filled into the quota below.)
      if (state !== 'merged') retained.push({ ticketId: id, state, logPath: `.adlc/fleet-logs/${id}.log`, runId });
      const prevState = prevTickets[id] && typeof prevTickets[id].state === 'string' ? prevTickets[id].state : null;
      if (sameRun && prevState !== state) {
        if (state === 'merged') {
          out.notifications.push({ ticketId: id, kind: 'merged', title: 'ADLC fleet', body: `${sanitizeToken(id)} merged`, sound: 'done' });
        } else {
          // Per §6.3 each ticket runs in its OWN worktree `.worktrees/fleet-<id>`
          // (the id is validated above, so the path is safe). herdr notifications
          // carry no action buttons, so the worktree to inspect is in the BODY
          // (a one-click shell needs a herdr notification-action API — phase 4).
          const worktreePath = `.worktrees/fleet-${id}`;
          out.notifications.push({ ticketId: id, kind: state, title: 'ADLC fleet', body: `${sanitizeToken(id)} ${state} — inspect ${worktreePath}`, sound: 'request', worktreePath });
        }
      }
    }
  }
  // Second pass: retained panes fill only the quota LEFT after active in-flight ones.
  for (const pane of retained) {
    if (out.tailPanes.length >= MAX_TAIL_PANES) break;
    out.tailPanes.push(pane);
  }
  return out;
}

// Fixed-argv builders (herdr contract probed 2026-07-25). Every externally-derived
// value is a validated token; the tail command is a fixed argv (no shell), with a
// `--` guard before the log path.
export function fleetTabArgs(title) {
  return ['tab', 'create', '--label', title, '--no-focus'];
}
export function fleetTailPaneArgs({ tabId, repoRoot, logPath, ticketId, runId }) {
  // The agent NAME carries the pane's identity — `agent start` has no --label
  // (0.7.4: only --cwd/--env/--split), so a per-ticket name is what makes N
  // concurrent tail panes distinguishable in herdr's UI. It MUST be namespaced by
  // `runId`: herdr agent names are global across the multiplexer, but the daemon
  // observes many repos at once, so two concurrent runs sharing a ticket id (e.g.
  // two clones) would otherwise collide and blind the second. `runId`/`ticketId`
  // are validated tokens upstream; fall back to the generic name if either is absent.
  const agentName = typeof runId === 'string' && runId && typeof ticketId === 'string' && ticketId
    ? `adlc-fleet-${runId}-${ticketId}`
    : 'adlc-fleet-tail';
  // `tail -F` (= --follow=name --retry), NOT -f: the fleet orchestrator creates
  // `.adlc/fleet-logs/<id>.log` a beat AFTER the ticket enters `building`, and
  // plain `tail -f` on a not-yet-existent file exits 1 immediately (dead pane,
  // dropped logs). -F waits for the file to appear and re-follows on rotation.
  // Supported by GNU/BSD/busybox tail (herdr's target platforms).
  return ['agent', 'start', agentName, '--cwd', repoRoot, '--tab', tabId, '--split', 'down', '--', 'tail', '-F', '--', logPath];
}
export function fleetPaneCloseArgs(paneId) {
  return ['pane', 'close', paneId];
}
// Open an interactive shell in a failed/blocked ticket's worktree so the user can
// investigate (ticket §2). `worktreePath` is `.worktrees/fleet-<id>` built from a
// validated ticket id upstream; it is `--cwd`'s value (never a bare positional),
// and the shell is a fixed argv of a trusted binary (no shell string). NOTE: this
// is not yet BOUND to a notification action — herdr notifications carry no action
// buttons (Phase 4). The builder exists per the ticket so the target is ready when
// that API lands; today the worktree path is surfaced in the notification body.
export function fleetWorktreeShellArgs({ worktreePath }) {
  return ['agent', 'start', 'adlc-fleet-shell', '--cwd', worktreePath, '--split', 'right', '--', 'bash'];
}

// Pull the created tab/pane id out of a runHerdrJson result, failing soft to
// null (kept here + tested so the watcher glue stays a one-liner, not untested
// response-shape parsing).
export function tabIdFromResponse(res) {
  if (!res || res.ok !== true) return null;
  const id = res.value?.result?.tab?.tab_id ?? res.value?.result?.tab_id ?? null;
  return typeof id === 'string' && id ? id : null;
}
export function paneIdFromResponse(res) {
  if (!res || res.ok !== true) return null;
  const id = res.value?.result?.pane?.pane_id ?? null;
  return typeof id === 'string' && id ? id : null;
}

/** Mark a run "seen" (tab opened) ONLY when a tab was requested this beat AND it
 *  now has an id — a transient tab failure must retry next beat, not be recorded
 *  as handled. Kept here + tested so the watcher glue isn't an untested guard. */
export function shouldMarkRunSeen(plan, runState) {
  return Boolean(plan && plan.openTab && runState && runState.tabId);
}

/**
 * Execute a fleet plan through injected effects, keeping per-run mutable `state`:
 *   - `tabId`  — the current run's tab;
 *   - `tailed` — Map<ticketId,paneId> of ACTIVE tail panes for the current run;
 *   - `closing` — Set<paneId> of panes AWAITING close, decoupled from tickets.
 * The tab opens once and each ticket gets ONE tail pane. Injected (async):
 * openTab(title)->tabId, spawn(argv)->paneId, closePane(paneId), notify(t,b,s);
 * optional log(msg,err).
 *
 * Every herdr effect is BEST-EFFORT: a transient IPC failure on one call
 * (open/spawn/close/notify) is logged and swallowed, never rethrown — otherwise
 * one busy socket aborts the rest of the beat, dropping every remaining
 * notification, and the caller advances `prev` past them so they never re-fire.
 * A single isolated failure loses only that one ephemeral effect (the board row
 * still reflects state); it is surfaced to `log`, not hidden.
 *
 * Pane teardown is a two-step "retire then drain": a pane that should close is
 * moved from `tailed` into `closing` (a Map paneId→failed-attempts, keyed by pane
 * id NOT ticket id, so a failed close from an old run can't block spawning a new
 * pane for the same ticket id next run), then `closing` is drained. A close
 * SUCCEEDS when it neither throws NOR returns `{ ok: false }` (the herdr shim
 * signals failure by return, not exception) — success clears the pane. A failure
 * is retried on the next beat, but only up to BOUNDED_CLOSE_ATTEMPTS: a pane still
 * unclosable after that is GONE (the user closed it), not merely busy — retrying
 * a vanished pane forever would spawn a failing `herdr pane close` on every 400ms
 * beat, so we drop it (its tail process is already dead — nothing leaks). What
 * gets retired is the plan's call:
 *   - degrade (schema no longer understood) → retire ALL tracked panes and poll;
 *   - observed (a valid status) → retire every pane whose ticket is no longer
 *     in-flight (terminal, vanished, or unknown state);
 *   - NOT observed (null / unreadable status) → retire nothing: absence of data
 *     is not evidence a ticket ended, and wiping panes on a one-beat read blip
 *     would churn the UI and destroy scrollback.
 */
// Retry a failing pane close at most this many beats before assuming the pane is
// gone (not busy) and dropping it — bounds the retry so a manually-closed pane
// can't drive a per-beat `herdr pane close` spawn loop. Exported for the test.
export const BOUNDED_CLOSE_ATTEMPTS = 5;
// Retry a failing tail spawn at most this many beats PER TICKET before giving up
// on that ticket's pane — bounds the retry so a ticket whose tab/pane can't be
// created (e.g. the user closed the run tab) can't drive a failing `agent start`
// on every 400ms beat forever. Per-ticket (not whole-tab): a transient failure
// only costs the tickets it actually hit, never blinds the rest of the run.
// Exported for the test.
export const BOUNDED_SPAWN_ATTEMPTS = 5;

export async function runFleetPlan({ plan, repoRoot, state, openTab, spawn, closePane, notify, tagPane, log, heartbeat = false }) {
  if (!plan) return;
  if (!(state.closing instanceof Map)) state.closing = new Map(); // paneId → failed close attempts, decoupled from active tracking
  if (!(state.tagged instanceof Map)) state.tagged = new Map(); // ticketId → last state token published to its pane
  if (!(state.spawnFails instanceof Map)) state.spawnFails = new Map(); // ticketId → consecutive failed tail spawns
  // A herdr effect fails by THROWING (unexpected) or by RESOLVING { ok:false }
  // (the shim's normal failure signal — it never rejects for a runtime error).
  // Either way, LOG it (the daemon must surface every failure, not hide it) and
  // return null so the caller sees a uniform "no result". Effects whose injected
  // form already extracts an id (openTab/spawn → string|null) never yield { ok }.
  const safeCall = async (label, fn, ...args) => {
    try {
      const res = await fn(...args);
      if (res && res.ok === false) { log?.(`adlc-herdr fleet ${label} failed`, res.error ?? res.stderr ?? res.code); return null; }
      return res;
    } catch (err) { log?.(`adlc-herdr fleet ${label} failed`, err); return null; }
  };
  // Move every ACTIVE pane not in `keep` into the pending-close set (0 attempts).
  const retire = (keep) => {
    for (const [ticketId, paneId] of [...state.tailed]) {
      if (keep.has(ticketId)) continue;
      state.tailed.delete(ticketId);
      state.tagged.delete(ticketId); // forget its state token so a re-run re-tags
      if (typeof paneId === 'string' && paneId && !state.closing.has(paneId)) state.closing.set(paneId, 0);
    }
  };
  // Drain pending closes. A close fails if it throws OR returns { ok:false } (the
  // herdr shim reports failure by return, never by exception). On success, clear
  // the pane; on failure, retry next beat until BOUNDED_CLOSE_ATTEMPTS, then drop
  // it (a pane unclosable that long is gone, not busy — its tail process is dead).
  const drainClosing = async () => {
    for (const [paneId, attempts] of [...state.closing]) {
      let failed = false;
      try { const res = await closePane(paneId); if (res && res.ok === false) { failed = true; log?.('adlc-herdr fleet pane-close failed', res.error ?? res.stderr ?? res.code); } }
      catch (err) { failed = true; log?.('adlc-herdr fleet pane-close failed', err); }
      if (!failed) { state.closing.delete(paneId); continue; }
      if (attempts + 1 >= BOUNDED_CLOSE_ATTEMPTS) {
        state.closing.delete(paneId); // give up: assume the pane is gone, so stop the per-beat retry
        log?.('adlc-herdr fleet pane-close giving up (pane assumed already gone)', paneId);
      } else {
        state.closing.set(paneId, attempts + 1);
      }
    }
  };
  if (plan.degrade) {
    // We can see the run but no longer understand its schema: retire every pane
    // and fall back to polling, so none leak for the rest of the run.
    retire(new Set());
    await drainClosing();
    return;
  }
  if (plan.openTab) {
    // A new run: retire the PREVIOUS run's panes (closed via the drain below,
    // retried on failure — NOT force-forgotten) and reset the active tab.
    retire(new Set());
    state.tabId = null;
    // Clear spawn-failure counts too: a ticket id that recurs across runs (or a
    // retained failed ticket that stays in `desired`) would otherwise keep its
    // prior run's give-up count and never get a tail pane in the new run.
    state.spawnFails.clear();
    const tabId = await safeCall('open-tab', openTab, plan.openTab.title);
    if (typeof tabId === 'string' && tabId) state.tabId = tabId;
  }
  // The tickets that SHOULD have a tail pane this beat (the in-flight set).
  const desired = new Set(plan.tailPanes.map((p) => p.ticketId));
  // Drop spawn-failure counts for tickets no longer in-flight (terminated /
  // vanished / a new run) so a gave-up entry can't linger, and a ticket that
  // ever returns in-flight retries fresh.
  for (const t of [...state.spawnFails.keys()]) if (!desired.has(t)) state.spawnFails.delete(t);
  for (const pane of plan.tailPanes) {
    if (!state.tabId || state.tailed.has(pane.ticketId)) continue; // one tab, one pane per ticket
    if ((state.spawnFails.get(pane.ticketId) ?? 0) >= BOUNDED_SPAWN_ATTEMPTS) continue; // gave up — stop hammering
    const paneId = await safeCall('tail', spawn, fleetTailPaneArgs({ tabId: state.tabId, repoRoot, logPath: pane.logPath, ticketId: pane.ticketId, runId: pane.runId }));
    if (typeof paneId === 'string' && paneId) {
      // A REAL pane — remember it and reset this ticket's failure count.
      state.tailed.set(pane.ticketId, paneId);
      state.spawnFails.delete(pane.ticketId);
    } else {
      // A failed spawn (null/throw) retries next beat, but only up to the bound:
      // a ticket whose pane can't be created (dead tab) must not `agent start`
      // every 400ms forever. Bounded PER TICKET, so it never blinds the rest.
      const n = (state.spawnFails.get(pane.ticketId) ?? 0) + 1;
      state.spawnFails.set(pane.ticketId, n);
      if (n >= BOUNDED_SPAWN_ATTEMPTS) log?.('adlc-herdr fleet tail spawn giving up for ticket (tab/pane unavailable)', pane.ticketId);
    }
  }
  // Token-tag each tail pane with its ticket + CURRENT state (plan §5.5), rendered
  // natively by herdr so concurrent panes are distinguishable. Attempt the tag on a
  // state CHANGE or on a HEARTBEAT beat, and cache the ATTEMPT unconditionally — so
  // a tag that fails (e.g. the pane was manually closed) is NOT retried on every
  // 400ms beat; the periodic heartbeat re-tag (which ignores the cache) is the
  // retry, so a transient failure still recovers within a heartbeat, and the token
  // TTL never lapses. This mirrors the main token loop exactly (diff-publish on
  // change + full-refresh on heartbeat). Skipped when no tagger is injected.
  if (typeof tagPane === 'function') {
    for (const pane of plan.tailPanes) {
      const paneId = state.tailed.get(pane.ticketId);
      if (!paneId) continue;
      if (state.tagged.get(pane.ticketId) === pane.state && !heartbeat) continue;
      await safeCall('tag', tagPane, paneId, pane.ticketId, pane.state);
      state.tagged.set(pane.ticketId, pane.state); // cache the attempt: heartbeat is the retry, not every beat
    }
  }
  // Only a valid observation authorizes retiring active panes (see the doc comment).
  if (plan.observed) retire(desired);
  await drainClosing();
  for (const n of plan.notifications) await safeCall('notify', notify, n.title, n.body, n.sound);
}

/**
 * One observer beat for a single repo: plan the transition from the mutable
 * per-repo `st` (`{ prev, seen:Set, runState }`) against the freshly-read `curr`
 * status, execute it through the injected herdr `effects`, and commit progress
 * even on partial failure. Extracted from the daemon glue (bin/watcher.mjs) so
 * the whole beat is a pinned invariant, not untested wiring:
 *   - herdr effects are best-effort (see runFleetPlan): a per-call failure is
 *     logged via `log` — a long-running daemon must surface IPC/herdr failures,
 *     never swallow them silently — and never crashes the plugin host; the outer
 *     try/catch is a last-resort guard for an unexpected planning/state error; and
 *   - `prev` advances ONLY on a clean plan with a real `curr` status: a caught
 *     error (couldn't plan) or a null `curr` (no run / transient read error) must
 *     NOT wipe the baseline, or the missed transitions never re-fire next beat.
 * @param {object} a
 * @param {{prev:any, seen:Set, runState:{tabId:string|null, tailed:Map}}} a.st
 * @param {any} a.curr  the freshly-read fleet-status object (or null)
 * @param {string} a.repoRoot
 * @param {{openTab:Function, spawn:Function, closePane:Function, notify:Function, tagPane?:Function}} a.effects
 * @param {(message:string, err:unknown)=>void} [a.log]  observability sink
 * @param {boolean} [a.heartbeat]  a periodic full-refresh beat: re-tag panes to keep token TTLs alive
 */
export async function runFleetBridgeBeat({ st, curr, repoRoot, effects, log, heartbeat = false }) {
  let plan = null;
  try {
    plan = planFleetBridge({ prev: st.prev, curr, knownSchemaVersion: KNOWN_FLEET_SCHEMA_VERSION, seenRunIds: st.seen });
    // On a new run, runFleetPlan closes the prior run's panes and resets the
    // (persistent) run state in place — so it is passed by reference, not reassigned.
    await runFleetPlan({ plan, repoRoot, state: st.runState, ...effects, log, heartbeat });
  } catch (err) {
    log?.('adlc-herdr fleet bridge error', err);
  } finally {
    if (shouldMarkRunSeen(plan, st.runState)) st.seen.add(plan.openTab.runId);
    if (plan && curr) st.prev = curr;
  }
}
