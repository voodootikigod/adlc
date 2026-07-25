// RAIL (t-herdr-9): the fleet observer's pure decision logic. Given the previous
// and current fleet-status (versioned by t-herdr-8), planFleetBridge computes the
// side effects — open a run tab once, tail panes for in-flight tickets, notify on
// terminal transitions, board summary rows — with NO I/O, failing soft on an
// unknown schema and refusing hostile ticket ids. bin/watcher.mjs only executes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFleetBridge, fleetTabArgs, fleetTailPaneArgs, openWorktreeShellArgs, runFleetPlan, KNOWN_FLEET_SCHEMA_VERSION } from '../lib/fleet-bridge.mjs';
import { renderBoard } from '../lib/board-render.mjs';

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
  assert.equal(byId['t-b'].worktreePath, '.worktrees/fleet-r1');
  assert.ok(!('t-c' in byId), 't-c was already merged in prev → no re-notification');
});

test('AC7 terminal tickets → board summary rows; in-flight ones do not', () => {
  const p = plan({ curr: status({ tickets: { 't-a': { state: 'building' }, 't-b': { state: 'failed' } } }) });
  assert.deepEqual(p.boardRows, [{ ticketId: 't-b', state: 'failed' }]);
});

test('runFleetPlan opens the tab, tails each ticket ONCE across beats, and notifies', async () => {
  const calls = { tab: [], spawn: [], notify: [] };
  const state = { tabId: null, tailed: new Set() };
  const deps = {
    repoRoot: '/repo', state,
    openTab: async (t) => { calls.tab.push(t); return 'w4:t9'; },
    spawn: async (a) => { calls.spawn.push(a); },
    notify: async (...n) => { calls.notify.push(n); },
  };
  const plan = {
    degrade: false, openTab: { runId: 'r1', title: 'fleet: run-r1' },
    tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }],
    notifications: [{ title: 'ADLC fleet', body: 't-a merged', sound: 'done' }], boardRows: [],
  };
  await runFleetPlan({ plan, ...deps });
  assert.equal(calls.tab.length, 1);
  assert.equal(state.tabId, 'w4:t9');
  assert.deepEqual(calls.spawn[0], fleetTailPaneArgs({ tabId: 'w4:t9', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log' }));
  assert.equal(calls.notify.length, 1);
  // next beat, same ticket still in-flight, tab already open → no re-tab, no re-tail
  await runFleetPlan({ plan: { ...plan, openTab: null }, ...deps });
  assert.equal(calls.tab.length, 1);
  assert.equal(calls.spawn.length, 1, 'each ticket is tailed exactly once');
});

test('runFleetPlan on a degrade performs no effects', async () => {
  let touched = false;
  const mark = async () => { touched = true; };
  await runFleetPlan({ plan: { degrade: true }, repoRoot: '/r', state: { tabId: null, tailed: new Set() }, openTab: mark, spawn: mark, notify: mark });
  assert.equal(touched, false);
});

test('the board renders a fleet section for terminal rows, and omits it with no run', () => {
  const base = { width: 80, repoRoot: '/r', groups: {}, paneRows: [], ledger: [] };
  const withFleet = renderBoard({ ...base, fleetRows: [{ ticketId: 't-b', state: 'failed' }] });
  assert.match(withFleet, /fleet/);
  assert.match(withFleet, /t-b · failed/);
  assert.doesNotMatch(renderBoard({ ...base, fleetRows: [] }), /fleet/);
});

test('AC8 fixed-argv builders: a shell-free tail -f argv, tab create, worktree shell', () => {
  assert.deepEqual(fleetTabArgs('fleet: run-r1'), ['tab', 'create', '--label', 'fleet: run-r1', '--no-focus']);
  assert.deepEqual(
    fleetTailPaneArgs({ tabId: 'w4:t2', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log' }),
    ['agent', 'start', 'adlc-fleet-tail', '--cwd', '/repo', '--tab', 'w4:t2', '--split', 'down', '--', 'tail', '-f', '--', '.adlc/fleet-logs/t-a.log'],
  );
  assert.deepEqual(
    openWorktreeShellArgs({ worktreePath: '/repo/.worktrees/fleet-r1', shell: 'bash' }),
    ['agent', 'start', 'adlc-fleet-shell', '--cwd', '/repo/.worktrees/fleet-r1', '--split', 'right', '--', 'bash'],
  );
});
