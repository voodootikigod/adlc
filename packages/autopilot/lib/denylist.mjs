// The protected-path denylist (spec §4.2, §11 "trust-root drift"; AC 3, 140).
//
// NON-SHRINKABLE: the union of (a) every path in rails-guard's
// `DEFAULT_IMMUTABLE_TRUST_ROOTS` and this repository's `REPO_TRUST_ROOTS`,
// both parsed from the SOURCE TEXT of the pinned blob at BASE_OID (never
// imported — the working tree could differ, and the parse cannot lag the
// repository's own trust-root set), (b) the static extras below, and (c)
// `autopilot.protectedPathsExtra` from config, which may only EXTEND. A
// source text without its list is a hard failure, never an empty list.

import { globMatch } from '@adlc/core';
import { active, registerSeams } from './mutations.mjs';

registerSeams([
  'denylist.allowShrink', // config `extras` REPLACE the denylist instead of extending it
  'denylist.staticOnly',  // the two parsed trust-root lists are ignored
]);

/** §4.2 (b): the static extras and the trust-root tier packages. */
export const STATIC_EXTRAS = Object.freeze([
  '.adlc/**', '.github/**',
  'scripts/rails-guard-ci.mjs', 'scripts/mutation-gate.mjs', 'scripts/run-tests.mjs',
  'docs/ci/**', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS',
  'package.json', '.npmrc',
  'packages/rails-guard/**', 'packages/prosecute/**', 'packages/gate-manifest/**', 'packages/build-gate/**',
  'packages/ticket-prune/**', 'packages/ticket-sync/**', 'packages/core/**',
]);

export const TRUST_ROOTS_IDENT = 'DEFAULT_IMMUTABLE_TRUST_ROOTS';
export const REPO_ROOTS_IDENT = 'REPO_TRUST_ROOTS';

export class DenylistError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'DenylistError'; this.code = code; this.exitCode = 1; }
}

/* ---------- source-text parsing ---------- */

/** Strip `//` and `/* *\/` comments outside string literals (a quote inside a comment must not open a string). */
export function stripComments(text) {
  let out = ''; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const d = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Every string literal inside `[ … ]` (nesting-aware), in order. */
function stringLiteralsOfArray(text, openIdx) {
  let depth = 0; const out = []; let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') { s += text[j + 1] ?? ''; j += 2; continue; } s += text[j]; j++; }
      if (j >= text.length) throw new DenylistError('denylist-source-unparseable', 'unterminated string literal');
      out.push(s); i = j + 1; continue;
    }
    if (c === '`') throw new DenylistError('denylist-source-unparseable', 'template literal inside a trust-root list');
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return out; }
    i++;
  }
  throw new DenylistError('denylist-source-unparseable', 'unterminated array literal');
}

const PATH_RE = /^[\x21-\x7e]+$/;
function validatePathGlob(p, where) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512 || !PATH_RE.test(p)) throw new DenylistError('denylist-source-unparseable', `${where}: illegal entry ${JSON.stringify(p)}`);
  if (p.startsWith('/') || p.split('/').some((seg) => seg === '..' || seg === '.')) throw new DenylistError('denylist-source-unparseable', `${where}: non-relative entry ${p}`);
  return p;
}

/**
 * Parse `const <ident> = [ … ]` / `Object.freeze([ … ])` from a module's
 * source text. Missing, empty or malformed → `denylist-source-unparseable`.
 */
