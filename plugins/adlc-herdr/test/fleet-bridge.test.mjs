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
import { planFleetBridge, fleetTabArgs, fleetTailPaneArgs, fleetPaneCloseArgs, fleetWorktreeShellArgs, runFleetPlan, runFleetBridgeBeat, tabIdFromResponse, paneIdFromResponse, shouldMarkRunSeen, KNOWN_FLEET_SCHEMA_VERSION, BOUNDED_CLOSE_ATTEMPTS, BOUNDED_SPAWN_ATTEMPTS, MAX_TAIL_PANES } from '../lib/fleet-bridge.mjs';
import { renderBoard } from '../lib/board-render.mjs';
import { readFleetStatus } from '../lib/adlc-state.mjs';

const V = 1; // knownSchemaVersion under test
const status = (over = {}) => ({ schemaVersion: V, runId: 'r1', tickets: {}, ...over });
const plan = (over, seen = []) => planFleetBridge({ prev: over.prev ?? null, curr: over.curr, knownSchemaVersion: V, seenRunIds: new Set(seen) });

test('AC1 no run → an empty plan (nothing to do, not a degrade, not observed)', () => {
  const p = planFleetBridge({ prev: null, curr: null, knownSchemaVersion: V, seenRunIds: new Set() });
  assert.deepEqual(p, { degrade: false, observed: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] });
});

test('observed flags a plan built from a VALID status only (null/degrade are not observed)', () => {
  assert.equal(plan({ curr: null }).observed, false, 'no run → not observed');
  assert.equal(plan({ curr: status({ schemaVersion: 999 }) }).observed, false, 'degrade → not observed');
  assert.equal(plan({ curr: status({ tickets: { 't-a': { state: 'building' } } }) }).observed, true, 'a valid status → observed');
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
    // A merged ticket releases its pane; a failed/blocked ticket RETAINS it so the
    // failure output stays readable (round 18).
    assert.equal(p.tailPanes.length, s === 'merged' ? 0 : 1, `${s} pane retention`);
    if (s !== 'merged') assert.deepEqual(p.tailPanes[0], { ticketId: 't-x', state: s, logPath: '.adlc/fleet-logs/t-x.log', runId: 'r1' });
  }
});

test('a failed/blocked pane is RETAINED so the executor keeps it open (round 18); merged closes it', async () => {
  // building → the pane exists; then the ticket fails. The retained tailPane keeps
  // it out of teardown, so the developer can still read the failure log.
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa']]), closing: new Map(), tagged: new Map(), spawnFails: new Map() };
  const closed = [];
  const failedPlan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [{ ticketId: 't-a', state: 'failed' }], tailPanes: [{ ticketId: 't-a', state: 'failed', logPath: '.adlc/fleet-logs/t-a.log' }] };
  await runFleetPlan({ plan: failedPlan, repoRoot: '/r', state, openTab: async () => {}, spawn: async () => 'w4:pa', closePane: async (p) => closed.push(p), notify: async () => {} });
  assert.deepEqual(closed, [], 'a failed ticket pane is NOT closed');
  assert.equal(state.tailed.get('t-a'), 'w4:pa', 'and stays tracked');
  // merged, by contrast, is absent from tailPanes → retired + closed
  const mergedPlan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [{ ticketId: 't-a', state: 'merged' }], tailPanes: [] };
  await runFleetPlan({ plan: mergedPlan, repoRoot: '/r', state, openTab: async () => {}, spawn: async () => {}, closePane: async (p) => closed.push(p), notify: async () => {} });
  assert.deepEqual(closed, ['w4:pa'], 'a merged ticket pane IS closed');
});

test('planFleetBridge CAPS tail panes at MAX_TAIL_PANES — an untrusted status cannot spawn thousands of panes (DoS guard, round 22)', () => {
  const tickets = {};
  for (let i = 0; i < MAX_TAIL_PANES + 30; i += 1) tickets[`t-${i}`] = { state: 'building' };
  const p = plan({ curr: status({ tickets }) });
  assert.equal(p.tailPanes.length, MAX_TAIL_PANES, 'tail panes are bounded regardless of the ticket count in the file');
});

