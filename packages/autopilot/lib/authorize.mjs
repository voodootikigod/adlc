// The ONE authorization predicate `eligibleAuthor` (spec §4.2, §5.1, §6.0a,
// §11; AC 33 79 85 109 155). Selection, revalidation, triage and the threat
// model all call this function and nothing else decides who may drive the
// worker.
//
// The predicate is evaluated over the issue REVISION, not the issue as an
// object: alongside `authorAssociation` and the label timeline it reads the
// body-edit history and the `renamed` events, and returns the `issueRevision`
// digest that §5 shapes and §6.0a revalidates byte for byte.
//
// Rule names: `not-authorized` for every failure §4.2 enumerates (an outside
// author, a `write`-actor label, a revoked/re-added label, a revision someone
// other than the author touched, an unreadable timeline or edit history);
// `dispatch-approval` ONLY when a trusted-class author (OWNER/MEMBER/
// COLLABORATOR) is excluded solely because the mode requires an approval label
// that was never applied — "awaiting dispatch approval" (AC 79/85).

import { createHash } from 'node:crypto';
import { LABELS } from './labels.mjs';
import { DISPATCH_APPROVAL_MODES, ConfigError } from './config.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'authorize.trustWriteActors',     // a `write` actor's label authorizes (AC 33)
  'authorize.acceptUnknownMode',    // an unknown dispatchApproval mode falls back to the default instead of bad-config (AC 79)
  'authorize.trustedAuthorsDefault', // the default mode admits MEMBER/COLLABORATOR authors unlabeled (AC 85)
  'authorize.ignoreUnlabel',        // the latest LABELED event counts even when an unlabel followed it (AC 109)
  'authorize.ignoreEdits',          // editors/renames and the label-vs-edit ordering are not checked (AC 155)
]);

const TRUSTED_CLASS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);
const sha256 = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');

/* ---------- issue shape helpers (gh issue view --json AND gh api shapes) ---------- */

