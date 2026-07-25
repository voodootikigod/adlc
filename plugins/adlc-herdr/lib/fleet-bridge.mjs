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
      if (prevState !== state) {
        if (state === 'merged') {
          out.notifications.push({ ticketId: id, kind: 'merged', title: 'ADLC fleet', body: `${sanitizeToken(id)} merged`, sound: 'done' });
        } else {
          // herdr notifications carry no action buttons, so the worktree to
          // inspect is surfaced in the BODY (a one-click shell needs a herdr
          // notification-action API that does not exist yet — phase 4).
          const worktreePath = `.worktrees/fleet-${runId}`;
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

/**
 * Execute a fleet plan through injected effects, keeping per-run mutable `state`
 * (`{ tabId, tailed:Map<ticketId,paneId> }`) so the tab opens once, each ticket
 * gets ONE tail pane, and that pane is CLOSED when the ticket terminates (else a
 * long run leaks a pane per finished ticket). Injected (async): openTab(title)->
 * tabId, spawn(argv)->paneId, closePane(paneId), notify(t,b,s).
 */
export async function runFleetPlan({ plan, repoRoot, state, openTab, spawn, closePane, notify }) {
  if (!plan || plan.degrade) return;
  if (plan.openTab) {
    const tabId = await openTab(plan.openTab.title);
    if (typeof tabId === 'string' && tabId) state.tabId = tabId;
  }
  for (const pane of plan.tailPanes) {
    if (!state.tabId || state.tailed.has(pane.ticketId)) continue; // one tab, one pane per ticket
    const paneId = await spawn(fleetTailPaneArgs({ tabId: state.tabId, repoRoot, logPath: pane.logPath }));
    state.tailed.set(pane.ticketId, typeof paneId === 'string' ? paneId : null);
  }
  // Close the tail pane of any ticket that has reached a terminal state (it only
  // does so once — the entry is removed, so a stable terminal state is a no-op).
  for (const row of plan.boardRows) {
    if (!state.tailed.has(row.ticketId)) continue;
    const paneId = state.tailed.get(row.ticketId);
    if (paneId) await closePane(paneId);
    state.tailed.delete(row.ticketId);
  }
  for (const n of plan.notifications) await notify(n.title, n.body, n.sound);
}
