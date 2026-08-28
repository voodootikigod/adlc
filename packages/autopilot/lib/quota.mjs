// The quota gate (spec §3; AC 2, 18, 23, 27, 39, 47, 50, 65, 87).
//
// Source of truth: GET https://api.anthropic.com/api/oauth/usage with the
// harness's OAuth bearer and the `anthropic-beta` header. The response schema is
// STRICT and every deviation is `quota-unknown` (fail closed): one malformed
// entry anywhere in `limits[]` — whether or not it concerns the effective model —
// refuses the start. When the endpoint is unavailable (401/unreachable) the
// `claude -p "/usage"` text is parsed with the versioned grammar `usage-text/v1`.
// Both sources are compared in ONE family space via `familyOf`.
//
// Pure functions everywhere possible: the validator, the evaluator, the fallback
// parser and the family normalizer take data and return data; the network and
// the subprocess are injected.

import { active, registerSeams } from './mutations.mjs';

registerSeams(['quota.lenientText']);

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const BETA_HEADER = 'oauth-2025-04-20';
export const FAMILIES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);
export const QUOTA_UNKNOWN = 'quota-unknown';
export const SAMPLE_TTL_MS = 60_000;
export const DEFAULT_THRESHOLD = 50;
export const DEFAULT_RESERVE = 5;
export const FALLBACK_GRAMMAR = 'usage-text/v1';

/**
 * ONE normalization function applied to the endpoint's `display_name`, the
 * fallback's parenthesized name and `effectiveModel`: lower-case, split on
 * non-alphanumerics, the first family that occurs as a TOKEN; else `unknown`.
 */
export function familyOf(x) {
  if (typeof x !== 'string') return 'unknown';
  const tokens = x.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) if (FAMILIES.includes(t)) return t;
  return 'unknown';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPct = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const unknown = (detail) => ({ ok: false, reason: QUOTA_UNKNOWN, detail });

/** Validate ONE `limits[]` entry against the strict schema. Returns { ok, family?, percent?, detail? }. */
export function validateLimitEntry(entry) {
  if (!isPlainObject(entry)) return { ok: false, detail: 'limits entry is not an object' };
  if (typeof entry.kind !== 'string') return { ok: false, detail: 'limits entry lacks string kind' };
  if (!isPct(entry.percent)) return { ok: false, detail: 'limits entry percent out of range or missing' };
  if (!('scope' in entry)) return { ok: true, family: null, percent: entry.percent };
  const scope = entry.scope;
  if (!isPlainObject(scope) || !isPlainObject(scope.model) || typeof scope.model.display_name !== 'string' || scope.model.display_name.length === 0) {
    return { ok: false, detail: 'limits entry scope is malformed' };
  }
  return { ok: true, family: familyOf(scope.model.display_name), percent: entry.percent };
}

/**
 * Strict response validation (§3.1). Returns
 *   { ok:true, fiveHour, sevenDay, resetsAt:{fiveHour, sevenDay}, scoped: Map<family, percent> }
 *   or { ok:false, reason:'quota-unknown', detail }.
 */
export function validateUsageBody(body) {
  if (!isPlainObject(body)) return unknown('body is not an object');
  for (const key of ['five_hour', 'seven_day']) {
    const w = body[key];
    if (!isPlainObject(w)) return unknown(`${key} is not an object`);
    if (!isPct(w.utilization)) return unknown(`${key}.utilization is not a finite number in [0,100]`);
    if (!isIso(w.resets_at)) return unknown(`${key}.resets_at is not an ISO-8601 string`);
  }
  const scoped = new Map();
  if ('limits' in body) {
    if (!Array.isArray(body.limits)) return unknown('limits is not an array');
    for (const entry of body.limits) {
      const v = validateLimitEntry(entry);
      // Mutation seam `quota.lenientSchema`: a malformed entry is skipped instead of refusing.
      if (!v.ok) { if (active('quota.lenientSchema')) continue; return unknown(v.detail); }
      if (v.family === null) continue;
      if (scoped.has(v.family) && scoped.get(v.family) !== v.percent) return unknown(`duplicate scoped entries for ${v.family} with different percent`);
      scoped.set(v.family, v.percent);
    }
  }
  // `seven_day_<family>` sibling keys: null/absent → nothing; an object → its
  // utilization must be a valid percentage and must AGREE with the limits entry.
  for (const family of FAMILIES) {
    const key = `seven_day_${family}`;
    if (!(key in body) || body[key] === null) continue;
    const w = body[key];
    if (!isPlainObject(w) || !isPct(w.utilization)) return unknown(`${key} is present but malformed`);
    if (scoped.has(family) && scoped.get(family) !== w.utilization) return unknown(`${key} disagrees with limits`);
    scoped.set(family, w.utilization);
  }
  return {
    ok: true,
    fiveHour: body.five_hour.utilization,
    sevenDay: body.seven_day.utilization,
    resetsAt: { fiveHour: body.five_hour.resets_at, sevenDay: body.seven_day.resets_at },
    scoped,
  };
}