export function parseTrustRootList(text, ident) {
  if (typeof text !== 'string') throw new DenylistError('denylist-source-unparseable', `${ident}: source text missing`);
  const clean = stripComments(text);
  const decl = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\[`).exec(clean);
  if (!decl) throw new DenylistError('denylist-source-unparseable', `${ident}: declaration not found`);
  const entries = stringLiteralsOfArray(clean, decl.index + decl[0].length - 1).map((p) => validatePathGlob(p, ident));
  if (entries.length === 0) throw new DenylistError('denylist-source-unparseable', `${ident}: empty list`);
  return entries;
}

/* ---------- the denylist ---------- */

const normalizePath = (p) => String(p).replace(/^(\.\/)+/, '');

/**
 * @param trustRootsModuleText  text of `packages/rails-guard/lib/ci/trust-roots.mjs` at BASE_OID
 * @param railsGuardCiText      text of `scripts/rails-guard-ci.mjs` at BASE_OID
 * @param extras                `autopilot.protectedPathsExtra` — extends only
 * @returns {{ globs: string[], matches(path): boolean, sources: {trustRoots, repoRoots, extras} }}
 */
export function buildDenylist({ trustRootsModuleText, railsGuardCiText, extras = [] }) {
  const trustRoots = parseTrustRootList(trustRootsModuleText, TRUST_ROOTS_IDENT);
  const repoRoots = parseTrustRootList(railsGuardCiText, REPO_ROOTS_IDENT);
  if (!Array.isArray(extras)) throw new DenylistError('bad-config', 'protectedPathsExtra must be an array');
  const extra = extras.map((p) => validatePathGlob(p, 'protectedPathsExtra'));
  const parsed = active('denylist.staticOnly') ? [] : [...trustRoots, ...repoRoots];
  const globs = active('denylist.allowShrink') && extra.length > 0
    ? [...new Set(extra)]
    : [...new Set([...parsed, ...STATIC_EXTRAS, ...extra])];
  Object.freeze(globs);
  const matches = (path) => {
    if (typeof path !== 'string') throw new TypeError('denylist.matches: path must be a string');
    const p = normalizePath(path);
    return globs.some((g) => globMatch(g, p));
  };
  return { globs, matches, sources: { trustRoots, repoRoots, extras: extra } };
}

/* ---------- scope ∩ denylist ---------- */

/** The literal prefix of a glob (everything before its first `*`). */
const literalPrefix = (g) => { const i = g.indexOf('*'); return i < 0 ? g : g.slice(0, i); };
const hasWildcard = (g) => g.includes('*');

/** `a` is `b`, or lies under `b` (segment-aware; a `b` ending in `/` is a directory prefix). */
function underPrefix(a, b) {
  if (b === '') return true;
  if (!a.startsWith(b)) return false;
  if (a.length === b.length || b.endsWith('/')) return true;
  return a[b.length] === '/';
}

/**
 * Whether one scope glob can reach one denylist entry. Conservative on
 * purpose (fail closed): a `**` at the root, a direct match in either
 * direction, or one glob's literal prefix lying under the other's.
 */
export function globsIntersect(scopeGlob, denyGlob) {
  const s = normalizePath(scopeGlob); const d = normalizePath(denyGlob);
  if (s === '' || s.startsWith('**') || s === '*' && !hasWildcard(d) && !d.includes('/')) return true;
  if (globMatch(s, d) || globMatch(d, s)) return true;
  const ps = literalPrefix(s); const pd = literalPrefix(d);
  if (hasWildcard(s) && underPrefix(pd, ps)) return true;   // scope covers a subtree containing the deny entry
  if (hasWildcard(d) && underPrefix(ps, pd)) return true;   // scope lies inside a denied subtree
  return false;
}

/** The scope globs that intersect the denylist (deduplicated, scope order). */
export function scopeIntersects(scopeGlobs, denylist) {
  const globs = denylist?.globs ?? denylist;
  if (!Array.isArray(globs)) throw new TypeError('scopeIntersects: denylist must carry globs');
  const out = [];
  for (const g of Array.isArray(scopeGlobs) ? scopeGlobs : []) {
    if (typeof g !== 'string') { out.push(String(g)); continue; } // fail closed on a malformed scope entry
    if (globs.some((d) => globsIntersect(g, d)) && !out.includes(g)) out.push(g);
  }
  return out;
}

/** `[{ glob, deny }]` — every intersecting pair, for CLARIFY findings. */
export function intersectingPairs(scopeGlobs, denylist) {
  const globs = denylist?.globs ?? denylist;
  const out = [];
  for (const g of Array.isArray(scopeGlobs) ? scopeGlobs : []) {
    for (const d of globs) if (typeof g === 'string' && globsIntersect(g, d)) out.push({ glob: g, deny: d });
  }
  return out;
}
