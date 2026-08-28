// Selection (spec §4; AC 3, 19, 54, 97): the §4.3 score, the §4.2 hard
// exclusions (every rule name a log line and the `--json` output carry), and
// the pick. `--issue N` bypasses SCORING only; `--force` lifts exactly the five
// autopilot-owned STOP labels, table-driven from `STOP_LABELS`, and nothing
// else (§2). Enumeration itself lives in lib/github.mjs (`listOpenIssues`).

import { branchFor, validateIssueNumber, InputError } from './input.mjs';
import { STOP_LABELS, EXCLUDING_LABELS, LABELS } from './labels.mjs';
import { labelNames } from './authorize.mjs';
import { scopeIntersects } from './denylist.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'select.ignoreLabels',        // the score ignores every label signal (AC 3)
  'select.forceLiftsAll',       // --force lifts every exclusion, not only the STOP labels (AC 19)
  'select.skipRemoteRefCheck',  // the selection-time ls-remote result is ignored (AC 97)
]);

/* ---------- §4.3 score ---------- */

export const PRIORITY_POINTS = Object.freeze({ 'P0-critical': 400, 'P1-high': 300, 'P2-medium': 200, 'P3-low': 100 });
export const KIND_POINTS = Object.freeze({ bug: 30, documentation: 20, enhancement: 10 });
export const AUTOPILOT_POINTS = 1000;
export const SECURITY_POINTS = 15;
export const SINGLE_AREA_POINTS = 10;
export const AGE_CAP = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Age in whole weeks open, capped (`createdAt` from gh issue view, `created_at` from gh api). */
export function agePoints(issue, nowMs) {
  const created = Date.parse(issue?.createdAt ?? issue?.created_at ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(nowMs) || nowMs <= created) return 0;
  return Math.min(AGE_CAP, Math.floor((nowMs - created) / WEEK_MS));
}

/** `{ score, breakdown }` per the §4.3 table; ties are broken by the caller (lower number). */
export function scoreIssue(issue, now = Date.now()) {
  const nowMs = typeof now === 'function' ? now() : now;
  const names = active('select.ignoreLabels') ? [] : labelNames(issue);
  const priority = Math.max(0, ...names.map((n) => PRIORITY_POINTS[n] ?? 0));
  const kind = names.reduce((sum, n) => sum + (KIND_POINTS[n] ?? 0), 0);
  const areas = names.filter((n) => n.startsWith('area:')).length;
  const breakdown = {
    autopilot: names.includes(LABELS.autopilot) ? AUTOPILOT_POINTS : 0,
    priority, kind,
    security: names.includes('security') ? SECURITY_POINTS : 0,
    area: areas === 1 ? SINGLE_AREA_POINTS : 0,
    age: agePoints(issue, nowMs),
  };
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown };
}

/* ---------- §4.2 hard exclusions ---------- */

/** Record states that quarantine an issue until a human acts (§2.1). */
export const QUARANTINE_STATES = Object.freeze(['oid-mismatch', 'blocked', 'stale', 'ci-red', 'clarify']);
export const SHAPING_ATTEMPT_LIMIT = 3;

const closesRe = (n) => new RegExp(`\\b(?:Closes|Fixes|Resolves)\\s+#${n}\\b`, 'i');

function recordFor(records, n) {
  if (!records) return null;
  if (typeof records.load === 'function') return records.load(n) ?? null;
  if (typeof records.state === 'string' && (records.issue === undefined || records.issue === n)) return records;
  return records[n] ?? records[String(n)] ?? null;
}

/**
 * Every §4.2 rule, evaluated over already-gathered facts (no I/O here).
 *
 * @param issue            the gh issue object
 * @param authorization    result of `eligibleAuthor` ({ ok, rule })
 * @param openPrs          [{ number, headRefName, body }]
 * @param localBranches    branch names present locally
 * @param remoteRefExists  boolean from the selection-time ls-remote; anything else → fail closed
 * @param records          record store (`load`), a map keyed by number, or the issue's record
 * @param milestoneTitle   overrides `issue.milestone.title` when given
 * @param scopeBlock       the issue's `<!-- adlc:begin -->` scope globs (or null)
 * @param denylist         `buildDenylist` result
 * @param attempts         failed shaping attempts in 24 h (number) or `{ failedWithin24h }`
 * @returns [{ rule, detail }]
 */
