// The status file (spec §10, §3.4; AC 87): `.adlc/autopilot-status.json`, a
// STRUCTURED document written atomically (temp + rename) whose free-text
// fields pass through the structured redactor and whose identifiers never do.
//
// `startsThisIteration` is the reservation ordinal of §3.4: reset to 0 at the
// top of each loop iteration and incremented atomically by EVERY start — the
// loop's own steps and the pre-strike helper alike — so the ordinal is a fact
// of record, not an argument a caller could get wrong. The increment is legal
// only while the autopilot lock is held by the caller's token (§3.2: "a helper
// invoked without a lock-holding parent refuses with exit 1").

import { mkdirSync, statSync, rmSync } from 'node:fs';
import { writeAtomicJson, readJson } from './records.mjs';
import { redactRecord } from './redact.mjs';
import { lockHeldBy } from './lock.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'status.noLockForOrdinal',   // incrementStarts no longer requires the lock
  'status.skipQuotaAppend',    // recordQuota drops the per-step entry
]);

/** A cross-process mutex for the status file: an atomic `mkdir`, spun with short sleeps, stale after 30 s. */
export function withStatusMutex(statusFile, fn, { timeoutMs = 10_000, staleMs = 30_000, sleepMs = 5 } = {}) {
  const dir = `${statusFile}.mutex`;
  const started = Date.now();
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
      if (age > staleMs) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() - started > timeoutMs) throw new StatusError('status-mutex-timeout', dir);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  try { return fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const STATUS_FREE_TEXT_FIELDS = Object.freeze(['lastError', 'reason', 'reasonText']);
export const MAX_QUOTA_STEPS = 50;

export class StatusError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/** The document a fresh status file starts from (every reader tolerates absence). */
export function defaultStatus(nowIso) {
  return {
    state: 'idle', since: nowIso, startsThisIteration: 0, iterationId: null,
    lastRun: null, quota: null, quotaSteps: [], openPrs: [], blocked: [], remoteRefsLeft: [],
    pinnedTools: null, pinnedUrls: null, digestIssue: null, lastError: null,
  };
}

/**
 * @param opts.paths      autopilotPaths(repoRoot) — `statusFile` and `adlc` are used
 * @param opts.lockToken  the autopilot lock token of this process (null → ordinal writes refuse)
 * @param opts.redactor   { redact } — applied to the free-text fields only
 * @param opts.now        injectable clock (epoch ms)
 */
export function createStatusStore({ paths, lockToken = null, redactor, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();
  const read = () => readJson(paths.statusFile) ?? defaultStatus(iso());
  const persist = (doc) => {
    const stamped = { ...doc, updatedAt: iso() };
    return writeAtomicJson(paths.statusFile, redactor ? redactRecord(stamped, STATUS_FREE_TEXT_FIELDS, redactor) : stamped);
  };
  /** Shallow merge + atomic write. Returns the written document. */
  const write = (patch) => persist({ ...read(), ...patch });
  const requireLock = (what) => {
    if (active('status.noLockForOrdinal')) return;
    // `lockToken` may be a getter: the store is built before the lock is acquired.
    const token = typeof lockToken === 'function' ? lockToken() : lockToken;
    if (!token || !lockHeldBy(paths.adlc, token)) throw new StatusError('lock-required', `${what} requires the autopilot lock`);
  };
  /** Atomic increment under the lock; returns the NEW ordinal (1 for the first start). */
  const incrementStarts = () => {
    requireLock('incrementStarts');
    // The read-modify-write is serialized ACROSS PROCESSES (the pre-strike helpers run concurrently
    // under the orchestrator's lock, which is not a mutex for them): a mkdir mutex next to the file.
    return withStatusMutex(paths.statusFile, () => {
    const cur = read();
      const next = (Number.isInteger(cur.startsThisIteration) ? cur.startsThisIteration : 0) + 1;
      persist({ ...cur, startsThisIteration: next });
      return next;
  
    });
  };
  /** Top of an iteration: the ordinal returns to 0 (under the lock). */
  const resetStarts = (iterationId = null) => {
    requireLock('resetStarts');
    persist({ ...read(), startsThisIteration: 0, iterationId });
    return 0;
  };
  /** Pinned tool paths (absolute paths only — never a key or token). */
  const pinTools = (pinned) => write({ pinnedTools: Object.fromEntries(Object.entries(pinned ?? {}).filter(([k]) => !k.endsWith(':realpath'))) });
  const pinUrls = ({ remoteFetchUrl, remotePushUrl, host, repo } = {}) => write({ pinnedUrls: { remoteFetchUrl, remotePushUrl, host, repo } });
  /** §3.4 reconciliation entry: appended per step (bounded) and mirrored into `quota`. */
  const recordQuota = (step, before, after, { threshold = null, overshoot = null, delta = null } = {}) => {
    const cur = read();
    const entry = { step, before, after, delta, overshoot, threshold, at: iso() };
    const quotaSteps = active('status.skipQuotaAppend') ? (cur.quotaSteps ?? []) : [...(cur.quotaSteps ?? []), entry].slice(-MAX_QUOTA_STEPS);
    persist({ ...cur, quotaSteps, quota: { ...(cur.quota ?? {}), ...(after ?? {}), checkedAt: entry.at } });
    return entry;
  };
  return { read, write, incrementStarts, resetStarts, pinTools, pinUrls, recordQuota, path: paths.statusFile };
}