/** The canonical no-scoped-limit predicate (AC 47), stated over the RAW body. */
export function noScopedLimit(body, family) {
  const key = `seven_day_${family}`;
  const sibling = !(key in body) || body[key] === null;
  const inLimits = Array.isArray(body?.limits) && body.limits.some((e) => familyOf(e?.scope?.model?.display_name) === family);
  return sibling && !inLimits;
}

/**
 * The gate proper: every window `< threshold`. `validated` is the output of
 * validateUsageBody or parseUsageText.
 */
export function evaluate(validated, { family, threshold = DEFAULT_THRESHOLD }) {
  if (!validated.ok) return { ok: false, reason: QUOTA_UNKNOWN, detail: validated.detail ?? validated.reason };
  const { fiveHour, sevenDay, scoped } = validated;
  const scopedPct = scoped instanceof Map ? scoped.get(family) : scoped?.[family];
  const windows = { fiveHour, sevenDay, scoped: scopedPct ?? null };
  // Mutation seam `quota.forceOk`: the gate admits every start.
  if (active('quota.forceOk')) return { ok: true, reason: null, windows, threshold };
  if (fiveHour >= threshold) return { ok: false, reason: 'five_hour', windows, threshold };
  if (sevenDay >= threshold) return { ok: false, reason: 'seven_day', windows, threshold };
  if (scopedPct != null && scopedPct >= threshold) return { ok: false, reason: `seven_day_${family}`, windows, threshold };
  return { ok: true, reason: null, windows, threshold };
}

// ---- fallback grammar usage-text/v1 (§3.3) ----
const SESSION_RE = /^Current session: (\d{1,3})% used/m;
const WEEK_RE = /^Current week \(all models\): (\d{1,3})% used/m;
const SCOPED_RE = /^Current week \(([A-Za-z0-9 .-]+)\): (\d{1,3})% used/gm;

function allMatches(re, text) {
  const out = []; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m; while ((m = g.exec(text)) !== null) out.push(m);
  return out;
}

/** Parse the `/usage` text. Pure; every malformed case → quota-unknown. */
export function parseUsageText(text) {
  if (typeof text !== 'string') return unknown('usage text is not a string');
  if (!text.includes('subscription')) return unknown('usage text lacks the literal "subscription"');
  const sessions = allMatches(SESSION_RE, text);
  const weeks = allMatches(WEEK_RE, text);
  if (sessions.length === 0) return unknown('missing "Current session" line');
  if (weeks.length === 0) return unknown('missing "Current week (all models)" line');
  const distinct = (ms) => new Set(ms.map((m) => m[1])).size;
  if (distinct(sessions) > 1) return unknown('duplicate session lines disagree');
  if (distinct(weeks) > 1) return unknown('duplicate weekly lines disagree');
  const fiveHour = Number(sessions[0][1]); const sevenDay = Number(weeks[0][1]);
  // Mutation seam `quota.lenientText`: an out-of-range percentage is accepted.
  if (!active('quota.lenientText') && (fiveHour > 100 || sevenDay > 100)) return unknown('value above 100');
  const scoped = new Map();
  for (const m of allMatches(SCOPED_RE, text)) {
    if (m[1] === 'all models') continue;
    const family = familyOf(m[1]); const pct = Number(m[2]);
    if (pct > 100) return unknown('scoped value above 100');
    if (family === 'unknown') continue; // cannot be the effective model's family (which is always known)
    if (scoped.has(family) && scoped.get(family) !== pct) return unknown(`two ${family} lines disagree`);
    scoped.set(family, pct);
  }
  return { ok: true, fiveHour, sevenDay, resetsAt: { fiveHour: null, sevenDay: null }, scoped, grammar: FALLBACK_GRAMMAR };
}

