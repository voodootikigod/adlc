#!/usr/bin/env node
// [[startup]] daemon (t-herdr-2, plan §5.1): maps panes to repos, watches
// `.adlc/` state, and publishes ticket/phase tokens per pane plus backlog
// counts per workspace. Thin glue — all decision logic lives in lib/ and is
// pinned by tests. Change-driven and debounced: no herdr process per event,
// heartbeat refreshes keep TTLs alive (plan premortem bounds).
import net from 'node:net';
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runHerdr, runHerdrJson, makeCachedReader } from '../lib/herdr.mjs';
import { buildPaneMap, repoGroups } from '../lib/panemap.mjs';
import { resolveRepoRoot } from '../lib/repo-root.mjs';
import { readActiveTicket, readLatestPhase, backlogCounts, readTicketsViaExport, readFleetStatus } from '../lib/adlc-state.mjs';
import {
  buildReportArgs, buildWorkspaceReportArgs, diffPublishes, droppedKeys,
  buildPaneClearArgs, buildWorkspaceClearArgs, versionGate,
} from '../lib/tokens.mjs';
import { planTokens, pendingWatchDirs, staleWatchDirs, deadWatchDirs, mapLimit, once } from '../lib/watch-plan.mjs';
import { runFleetBridgeBeat, fleetTabArgs, fleetPaneCloseArgs, tabIdFromResponse, paneIdFromResponse } from '../lib/fleet-bridge.mjs';
import { notifyArgs } from '../lib/actions.mjs';

const TESTED_CEILING = '0.7.4';
const TOKEN_TTL_MS = 90_000;
const HEARTBEAT_MS = 45_000;
const DEBOUNCE_MS = 400;
// Above the heartbeat interval: a steady-state heartbeat reuses the cached
// backlog (real changes still invalidate it via fs.watch) instead of
// re-spawning `adlc export` on every beat.
const BACKLOG_CACHE_MS = 60_000;
// Max concurrent backlog subprocess reads per refresh.
const READ_CONCURRENCY = 6;
const SUBSCRIPTIONS = [
  'pane.created', 'pane.updated', 'pane.closed', 'pane.exited',
  'worktree.created', 'worktree.opened', 'worktree.removed',
];

const readBacklog = makeCachedReader((repoRoot) => readTicketsViaExport(repoRoot), BACKLOG_CACHE_MS);

let prevPane = new Map();
let prevWorkspace = new Map();
const watchedDirs = new Map(); // dir -> { watcher, repoRoot }

// Fleet observer state per repo (t-herdr-9, §5.5): the last-seen status (for
// transition detection), the runIds whose tab we already opened, and the current
// run's tab id + which tickets already have a tail pane. All the decisions live
// in the tested fleet-bridge planner/executor; this glue only supplies the herdr
// effects + this per-repo state, and fails soft so a fleet hiccup never crashes
// the daemon.
//
// Restart behaviour: this state is in-memory. If the daemon restarts mid-run it
// re-initialises empty, opens a fresh run tab, and re-tails; the prior instance's
// panes are orphaned — the new daemon has none of their ids, so it cannot close
// them, and they persist (an idle `tail -F` on the finished log) until the user
// closes them or herdr restarts.
//
// Recovering the panes by persisting their ids is not sound with the current
// herdr contract: herdr reuses pane ids after a herdr-daemon restart, so a
// persisted id can match an unrelated pane the user has since opened, and closing
// it would kill that pane. Reliable adoption/teardown needs herdr to expose a
// pane's agent/command in `api snapshot` (today it carries only pane_id + cwd —
// see lib/panemap.mjs) so a fleet tail pane can be identified unambiguously.
const fleetState = new Map();