test('planFleetBridge PRIORITIZES active builds over retained failed panes in the shared tail quota (round 23)', () => {
  const tickets = {};
  // Many FAILED tickets appear FIRST in insertion order, then one active build.
  for (let i = 0; i < MAX_TAIL_PANES + 5; i += 1) tickets[`f-${i}`] = { state: 'failed' };
  tickets['t-build'] = { state: 'building' };
  const p = plan({ curr: status({ tickets }) });
  const ids = p.tailPanes.map((x) => x.ticketId);
  assert.equal(p.tailPanes.length, MAX_TAIL_PANES, 'the quota is still capped');
  assert.ok(ids.includes('t-build'), 'the active building ticket is tailed — never starved by earlier failed panes');
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

test('planFleetBridge is TOTAL on a poisoned prev with tickets:null — no TypeError (typeof null === object footgun)', () => {
  // A prior (untrusted) status with `tickets: null`: without the truthiness guard,
  // prevTickets would be null and prevTickets[id] would throw, poisoning prev
  // forever (it never advances past the throwing beat) → the observer dies.
  const prev = { schemaVersion: V, runId: 'r1', tickets: null };
  const curr = status({ runId: 'r1', tickets: { 't-a': { state: 'merged' } } });
  let p;
  assert.doesNotThrow(() => { p = planFleetBridge({ prev, curr, knownSchemaVersion: V, seenRunIds: new Set(['r1']) }); });
  assert.deepEqual(p.boardRows, [{ ticketId: 't-a', state: 'merged' }], 'prevTickets treated as {} → the ticket still summarizes');
  assert.equal(p.notifications.length, 1, 'and the merge reads as a fresh transition, not a crash');
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
    degrade: false, observed: true, openTab: { runId: 'r1', title: 'fleet: run-r1' },
    tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }],
    notifications: [], boardRows: [],
  };
  await runFleetPlan({ plan: building, ...deps });
  assert.equal(state.tabId, 'w4:t9');
  assert.deepEqual(calls.spawn[0], fleetTailPaneArgs({ tabId: 'w4:t9', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log', ticketId: 't-a' }));
  assert.equal(state.tailed.get('t-a'), 'w4:p5');
  // next beat, still building, tab open → no re-tab, no re-tail, no close
  await runFleetPlan({ plan: { ...building, openTab: null }, ...deps });
  assert.equal(calls.tab.length, 1);
  assert.equal(calls.spawn.length, 1, 'tailed exactly once');
  assert.equal(calls.close.length, 0);
  // t-a terminates → its tail pane is closed exactly once and forgotten
  const merged = { degrade: false, observed: true, openTab: null, tailPanes: [], notifications: [], boardRows: [{ ticketId: 't-a', state: 'merged' }] };
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

test('runFleetPlan RETAINS a pane on a transient close failure so it retries — but notifications still fire that beat', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:p5']]), closing: new Map() };
  const notified = [];
  let fail = true; // the close fails transiently on the first beat, succeeds on the next
  const plan = { degrade: false, observed: true, openTab: null, tailPanes: [], notifications: [{ title: 'x', body: 'y', sound: 'done' }], boardRows: [] };
  const deps = {
    repoRoot: '/r', state,
    openTab: async () => {}, spawn: async () => {},
    closePane: async () => { if (fail) throw new Error('socket busy'); },
    notify: async (...a) => { notified.push(a); },
  };
  await runFleetPlan({ plan, ...deps });
  assert.equal(state.tailed.has('t-a'), false, 'the pane is retired out of active tracking');
  assert.equal(state.closing.has('w4:p5'), true, 'a transient close failure KEEPS the pane pending (leaking it would be worse)');
  assert.equal(notified.length, 1, 'the close failure does not abort the beat — notifications still fire');
  fail = false;
  await runFleetPlan({ plan, ...deps }); // next beat retries the close, now succeeds
  assert.equal(state.closing.has('w4:p5'), false, 'the retried close succeeds and the pane is forgotten');
});

test('runFleetPlan treats a { ok:false } close RETURN as a failure (the herdr shim reports failure by return, not throw)', async () => {
  // The real injected closePane is runHerdr(...), which RESOLVES {ok:false} on a
  // non-zero exit — it never throws. A prior version only caught throws, so a
  // failed close was silently treated as success and the pane leaked.
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:p5']]), closing: new Map() };
  let ok = false;
  const plan = { degrade: false, observed: true, openTab: null, tailPanes: [], notifications: [], boardRows: [] };
  const deps = { repoRoot: '/r', openTab: async () => {}, spawn: async () => {}, notify: async () => {}, closePane: async () => ({ ok }) };
  await runFleetPlan({ plan, state, ...deps });
  assert.equal(state.closing.get('w4:p5'), 1, 'a { ok:false } return is a failure → the pane stays pending with one recorded attempt');
  ok = true; // herdr recovers
  await runFleetPlan({ plan, state, ...deps });
  assert.equal(state.closing.has('w4:p5'), false, 'a { ok:true } return clears the pane');
});

test('runFleetPlan BOUNDS spawn retries PER TICKET — after BOUNDED_SPAWN_ATTEMPTS it gives up on that ticket, not the whole tab (round 16/17)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map(), spawnFails: new Map() };
  let calls = 0;
  const plan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: 'x' }] };
  const deps = { repoRoot: '/r', openTab: async () => {}, closePane: async () => {}, notify: async () => {}, spawn: async () => { calls += 1; return null; } }; // spawn always fails
  for (let i = 0; i < BOUNDED_SPAWN_ATTEMPTS + 3; i += 1) await runFleetPlan({ plan, state, ...deps });
  assert.equal(calls, BOUNDED_SPAWN_ATTEMPTS, 'spawn attempted exactly the bounded number of times, then no more');
  assert.equal(state.tabId, 'w4:t1', 'the TAB is retained — a spawn failure never blinds the whole run (round 17)');
});

