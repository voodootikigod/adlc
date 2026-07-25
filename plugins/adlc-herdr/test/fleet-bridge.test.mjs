// RAIL (t-herdr-9): the fleet observer's pure decision logic. Given the previous
// and current fleet-status (versioned by t-herdr-8), planFleetBridge computes the
// side effects — open a run tab once, tail panes for in-flight tickets, notify on
// terminal transitions, board summary rows — with NO I/O, failing soft on an
// unknown schema and refusing hostile ticket ids. bin/watcher.mjs only executes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFleetBridge, fleetTabArgs, fleetTailPaneArgs, fleetPaneCloseArgs, runFleetPlan, runFleetBridgeBeat, tabIdFromResponse, paneIdFromResponse, shouldMarkRunSeen, KNOWN_FLEET_SCHEMA_VERSION } from '../lib/fleet-bridge.mjs';
import { renderBoard } from '../lib/board-render.mjs';
import { readFleetStatus } from '../lib/adlc-state.mjs';

const V = 1; // knownSchemaVersion under test
const status = (over = {}) => ({ schemaVersion: V, runId: 'r1', tickets: {}, ...over });
const plan = (over, seen = []) => planFleetBridge({ prev: over.prev ?? null, curr: over.curr, knownSchemaVersion: V, seenRunIds: new Set(seen) });

test('AC1 no run → an empty plan (nothing to do, not a degrade)', () => {
  const p = planFleetBridge({ prev: null, curr: null, knownSchemaVersion: V, seenRunIds: new Set() });
  assert.deepEqual(p, { degrade: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] });
});

test('AC2 unknown/absent schemaVersion → degrade (poll instead of trusting the file)', () => {
  assert.equal(plan({ curr: status({ schemaVersion: undefined }) }).degrade, true);
  assert.equal(plan({ curr: status({ schemaVersion: 999 }) }).degrade, true);
  // a degrade carries no effects
  assert.deepEqual(plan({ curr: status({ schemaVersion: 999 }) }).tailPanes, []);
});

test('AC3 a new run opens the tab once; an already-seen run does not', () => {
  const fresh = plan({ curr: status({ runId: 'run-9' }) });
  assert.deepEqual(fresh.openTab, { runId: 'run-9', title: 'fleet: run-run-9' });
  const seen = plan({ curr: status({ runId: 'run-9' }) }, ['run-9']);
  assert.equal(seen.openTab, null);
});