async function bridgeFleet(repoRoot, full) {
  const st = fleetState.get(repoRoot) ?? { prev: null, seen: new Set(), runState: { tabId: null, tailed: new Map(), closing: new Map(), tagged: new Map(), spawnFails: new Map() } };
  fleetState.set(repoRoot, st);
  // Thin wire-up: the whole beat (plan → run → commit → log-on-error) is tested
  // in lib/fleet-bridge.mjs. Here we only supply the real herdr effects, the
  // freshly-read status, and a stderr logger so a stuck bridge is diagnosable.
  // `full` (the 45s heartbeat) re-tags panes so their token TTLs never lapse.
  await runFleetBridgeBeat({
    st,
    curr: readFleetStatus(repoRoot),
    repoRoot,
    heartbeat: full,
    effects: {
      openTab: async (title) => tabIdFromResponse(await runHerdrJson(fleetTabArgs(title))),
      spawn: async (argv) => paneIdFromResponse(await runHerdrJson(argv)),
      closePane: (paneId) => runHerdr(fleetPaneCloseArgs(paneId)),
      notify: (title, body, sound) => runHerdr(notifyArgs(title, body, sound)),
      // Token-tag the tail pane with its ticket + state, rendered natively by herdr.
      tagPane: (paneId, ticketId, state) => runHerdr(buildReportArgs(paneId, { ticket: ticketId, state }, TOKEN_TTL_MS)),
    },
    log: (message, err) => console.error(`${message}:`, err),
  });
}
let refreshTimer = null;
let refreshing = false;
let pendingFull = false;
let pendingRefresh = false;

async function refresh({ full = false } = {}) {
  // Coalesce, don't drop: if a refresh is already running, remember that
  // another was requested (and whether it was a full heartbeat) and run a
  // follow-up when the current one finishes. Dropping a non-full refresh would
  // leave a pane's tokens stale until the next 45s heartbeat; dropping a full
  // one could lapse tokens past their 90s TTL.
  if (refreshing) {
    if (full) pendingFull = true;
    else pendingRefresh = true;
    return;
  }
  refreshing = true;
  try {
    // Drain iteratively (NOT by recursively awaiting refresh()): a recursive
    // await under continuous fs events builds an unbounded promise chain that
    // never unwinds → OOM. This loop consumes pending requests in place.
    let runFull = full;
    for (;;) {
      await refreshPass(runFull);
      if (pendingFull) { pendingFull = false; pendingRefresh = false; runFull = true; continue; }
      if (pendingRefresh) { pendingRefresh = false; runFull = false; continue; }
      break;
    }
  } finally {
    refreshing = false;
  }
}

async function refreshPass(full) {
  const snap = await runHerdrJson(['api', 'snapshot']);
  if (!snap.ok) return; // fail soft — next heartbeat retries
  {
    const panes = snap.value?.result?.snapshot?.panes;
    const map = buildPaneMap(Array.isArray(panes) ? panes : [], { resolveRepoRoot });
    const groups = repoGroups(map);
    const activeRepos = new Set(groups.keys());

    // Close watches for repos no longer present (leak prevention) AND for
    // directories deleted on disk (a deleted `.adlc` emits rename/change, not
    // error, so the watch goes silently dead — drop it here so ensureWatched
    // re-attaches when the dir reappears).
    const toClose = new Set([
      ...staleWatchDirs(watchedDirs, activeRepos),
      ...deadWatchDirs(watchedDirs, existsSync),
    ]);
    for (const dir of toClose) {
      try {
        watchedDirs.get(dir)?.watcher.close();
      } catch {
        // best-effort
      }
      watchedDirs.delete(dir);
    }

    // Read each repo's state with BOUNDED concurrency: readBacklog spawns
    // `adlc` (15s timeout). Awaiting sequentially could exceed the 90s token
    // TTL under load; spawning one per repo all at once (many worktrees) is a
    // process storm. `mapLimit` fans out up to READ_CONCURRENCY at a time.
    for (const repoRoot of activeRepos) ensureWatched(repoRoot);
    const states = await mapLimit([...activeRepos], READ_CONCURRENCY, async (repoRoot) => {
      const active = readActiveTicket(repoRoot);
      const phase = active.state === 'active' ? readLatestPhase(repoRoot, active.id) : null;
      const tickets = existsSync(join(repoRoot, '.adlc')) ? await readBacklog(repoRoot) : null;
      const counts = tickets ? backlogCounts(tickets, active.state === 'active' ? active.id : null) : null;
      return [repoRoot, { active, phase, counts }];
    });
    const repoState = new Map(states);
    const { nextPane, nextWorkspace } = planTokens(map, repoState);

    const paneChanges = full ? nextPane : diffPublishes(prevPane, nextPane);
    const wsChanges = full ? nextWorkspace : diffPublishes(prevWorkspace, nextWorkspace);
    for (const [paneId, tokens] of paneChanges) {
      await runHerdr(buildReportArgs(paneId, tokens, TOKEN_TTL_MS));
    }
    for (const [workspaceId, tokens] of wsChanges) {
      await runHerdr(buildWorkspaceReportArgs(workspaceId, tokens, TOKEN_TTL_MS));
    }
    // Actively clear tokens for panes/workspaces that dropped out — otherwise a
    // pane whose ticket became absent keeps showing the stale ticket until the
    // 90s TTL lapses.
    for (const paneId of droppedKeys(prevPane, nextPane)) {
      await runHerdr(buildPaneClearArgs(paneId));
    }
    for (const workspaceId of droppedKeys(prevWorkspace, nextWorkspace)) {
      await runHerdr(buildWorkspaceClearArgs(workspaceId));
    }
    // Fleet observer: reflect each repo's fleet run into herdr (tab, tail panes,
    // transition notifications). Sequential + after token publishing — it has
    // side effects and shared per-repo state, unlike the read-only token pass.
    for (const repoRoot of activeRepos) await bridgeFleet(repoRoot, full);
    prevPane = nextPane;
    prevWorkspace = nextWorkspace;
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(() => {});
  }, DEBOUNCE_MS);
}

