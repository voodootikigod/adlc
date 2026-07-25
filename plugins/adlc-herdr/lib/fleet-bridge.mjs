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

  for (const [id, rec] of Object.entries(tickets)) {
    if (!safeId(id)) continue; // hostile id → never reaches a log path, argv, or the board
    const state = rec && typeof rec.state === 'string' ? rec.state : null;
    if (!state) continue;
    if (IN_FLIGHT.has(state)) {
      out.tailPanes.push({ ticketId: id, state, logPath: `.adlc/fleet-logs/${id}.log` });
    } else if (TERMINAL.has(state)) {
      out.boardRows.push({ ticketId: id, state });
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
  return out;
}

// Fixed-argv builders (herdr contract probed 2026-07-25). Every externally-derived
// value is a validated token; the tail command is a fixed argv (no shell), with a
// `--` guard before the log path.
export function fleetTabArgs(title) {
  return ['tab', 'create', '--label', title, '--no-focus'];
}
export function fleetTailPaneArgs({ tabId, repoRoot, logPath, ticketId }) {
  // The agent NAME carries the pane's identity — `agent start` has no --label
  // (0.7.4: only --cwd/--env/--split), so a per-ticket name is what makes N
  // concurrent tail panes distinguishable in herdr's UI. `ticketId` is a
  // validated token upstream; fall back to the generic name if it's absent.
  const agentName = typeof ticketId === 'string' && ticketId ? `adlc-fleet-${ticketId}` : 'adlc-fleet-tail';
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

export async function runFleetPlan({ plan, repoRoot, state, openTab, spawn, closePane, notify, tagPane, log }) {
  if (!plan) return;
  if (!(state.closing instanceof Map)) state.closing = new Map(); // paneId → failed close attempts, decoupled from active tracking
  if (!(state.tagged instanceof Map)) state.tagged = new Map(); // ticketId → last state token published to its pane
  const safeCall = async (label, fn, ...args) => {
    try { return await fn(...args); } catch (err) { log?.(`adlc-herdr fleet ${label} failed`, err); return null; }
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
      try { const res = await closePane(paneId); if (res && res.ok === false) failed = true; }
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
    const tabId = await safeCall('open-tab', openTab, plan.openTab.title);
    if (typeof tabId === 'string' && tabId) state.tabId = tabId;
  }
  // The tickets that SHOULD have a tail pane this beat (the in-flight set).
  const desired = new Set(plan.tailPanes.map((p) => p.ticketId));
  for (const pane of plan.tailPanes) {
    if (!state.tabId || state.tailed.has(pane.ticketId)) continue; // one tab, one pane per ticket
    const paneId = await safeCall('tail', spawn, fleetTailPaneArgs({ tabId: state.tabId, repoRoot, logPath: pane.logPath, ticketId: pane.ticketId }));
    // Only remember a REAL pane — a failed spawn (null/throw) must retry next
    // beat, not be cached as "already tailed" and deprive the ticket of logs.
    if (typeof paneId === 'string' && paneId) state.tailed.set(pane.ticketId, paneId);
  }
  // Token-tag each tail pane with its ticket + CURRENT state (plan §5.5), rendered
  // natively by herdr so concurrent panes are distinguishable. Re-tag only when the
  // state actually changed (no per-beat token spam); best-effort, and skipped when
  // no tagger is injected (unit tests that don't exercise tagging).
  if (typeof tagPane === 'function') {
    for (const pane of plan.tailPanes) {
      const paneId = state.tailed.get(pane.ticketId);
      if (!paneId || state.tagged.get(pane.ticketId) === pane.state) continue;
      await safeCall('tag', tagPane, paneId, pane.ticketId, pane.state);
      state.tagged.set(pane.ticketId, pane.state);
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
 * @param {{openTab:Function, spawn:Function, closePane:Function, notify:Function}} a.effects
 * @param {(message:string, err:unknown)=>void} [a.log]  observability sink
 */
export async function runFleetBridgeBeat({ st, curr, repoRoot, effects, log }) {
  let plan = null;
  try {
    plan = planFleetBridge({ prev: st.prev, curr, knownSchemaVersion: KNOWN_FLEET_SCHEMA_VERSION, seenRunIds: st.seen });
    // On a new run, runFleetPlan closes the prior run's panes and resets the
    // (persistent) run state in place — so it is passed by reference, not reassigned.
    await runFleetPlan({ plan, repoRoot, state: st.runState, ...effects, log });
  } catch (err) {
    log?.('adlc-herdr fleet bridge error', err);
  } finally {
    if (shouldMarkRunSeen(plan, st.runState)) st.seen.add(plan.openTab.runId);
    if (plan && curr) st.prev = curr;
  }
}
