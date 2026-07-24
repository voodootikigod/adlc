#!/usr/bin/env node
// [[events]] dispatcher (t-herdr-5, plan §5.4). Thin glue: parse the event env
// (probed live 2026-07-24 — HERDR_PLUGIN_EVENT is the dotted name,
// HERDR_PLUGIN_EVENT_JSON the payload), wire the real repo-state readers, ask
// the pure planner (lib/event-plan) what to do, and execute the single plan.
// Fail soft everywhere — an event handler must never crash the herdr session.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { resolveRepoRoot } from '../lib/repo-root.mjs';
import { readActiveTicket } from '../lib/adlc-state.mjs';
import { notifyArgs } from '../lib/actions.mjs';
import { buildPaneClearArgs } from '../lib/tokens.mjs';
import { planEvent } from '../lib/event-plan.mjs';

async function resolveRepoForPane(paneId) {
  const res = await runHerdrJson(paneInfoArgs(paneId));
  const pane = res.ok ? res.value?.result?.pane ?? null : null;
  const dir = (pane && typeof pane.foreground_cwd === 'string' && pane.foreground_cwd)
    || (pane && typeof pane.cwd === 'string' && pane.cwd) || null;
  if (!dir) return null;
  try {
    return resolveRepoRoot(dir);
  } catch {
    return null;
  }
}

function listTicketIds(repoRoot) {
  return new Promise((resolve) => {
    // execFile does not use a shell (its default) — the argv is a fixed
    // literal array with no interpolated/observed data.
    execFile('adlc', ['ticket', 'list', '--json'], { cwd: repoRoot, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickets) ? parsed.tickets : [];
        resolve(list.map((t) => t?.id).filter((id) => typeof id === 'string'));
      } catch {
        resolve([]);
      }
    });
  });
}

const hasCurrentTicket = (repoRoot) => existsSync(join(repoRoot, '.adlc', 'current-ticket.json'));

// Dedupe markers: one empty file per (pane|ticket|status), named by hash so any
// id characters are safe in the filename.
const nudgeDir = process.env.HERDR_PLUGIN_STATE_DIR
  ? join(process.env.HERDR_PLUGIN_STATE_DIR, 'nudged')
  : null;
const markerPath = (key) => (nudgeDir ? join(nudgeDir, createHash('sha256').update(key).digest('hex').slice(0, 32)) : null);
const seen = (key) => {
  const p = markerPath(key);
  return p ? existsSync(p) : false;
};
const markSeen = (key) => {
  const p = markerPath(key);
  if (!p) return;
  try {
    mkdirSync(nudgeDir, { recursive: true });
    writeFileSync(p, '');
  } catch {
    // dedupe is best-effort; a failed marker just risks one extra nudge
  }
};

async function main() {
  const eventName = process.env.HERDR_PLUGIN_EVENT ?? '';
  let payload;
  try {
    payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? 'null');
  } catch {
    return; // malformed event JSON → do nothing
  }
  const plan = await planEvent(eventName, payload, {
    resolveRepoForPane, listTicketIds, readActiveTicket, hasCurrentTicket, seen, markSeen,
  });
  if (plan.kind === 'clear-pane') {
    await runHerdr(buildPaneClearArgs(plan.paneId));
  } else if (plan.kind === 'notify') {
    await runHerdr(notifyArgs(plan.title, plan.body, plan.sound));
  }
  // kind === 'none' → nothing
}

main().catch(() => process.exit(0));