// Track watched DIRECTORIES (in `watchedDirs`), not repos: the set of dirs to
// watch is computed by the pure `pendingWatchDirs`, which re-attaches the
// tickets dir once it appears (it often does not exist when the repo is first
// seen). Guarding by repoRoot alone would never attach that watch, leaving the
// daemon serving stale backlog counts until restart.
function ensureWatched(repoRoot) {
  for (const dir of pendingWatchDirs(repoRoot, watchedDirs, existsSync)) {
    try {
      // Deletion of `dir` (e.g. `rm -rf .adlc`) emits rename/change, not
      // error, and the deterministic `deadWatchDirs` prune in refresh() is what
      // drops the dead watch so this re-attaches on re-init. The `error`
      // handler is only a defensive backstop against a watcher-level error.
      const watcher = watch(dir, () => { readBacklog.invalidate(repoRoot); scheduleRefresh(); });
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        watchedDirs.delete(dir);
        scheduleRefresh();
      });
      watchedDirs.set(dir, { watcher, repoRoot });
    } catch {
      // fail soft — heartbeat polling still covers this repo
    }
  }
}

function subscribeSocket() {
  const sockPath = process.env.HERDR_SOCKET_PATH;
  if (!sockPath) return;
  const client = net.createConnection(sockPath);
  let buf = '';
  client.on('connect', () => {
    client.write(`${JSON.stringify({
      id: 'adlc-watcher',
      method: 'events.subscribe',
      params: { subscriptions: SUBSCRIPTIONS.map((type) => ({ type })) },
    })}\n`);
  });
  client.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      buf = buf.slice(idx + 1);
      scheduleRefresh(); // any subscribed event just marks the world dirty
    }
    if (buf.length > 1_000_000) buf = ''; // bound memory on a torn stream
  });
  // A failed connection emits BOTH `error` and `close`; retry AT MOST once per
  // socket instance, or the retries double on every failure (2^N) and exhaust
  // file descriptors when the herdr server is down for a while.
  const retry = once(() => setTimeout(subscribeSocket, 30_000).unref());
  client.on('error', retry);
  client.on('close', retry);
}

async function main() {
  const version = await runHerdr(['--version']);
  const gate = versionGate(version.ok ? version.stdout : '', TESTED_CEILING);
  if (!gate.supported) {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (workspaceId) {
      // persistent (no TTL) — the next supported run clears it
      await runHerdr(['workspace', 'report-metadata', workspaceId, '--source', 'adlc', '--token', `adlc=${gate.token}`]);
    }
    return; // degrade: single warning token, nothing else (plan §6.5)
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (workspaceId) await runHerdr(['workspace', 'report-metadata', workspaceId, '--source', 'adlc', '--clear-token', 'adlc']);

  subscribeSocket();
  await refresh({ full: true });
  setInterval(() => refresh({ full: true }).catch(() => {}), HEARTBEAT_MS);
}

main().catch(() => process.exit(0)); // never crash the plugin host loudly
