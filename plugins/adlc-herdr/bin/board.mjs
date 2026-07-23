#!/usr/bin/env node
// [[panes]] board entrypoint (t-herdr-4, plan §5.2). Probed contract
// (2026-07-23): the overlay is a real PTY with its own pane id; the process
// gets HERDR_PLUGIN_CONTEXT_JSON with the pane focused at open time; the
// pane closes when this process exits. Thin glue: resolve the repo like
// actions do, gather via the tested libs, redraw every few seconds and on
// resize, quit on q / Ctrl-C.
import { appendFileSync } from 'node:fs';
import { runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { resolveRepoRoot } from '../lib/repo-root.mjs';
import { parseContext, resolveTarget } from '../lib/actions.mjs';
import {
  readActiveTicket, readLatestPhase, groupBacklog, readLedgerTail, readTicketsViaExport,
} from '../lib/adlc-state.mjs';
import { buildPaneMap } from '../lib/panemap.mjs';
import { renderBoard } from '../lib/board-render.mjs';

const REFRESH_MS = 3_000;
const LEDGER_ROWS = 8;

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
  const tickets = await readTicketsViaExport(repoRoot);
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
    repoRoot,
    active,
    phase,
    groups,
    paneRows,
    ledger: readLedgerTail(repoRoot, LEDGER_ROWS),
  };
}

function draw(body) {
  // Probed 2026-07-23: \x1b[2J leaves a herdr pane blank AND unreadable via
  // `pane read` — redraw with cursor-home + per-line erase-to-EOL + erase-
  // below instead of a full clear.
  const footer = `\x1b[2mq to quit · refreshes every ${REFRESH_MS / 1000}s\x1b[0m`;
  const frameText = `${body}\n\n${footer}`.split('\n').map((line) => `${line}\x1b[K`).join('\n');
  process.stdout.write(`\x1b[H${frameText}\n\x1b[0J`);
}

async function frame(repoRoot) {
  draw(renderBoard(await gather(repoRoot)));
}

function armInput(onQuit) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    const key = chunk.toString();
    if (key === 'q' || key === 'Q' || key === '\x03') onQuit();
  });
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
