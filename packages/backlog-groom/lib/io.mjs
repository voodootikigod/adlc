/**
 * Filesystem wiring for the CLI, in lib so it can be tested.
 *
 * Left in the binary, these branches are only reachable by spawning the process
 * with a live `gh` behind it, so they go untested and a flipped guard — writing
 * the cache only when there is no cache, say — passes every suite.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseProfile } from './profile.mjs';
import { DEFAULT_AUTONOMY_FLOOR } from './floor.mjs';

/** The profile schema version a bare, profile-less repo is treated as declaring. */
export const IMPLIED_SCHEMA_VERSION = 1;

/**
 * Load and validate the profile.
 *
 * A MISSING profile is not an error: the documented defaults are a complete,
 * conservative profile, and demanding the file would make the tool unusable on a
 * repo that has not adopted it. A MALFORMED one is an error — that is a
 * statement the operator made and got wrong.
 */
export function loadProfile(path, io = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = io;
  const raw = exists(path) ? JSON.parse(readFile(path)) : { schemaVersion: IMPLIED_SCHEMA_VERSION };
  return parseProfile(raw);
}

/**
 * Load the cache, or `{}`.
 *
 * A corrupt cache costs a slow run, never a wrong answer, so it degrades to
 * empty rather than throwing.
 */
export function loadCache(path, io = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = io;
  try {
    if (!exists(path)) return {};
    const parsed = JSON.parse(readFile(path));
    // A valid JSON PRIMITIVE is not a cache. `"bad"` and `7` are truthy and
    // parse cleanly, so a hand-edited or partially-replaced file would sail past
    // a truthiness check and then throw on the first assignment — crashing a run
    // that had a perfectly good answer to give.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Serialise a JSON artifact the way the rest of the repo writes them. */
export function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Persist the cache, returning a warning string rather than throwing.
 *
 * An unwritable cache must not fail a run that already produced its answer.
 */
export function saveCache(path, cache, io = {}) {
  if (!cache) return null;
  const { write = writeFileSync } = io;
  try {
    write(path, serialiseJson(cache));
    return null;
  } catch (err) {
    return `could not write the cache at ${path}: ${err.message}`;
  }
}

/**
 * The autonomy floor as it exists at the MERGE BASE with the default branch.
 *
 * §3.7/AC24: the comparison that makes the floor a floor is against the base,
 * not the checked-out file. The working copy is exactly what someone widening
 * the floor controls, so a check reading only the working copy validates the
 * attacker's own claim.
 *
 * Returns `null` when the base profile cannot be read — and `null` is NOT an
 * empty floor. `assertFloorNotWidened` refuses to act on a null base precisely
 * so that deleting the profile at the base cannot become the cheapest widening.
 *
 * @returns {string[]|null}
 */
export function baseFloorFromGit(profilePath, { run = defaultGitRun, baseRef = 'origin/main' } = {}) {
  let mergeBase;
  try {
    mergeBase = String(run(['merge-base', 'HEAD', baseRef])).trim();
  } catch {
    return null;
  }
  if (!mergeBase) return null;

  let raw;
  try {
    raw = run(['show', `${mergeBase}:${profilePath}`]);
  } catch {
    // Absent at the base means the DEFAULT floor was in force there — not that
    // the floor is unknown. Refusing here would make the tool unusable on any
    // repo that has not yet adopted a profile, and it buys nothing: the default
    // is the most conservative floor, so a head that narrows it is still caught.
    return [...DEFAULT_AUTONOMY_FLOOR];
  }

  try {
    const parsed = parseProfile(JSON.parse(raw));
    return parsed.autonomyFloor;
  } catch {
    // PRESENT but unreadable is genuinely unknown, and distinct from absent: the
    // file may have declared a fuller floor than the default, so assuming the
    // default would under-detect a real widening.
    return null;
  }
}

function defaultGitRun(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