test('AC4 in-flight tickets → tail panes with a safe log path; terminal ones do not', () => {
  const p = plan({ curr: status({ tickets: { 't-a': { state: 'building' }, 't-b': { state: 'merged' }, 't-c': { state: 'prosecuting' } } }) });
  const byId = Object.fromEntries(p.tailPanes.map((x) => [x.ticketId, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['t-a', 't-c']);
  assert.equal(byId['t-a'].logPath, '.adlc/fleet-logs/t-a.log');
  assert.equal(byId['t-a'].state, 'building');
});

test('EVERY in-flight state yields a tail pane (pins the IN_FLIGHT set + version)', () => {
  assert.equal(KNOWN_FLEET_SCHEMA_VERSION, 1); // the version this plugin understands
  for (const s of ['building', 'gating', 'prosecuting', 'fixing', 'merging']) {
    const p = plan({ curr: status({ tickets: { 't-x': { state: s } } }) });
    assert.equal(p.tailPanes.length, 1, `${s} → one tail pane`);
    assert.equal(p.boardRows.length, 0, `${s} is not terminal`);
  }
});

test('EVERY terminal state yields a board row + a transition notification (pins the TERMINAL set)', () => {
  for (const s of ['merged', 'failed', 'blocked']) {
    const prev = status({ tickets: { 't-x': { state: 'building' } } });
    const curr = status({ tickets: { 't-x': { state: s } } });
    const p = planFleetBridge({ prev, curr, knownSchemaVersion: V, seenRunIds: new Set(['r1']) });
    assert.deepEqual(p.boardRows, [{ ticketId: 't-x', state: s }], `${s} → board row`);
    assert.equal(p.notifications.length, 1, `${s} → one notification`);
    assert.equal(p.notifications[0].sound, s === 'merged' ? 'done' : 'request');
    assert.equal(p.tailPanes.length, 0, `${s} is not in-flight`);
  }
});

test('AC5 a hostile ticket id is skipped entirely (no tail pane, no board row, no path)', () => {
  const p = plan({ curr: status({ tickets: { 'a/b': { state: 'building' }, '../evil': { state: 'building' }, '-x': { state: 'merged' } } }) });
  assert.deepEqual(p.tailPanes, []);
  assert.deepEqual(p.boardRows, []);
});

test('AC6 terminal transitions → notifications; a stable terminal state does not re-notify', () => {
  const prev = status({ tickets: { 't-a': { state: 'building' }, 't-b': { state: 'building' }, 't-c': { state: 'merged' } } });
  const curr = status({ tickets: { 't-a': { state: 'merged' }, 't-b': { state: 'failed' }, 't-c': { state: 'merged' } } });
  const p = planFleetBridge({ prev, curr, knownSchemaVersion: V, seenRunIds: new Set(['r1']) });
  const byId = Object.fromEntries(p.notifications.map((n) => [n.ticketId, n]));
  assert.equal(byId['t-a'].kind, 'merged'); assert.equal(byId['t-a'].sound, 'done');
  assert.equal(byId['t-b'].kind, 'failed'); assert.equal(byId['t-b'].sound, 'request');
  assert.equal(byId['t-b'].worktreePath, '.worktrees/fleet-t-b'); // per-TICKET worktree (§6.3), not the run
  assert.ok(!('t-c' in byId), 't-c was already merged in prev → no re-notification');
});

test('a baseline beat does NOT notify — first observation AND a NEW run vs the prior run', () => {
  const terminals = { tickets: { 't-a': { state: 'merged' }, 't-b': { state: 'failed' } } };
  // first observation (no prev)
  const first = planFleetBridge({ prev: null, curr: status(terminals), knownSchemaVersion: V, seenRunIds: new Set(['r1']) });
  assert.deepEqual(first.notifications, [], 'no storm for pre-existing terminals on startup');
  assert.equal(first.boardRows.length, 2, 'they still appear as board rows');
  // new run: prev belongs to a DIFFERENT runId → its tickets must not be compared
  const prevRun = status({ runId: 'r0', tickets: { 't-a': { state: 'building' } } });
  const newRun = status({ runId: 'r1', ...terminals });
  const cross = planFleetBridge({ prev: prevRun, curr: newRun, knownSchemaVersion: V, seenRunIds: new Set(['r1']) });
  assert.deepEqual(cross.notifications, [], 'a new run is a fresh baseline, not cross-run transitions');
});

test('shouldMarkRunSeen: only when a tab was requested AND actually opened', () => {
  assert.equal(shouldMarkRunSeen({ openTab: { runId: 'r' } }, { tabId: 'w4:t1' }), true);
  assert.equal(shouldMarkRunSeen({ openTab: { runId: 'r' } }, { tabId: null }), false); // tab failed → retry
  assert.equal(shouldMarkRunSeen({ openTab: null }, { tabId: 'w4:t1' }), false); // not a new run
  assert.equal(shouldMarkRunSeen(null, { tabId: 'w4:t1' }), false);
});

test('readFleetStatus reads a valid status and fails soft on bad input', () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-fleet-read-'));
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  const p = join(repo, '.adlc', 'fleet-status.json');
  writeFileSync(p, JSON.stringify({ schemaVersion: 1, runId: 'r1', tickets: {} }));
  assert.equal(readFleetStatus(repo).runId, 'r1');
  assert.equal(readFleetStatus(null), null); // non-string root → null WITHOUT reaching isAbsolute (pins the `||` guard)
  assert.equal(readFleetStatus('relative/path'), null); // non-absolute root → null (pins the guard)
  assert.equal(readFleetStatus(join(repo, 'nope')), null); // missing → null
  writeFileSync(p, '{ not json');
  assert.equal(readFleetStatus(repo), null); // malformed → null
  writeFileSync(p, '[1,2,3]');
  assert.equal(readFleetStatus(repo), null); // array is not a status object → null
});

test('runFleetPlan closes the previous run panes when a new run starts (no restart leak)', async () => {
  const closed = [];
  const state = { tabId: 'w4:t1', tailed: new Map([['t-old', 'w4:p1']]) };
  await runFleetPlan({
    plan: { degrade: false, openTab: { runId: 'r2', title: 'fleet: run-r2' }, tailPanes: [], notifications: [], boardRows: [] },
    repoRoot: '/r', state,
    openTab: async () => 'w4:t2', spawn: async () => 'w4:p2', closePane: async (p) => closed.push(p), notify: async () => {},
  });
  assert.deepEqual(closed, ['w4:p1'], 'the prior run pane is closed');
  assert.equal(state.tabId, 'w4:t2', 'the new tab is adopted');
  assert.equal(state.tailed.has('t-old'), false, 'the old pane is forgotten');
});

test('AC7 terminal tickets → board summary rows; in-flight ones do not', () => {
  const p = plan({ curr: status({ tickets: { 't-a': { state: 'building' }, 't-b': { state: 'failed' } } }) });
  assert.deepEqual(p.boardRows, [{ ticketId: 't-b', state: 'failed' }]);
});

test('runFleetPlan opens the tab, tails each ticket ONCE, then CLOSES the pane on terminal', async () => {
  const calls = { tab: [], spawn: [], close: [], notify: [] };
  const state = { tabId: null, tailed: new Map() };
  const deps = {
    repoRoot: '/repo', state,
    openTab: async (t) => { calls.tab.push(t); return 'w4:t9'; },
    spawn: async (a) => { calls.spawn.push(a); return 'w4:p5'; },
    closePane: async (p) => { calls.close.push(p); },
    notify: async (...n) => { calls.notify.push(n); },
  };
  const building = {
    degrade: false, openTab: { runId: 'r1', title: 'fleet: run-r1' },
    tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }],
    notifications: [], boardRows: [],
  };
  await runFleetPlan({ plan: building, ...deps });
  assert.equal(state.tabId, 'w4:t9');
  assert.deepEqual(calls.spawn[0], fleetTailPaneArgs({ tabId: 'w4:t9', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log' }));
  assert.equal(state.tailed.get('t-a'), 'w4:p5');
  // next beat, still building, tab open → no re-tab, no re-tail, no close
  await runFleetPlan({ plan: { ...building, openTab: null }, ...deps });
  assert.equal(calls.tab.length, 1);
  assert.equal(calls.spawn.length, 1, 'tailed exactly once');
  assert.equal(calls.close.length, 0);
  // t-a terminates → its tail pane is closed exactly once and forgotten
  const merged = { degrade: false, openTab: null, tailPanes: [], notifications: [], boardRows: [{ ticketId: 't-a', state: 'merged' }] };
  await runFleetPlan({ plan: merged, ...deps });
  assert.deepEqual(calls.close, ['w4:p5']);
  assert.equal(state.tailed.has('t-a'), false);
  await runFleetPlan({ plan: merged, ...deps }); // stable terminal → no double-close
  assert.equal(calls.close.length, 1, 'a terminated pane is closed exactly once');
});

test('tabIdFromResponse / paneIdFromResponse extract the id and fail soft', () => {
  assert.equal(tabIdFromResponse({ ok: true, value: { result: { tab: { tab_id: 'w4:t2' } } } }), 'w4:t2');
  assert.equal(tabIdFromResponse({ ok: true, value: { result: { tab_id: 'w4:t3' } } }), 'w4:t3');
  assert.equal(tabIdFromResponse({ ok: false }), null);
  assert.equal(tabIdFromResponse(null), null);
  assert.equal(paneIdFromResponse({ ok: true, value: { result: { pane: { pane_id: 'w4:p5' } } } }), 'w4:p5');
  assert.equal(paneIdFromResponse({ ok: true, value: { result: {} } }), null);
  assert.equal(paneIdFromResponse({ ok: false }), null);
});

test('runFleetPlan RETRIES a tail pane whose spawn failed (null is not cached)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map() };
  let n = 0;
  const spawn = async () => (n++ === 0 ? null : 'w4:p9'); // first fails, second succeeds
  const plan = { degrade: false, openTab: null, tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }], notifications: [], boardRows: [] };
  const deps = { openTab: async () => 'x', closePane: async () => {}, notify: async () => {} };
  await runFleetPlan({ plan, repoRoot: '/r', state, spawn, ...deps });
  assert.equal(state.tailed.has('t-a'), false, 'a failed spawn is not cached');
  await runFleetPlan({ plan, repoRoot: '/r', state, spawn, ...deps });
  assert.equal(state.tailed.get('t-a'), 'w4:p9', 'retried and cached on the next success');
});