test('runFleetPlan RESETS a ticket spawn-fail count on success (a transient spawn failure never trips the bound)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map(), spawnFails: new Map() };
  let ok = false;
  const plan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: 'x' }] };
  const deps = { repoRoot: '/r', openTab: async () => {}, closePane: async () => {}, notify: async () => {}, spawn: async () => (ok ? 'w4:pa' : null) };
  await runFleetPlan({ plan, state, ...deps }); // fail
  await runFleetPlan({ plan, state, ...deps }); // fail
  ok = true;
  await runFleetPlan({ plan, state, ...deps }); // recovers
  assert.equal(state.tailed.get('t-a'), 'w4:pa');
  assert.equal(state.spawnFails.has('t-a'), false, 'the ticket fail count reset on success');
});

test('runFleetPlan drops a ticket spawn-fail count once the ticket leaves the in-flight set (a returning ticket retries fresh)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map(), spawnFails: new Map([['t-a', 3]]) };
  const deps = { repoRoot: '/r', openTab: async () => {}, closePane: async () => {}, notify: async () => {}, spawn: async () => 'w4:pa' };
  // t-a is no longer in-flight this beat → its stale fail count is pruned.
  await runFleetPlan({ plan: { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [] }, state, ...deps });
  assert.equal(state.spawnFails.has('t-a'), false);
});

test('runFleetPlan CLEARS spawn-fail counts on a NEW run — a ticket that gave up last run gets a fresh pane, even if it stays in tailPanes (round 19)', async () => {
  // t-a exhausted its spawn attempts in the prior run and is STILL in-flight now.
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map(), spawnFails: new Map([['t-a', BOUNDED_SPAWN_ATTEMPTS]]) };
  let spawned = null;
  const newRun = { degrade: false, observed: true, openTab: { runId: 'r2', title: 'fleet: run-r2' }, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: 'x' }] };
  await runFleetPlan({ plan: newRun, repoRoot: '/r', state, openTab: async () => 'w4:t2', spawn: async () => { spawned = 't-a'; return 'w4:pa'; }, closePane: async () => {}, notify: async () => {} });
  assert.equal(state.spawnFails.has('t-a'), false, 'the prior run give-up count is cleared on a new run — no cross-run poisoning');
  assert.equal(spawned, 't-a', 'so the ticket gets a fresh spawn attempt in the new run');
  assert.equal(state.tailed.get('t-a'), 'w4:pa');
});

