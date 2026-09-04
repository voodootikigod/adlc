// The autopilot's label vocabulary (spec §4.2, §9.5, §2 `--force`).
//
// Every label the autopilot reads or writes is named HERE and nowhere else:
// the eight it owns (created idempotently by `adlc-autopilot init --labels`,
// required by preflight phase A), the five STOP labels `--force` may lift, and
// the full §4.2 excluding set. Preflight fails closed with `labels-missing`
// naming the absent ones, so every later label mutation targets a label that
// is known to exist.

import { PER_PAGE, MAX_PAGES } from './github.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'labels.skipCreate',    // ensureLabels reports success without spawning `gh label create`
  'labels.ignoreMissing', // missingLabels reports nothing missing regardless of the repo
]);

export const LABELS = Object.freeze({
  autopilot: 'adlc:autopilot',
  skip: 'adlc:autopilot-skip',
  clarify: 'adlc:needs-clarification',
  blocked: 'adlc:autopilot-blocked',
  stale: 'adlc:autopilot-stale',
  ciRed: 'adlc:autopilot-ci-red',
  needsHuman: 'adlc:needs-human',
  log: 'adlc:autopilot-log',
});

/** The eight labels §9.5 requires to exist. */
export const ALL_LABELS = Object.freeze(Object.values(LABELS));

/** The five autopilot-owned STOP labels `--force` lifts (§2) — and nothing else. */
export const STOP_LABELS = Object.freeze([LABELS.blocked, LABELS.stale, LABELS.ciRed, LABELS.clarify, LABELS.skip]);

/** The §4.2 "label in {…}" exclusion set, verbatim. */
export const EXCLUDING_LABELS = Object.freeze([
  'trust-root-change', 'question', 'wontfix', 'duplicate', 'invalid',
  LABELS.skip, LABELS.blocked, LABELS.stale, LABELS.ciRed, LABELS.clarify, LABELS.needsHuman, LABELS.log,
]);

/** Colour + description used when a label is created (cosmetic; never read back). */
export const LABEL_META = Object.freeze({
  [LABELS.autopilot]: { color: '0E8A16', description: 'Operator override: authorize and prioritize for the ADLC autopilot' },
  [LABELS.skip]: { color: 'D4C5F9', description: 'Autopilot must not pick this issue' },
  [LABELS.clarify]: { color: 'FBCA04', description: 'Autopilot triage needs a clarified issue body' },
  [LABELS.blocked]: { color: 'B60205', description: 'Autopilot run blocked; a human must lift' },
  [LABELS.stale]: { color: 'BFD4F2', description: 'Autopilot PR could not be rebased; a human must lift' },
  [LABELS.ciRed]: { color: 'E99695', description: 'Autopilot PR is red in CI beyond its fix budget' },
  [LABELS.needsHuman]: { color: 'F9D0C4', description: 'Autopilot escalation: a human decision is required' },
  [LABELS.log]: { color: 'C5DEF5', description: 'The autopilot digest issue' },
});

export class LabelsError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'LabelsError'; this.code = code; this.exitCode = 1; }
}

/**
 * The repository's label names — one page per call, bounded like §4.1
 * (never `gh label list --limit N`, which truncates silently).
 * Unreadable → throws `labels-unreadable` (fail closed).
 */
export async function listLabelNames(gh, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const names = new Set();
  for (let page = 1; page <= maxPages; page++) {
    let arr;
    try { arr = await gh.json(['api', `repos/${gh.repo}/labels?per_page=${perPage}&page=${page}`]); }
    catch (e) { throw new LabelsError('labels-unreadable', e.message); }
    if (!Array.isArray(arr)) throw new LabelsError('labels-unreadable', 'page is not an array');
    for (const el of arr) {
      if (el === null || typeof el !== 'object' || typeof el.name !== 'string') throw new LabelsError('labels-unreadable', 'malformed element');
      names.add(el.name);
    }
    if (arr.length < perPage) return names;
  }
  throw new LabelsError('labels-unreadable', `${maxPages} full pages`);
}

/** The §9.5 labels absent from the repository, in LABELS order. */
export async function missingLabels(gh) {
  const present = await listLabelNames(gh);
  if (active('labels.ignoreMissing')) return [];
  return ALL_LABELS.filter((name) => !present.has(name));
}

/**
 * Create every §9.5 label idempotently (`gh label create <name> --force`:
 * creates or updates, never fails on an existing label). Returns the names
 * created; any non-zero exit → throws `label-create-failed` naming the label.
 */
export async function ensureLabels(gh, { labels = ALL_LABELS } = {}) {
  const created = [];
  for (const name of labels) {
    if (!ALL_LABELS.includes(name)) throw new LabelsError('label-create-failed', `${name} is not an autopilot label`);
    if (active('labels.skipCreate')) { created.push(name); continue; }
    const meta = LABEL_META[name];
    const res = await gh.run(['label', 'create', name, '--force', '--color', meta.color, '--description', meta.description]);
    if (res.status !== 0) throw new LabelsError('label-create-failed', `${name}: ${String(res.stderr ?? '').trim().slice(0, 200)}`);
    created.push(name);
  }
  return { created };
}
