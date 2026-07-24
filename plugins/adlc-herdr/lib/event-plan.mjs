// Pure event decision logic (plan §5.4). Given a herdr event name (dotted,
// e.g. "pane.exited"), the parsed HERDR_PLUGIN_EVENT_JSON payload, and injected
// repo-state readers, return exactly one plan — the glue (bin/on-event.mjs)
// performs the I/O. Contract frozen in test/event-plan.test.mjs (rail).
//
// Everything fails closed to {kind:'none'}: an unknown event, a malformed
// payload, a hostile id, or a missing repo produces no side effect. Plans are
// advisory data only — never a write, never a spawn.
import { sanitize, sanitizeToken } from './sanitize.mjs';

// Same identifier discipline as lib/actions: no leading hyphen (argument
// injection), only known-safe characters.
const PANE_ID_RE = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;
const IDLE_STATES = new Set(['idle', 'done']);

const none = (reason) => ({ kind: 'none', reason });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function planPaneExited(data) {
  const paneId = data.pane_id;
  if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) return none('invalid pane id');
  return { kind: 'clear-pane', paneId };
}

async function planWorktreeCreated(data, { listTicketIds, hasCurrentTicket }) {
  const ws = isObj(data.workspace) ? data.workspace : null;
  const repoRoot = ws && isObj(ws.worktree) ? ws.worktree.repo_root : null;
  const branch = ws ? ws.label : null;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return none('no repo root');
  if (typeof branch !== 'string' || branch.length === 0) return none('no branch');
  if (hasCurrentTicket(repoRoot)) return none('already has an active ticket'); // don't nag
  // listTicketIds reads the store directly from the filesystem: the untrusted
  // repoRoot is only ever a read target, and is never passed as a subprocess
  // working directory.
  const ids = await listTicketIds(repoRoot);
  if (!Array.isArray(ids) || !ids.includes(branch)) return none('branch is not a ticket id');
  return {
    kind: 'notify',
    title: 'ADLC',
    body: sanitize(`worktree ${sanitizeToken(branch)} matches ticket ${sanitizeToken(branch)} — set it active?`),
    sound: 'none',
  };
}

async function planAgentStatusChanged(data, { resolveRepoForPane, readActiveTicket, claim }) {
  const status = data.agent_status;
  if (typeof status !== 'string' || !IDLE_STATES.has(status)) return none('not an idle/done transition');
  const paneId = data.pane_id;
  if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) return none('invalid pane id');
  const repoRoot = await resolveRepoForPane(paneId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return none('pane not in a repo');
  const active = readActiveTicket(repoRoot);
  if (!active || active.state !== 'active') return none('no active ticket to gate');
  // Atomic claim: only the FIRST process to record this (pane,ticket,status)
  // notifies — herdr spawns one process per event, so a check-then-write would
  // race under a status flap and spam. `claim` returns true only for the winner.
  const key = `${paneId}|${active.id}|${status}`;
  if (!(await claim(key))) return none('already nudged for this transition');
  return {
    kind: 'notify',
    title: 'ADLC',
    body: sanitize(`${sanitizeToken(active.id)} went ${sanitizeToken(status)} — gate it?`),
    sound: 'request',
  };
}

/**
 * Decide what (if anything) to do for a herdr event.
 * @returns {Promise<{kind:'clear-pane',paneId}|{kind:'notify',title,body,sound}|{kind:'none',reason}>}
 */
export async function planEvent(eventName, payload, deps) {
  if (!isObj(payload) || !isObj(payload.data)) return none('malformed payload');
  const { data } = payload;
  switch (eventName) {
    case 'pane.exited':
      return planPaneExited(data);
    case 'worktree.created':
      return planWorktreeCreated(data, deps);
    case 'pane.agent_status_changed':
      return planAgentStatusChanged(data, deps);
    default:
      return none('unhandled event');
  }
}