export function hardExclusions({ issue, authorization, openPrs = [], localBranches = [], remoteRefExists, records = null, milestoneTitle, scopeBlock = null, denylist = null, attempts = 0 }) {
  const n = validateIssueNumber(issue?.number, 'issue');
  const branch = branchFor(n);
  const out = [];
  const add = (rule, detail = null) => { out.push(detail == null ? { rule } : { rule, detail }); };

  if (!authorization || authorization.ok !== true) add(authorization?.rule ?? 'not-authorized', authorization?.reason ?? 'no authorization result');

  const names = labelNames(issue);
  for (const label of EXCLUDING_LABELS) if (names.includes(label)) add(`label:${label}`);

  const milestone = milestoneTitle ?? issue?.milestone?.title ?? null;
  if (typeof milestone === 'string' && milestone.startsWith('Programs')) add('programs-milestone', milestone);

  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    const head = pr?.headRefName ?? pr?.head?.ref ?? null;
    if (head === branch) { add('open-pr', `#${pr.number} head ${head}`); break; }
    if (typeof pr?.body === 'string' && closesRe(n).test(pr.body)) { add('open-pr', `#${pr.number} closes #${n}`); break; }
  }

  if ((Array.isArray(localBranches) ? localBranches : []).includes(branch)) add('local-branch', branch);

  if (Array.isArray(scopeBlock) && scopeBlock.length > 0 && denylist) {
    const hits = scopeIntersects(scopeBlock, denylist);
    if (hits.length) add('protected-path', hits.join(','));
  }

  if (!active('select.skipRemoteRefCheck')) {
    if (remoteRefExists === true) add('remote-ref-exists', branch);
    else if (remoteRefExists !== false) add('remote-ref-unverified', 'selection-time ls-remote did not answer');
  }

  const record = recordFor(records, n);
  if (record) {
    if (record.state === 'remote-pending') add('remote-ref-pending', branch);
    if (record.state === 'orphan') add('orphan', record.branch ?? branch);
    if (QUARANTINE_STATES.includes(record.state)) add('quarantined', record.state);
  }

  const failed = typeof attempts === 'number' ? attempts : Number(attempts?.failedWithin24h ?? 0);
  if (failed >= SHAPING_ATTEMPT_LIMIT) add('shaping-failed', `${failed} failed shaping attempts in 24 h`);

  return out;
}

/* ---------- --force ---------- */

/** The rules `--force` lifts: exactly `label:<STOP_LABEL>` for the five STOP labels (§2). */
export const FORCE_LIFTABLE_RULES = Object.freeze(STOP_LABELS.map((l) => `label:${l}`));
export const forceLifts = (rule) => active('select.forceLiftsAll') || FORCE_LIFTABLE_RULES.includes(rule);

/* ---------- the pick ---------- */

/**
 * @param candidates  issue objects (the §4.1 candidate set)
 * @param evaluate    issue → { exclusions:[{rule}], score?, breakdown? } (sync or async); an array is taken as exclusions
 * @param pinned      `--issue N`: scoring bypassed, every exclusion still applied
 * @param force       `--force` (only with `pinned`): lifts FORCE_LIFTABLE_RULES only
 * @returns {{ picked, ranked:[{ number, score, breakdown, excluded, lifted }], reason, rules }}
 */
export async function selectIssue({ candidates, evaluate, pinned = null, force = false, now = Date.now }) {
  if (!Array.isArray(candidates)) throw new TypeError('selectIssue: candidates must be an array');
  const pin = pinned == null ? null : validateIssueNumber(pinned, 'issue');
  if (force && pin == null) throw new InputError('force', '--force requires --issue');
  const pool = pin == null ? candidates : candidates.filter((c) => c?.number === pin);
  if (pin != null && pool.length === 0) return { picked: null, ranked: [], reason: 'issue-not-found', rules: [] };

  const ranked = [];
  for (const issue of pool) {
    const ev = await evaluate(issue);
    const exclusions = Array.isArray(ev) ? ev : (ev?.exclusions ?? []);
    const lifted = force ? exclusions.filter((x) => forceLifts(x.rule)) : [];
    const excluded = exclusions.filter((x) => !lifted.includes(x));
    const scored = !Array.isArray(ev) && typeof ev?.score === 'number' ? { score: ev.score, breakdown: ev.breakdown ?? {} } : scoreIssue(issue, now);
    ranked.push({ number: issue.number, score: scored.score, breakdown: scored.breakdown, excluded, lifted });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.number - b.number));
  const first = ranked.find((r) => r.excluded.length === 0) ?? null;
  const picked = first ? pool.find((c) => c.number === first.number) : null;
  if (picked) return { picked, ranked, reason: null, rules: [] };
  const rules = pin != null ? ranked[0].excluded.map((x) => x.rule) : [];
  return { picked: null, ranked, reason: pin != null ? 'excluded' : 'no-eligible-candidate', rules };
}
