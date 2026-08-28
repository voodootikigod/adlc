// Run records (spec §2.1): one JSON document per issue under
// `.adlc/autopilot-runs/<issue>.json`, written atomically (temp + rename) and
// BEFORE the world-effect it names is attempted, so a crash between the two
// leaves a record the next iteration can disambiguate by inspecting git/gh.
// Free-text fields pass through the structured redactor; identifiers never do.

import { writeFileSync, readFileSync, existsSync, renameSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { redactRecord } from './redact.mjs';
import { active } from './mutations.mjs';

export const STATES = Object.freeze([
  'creating', 'clarify', 'shaped', 'dispatched', 'quota-paused', 'built', 'attested', 'pushed', 'pr-open',
  'ci-watch', 'oid-mismatch', 'blocked', 'stale', 'ci-red', 'done', 'remote-pending', 'remote-deleted', 'orphan',
]);
export const CREATION_PHASES = Object.freeze(['recorded', 'staged', 'marked', 'renamed', 'moved']);
/** label ↔ state mapping is fixed (§2.1). */
export const LABEL_FOR_STATE = Object.freeze({
  clarify: 'adlc:needs-clarification',
  blocked: 'adlc:autopilot-blocked',
  stale: 'adlc:autopilot-stale',
  'ci-red': 'adlc:autopilot-ci-red',
});
export const STATE_FOR_LABEL = Object.freeze(Object.fromEntries(Object.entries(LABEL_FOR_STATE).map(([s, l]) => [l, s])));
/** The free-text fields the redactor sees (§10); everything else is identifier/state. */
export const FREE_TEXT_FIELDS = Object.freeze(['lastError', 'reasonText', 'commentDraft', 'excerpt', 'findingsExcerpt']);
/** Maintenance candidates (§8): ONLY these states are ever rebased/dispatched/pushed by maintenance. */
export const MAINTENANCE_STATES = Object.freeze(['pr-open', 'ci-watch']);
/** States that count toward the open-PR cap when their PR is OPEN (§8). */
export const CAP_STATES = Object.freeze(['pr-open', 'ci-watch', 'oid-mismatch']);
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function writeAtomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
  return data;
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertState(state) {
  if (!STATES.includes(state)) throw new Error(`unknown run state: ${state}`);
  return state;
}

/**
 * A run-record store bound to the paths and a redactor. Every write goes
 * through `save`, which validates the state, stamps `updatedAt` and redacts
 * the free-text fields.
 */
export function createRecordStore({ paths, redactor, now = () => new Date().toISOString() }) {
  const load = (issue) => readJson(paths.record(issue));
  const save = (record) => {
    assertState(record.state);
    if (record.creationPhase != null && !CREATION_PHASES.includes(record.creationPhase)) throw new Error(`unknown creationPhase: ${record.creationPhase}`);
    // Mutation seam `records.skipRedaction`: free-text fields are written raw.
    const stamped = { ...record, updatedAt: now() };
    const doc = active('records.skipRedaction') ? stamped : redactRecord(stamped, FREE_TEXT_FIELDS, redactor);
    return writeAtomicJson(paths.record(record.issue), doc);
  };
  const update = (issue, patch) => {
    const cur = load(issue);
    if (!cur) throw new Error(`no run record for issue ${issue}`);
    return save({ ...cur, ...patch });
  };
  /** The canonical deletion rule's final step (§2.1): delete + tombstone. */
  const remove = (issue, { lastPushedOid = null } = {}) => {
    const cur = load(issue);
    const p = paths.record(issue);
    if (existsSync(p)) unlinkSync(p);
    writeAtomicJson(paths.tombstone(issue), { issue, lastPushedOid: lastPushedOid ?? cur?.lastPushedOid ?? null, deletedAt: now() });
    return cur;
  };
  const tombstone = (issue) => readJson(paths.tombstone(issue));
  const pruneTombstones = (nowMs = Date.now()) => {
    let pruned = 0;
    for (const f of listFiles(paths.runsDir, /\.tombstone\.json$/)) {
      const t = readJson(f);
      if (t?.deletedAt && nowMs - Date.parse(t.deletedAt) > TOMBSTONE_TTL_MS) { unlinkSync(f); pruned++; }
    }
    return pruned;
  };
  const all = () => listFiles(paths.runsDir, /^\d+\.json$/, true).map((f) => readJson(f)).filter(Boolean);
  return { load, save, update, remove, tombstone, pruneTombstones, all };
}

function listFiles(dir, re, basenameOnly = false) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n)).filter(() => true).filter((p) => (basenameOnly ? re.test(p.slice(p.lastIndexOf('/') + 1)) : true));
}

/** A fresh record for a run about to be created (§6.1 step 1). */
export function newRecord({ issue, token, baseOid, branch, stagingBranch, stagingPath, finalPath, issueRevision = null, ticketCache = null }) {
  return {
    issue, token, state: 'creating', creationPhase: 'recorded',
    baseOid, branch, finalBranch: branch, stagingBranch, stagingPath, finalPath,
    runId: null, ticketId: null, fleetRunId: null, prNumber: null,
    roundsUsed: 0, wallClockUsedMs: 0, ciRoundsUsed: 0,
    lastPushedOid: null, lastPushedAt: null, localHead: null, attestedHead: null, reviewedHead: null,
    integrationStart: null, ticketSnapshotSha256: null, specBlob: null,
    manifestLinesWritten: [], issueRevision, ticketCache,
    effects: {}, digestPosted: false, unlabeledEventId: null,
    createdAt: new Date().toISOString(),
  };
}
