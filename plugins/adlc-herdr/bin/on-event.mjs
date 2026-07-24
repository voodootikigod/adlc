#!/usr/bin/env node
// [[events]] dispatcher (t-herdr-5, plan §5.4). Thin glue: parse the event env
// (probed live 2026-07-24 — HERDR_PLUGIN_EVENT is the dotted name,
// HERDR_PLUGIN_EVENT_JSON the payload), wire the real repo-state readers, ask
// the pure planner (lib/event-plan) what to do, and execute the single plan.
// Fail soft everywhere — an event handler must never crash the herdr session.
import { mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { repoRootFromCwd } from '../lib/repo-root.mjs';
import { readActiveTicket, ticketIdsFromStore, readdirBounded } from '../lib/adlc-state.mjs';
import { notifyArgs } from '../lib/actions.mjs';
import { buildPaneClearArgs } from '../lib/tokens.mjs';
import { planEvent } from '../lib/event-plan.mjs';
import { bucketFor, markerName, isStaleMarker } from '../lib/nudge.mjs';

async function resolveRepoForPane(paneId) {
  const res = await runHerdrJson(paneInfoArgs(paneId));
  const pane = res.ok ? res.value?.result?.pane ?? null : null;
  const dir = (pane && typeof pane.foreground_cwd === 'string' && pane.foreground_cwd)
    || (pane && typeof pane.cwd === 'string' && pane.cwd) || null;
  if (!dir) return null;
  // PURE upward walk — never spawn `git` inside the (untrusted) pane cwd, which
  // could trigger a malicious .git/config hook. Read-only existence checks only.
  return repoRootFromCwd(dir, 64); // bounded upward walk
}

// Ticket ids come from a direct FILESYSTEM read of the store (never a
// subprocess with the untrusted event repoRoot as cwd — a config-loading CLI
// there would be a code-execution vector; a plain read is not).
const listTicketIds = (repoRoot) => ticketIdsFromStore(repoRoot);

// "Is a ticket already pointed at?" via the generated reader (never hand-parse
// the pointer — the ticket-store boundary guard enforces exactly one reader).
// present OR unreadable both count as "has a pointer" → don't nudge to seed.
const hasCurrentTicket = (repoRoot) => readActiveTicket(repoRoot).state !== 'absent';

// Dedupe markers: one file per (pane|ticket|status, TIME-BUCKET). The window is
// encoded in the marker NAME (floor(now / windowMs)), so `claim` is a SINGLE
// atomic op — openSync('wx') — with no stat/rmSync check-then-act to race. The
// first process in a given window bucket wins and nudges; the rest get EEXIST
// and suppress the flap. When the window advances, the bucket (and marker name)
// changes, so a genuine later idle re-nudges — the point is a window, not a
// permanent marker. windowMs<=0 disables dedupe entirely (always nudge).
const NUDGE_WINDOW_MS = Number(process.env.ADLC_HERDR_NUDGE_WINDOW_MS ?? 30_000);
const nudgeDir = process.env.HERDR_PLUGIN_STATE_DIR
  ? join(process.env.HERDR_PLUGIN_STATE_DIR, 'nudged')
  : null;

// After winning a bucket, sweep EVERY marker older than the current bucket (any
// key), so spaced-out idles don't orphan markers — this bounds the directory to
// the current window's markers. Best-effort; delete races are benign. The read
// is BOUNDED (readdirBounded, not readdirSync): a nudge dir flooded with markers
// — a burst of unique pane events, or local tampering — must never load an
// unbounded listing into memory and block this event handler. Per sweep we clear
// up to the cap; a genuinely over-full dir just drains across successive sweeps.
const MAX_SWEEP_ENTRIES = 10_000;
function sweepStaleMarkers(currentBucket) {
  for (const name of readdirBounded(nudgeDir, MAX_SWEEP_ENTRIES)) {
    if (isStaleMarker(name, currentBucket)) {
      try {
        rmSync(join(nudgeDir, name), { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

const claim = async (key) => {
  if (!nudgeDir) return true; // no state dir → can't dedupe; allow the nudge
  const bucket = bucketFor(Date.now(), NUDGE_WINDOW_MS);
  if (bucket === null) return true; // dedupe disabled (windowMs<=0)
  // Make the dir OUTSIDE the collision try — an mkdir failure must fail OPEN
  // (nudge), not be mistaken for a marker collision (which would suppress).
  try {
    mkdirSync(nudgeDir, { recursive: true });
  } catch {
    return true;
  }
  const p = join(nudgeDir, markerName(key, bucket));
  try {
    closeSync(openSync(p, 'wx')); // atomic: only the first in this window bucket wins
  } catch (error) {
    if (error && error.code === 'EEXIST') return false; // already nudged this window
    return true; // other errors → fail toward notifying
  }
  sweepStaleMarkers(bucket);
  return true;
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
    resolveRepoForPane, listTicketIds, readActiveTicket, hasCurrentTicket, claim,
  });
  if (plan.kind === 'clear-pane') {
    await runHerdr(buildPaneClearArgs(plan.paneId));
  } else if (plan.kind === 'notify') {
    await runHerdr(notifyArgs(plan.title, plan.body, plan.sound));
  }
  // kind === 'none' → nothing
}

// Fail SOFT (never crash the herdr session) but not SILENT — log to stderr so
// the host captures the failure. Set exitCode instead of calling process.exit,
// so the event loop drains and the stderr write actually flushes to the host
// pipe before the process ends (a synchronous exit could truncate it).
main().catch((err) => {
  try {
    console.error('[adlc on-event]', err instanceof Error ? err.stack || err.message : String(err));
  } catch {
    // logging must never itself throw
  }
  process.exitCode = 0;
});