/**
 * Read the quota from the endpoint, falling back to the `/usage` text.
 *
 * @param opts.fetchImpl   injectable fetch; the request carries EXACTLY two headers
 * @param opts.accessToken the bearer (never logged; the result names header NAMES only)
 * @param opts.fallback    async () => string — the `.result` of `claude -p "/usage" --output-format json`
 * @param opts.timeoutMs   endpoint timeout (10 s, one retry); fallback bound is the caller's
 */
export async function readUsage({ fetchImpl, accessToken, fallback, timeoutMs = 10_000, retries = 1, log = () => {} } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': BETA_HEADER };
  let last = null;
  if (typeof fetchImpl === 'function' && typeof accessToken === 'string' && accessToken.length > 0) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(USAGE_URL, { method: 'GET', headers, signal: ctl.signal });
        clearTimeout(timer);
        if (res.status === 401) { last = { source: 'endpoint', status: 401 }; break; }
        if (res.status !== 200) { last = { source: 'endpoint', status: res.status }; continue; }
        let body;
        try { body = await res.json(); } catch { return { ...unknown('endpoint body is not JSON'), source: 'endpoint', headersUsed: Object.keys(headers) }; }
        const v = validateUsageBody(body);
        return { ...v, body, source: 'endpoint', headersUsed: Object.keys(headers) };
      } catch (e) {
        clearTimeout(timer);
        last = { source: 'endpoint', error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
      }
    }
  }
  log(`quota endpoint unavailable (${JSON.stringify(last)}); consulting /usage fallback`);
  if (typeof fallback !== 'function') return { ...unknown('no usage source available'), source: 'none', headersUsed: Object.keys(headers) };
  let text;
  try { text = await fallback(); } catch (e) { return { ...unknown(`fallback failed: ${e.message}`), source: 'fallback', headersUsed: Object.keys(headers) }; }
  return { ...parseUsageText(text), source: 'fallback', headersUsed: Object.keys(headers) };
}

/**
 * A sample cache with the 60-second validity rule (§3.2): a result older than
 * `ttlMs` is NEVER reused; every Claude-consuming step re-samples.
 */
export function createSampler({ read, now = Date.now, ttlMs = SAMPLE_TTL_MS }) {
  let cached = null;
  return {
    async sample({ fresh = false } = {}) {
      // Mutation seam `quota.reuseStale`: a sample older than the TTL is reused.
      const ttl = active('quota.reuseStale') ? Number.POSITIVE_INFINITY : ttlMs;
      if (!fresh && cached && now() - cached.at < ttl) return cached.value;
      const value = await read();
      cached = { at: now(), value };
      return value;
    },
    invalidate() { cached = null; },
  };
}

/**
 * Threshold for a start ordinal (§3.4): the FIRST start of an iteration is
 * gated at the threshold, every later one at threshold − reserve.
 */
export function thresholdFor(ordinal, { threshold = DEFAULT_THRESHOLD, reserve = DEFAULT_RESERVE } = {}) {
  // Mutation seam `quota.noReserve`: every start is gated at the bare threshold.
  if (active('quota.noReserve')) return threshold;
  return ordinal <= 1 ? threshold : threshold - reserve;
}

/** Reconciliation record after a Claude-consuming step (§3.4). */
export function reconcile({ step, before, after, threshold = DEFAULT_THRESHOLD }) {
  const max = (w) => Math.max(w?.fiveHour ?? 0, w?.sevenDay ?? 0, w?.scoped ?? 0);
  const b = max(before); const a = max(after);
  return { step, before, after, delta: a - b, overshoot: a >= threshold };
}