test('runFleetPlan GIVES UP after BOUNDED_CLOSE_ATTEMPTS on a pane that never closes — no per-beat spawn loop (round 9)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map([['w4:ghost', 0]]) };
  const logs = [];
  let attempts = 0;
  const plan = { degrade: false, observed: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] }; // drain runs every beat
  const deps = {
    repoRoot: '/r', openTab: async () => {}, spawn: async () => {}, notify: async () => {},
    closePane: async () => { attempts += 1; throw new Error('no such pane'); }, // user manually closed it → gone forever
    log: (m, id) => logs.push([m, id]),
  };
  for (let beat = 0; beat < BOUNDED_CLOSE_ATTEMPTS + 3; beat += 1) await runFleetPlan({ plan, state, ...deps });
  assert.equal(state.closing.has('w4:ghost'), false, 'the vanished pane is dropped, not retried forever');
  assert.equal(attempts, BOUNDED_CLOSE_ATTEMPTS, 'it is retried exactly the bounded number of times, then no more spawns');
  assert.ok(logs.some(([m]) => /giving up/.test(m)), 'giving up is surfaced to the log');
});

test('runFleetPlan RETRIES a NEW-RUN teardown whose close failed — a run restart never force-forgets a leaked pane (round 8)', async () => {
  // The prior run left a tail pane; a new run starts while the herdr socket is
  // briefly busy, so tearing the old pane down fails. It must be retried, and a
  // NEW pane for the SAME ticket id must still spawn (no id collision).
  const state = { tabId: 'w4:old', tailed: new Map([['t-a', 'w4:pOld']]), closing: new Map() };
  let closeFails = true;
  const spawned = [];
  const deps = {
    repoRoot: '/r', state,
    openTab: async () => 'w4:new',
    spawn: async (a) => { spawned.push(a); return 'w4:pNew'; },
    closePane: async (p) => { if (closeFails && p === 'w4:pOld') throw new Error('socket busy'); },
    notify: async () => {},
  };
  const newRun = {
    degrade: false, observed: true, openTab: { runId: 'r2', title: 'fleet: run-r2' },
    tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }], notifications: [], boardRows: [],
  };
  await runFleetPlan({ plan: newRun, ...deps });
  assert.equal(state.closing.has('w4:pOld'), true, 'the old pane whose close failed is NOT force-forgotten — it stays pending');
  assert.equal(state.tailed.get('t-a'), 'w4:pNew', 'the new run still spawns a fresh pane for the same ticket id (no collision)');
  assert.equal(spawned.length, 1);
  // Next beat, still the same run, the socket recovers → the old pane is finally closed.
  closeFails = false;
  await runFleetPlan({ plan: { ...newRun, openTab: null }, ...deps });
  assert.equal(state.closing.has('w4:pOld'), false, 'the retried teardown succeeds and the old pane is forgotten');
});

test('runFleetPlan ISOLATES a notify failure — the remaining notifications still fire and it is logged', async () => {
  const notified = [];
  const logs = [];
  let n = 0;
  await runFleetPlan({
    plan: {
      degrade: false, openTab: null, tailPanes: [], boardRows: [],
      notifications: [{ title: 'a', body: 'b1', sound: 'done' }, { title: 'c', body: 'b2', sound: 'request' }],
    },
    repoRoot: '/r', state: { tabId: 'w4:t1', tailed: new Map() },
    openTab: async () => {}, spawn: async () => {}, closePane: async () => {},
    notify: async (...a) => { n += 1; if (n === 1) throw new Error('socket busy'); notified.push(a); },
    log: (m, e) => logs.push([m, e]),
  });
  assert.equal(n, 2, 'both notifications are attempted — the first throwing does not abort the rest');
  assert.deepEqual(notified, [['c', 'b2', 'request']], 'the second notification still fires');
  assert.equal(logs.length, 1, 'the failed notification is surfaced to the log');
  assert.match(logs[0][0], /notify failed/);
});

