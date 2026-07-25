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

const EMPTY = () => ({ degrade: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] });

/**
 * Plan the observer's side effects for a fleet-status transition.
 * @returns {{degrade:boolean, openTab:{runId:string,title:string}|null,
 *   tailPanes:Array, notifications:Array, boardRows:Array}}
 */
export function planFleetBridge({ prev, curr, knownSchemaVersion, seenRunIds }) {
  if (!curr || typeof curr !== 'object') return EMPTY(); // no run in progress
  if (curr.schemaVersion !== knownSchemaVersion) return { ...EMPTY(), degrade: true };
  if (!safeId(curr.runId)) return { ...EMPTY(), degrade: true }; // malformed run → can't observe safely
  const runId = curr.runId;

  const tickets = curr.tickets && typeof curr.tickets === 'object' ? curr.tickets : {};
  const prevTickets = prev && typeof prev.tickets === 'object' ? prev.tickets : {};
  // Notify only on a transition observed WITHIN THE SAME run: the first beat of a
  // run (no prev, or prev belongs to a different runId) is a baseline, not
  // transitions — else a watcher starting mid-run, or a restarted run, storms one
  // notification per already-terminal ticket.
  const sameRun = Boolean(prev && typeof prev === 'object' && prev.runId === runId);
  const seen = seenRunIds instanceof Set ? seenRunIds : new Set();

  const out = EMPTY();
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
export function fleetTailPaneArgs({ tabId, repoRoot, logPath }) {
  return ['agent', 'start', 'adlc-fleet-tail', '--cwd', repoRoot, '--tab', tabId, '--split', 'down', '--', 'tail', '-f', '--', logPath];
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
 * Execute a fleet plan through injected effects, keeping per-run mutable `state`
 * (`{ tabId, tailed:Map<ticketId,paneId> }`) so the tab opens once, each ticket
 * gets ONE tail pane, and that pane is CLOSED when the ticket terminates (else a
 * long run leaks a pane per finished ticket). Injected (async): openTab(title)->
 * tabId, spawn(argv)->paneId, closePane(paneId), notify(t,b,s).
 */
export async function runFleetPlan({ plan, repoRoot, state, openTab, spawn, closePane, notify }) {
  if (!plan || plan.degrade) return;
  // Closing a pane can throw if the user already closed it — best-effort, so one
  // dead pane never aborts the run (which would block every later notification).
  const safeClose = async (paneId) => { if (paneId) { try { await closePane(paneId); } catch { /* pane may already be gone */ } } };
  if (plan.openTab) {
    // A new run: close the PREVIOUS run's tail panes (they belong to the old
    // tab) and reset, so a restarted run never abandons/leaks panes.
    for (const paneId of state.tailed.values()) await safeClose(paneId);
    state.tailed.clear();
    state.tabId = null;
    const tabId = await openTab(plan.openTab.title);
    if (typeof tabId === 'string' && tabId) state.tabId = tabId;
  }
  for (const pane of plan.tailPanes) {
    if (!state.tabId || state.tailed.has(pane.ticketId)) continue; // one tab, one pane per ticket
    const paneId = await spawn(fleetTailPaneArgs({ tabId: state.tabId, repoRoot, logPath: pane.logPath }));
    // Only remember a REAL pane — a failed spawn (null) must retry next beat, not
    // be cached as "already tailed" and silently deprive the ticket of logs.
    if (typeof paneId === 'string' && paneId) state.tailed.set(pane.ticketId, paneId);
  }
  // Close the tail pane of any ticket that has reached a terminal state. Forget
  // the entry FIRST, so a throwing close can't leave it to be retried every beat.
  for (const row of plan.boardRows) {
    if (!state.tailed.has(row.ticketId)) continue;
    const paneId = state.tailed.get(row.ticketId);
    state.tailed.delete(row.ticketId);
    await safeClose(paneId);
  }
  for (const n of plan.notifications) await notify(n.title, n.body, n.sound);
}

/**
 * One observer beat for a single repo: plan the transition from the mutable
 * per-repo `st` (`{ prev, seen:Set, runState }`) against the freshly-read `curr`
 * status, execute it through the injected herdr `effects`, and commit progress
 * even on partial failure. Extracted from the daemon glue (bin/watcher.mjs) so
 * the whole beat is a pinned invariant, not untested wiring:
 *   - a fleet-bridge error is LOGGED via `log` (a long-running daemon must
 *     surface IPC/herdr failures — never swallow them silently) but NEVER
 *     rethrown, so one hiccup can't crash the plugin host; and
 *   - `prev` always advances to `curr` (and a run is marked seen the moment its
 *     tab exists), so a transient error can't re-fire the same beat forever.
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
    await runFleetPlan({ plan, repoRoot, state: st.runState, ...effects });
  } catch (err) {
    log?.('adlc-herdr fleet bridge error', err);
  } finally {
    if (shouldMarkRunSeen(plan, st.runState)) st.seen.add(plan.openTab.runId);
    st.prev = curr;
  }
}
