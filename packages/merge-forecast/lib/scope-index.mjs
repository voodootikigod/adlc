/**
 * Scope matching, computed once per run instead of once per ticket pair.
 *
 * Every signal needs "the repo files inside this ticket's scope". Before this
 * module, each one recomputed it for both tickets of every pair, as
 * up to |files| × |scope| fresh globMatch calls, which made globMatch 77% of a
 * merge-forecast run. Here each distinct scope is compiled once per run, and
 * filtered once per run for each view (raw, and backslash-normalized).
 *
 * Nothing here decides what a glob means: core's globMatch stays the only
 * definition. compileGlob answers the two trivial shapes directly and, for
 * every other pattern, only skips calls whose answer is already known to be
 * false. Anything that is not an array of strings goes through the original
 * expression verbatim, so it throws (or does not) exactly as before.
 *
 * Spec: .adlc/specs/merge-forecast-scope-index.md
 */

import { globMatch } from '@adlc/core';

// The same split globMatch uses, so the tokens are the same tokens.
const TOKEN_SPLIT = /(\*\*\/|\*\*|\*)/;
const WILDCARDS = new Set(['**/', '**', '*']);

/**
 * A matcher with the same answer as `globMatch(pattern, path)` for every
 * pattern and every string path.
 *
 * @param {string} pattern
 * @returns {(path: string) => boolean}
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string') return (path) => globMatch(pattern, path);
  const tokens = pattern.split(TOKEN_SPLIT).filter((part) => part !== '');
  const literals = tokens.filter((token) => !WILDCARDS.has(token));

  // No wildcard at all: the pattern is the path.
  if (literals.length === tokens.length) return (path) => path === pattern;

  // `literal**` or `**`: the split never yields two literals in a row, so when
  // the only wildcard token is the last one, at most one literal precedes it.
  if (tokens.length - literals.length === 1 && tokens[tokens.length - 1] === '**') {
    const prefix = literals.length === 1 ? literals[0] : '';
    return (path) => path.startsWith(prefix);
  }

  // Each check is a NECESSARY condition of a match: the first token, when
  // literal, is matched at offset 0; the last, when literal, ends at the end;
  // every literal consumes its own characters. When all hold, globMatch decides.
  const head = WILDCARDS.has(tokens[0]) ? '' : tokens[0];
  const tail = WILDCARDS.has(tokens[tokens.length - 1]) ? '' : tokens[tokens.length - 1];
  const minLength = literals.reduce((sum, token) => sum + token.length, 0);
  return (path) =>
    path.length >= minLength &&
    path.startsWith(head) &&
    path.endsWith(tail) &&
    globMatch(pattern, path);
}

/** One predicate for a whole scope of string globs. */
function compileScope(scope) {
  const exact = new Set();
  const others = [];
  // forEach, like some(), skips the holes of a sparse array.
  scope.forEach((glob) => {
    if (glob.includes('*')) others.push(compileGlob(glob));
    else exact.add(glob);
  });
  return (path) => exact.has(path) || others.some((match) => match(path));
}

/**
 * The cache key of a scope, or null when it must not be cached: a scope that
 * is not an array of strings keeps the old expression, including whatever
 * that throws. Order and duplicates are part of the key.
 */
function cacheKey(scope) {
  return Array.isArray(scope) && scope.every((glob) => typeof glob === 'string')
    ? JSON.stringify(scope)
    : null;
}

/**
 * A per-run memo of scope matches over one file list. The list is a snapshot:
 * do not mutate it, or the arrays this returns, while the index is in use.
 * Nothing is evicted, so the index lives as long as one forecast run.
 *
 * @param {string[]} repoFiles
 */
export function createScopeIndex(repoFiles) {
  const matchers = new Map();
  const rawHits = new Map();
  const normalizedHits = new Map();
  let normalizedPaths = null;

  function matcherFor(key, scope) {
    let match = matchers.get(key);
    if (match === undefined) {
      match = compileScope(scope);
      matchers.set(key, match);
    }
    return match;
  }

  /**
   * Exactly `(path) => (scope ?? []).some((g) => globMatch(g, path))`, built
   * once per scope content. Building it never throws: like the expression it
   * replaces, any error comes when it is called.
   */
  function matcher(scope) {
    const globs = scope ?? [];
    const key = cacheKey(globs);
    if (key === null) return (path) => (scope ?? []).some((g) => globMatch(g, path));
    return matcherFor(key, globs);
  }

  // The uncached branches, here and in matcher() above, spell
  // `(scope ?? []).some` out in full, so a scope that is not an array fails
  // with the same TypeError as the shared expression they replace. The message
  // names `(scope ?? [])` where each signal used to name its own variable
  // (`(a.scope ?? [])`, `bScope`, ...): V8 builds it from the source text.
  // From runForecast, only a non-empty scope holding a non-string gets here, and
  // it throws (or not) exactly as before; a non-array scope is marked unscoped
  // before any of this runs.
  return {
    /** Exactly `repoFiles.filter((f) => (scope ?? []).some((g) => globMatch(g, f)))`. */
    files(scope) {
      const globs = scope ?? [];
      const key = cacheKey(globs);
      if (key === null) return repoFiles.filter((f) => (scope ?? []).some((g) => globMatch(g, f)));
      let hits = rawHits.get(key);
      if (hits === undefined) {
        const match = matcherFor(key, globs);
        hits = repoFiles.filter((f) => match(f));
        rawHits.set(key, hits);
      }
      return hits;
    },

    /**
     * The import-radius view: matches the backslash-normalized path, returns
     * the original string.
     */
    filesNormalized(scope) {
      const globs = scope ?? [];
      const key = cacheKey(globs);
      if (key === null) {
        return repoFiles.filter((f) => {
          const fNorm = f.replace(/\\/g, '/');
          return (scope ?? []).some((g) => globMatch(g, fNorm));
        });
      }
      let hits = normalizedHits.get(key);
      if (hits === undefined) {
        const match = matcherFor(key, globs);
        normalizedPaths ??= repoFiles.map((f) => f.replace(/\\/g, '/'));
        hits = repoFiles.filter((_, i) => match(normalizedPaths[i]));
        normalizedHits.set(key, hits);
      }
      return hits;
    },

    matcher,

    /** Exactly `(scope ?? []).some((g) => globMatch(g, path))`, for any path. */
    matches(scope, path) {
      return matcher(scope)(path);
    },
  };
}