test('runFleetPlan RECONCILES panes — closes a ticket that left the in-flight set (removed/unknown state), not just terminal', async () => {
  const closed = [];
  // t-a still in-flight; t-b is absent from tailPanes AND boardRows (removed from
  // the status file, or in a state outside IN_FLIGHT/TERMINAL) — its pane must close.
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa'], ['t-b', 'w4:pb']]) };
  await runFleetPlan({
    plan: {
      degrade: false, observed: true, openTab: null, boardRows: [], notifications: [],
      tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }],
    },
    repoRoot: '/r', state,
    openTab: async () => {}, spawn: async () => 'w4:pa', closePane: async (p) => closed.push(p), notify: async () => {},
  });
  assert.deepEqual(closed, ['w4:pb'], 'the vanished ticket pane is closed with no terminal row');
  assert.equal(state.tailed.has('t-b'), false, 'and forgotten');
  assert.equal(state.tailed.has('t-a'), true, 'the still-in-flight ticket keeps its pane');
});

test('runFleetPlan does NOT touch panes on an UNOBSERVED plan — a null/unreadable status must not churn the UI', async () => {
  const closed = [];
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa']]) };
  // observed:false is exactly what planFleetBridge returns for curr===null.
  await runFleetPlan({
    plan: { degrade: false, observed: false, openTab: null, tailPanes: [], notifications: [], boardRows: [] },
    repoRoot: '/r', state,
    openTab: async () => {}, spawn: async () => {}, closePane: async (p) => closed.push(p), notify: async () => {},
  });
  assert.deepEqual(closed, [], 'no pane is closed on a missing observation');
  assert.equal(state.tailed.get('t-a'), 'w4:pa', 'the tail pane is preserved across a transient read blip');
});

