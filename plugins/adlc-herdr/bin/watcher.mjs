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
import { readActiveTicket, readLatestPhase, backlogCounts, readTicketsViaExport } from '../lib/adlc-state.mjs';
import { buildReportArgs, buildWorkspaceReportArgs, diffPublishes, versionGate } from '../lib/tokens.mjs';
import { planTokens } from '../lib/watch-plan.mjs';

const TESTED_CEILING = '0.7.4';
const TOKEN_TTL_MS = 90_000;
const HEARTBEAT_MS = 45_000;
const DEBOUNCE_MS = 400;
const BACKLOG_CACHE_MS = 30_000;
const SUBSCRIPTIONS = [
  'pane.created', 'pane.updated', 'pane.closed', 'pane.exited',
  'worktree.created', 'worktree.opened', 'worktree.removed',
];

const readBacklog = makeCachedReader((repoRoot) => readTicketsViaExport(repoRoot), BACKLOG_CACHE_MS);

let prevPane = new Map();
let prevWorkspace = new Map();
const watchedRepos = new Set();
let refreshTimer = null;
let refreshing = false;
let pendingFull = false;

async function refresh({ full = false } = {}) {
  // Coalesce, don't drop: if a refresh is already running and a FULL heartbeat
  // fires, remember it and run a follow-up full pass when the current one
  // finishes — otherwise two colliding heartbeats could let a stable pane's
  // tokens lapse past their 90s TTL.
  if (refreshing) {
    if (full) pendingFull = true;
    return;
  }
  refreshing = true;
  try {
    const snap = await runHerdrJson(['api', 'snapshot']);
    if (!snap.ok) return; // fail soft — next heartbeat retries
    const panes = snap.value?.result?.snapshot?.panes;
    const map = buildPaneMap(Array.isArray(panes) ? panes : [], { resolveRepoRoot });
    const groups = repoGroups(map);

    // Read each repo's state once, then let the pure planner assemble tokens.
    const repoState = new Map();
    for (const [repoRoot] of groups) {
      ensureWatched(repoRoot);
      const active = readActiveTicket(repoRoot);
      const phase = active.state === 'active' ? readLatestPhase(repoRoot, active.id) : null;
      const tickets = existsSync(join(repoRoot, '.adlc')) ? await readBacklog(repoRoot) : null;
      const counts = tickets ? backlogCounts(tickets, active.state === 'active' ? active.id : null) : null;
      repoState.set(repoRoot, { active, phase, counts });
    }
    const { nextPane, nextWorkspace } = planTokens(map, repoState);

    const paneChanges = full ? nextPane : diffPublishes(prevPane, nextPane);
    const wsChanges = full ? nextWorkspace : diffPublishes(prevWorkspace, nextWorkspace);
    for (const [paneId, tokens] of paneChanges) {
      await runHerdr(buildReportArgs(paneId, tokens, TOKEN_TTL_MS));
    }
    for (const [workspaceId, tokens] of wsChanges) {
      await runHerdr(buildWorkspaceReportArgs(workspaceId, tokens, TOKEN_TTL_MS));
    }
    prevPane = nextPane;
    prevWorkspace = nextWorkspace;
  } finally {
    refreshing = false;
  }
  // Service a heartbeat that collided with this run.
  if (pendingFull) {
    pendingFull = false;
    await refresh({ full: true });
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(() => {});
  }, DEBOUNCE_MS);
}

function ensureWatched(repoRoot) {
  if (watchedRepos.has(repoRoot)) return;
  watchedRepos.add(repoRoot);
  const adlcDir = join(repoRoot, '.adlc');
  if (!existsSync(adlcDir)) return;
  try {
    watch(adlcDir, () => { readBacklog.invalidate(repoRoot); scheduleRefresh(); });
    const ticketsDir = join(adlcDir, 'tickets');
    if (existsSync(ticketsDir)) {
      watch(ticketsDir, () => { readBacklog.invalidate(repoRoot); scheduleRefresh(); });
    }
  } catch {
    // fail soft — heartbeat polling still covers this repo
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
  const retry = () => setTimeout(subscribeSocket, 30_000).unref();
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
