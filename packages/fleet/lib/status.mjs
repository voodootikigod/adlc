// Run status persistence (spec §6.2). `.adlc/fleet-status.json` is the resumable
// cache; git remains the source of truth (§6.4). Written atomically (temp +
// rename) after every transition so a crash never leaves a partial file.
//
// Immutable updates: every mutator returns a NEW status object rather than
// editing in place (repo coding-style rule), which keeps the scheduler's
// state transitions easy to reason about and test.

import { writeFileSync, readFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const STATUS_FILE = 'fleet-status.json';

/** Terminal + in-flight state sets used across the scheduler. */
export const IN_FLIGHT_STATES = ['building', 'gating', 'prosecuting', 'fixing', 'merging'];
export const TERMINAL_STATES = ['merged', 'failed', 'blocked'];

/**
 * A fresh run status. `baseSha` + `integrationBranch` anchor resume
 * reconciliation (§6.4, N2); they are NOT `base`, because successful work merges
 * only into the integration branch.
 */
// Version of the fleet-status.json shape. It is an internal resumable cache AND
// a read-only observation surface (the herdr plugin reads it); a consumer that
// sees an unknown/absent version must degrade to polling `fleet status --json`.
// Bump ONLY on a breaking change to the observed fields.
export const FLEET_STATUS_SCHEMA_VERSION = 1;

export function newStatus({ runId, base, baseSha, integrationBranch, concurrency, sandboxMode, startedAt }) {
  return {
    schemaVersion: FLEET_STATUS_SCHEMA_VERSION,
    runId,
    base,
    baseSha,
    integrationBranch,
    sandboxMode,
    concurrency,
    startedAt,
    // Branch-level quarantine: survives across resumes, so a run that could not
    // withdraw a gate-rejected completion never publishes that branch later.
    contaminated: false,
    contaminationReason: null,
    tickets: {},
  };
}

function statusPath(dir) {
  return join(dir, STATUS_FILE);
}

/** Load the status object, or null if none exists. */
export function loadStatus(dir) {
  const p = statusPath(dir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Atomically persist the status object (temp file + rename). */
export function saveStatus(dir, status) {
  mkdirSync(dir, { recursive: true });
  const p = statusPath(dir);
  const tmp = `${p}.tmp-${status.runId ?? 'run'}`;
  writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  renameSync(tmp, p);
  return status;
}

/**
 * Return a NEW status with ticket `id` patched. `patch` is merged over the
 * existing per-ticket record; `updatedAt` is stamped by the caller (Date is
 * injected — this module never calls Date itself, keeping it deterministic).
 */
export function withTicket(status, id, patch) {
  const prev = status.tickets[id] ?? { state: 'pending', strikes: 0 };
  return {
    ...status,
    tickets: {
      ...status.tickets,
      [id]: { ...prev, ...patch },
    },
  };
}

/** Map of ticket id → state string, for feeding plan.computeReady. */
export function statusById(status) {
  const out = {};
  for (const [id, rec] of Object.entries(status.tickets)) out[id] = rec.state;
  return out;
}

/** Ids currently occupying a worker slot. */
export function inFlightIds(status) {
  return Object.entries(status.tickets)
    .filter(([, rec]) => IN_FLIGHT_STATES.includes(rec.state))
    .map(([id]) => id);
}