test('runFleetPlan on a DEGRADE tears down every tracked pane (clean fallback to polling), then no other effect', async () => {
  const closed = [];
  let otherTouched = false;
  const mark = async () => { otherTouched = true; };
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa'], ['t-b', 'w4:pb']]) };
  await runFleetPlan({
    plan: { degrade: true }, repoRoot: '/r', state,
    openTab: mark, spawn: mark, notify: mark, closePane: async (p) => closed.push(p),
  });
  assert.deepEqual(closed.sort(), ['w4:pa', 'w4:pb'], 'the panes we can no longer manage are closed, not leaked');
  assert.equal(state.tailed.size, 0, 'and forgotten');
  assert.equal(otherTouched, false, 'degrade opens no tab, spawns no pane, sends no notification');
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

test('runFleetBridgeBeat surfaces a per-effect failure via log but never throws, and still advances prev', async () => {
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
  assert.equal(logged.length, 1, 'the swallowed effect error is surfaced to the log sink (observability)');
  assert.match(logged[0][0], /open-tab failed/, 'the log message identifies the failing effect');
  assert.equal(logged[0][1].message, 'herdr socket refused', 'the actual error is passed through');
  assert.equal(st.prev, curr, 'an isolated effect failure still advances prev (no re-fire storm)');
});

test('runFleetBridgeBeat NEVER crashes on an unexpected internal error — the outer guard catches and logs it', async () => {
  const st = { prev: null, seen: new Set(), runState: { tabId: null, tailed: null } }; // corrupt run state → an internal throw outside any per-effect guard
  const logged = [];
  await assert.doesNotReject(runFleetBridgeBeat({
    st, curr: status({ runId: 'rX', tickets: {} }), repoRoot: '/repo',
    effects: { openTab: async () => 'w4:t9', spawn: async () => {}, closePane: async () => {}, notify: async () => {} },
    log: (m, e) => logged.push([m, e]),
  }));
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /fleet bridge error/, 'the last-resort guard reports a bridge-level error, not a per-effect one');
});

test('runFleetBridgeBeat does NOT wipe the baseline when curr is null (transient read error / no run)', async () => {
  const prevStatus = status({ runId: 'r1', tickets: { 't-a': { state: 'building' } } });
  const st = { prev: prevStatus, seen: new Set(['r1']), runState: { tabId: 'w4:t1', tailed: new Map() } };
  await runFleetBridgeBeat({
    st, curr: null, repoRoot: '/repo',
    effects: { openTab: async () => {}, spawn: async () => {}, closePane: async () => {}, notify: async () => {} },
  });
  assert.equal(st.prev, prevStatus, 'a null observation keeps the last-known status so a transition still fires when the file returns');
});

test('runFleetBridgeBeat tolerates a missing log sink (log is optional)', async () => {
  const st = { prev: null, seen: new Set(), runState: { tabId: null, tailed: new Map() } };
  await assert.doesNotReject(runFleetBridgeBeat({
    st, curr: status({ tickets: { 't-a': { state: 'building' } } }), repoRoot: '/repo',
    effects: { openTab: async () => { throw new Error('boom'); }, spawn: async () => {}, closePane: async () => {}, notify: async () => {} },
  }));
});

test('AC8 fixed-argv builders: a shell-free tail -F argv (waits for a not-yet-created log), tab create, pane close', () => {
  assert.deepEqual(fleetTabArgs('fleet: run-r1'), ['tab', 'create', '--label', 'fleet: run-r1', '--no-focus']);
  // A run-namespaced, per-ticket agent NAME makes concurrent panes distinguishable
  // AND globally unique (agent start has no --label; herdr names are global).
  assert.deepEqual(
    fleetTailPaneArgs({ tabId: 'w4:t2', repoRoot: '/repo', logPath: '.adlc/fleet-logs/t-a.log', ticketId: 't-a', runId: 'r9' }),
    ['agent', 'start', 'adlc-fleet-r9-t-a', '--cwd', '/repo', '--tab', 'w4:t2', '--split', 'down', '--', 'tail', '-F', '--', '.adlc/fleet-logs/t-a.log'],
  );
  // Two concurrent runs sharing a ticket id get DISTINCT agent names (no collision).
  assert.notEqual(
    fleetTailPaneArgs({ tabId: 't', repoRoot: '/a', logPath: '/l', ticketId: 't-1', runId: 'rA' })[2],
    fleetTailPaneArgs({ tabId: 't', repoRoot: '/b', logPath: '/l', ticketId: 't-1', runId: 'rB' })[2],
  );
  // Falls back to the generic name when the run/ticket id is absent.
  assert.equal(fleetTailPaneArgs({ tabId: 'w4:t2', repoRoot: '/repo', logPath: '/l' })[2], 'adlc-fleet-tail');
  assert.deepEqual(fleetPaneCloseArgs('w4:p5'), ['pane', 'close', 'w4:p5']);
});

test('a herdr effect that RESOLVES { ok:false } (not a throw) is still surfaced to the log (round 13)', async () => {
  // The herdr shim reports runtime failure by resolving { ok:false }, never by
  // throwing; a prior safeCall only logged on throw, so these went silent.
  const logs = [];
  const plan = { degrade: false, observed: true, openTab: null, boardRows: [], tailPanes: [], notifications: [{ title: 'a', body: 'b', sound: 'done' }] };
  await runFleetPlan({
    plan, repoRoot: '/r', state: { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map() },
    openTab: async () => {}, spawn: async () => {}, closePane: async () => {},
    notify: async () => ({ ok: false, code: 1 }),
    log: (m, e) => logs.push([m, e]),
  });
  assert.equal(logs.length, 1, 'the { ok:false } notify failure is logged, not swallowed');
  assert.match(logs[0][0], /notify failed/);
});

test('runFleetPlan caches a tag ATTEMPT so a failure does NOT retry every beat; the HEARTBEAT is the retry (round 13/20)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa']]), closing: new Map(), tagged: new Map(), spawnFails: new Map() };
  const tags = [];
  let tagOk = false; // the pane is gone → tag keeps failing
  const plan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: 'x' }] };
  const deps = {
    repoRoot: '/r', openTab: async () => {}, spawn: async () => 'w4:pa', closePane: async () => {}, notify: async () => {},
    tagPane: async (_p, _t, s) => { tags.push(s); return { ok: tagOk }; },
  };
  await runFleetPlan({ plan, state, ...deps }); // state change → one attempt (fails)
  assert.equal(tags.length, 1, 'one attempt on the state change');
  await runFleetPlan({ plan, state, ...deps }); // ordinary beat, unchanged → NO per-beat retry (round 20)
  assert.equal(tags.length, 1, 'a failed tag is NOT retried every 400ms beat');
  tagOk = true;
  await runFleetPlan({ plan, state, ...deps, heartbeat: true }); // heartbeat → the retry
  assert.equal(tags.length, 2, 'the heartbeat re-tags, so a transient failure still recovers');
  assert.equal(state.tagged.get('t-a'), 'building');
});

