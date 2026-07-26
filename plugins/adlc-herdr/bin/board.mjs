#!/usr/bin/env node
// [[panes]] board entrypoint (t-herdr-4, plan §5.2). Probed contract
// (2026-07-23): the overlay is a real PTY with its own pane id; the process
// gets HERDR_PLUGIN_CONTEXT_JSON with the pane focused at open time; the
// pane closes when this process exits. Thin glue: resolve the repo like
// actions do, gather via the tested libs, redraw every few seconds and on
// resize, quit on q / Ctrl-C.
import { appendFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { resolveRepoRoot } from '../lib/repo-root.mjs';
import { parseContext, resolveTarget } from '../lib/actions.mjs';
import {
  readActiveTicket, readLatestPhase, groupBacklog, readLedgerByTicket,
  readTicketsViaExport, storeCacheKey, makeKeyedCache, readFleetStatus,
} from '../lib/adlc-state.mjs';
import { buildPaneMap } from '../lib/panemap.mjs';
import { renderBoard, boardFooter } from '../lib/board-render.mjs';
import { planFleetBridge, KNOWN_FLEET_SCHEMA_VERSION } from '../lib/fleet-bridge.mjs';
import { flattenGroups, nextSelectedId, focusSelected, classifyKey, redrawBoard } from '../lib/board-nav.mjs';

const REFRESH_MS = 3_000;

// Row-selection state (t-herdr-7). The selection is tracked by stable ticket
// *id* (`selectedId`), NOT by row index — the 3s background refresh can reorder
// or drop tickets, and a raw index would then point at a different ticket (and
// confirm on the wrong one). The render index is re-derived from the id on every
// draw. `lastProps` is the last gathered frame so input handlers resolve rows
// without re-gathering. `flatTickets` mirrors renderBoard's section order.
let selectedId = null;
let lastProps = null;

// mtime-gate the ticket-store export: the board redraws every 3s, but
// `readTicketsViaExport` spawns an `adlc` process, so re-exporting on every
// idle redraw drains battery/IO for nothing. The keyed cache re-exports only
// when `storeCacheKey` advances (the store changed); a stable key — including
// an absent store — serves the cached value, even `null`.
const readBacklogTickets = makeKeyedCache(storeCacheKey, readTicketsViaExport);

async function resolveRepo() {
  const parsed = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  let paneInfo = null;
  if (parsed.ok) {
    const res = await runHerdrJson(paneInfoArgs(parsed.ctx.focused_pane_id));
    paneInfo = res.ok ? res.value?.result?.pane ?? null : null;
  }
  const target = resolveTarget({ ctx: parsed.ok ? parsed.ctx : {}, paneInfo, resolveRepoRoot });
  return target.ok ? target.repoRoot : null;
}

async function gather(repoRoot) {
  const active = readActiveTicket(repoRoot);
  const phase = active.state === 'active' ? readLatestPhase(repoRoot, active.id) : null;
  const tickets = await readBacklogTickets(repoRoot);
  const groups = groupBacklog(tickets ?? [], active.state === 'active' ? active.id : null);
  const snap = await runHerdrJson(['api', 'snapshot']);
  const panes = Array.isArray(snap.value?.result?.snapshot?.panes) ? snap.value.result.snapshot.panes : [];
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  const paneRows = buildPaneMap(panes, { resolveRepoRoot })
    .filter((e) => e.repoRoot === repoRoot && e.paneId !== process.env.HERDR_PANE_ID)
    .map((e) => ({
      paneId: e.paneId,
      agent: byId.get(e.paneId)?.agent ?? null,
      agentStatus: byId.get(e.paneId)?.agent_status ?? null,
      ticket: byId.get(e.paneId)?.tokens?.ticket ?? null,
    }));
  return {
    width: process.stdout.columns ?? 80,
    // Reserve two lines for the blank + footer draw() adds, so the whole frame
    // fits the pane and cursor-home redraw never scrolls/duplicates.
    height: process.stdout.rows ? Math.max(4, process.stdout.rows - 2) : null,
    repoRoot,
    active,
    phase,
    groups,
    paneRows,
    ledger: readLedgerByTicket(repoRoot),
    // Passive fleet summary: terminal fleet tickets as board rows (planner
    // validates schemaVersion + ids; unknown version → empty, i.e. no section).
    fleetRows: planFleetBridge({
      prev: null, curr: readFleetStatus(repoRoot),
      knownSchemaVersion: KNOWN_FLEET_SCHEMA_VERSION, seenRunIds: new Set(),
    }).boardRows,
  };
}

function draw(body) {
  // Probed 2026-07-23: \x1b[2J leaves a herdr pane blank AND unreadable via
  // `pane read` — redraw with cursor-home + per-line erase-to-EOL + erase-
  // below instead of a full clear.
  const footer = boardFooter(REFRESH_MS);
  const frameText = `${body}\n\n${footer}`.split('\n').map((line) => `${line}\x1b[K`).join('\n');
  process.stdout.write(`\x1b[H${frameText}\n\x1b[0J`);
}

// Single-flight latch: gather() runs several herdr subprocess calls plus an
// `adlc ticket store export` (15s timeout), so a slow gather could outlast the
// 3s interval or collide with a resize. Two concurrent frames would interleave
// their cursor-home + erase writes and corrupt the pane. Mirror the watcher's
// `refreshing` guard — skip a frame while one is in flight.
let framing = false;
async function frame(repoRoot) {
  if (framing) return;
  framing = true;
  try {
    lastProps = await gather(repoRoot);
    redraw();
  } catch (err) {
    // A transient gather failure (an adlc/herdr subprocess hiccup) must never
    // tear down the pane — keep the last good frame and retry next tick. This
    // also covers the first, awaited frame, which would otherwise exit the board.
    trace(`frame error: ${err}`);
  } finally {
    framing = false;
  }
}

// Redraw from the cached frame (no re-gather) — instant selection feedback.
// redrawBoard suppresses the draw until the first frame has loaded, so an early
// keypress can't wipe the "loading…" screen.
function redraw() {
  redrawBoard({ props: lastProps, selectedId, render: renderBoard, draw });
}

function move(direction) {
  selectedId = nextSelectedId(selectedId, direction, flattenGroups(lastProps?.groups));
  redraw();
}

function armInput(onQuit) {
  // readline keypress events parse ANSI escape sequences and coalesced chunks
  // into atomic keys — a raw `data` chunk can carry several keystrokes (paste,
  // fast typing, SSH) and whole-chunk equality would drop them. classifyKey owns
  // the routing decision and focusSelected owns the run decision (both tested);
  // this glue only maps a command name to its effect.
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const commands = {
    quit: onQuit,
    up: () => move('up'),
    down: () => move('down'),
    focus: () => focusSelected({ selectedId, groups: lastProps?.groups, paneRows: lastProps?.paneRows, run: runHerdr }),
  };
  process.stdin.on('keypress', (str, key) => { commands[classifyKey(str, key)]?.(); });
}

// Last-start breadcrumb into the plugin's state dir — the supportability
// channel for "the board opened blank" reports.
const traceFile = process.env.ADLC_HERDR_DEBUG_FILE
  || (process.env.HERDR_PLUGIN_STATE_DIR ? `${process.env.HERDR_PLUGIN_STATE_DIR}/board.log` : null);
const trace = (msg) => {
  if (!traceFile) return;
  try {
    appendFileSync(traceFile, `${Date.now()} ${msg}\n`);
  } catch {
    // debug-only, never fatal
  }
};

async function main() {
  process.stdout.write('ADLC board loading…\n');
  trace('start');
  const repoRoot = await resolveRepo();
  trace(`repo ${repoRoot}`);
  if (!repoRoot) {
    process.stdout.write('ADLC board: the focused pane does not resolve to a git repository.\npress q to close\n');
    armInput(() => process.exit(0));
    return;
  }
  trace('first frame begin');
  await frame(repoRoot);
  trace('first frame done');
  const timer = setInterval(() => frame(repoRoot).catch(() => {}), REFRESH_MS);
  process.stdout.on('resize', () => frame(repoRoot).catch(() => {}));
  armInput(() => {
    clearInterval(timer);
    process.exit(0);
  });
}

main().catch(() => process.exit(0));