export const authorOf = (issue) => issue?.author?.login ?? issue?.user?.login ?? null;
export const associationOf = (issue) => issue?.authorAssociation ?? issue?.author_association ?? null;
export const labelNames = (issue) => (Array.isArray(issue?.labels) ? issue.labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
export const isMaintainerPerm = (perm) => perm === 'admin' || perm === 'maintain' || (active('authorize.trustWriteActors') && perm === 'write');

/** The validated mode, or `bad-config` (exit 1) for anything outside the enum. */
export function resolveMode(mode) {
  const m = mode ?? 'owner-or-label';
  if (DISPATCH_APPROVAL_MODES.includes(m)) return m;
  if (active('authorize.acceptUnknownMode')) return 'owner-or-label';
  throw new ConfigError('bad-config', `autopilot.dispatchApproval must be one of ${DISPATCH_APPROVAL_MODES.join('|')} (got ${JSON.stringify(mode)})`);
}

/** Whether the mode's AUTHOR clause admits this association at all. */
function authorClassAdmitted(mode, association) {
  if (mode === 'label-only') return false;
  if (mode === 'trusted-authors' || active('authorize.trustedAuthorsDefault')) return TRUSTED_CLASS.includes(association);
  return association === 'OWNER';
}

/* ---------- the revision digest (§4.2, AC 155) ---------- */

function normalizeEditors(editors) {
  return (Array.isArray(editors) ? editors : [])
    .map((e) => ({ login: typeof e?.login === 'string' ? e.login : null, editedAt: typeof e?.editedAt === 'string' ? e.editedAt : null }))
    .sort((a, b) => String(a.editedAt).localeCompare(String(b.editedAt)) || String(a.login).localeCompare(String(b.login)));
}

/**
 * `{ titleSha256, bodySha256, lastEditedAt, editors[], editsReadable }` — the
 * revision the predicate authorizes and the run record persists.
 */
export function revisionOf(issue, edits) {
  const readable = edits != null && typeof edits === 'object' && edits.ok !== false;
  return {
    titleSha256: sha256(issue?.title),
    bodySha256: sha256(issue?.body),
    lastEditedAt: readable && typeof edits.lastEditedAt === 'string' ? edits.lastEditedAt : null,
    editors: readable ? normalizeEditors(edits.editors) : [],
    editsReadable: readable,
  };
}

export function sameRevision(a, b) {
  if (!a || !b) return false;
  const pick = (r) => JSON.stringify({ t: r.titleSha256, b: r.bodySha256, l: r.lastEditedAt ?? null, e: normalizeEditors(r.editors), r: r.editsReadable !== false });
  return pick(a) === pick(b);
}

/* ---------- timeline helpers ---------- */

/** The events array, or null when the timeline is unreadable. */
function timelineEvents(timeline) {
  if (Array.isArray(timeline)) return timeline;
  if (timeline && typeof timeline === 'object' && timeline.ok === true && Array.isArray(timeline.events)) return timeline.events;
  return null;
}

const eventTime = (e) => Date.parse(e?.created_at ?? e?.createdAt ?? '');
const eventId = (e) => (typeof e?.id === 'number' ? e.id : Number.parseInt(String(e?.id ?? ''), 10) || 0);
/** Chronological order: created_at, ties by id. */
const byTime = (a, b) => (eventTime(a) - eventTime(b)) || (eventId(a) - eventId(b));
const actorOf = (e) => e?.actor?.login ?? null;
const renames = (events) => events.filter((e) => e?.event === 'renamed');

/** Every body editor and every rename actor is the author (the AUTHOR clause's revision rule). */
function revisionByAuthor(author, revision, events) {
  if (!author) return false;
  if (!revision.editors.every((e) => e.login === author)) return false;
  return renames(events).every((e) => actorOf(e) === author);
}

/* ---------- the labeled clause ---------- */

async function labelClause({ issue, events, revision, perm }) {
  const label = LABELS.autopilot;
  if (!labelNames(issue).includes(label)) return { ok: false, reason: 'label-absent', attempted: false };
  const labelEvents = events.filter((e) => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === label).sort(byTime);
  if (labelEvents.length === 0) return { ok: false, reason: 'no-label-event', attempted: true };
  const pool = active('authorize.ignoreUnlabel') ? labelEvents.filter((e) => e.event === 'labeled') : labelEvents;
  const latest = pool[pool.length - 1];
  if (!latest || latest.event !== 'labeled') return { ok: false, reason: 'label-revoked', attempted: true };
  if (!isMaintainerPerm(await perm(actorOf(latest)))) return { ok: false, reason: 'label-actor-not-maintainer', attempted: true };
  const t = eventTime(latest);
  if (!Number.isFinite(t)) return { ok: false, reason: 'label-event-undated', attempted: true };
  if (active('authorize.ignoreEdits')) return { ok: true };
  if (revision.lastEditedAt != null) {
    const edited = Date.parse(revision.lastEditedAt);
    if (!Number.isFinite(edited) || !(t > edited)) return { ok: false, reason: 'label-precedes-edit', attempted: true };
  }
  for (const r of renames(events)) {
    if (isMaintainerPerm(await perm(actorOf(r)))) continue;
    const rt = eventTime(r);
    if (!Number.isFinite(rt) || !(t > rt)) return { ok: false, reason: 'label-precedes-rename', attempted: true };
  }
  return { ok: true };
}

/* ---------- the predicate ---------- */

/**
 * @param issue        gh issue object (`author.login`, `authorAssociation`, `labels[]`, `title`, `body`)
 * @param timeline     events array, `{ ok:true, events }`, or `{ ok:false }`
 * @param edits        `{ lastEditedAt, editors:[{login, editedAt}] }` (ok:true implied) or `{ ok:false }`
 * @param mode         `autopilot.dispatchApproval`
 * @param permissionOf login → 'admin'|'maintain'|'write'|'triage'|'read'|null (sync or async)
 * @returns {{ ok, rule: 'not-authorized'|'dispatch-approval'|null, clause: 'author'|'label'|null, reason, issueRevision }}
 */
export async function eligibleAuthor({ issue, timeline, edits, mode, permissionOf }) {
  const effectiveMode = resolveMode(mode);
  const issueRevision = revisionOf(issue, edits);
  const deny = (rule, reason) => ({ ok: false, rule, clause: null, reason, issueRevision });
  const events = timelineEvents(timeline);
  if (!events) return deny('not-authorized', 'timeline-unreadable');
  if (!issueRevision.editsReadable && !active('authorize.ignoreEdits')) return deny('not-authorized', 'edits-unreadable');

  const cache = new Map();
  const perm = async (login) => {
    if (typeof login !== 'string' || !login) return null;
    if (!cache.has(login)) cache.set(login, typeof permissionOf === 'function' ? await permissionOf(login) : null);
    return cache.get(login);
  };

  const association = associationOf(issue);
  const classOk = authorClassAdmitted(effectiveMode, association);
  const intact = active('authorize.ignoreEdits') || revisionByAuthor(authorOf(issue), issueRevision, events);
  if (classOk && intact) return { ok: true, rule: null, clause: 'author', reason: null, issueRevision };

  const label = await labelClause({ issue, events, revision: issueRevision, perm });
  if (label.ok) return { ok: true, rule: null, clause: 'label', reason: null, issueRevision };

  if (classOk && !intact) return deny('not-authorized', 'revision-not-by-author');
  if (label.attempted) return deny('not-authorized', label.reason);
  if (TRUSTED_CLASS.includes(association) && intact) return deny('dispatch-approval', label.reason);
  return deny('not-authorized', intact ? label.reason : 'revision-not-by-author');
}
