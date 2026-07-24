#!/usr/bin/env node
// [[events]] dispatcher (t-herdr-5, plan §5.4). Thin glue: parse the event env
// (probed live 2026-07-24 — HERDR_PLUGIN_EVENT is the dotted name,
// HERDR_PLUGIN_EVENT_JSON the payload), wire the real repo-state readers, ask
// the pure planner (lib/event-plan) what to do, and execute the single plan.
// Fail soft everywhere — an event handler must never crash the herdr session.
import { mkdirSync, openSync, closeSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runHerdr, runHerdrJson, paneInfoArgs } from '../lib/herdr.mjs';
import { repoRootFromCwd } from '../lib/repo-root.mjs';
import { readActiveTicket, ticketIdsFromStore } from '../lib/adlc-state.mjs';
import { notifyArgs } from '../lib/actions.mjs';
import { buildPaneClearArgs } from '../lib/tokens.mjs';
import { planEvent } from '../lib/event-plan.mjs';

async function resolveRepoForPane(paneId) {
  const res = await runHerdrJson(paneInfoArgs(paneId));
  const pane = res.ok ? res.value?.result?.pane ?? null : null;
  const dir = (pane && typeof pane.foreground_cwd === 'string' && pane.foreground_cwd)
    || (pane && typeof pane.cwd === 'string' && pane.cwd) || null;
  if (!dir) return null;
  // PURE upward walk — never spawn `git` inside the (untrusted) pane cwd, which
  // could trigger a malicious .git/config hook. Read-only existence checks only.
  return repoRootFromCwd(dir);
}

// Ticket ids come from a direct FILESYSTEM read of the store (never a
// subprocess with the untrusted event repoRoot as cwd — a config-loading CLI
// there would be a code-execution vector; a plain read is not).
const listTicketIds = (repoRoot) => ticketIdsFromStore(repoRoot);

// "Is a ticket already pointed at?" via the generated reader (never hand-parse
// the pointer — the ticket-store boundary guard enforces exactly one reader).
// present OR unreadable both count as "has a pointer" → don't nudge to seed.
const hasCurrentTicket = (repoRoot) => readActiveTicket(repoRoot).state !== 'absent';

// Dedupe markers: one file per (pane|ticket|status), named by hash so any id
// characters are safe in the filename. `claim` returns true (nudge) only if we
// have NOT already nudged this key within NUDGE_WINDOW_MS. The window — not a
// permanent marker — is the point: a rapid status flap is suppressed, but a
// genuine later idle (a new work cycle) re-nudges, so multi-turn workflows keep
// getting nudged. Marker creation is atomic (openSync 'wx') so concurrent
// per-event processes can't both pass a check-then-write race.
const NUDGE_WINDOW_MS = Number(process.env.ADLC_HERDR_NUDGE_WINDOW_MS ?? 30_000);
const nudgeDir = process.env.HERDR_PLUGIN_STATE_DIR
  ? join(process.env.HERDR_PLUGIN_STATE_DIR, 'nudged')
  : null;
const markerPath = (key) => (nudgeDir ? join(nudgeDir, createHash('sha256').update(key).digest('hex')) : null);
const claim = async (key) => {
  const p = markerPath(key);
  if (!p) return true; // no state dir → can't dedupe; allow the nudge
  const now = Date.now();
  try {
    mkdirSync(nudgeDir, { recursive: true });
    closeSync(openSync(p, 'wx')); // first time for this key → nudge
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      let stale;
      try {
        stale = now - statSync(p).mtimeMs >= NUDGE_WINDOW_MS;
      } catch {
        return true; // marker vanished/unreadable → nudge
      }
      if (!stale) return false; // within the window → suppress the flap
      // Window elapsed → renew ATOMICALLY: remove the expired marker and
      // re-create exclusively. Only the one process whose openSync('wx') wins
      // returns true; concurrent racers get EEXIST → false. (A plain
      // stat-then-utimes would let every racer renew and all nudge.)
      try {
        rmSync(p, { force: true });
        closeSync(openSync(p, 'wx'));
        return true;
      } catch {
        return false; // another process already renewed
      }
    }
    return true; // other errors: fail toward notifying (better one extra than a silent miss)
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
    resolveRepoForPane, listTicketIds, readActiveTicket, hasCurrentTicket, claim,
  });
  if (plan.kind === 'clear-pane') {
    await runHerdr(buildPaneClearArgs(plan.paneId));
  } else if (plan.kind === 'notify') {
    await runHerdr(notifyArgs(plan.title, plan.body, plan.sound));
  }
  // kind === 'none' → nothing
}

main().catch(() => process.exit(0));
