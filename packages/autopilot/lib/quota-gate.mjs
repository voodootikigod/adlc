// `ctx.quota` (spec §3.2, §3.4): the START gate every Claude-consuming step
// consults, bound to the status file's reservation ordinal, plus the
// post-step reconciliation that appends `{step, before, after, delta}` to the
// status file AND the run record. Pure pieces come from lib/quota.mjs; this
// module only wires them to the stores.

import { createSampler, evaluate, thresholdFor, reconcile as reconcileWindows, familyOf, DEFAULT_THRESHOLD, DEFAULT_RESERVE, QUOTA_UNKNOWN } from './quota.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'quota-gate.skipRecordAppend',   // reconcile no longer appends the entry to the run record
]);

export const MAX_RECORD_QUOTA_STEPS = 50;

/**
 * @param opts.read       async () => validated usage (readUsage's result) — injected network
 * @param opts.status     lib/status.mjs store
 * @param opts.records    lib/records.mjs store
 * @param opts.model      effective model (family via familyOf)
 * @param opts.threshold  operator-local threshold (1..50)
 * @param opts.reserve    operator-local reserve
 * @param opts.now        injectable clock
 */
export function createQuotaGate({ read, status, records, model, threshold = DEFAULT_THRESHOLD, reserve = DEFAULT_RESERVE, now = Date.now, log = () => {} }) {
  const family = familyOf(model);
  const sampler = createSampler({ read, now });
  const windowsOf = (validated) => (validated?.ok ? {
    fiveHour: validated.fiveHour, sevenDay: validated.sevenDay,
    scoped: (validated.scoped instanceof Map ? validated.scoped.get(family) : validated.scoped?.[family]) ?? null,
    nextResetAt: validated.resetsAt?.fiveHour ?? null,
  } : null);

  /**
   * Evaluate the gate for a start at `ordinal` (1 = the first start of the
   * iteration → threshold; later → threshold − reserve). `fresh` forces a
   * re-read (every Claude-consuming step passes it).
   */
  async function sample({ ordinal = 1, fresh = true } = {}) {
    const validated = await sampler.sample({ fresh });
    const t = thresholdFor(ordinal, { threshold, reserve });
    const verdict = evaluate(validated, { family, threshold: t });
    const windows = verdict.windows ?? windowsOf(validated);
    const result = { ok: verdict.ok, reason: verdict.reason ?? null, windows, threshold: t, ordinal, family, checkedAt: new Date(now()).toISOString() };
    try {
      status?.write({ quota: { ...(windows ?? {}), checkedAt: result.checkedAt, ok: result.ok, reason: result.reason, threshold: t, nextResetAt: validated?.resetsAt?.fiveHour ?? null } });
    } catch (e) { log(`status write failed: ${e.message}`); }
    return result;
  }

  /**
   * After a Claude-consuming step: re-read, compute the delta and overshoot,
   * append to the status file and (when `issue` is given) the run record.
   */
  async function reconcile(step, before, { issue = null } = {}) {
    const validated = await sampler.sample({ fresh: true });
    const after = validated?.ok ? windowsOf(validated) : { unknown: true, reason: validated?.reason ?? QUOTA_UNKNOWN };
    const beforeWindows = before?.windows ?? before ?? null;
    const entry = reconcileWindows({ step, before: beforeWindows, after: validated?.ok ? after : null, threshold });
    const recorded = { ...entry, after, at: new Date(now()).toISOString() };
    try { status?.recordQuota(step, beforeWindows, after, { threshold, overshoot: entry.overshoot, delta: entry.delta }); }
    catch (e) { log(`status quota append failed: ${e.message}`); }
    if (issue != null && records && !active('quota-gate.skipRecordAppend')) {
      const cur = records.load(issue);
      if (cur) records.update(issue, { quotaSteps: [...(cur.quotaSteps ?? []), recorded].slice(-MAX_RECORD_QUOTA_STEPS) });
    }
    return recorded;
  }

  return { sample, reconcile, invalidate: () => sampler.invalidate(), family, threshold, reserve };
}
