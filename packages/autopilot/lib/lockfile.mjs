// Canonical package-lock.json comparison (spec §6.5b (ii); AC 56, 75).
//
// Both sides are PARSED and their `packages` maps compared entry by entry:
//   - an entry present on both sides must have identical resolved, integrity,
//     version, dependencies, optional, dev and link fields;
//   - an added entry may only be `packages/<x>` (the new workspace itself — a
//     source entry, never resolved anywhere) or `node_modules/@adlc/<x>` for an
//     `<x>` in the allowed set (or the workspace added in the same diff), and
//     that link entry must be EXACTLY a workspace link: `link: true`,
//     `resolved: "packages/<x>"`. A registry `resolved` URL of ANY scope on an
//     added entry is drift;
//   - no entry may be removed; any other difference is drift.
// Because the only admissible additions are workspace links, the offline
// `npm ci` of §6.5b(iii) never needs a tarball the private cache lacks.

import { registerSeams, active } from './mutations.mjs';

registerSeams(['lockfile.ignoreResolved']); // resolved/integrity differences on shared entries pass

export const COMPARED_FIELDS = Object.freeze(['resolved', 'integrity', 'version', 'dependencies', 'optional', 'dev', 'link']);

function canon(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canon);
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
}
export const deepEqual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Parse a lockfile text; null when unparseable or without a `packages` map (lockfileVersion < 2). */
export function parseLockfile(text) {
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || !doc.packages || typeof doc.packages !== 'object') return null;
    return doc;
  } catch { return null; }
}

const drift = (detail) => ({ ok: false, code: 'lockfile-drift', detail });
const workspaceName = (dep) => dep.replace(/^@adlc\//, '');

function checkSharedEntry(key, base, head) {
  const fields = active('lockfile.ignoreResolved') ? COMPARED_FIELDS.filter((f) => f !== 'resolved' && f !== 'integrity') : COMPARED_FIELDS;
  for (const f of fields) {
    if (!deepEqual(base[f], head[f])) return drift(`${key}: ${f} differs`);
  }
  return null;
}

function checkAddedEntry(key, entry, { allowedWorkspaces, addedWorkspaces }) {
  const ws = /^packages\/([^/]+)$/.exec(key);
  if (ws) {
    if (entry.resolved !== undefined || entry.integrity !== undefined || entry.link !== undefined) return drift(`${key}: a workspace source entry may not be resolved or linked`);
    return null;
  }
  const link = /^node_modules\/@adlc\/([^/]+)$/.exec(key);
  if (!link) return drift(`${key}: added entry is not a workspace link`);
  const x = link[1];
  if (!allowedWorkspaces.has(x) && !addedWorkspaces.has(x)) return drift(`${key}: @adlc/${x} is not in the allowed workspace set`);
  if (entry.link !== true || entry.resolved !== `packages/${x}` || entry.integrity !== undefined) return drift(`${key}: must be a workspace link {link:true, resolved:"packages/${x}"}`);
  return null;
}

/**
 * @param baseDoc  parsed base lockfile (parseLockfile)
 * @param headDoc  parsed head lockfile
 * @param opts.allowed  dependency names the ticket may add, e.g. ['@adlc/core']
 * @returns {{ ok: boolean, code: 'lockfile-drift'|null, detail: string|null }}
 */
export function compareLockfiles(baseDoc, headDoc, { allowed = [] } = {}) {
  if (!baseDoc) return drift('base lockfile missing or unparseable');
  if (!headDoc) return drift('head lockfile missing or unparseable');
  if (baseDoc.lockfileVersion !== headDoc.lockfileVersion) return drift('lockfileVersion differs');
  const base = baseDoc.packages; const head = headDoc.packages;
  const allowedWorkspaces = new Set(allowed.map(workspaceName));
  const addedWorkspaces = new Set(Object.keys(head).filter((k) => !(k in base)).map((k) => /^packages\/([^/]+)$/.exec(k)?.[1]).filter(Boolean));
  for (const key of Object.keys(base)) {
    if (!(key in head)) return drift(`${key}: entry removed`);
    const bad = checkSharedEntry(key, base[key], head[key]);
    if (bad) return bad;
  }
  for (const key of Object.keys(head)) {
    if (key in base) continue;
    const bad = checkAddedEntry(key, head[key], { allowedWorkspaces, addedWorkspaces });
    if (bad) return bad;
  }
  return { ok: true, code: null, detail: null };
}