test('runFleetPlan TOLERATES a closePane failure — entry forgotten, notifications still fire', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:p5']]) };
  const notified = [];
  const plan = { degrade: false, openTab: null, tailPanes: [], notifications: [{ title: 'x', body: 'y', sound: 'done' }], boardRows: [{ ticketId: 't-a', state: 'merged' }] };
  await runFleetPlan({
    plan, repoRoot: '/r', state,
    openTab: async () => {}, spawn: async () => {},
    closePane: async () => { throw new Error('pane already gone'); },
    notify: async (...a) => { notified.push(a); },
  });
  assert.equal(state.tailed.has('t-a'), false, 'entry forgotten despite the close failure');
  assert.equal(notified.length, 1, 'notifications still fire after a close failure');
});

test('runFleetPlan on a degrade performs no effects', async () => {
  let touched = false;
  const mark = async () => { touched = true; };
  await runFleetPlan({ plan: { degrade: true }, repoRoot: '/r', state: { tabId: null, tailed: new Map() }, openTab: mark, spawn: mark, closePane: mark, notify: mark });
  assert.equal(touched, false);
});

test('the board renders a fleet section for terminal rows, and omits it with no run', () => {
  const base = { width: 80, repoRoot: '/r', groups: {}, paneRows: [], ledger: [] };
  const withFleet = renderBoard({ ...base, fleetRows: [{ ticketId: 't-b', state: 'failed' }] });
  assert.match(withFleet, /fleet/);
  assert.match(withFleet, /t-b · failed/);
  assert.doesNotMatch(renderBoard({ ...base, fleetRows: [] }), /fleet/);
});