test('runFleetPlan RE-TAGS an unchanged-state pane on a HEARTBEAT beat, keeping the token TTL alive (round 13)', async () => {
  const state = { tabId: 'w4:t1', tailed: new Map([['t-a', 'w4:pa']]), closing: new Map(), tagged: new Map([['t-a', 'building']]) };
  const tags = [];
  const plan = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: 'x' }] };
  const deps = { repoRoot: '/r', openTab: async () => {}, spawn: async () => 'w4:pa', closePane: async () => {}, notify: async () => {}, tagPane: async (_p, _t, s) => { tags.push(s); } };
  await runFleetPlan({ plan, state, ...deps }); // ordinary beat, unchanged state → no re-tag
  assert.deepEqual(tags, [], 'an unchanged state is not re-tagged on an ordinary beat (no token spam)');
  await runFleetPlan({ plan, state, ...deps, heartbeat: true }); // heartbeat → refresh the TTL
  assert.deepEqual(tags, ['building'], 'the heartbeat re-tags even though the state is unchanged');
});

test('fleetWorktreeShellArgs builds a shell-free open-shell argv in the validated worktree (ticket §2)', () => {
  assert.deepEqual(
    fleetWorktreeShellArgs({ worktreePath: '.worktrees/fleet-t-a' }),
    ['agent', 'start', 'adlc-fleet-shell', '--cwd', '.worktrees/fleet-t-a', '--split', 'right', '--', 'bash'],
  );
});

test('runFleetPlan token-tags each tail pane with its ticket + CURRENT state, re-tagging only on a state change', async () => {
  const tags = [];
  const state = { tabId: 'w4:t1', tailed: new Map(), closing: new Map(), tagged: new Map() };
  const deps = {
    repoRoot: '/r', openTab: async () => {}, closePane: async () => {}, notify: async () => {},
    spawn: async () => 'w4:pa',
    tagPane: async (paneId, ticketId, s) => { tags.push([paneId, ticketId, s]); },
  };
  const building = { degrade: false, observed: true, openTab: null, notifications: [], boardRows: [], tailPanes: [{ ticketId: 't-a', state: 'building', logPath: '.adlc/fleet-logs/t-a.log' }] };
  await runFleetPlan({ plan: building, state, ...deps });
  assert.deepEqual(tags, [['w4:pa', 't-a', 'building']], 'the pane is tagged with ticket + state on first sight');
  // same state next beat → no re-tag (no token spam)
  await runFleetPlan({ plan: building, state, ...deps });
  assert.equal(tags.length, 1, 'an unchanged state does not re-tag');
  // state advances → re-tag with the new state
  const gating = { ...building, tailPanes: [{ ticketId: 't-a', state: 'gating', logPath: '.adlc/fleet-logs/t-a.log' }] };
  await runFleetPlan({ plan: gating, state, ...deps });
  assert.deepEqual(tags[1], ['w4:pa', 't-a', 'gating'], 'a state change re-tags the pane');
});