test('runFleetBridgeBeat happy path: effects run, prev advances to curr, run marked seen, no error logged', async () => {
  const st = { prev: null, seen: new Set(), runState: { tabId: null, tailed: new Map() } };
  const curr = status({ runId: 'r7', tickets: { 't-a': { state: 'building' } } });
  const logged = [];
  const notify = [];
  await runFleetBridgeBeat({
    st, curr, repoRoot: '/repo',
    effects: {
      openTab: async () => 'w4:t9',
      spawn: async () => 'w4:p5',
      closePane: async () => {},
      notify: async (...n) => { notify.push(n); },
    },
    log: (m, e) => logged.push([m, e]),
  });
  assert.equal(st.prev, curr, 'prev advances to the observed status');
  assert.equal(st.seen.has('r7'), true, 'the run is marked seen once its tab opened');
  assert.equal(st.runState.tabId, 'w4:t9', 'the tab id is retained in the run state');
  assert.equal(logged.length, 0, 'a clean beat logs nothing');
});

test('runFleetBridgeBeat surfaces an effect failure via log but never throws, and still advances prev', async () => {
  const st = { prev: null, seen: new Set(), runState: { tabId: null, tailed: new Map() } };
  const curr = status({ runId: 'r8', tickets: { 't-a': { state: 'building' } } });
  const logged = [];
  await assert.doesNotReject(runFleetBridgeBeat({
    st, curr, repoRoot: '/repo',
    effects: {
      openTab: async () => { throw new Error('herdr socket refused'); }, // IPC failure mid-beat
      spawn: async () => 'w4:p5',
      closePane: async () => {},
      notify: async () => {},
    },
    log: (m, e) => logged.push([m, e]),
  }));
  assert.equal(logged.length, 1, 'the swallowed error is surfaced to the log sink (observability)');
  assert.match(logged[0][0], /fleet bridge/, 'the log message identifies the fleet bridge');
  assert.equal(logged[0][1].message, 'herdr socket refused', 'the actual error is passed through');
  assert.equal(st.prev, curr, 'prev still advances so a transient error does not re-fire the beat forever');
});

test('runFleetBridgeBeat tolerates a missing log sink (log is optional)', async () => {
  const st = { prev: null, seen: new Set(), runState: { tabId: null, tailed: new Map() } };
  await assert.doesNotReject(runFleetBridgeBeat({
    st, curr: status({ tickets: { 't-a': { state: 'building' } } }), repoRoot: '/repo',
    effects: { openTab: async () => { throw new Error('boom'); }, spawn: async () => {}, closePane: async () => {}, notify: async () => {} },
  }));
});

test('AC8 fixed-argv builders: a shell-free tail -f argv, tab create, pane close', () => {
  assert.deepEqual(fleetTabArgs('fleet: run-r1'), ['tab', 'create', '--label', 'fleet: run-r1', '--no-focus']);
  assert.deepEqual(
    fleetTailPaneArgs({ tabId: 'w4:t2', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log' }),
    ['agent', 'start', 'adlc-fleet-tail', '--cwd', '/repo', '--tab', 'w4:t2', '--split', 'down', '--', 'tail', '-f', '--', '.adlc/fleet-logs/t-a.log'],
  );
  assert.deepEqual(fleetPaneCloseArgs('w4:p5'), ['pane', 'close', 'w4:p5']);
});
