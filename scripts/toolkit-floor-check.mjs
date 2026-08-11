#!/usr/bin/env node
// toolkit-floor-check — fail fast when a pre-forest toolkit could write the
// frozen manifest root.
//
// WHY THIS EXISTS. The repository cut over to segmented (forest) gate-manifest
// storage (PR #482): the root `.adlc/manifest.jsonl` is frozen, and the marker
// `.adlc/manifest.d/.store.json` directs all new evidence into per-branch
// segments. Toolkits below the floor pinned in scripts/toolkit-floor.json
// predate the full forest contract: the oldest (pre-1.8) never read the marker
// and append evidence directly to the frozen root; newer-but-stale releases
// are marker-aware but lack the cutover/salvage verbs (`gate-manifest migrate`
// / `migrate-branch`) a post-cutover repository operates with. CI's
// rails-guard forest gate rejects a root-append diff at PR time — but only
// after the developer has already written bad evidence locally, as a confusing
// late failure. This check moves that failure to the earliest possible moment,
// in two modes:
//
//   global   (preflight) fail when the marker exists AND a globally resolvable
//            `adlc --version` reports a version below the floor. A MISSING
//            global `adlc` is not a failure: CI has none, and in-tree code is
//            what runs there.
//   in-tree  (CI rails-guard job) fail when the marker exists in the checked-
//            out tree but packages/gate-manifest/package.json is versioned
//            below the floor — guards CI runs that execute branch code without
//            merging base (workflow_dispatch / push), and a branch that
//            downgrades the in-tree gate packages.
//
// The floor value lives ONLY in scripts/toolkit-floor.json. This script reads
// it at runtime; nothing else may hardcode it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FLOOR_FILE = 'scripts/toolkit-floor.json';
export const MARKER_FILE = '.adlc/manifest.d/.store.json';
const IN_TREE_MANIFEST = 'packages/gate-manifest/package.json';
const UPGRADE_COMMAND = 'npm i -g @adlc/cli@latest';

/**
 * Parse the leading `major.minor.patch[-prerelease]` out of `text` (which may
 * be a full `adlc --version` output line or a package.json version field).
 * Returns `{ version, triple, prerelease }` or null when no triple is present.
 * Prerelease presence matters: semver orders `1.2.3-rc.1` BELOW `1.2.3`, so a
 * floor-equal triple with a prerelease tag must not satisfy the floor.
 */
export function parseVersion(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/);
  if (!m) return null;
  return {
    version: m[0],
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] !== undefined,
  };
}

/** Numeric triple comparison: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Does `found` satisfy `floor`? Above the floor triple always passes (a
 * prerelease of a HIGHER version still postdates the floor release); below
 * always fails; at the floor triple, a prerelease precedes the release and
 * therefore fails. The floor itself is validated stable-only by readFloor.
 */
export function meetsFloor(found, floor) {
  const cmp = compareVersions(found.triple, floor.triple);
  if (cmp !== 0) return cmp > 0;
  return !found.prerelease;
}

/**
 * Drop npm-injected `node_modules/.bin` entries from a PATH string. Under
 * `npm run preflight` npm PREPENDS the workspace's own node_modules/.bin, and
 * this workspace installs its own (current-version) `adlc` there — which would
 * shadow the developer's stale GLOBAL CLI and make the global check vacuously
 * pass through the documented entry point. The global check must see the PATH
 * a normal shell sees.
 *
 * Platform-aware: entries split on the OS PATH delimiter (`;` on Windows, `:`
 * elsewhere — injectable for tests) and matched with either slash style, so a
 * Windows `C:\repo\node_modules\.bin` entry is scrubbed too.
 */
export function scrubNpmPath(path, pathDelimiter = delimiter) {
  return String(path ?? '')
    .split(pathDelimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry))
    .join(pathDelimiter);
}

/**
 * Read and validate the floor file. Throws on a missing or malformed file:
 * the floor is committed alongside this script, so absence means the tree is
 * broken and the check must fail closed rather than silently not enforce.
 */
export function readFloor(root) {
  const path = join(root, FLOOR_FILE);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const floor = parseVersion(parsed.minToolkit);
  // Stable-only: a prerelease floor would make "at the floor" ambiguous.
  if (!floor || !/^\d+\.\d+\.\d+$/.test(String(parsed.minToolkit))) {
    throw new Error(`${FLOOR_FILE}: minToolkit must be an exact stable major.minor.patch version, got ${JSON.stringify(parsed.minToolkit)}`);
  }
  return { minToolkit: String(parsed.minToolkit), floor, reason: String(parsed.reason ?? '') };
}

function pass(message) {
  return { ok: true, message };
}

function fail(message) {
  return { ok: false, message };
}

/**
 * Is the segmented-manifest marker present? A plain missing path (ENOENT —
 * including a dangling symlink) means "not in forest mode". Anything else
 * (permissions, I/O) is indistinguishable from a cut-over repository whose
 * marker cannot be read, so it throws for the caller to FAIL CLOSED rather
 * than silently declaring the floor not in force.
 */
function segmentedMarkerPresent(root) {
  try {
    readFileSync(join(root, MARKER_FILE));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw new Error(`could not determine segmented-manifest marker state (${MARKER_FILE}): ${e.message}`);
  }
}

function belowFloorMessage({ what, found, minToolkit, reason }) {
  return [
    `toolkit-floor: ${what} is ${found}, below the minimum ${minToolkit} pinned in ${FLOOR_FILE}.`,
    `  Why: ${reason}`,
    `  Toolkits below the floor predate the full contract for the segmented manifest`,
    `  (${MARKER_FILE}); the oldest append evidence to the frozen manifest root.`,
    `  Fix: ${UPGRADE_COMMAND}`,
  ].join('\n');
}

/**
 * Preflight mode: the stale-GLOBAL-CLI gap. `run` is injectable for tests and
 * must behave like spawnSync('adlc', ['--version']).
 */
export function checkGlobal(root, { run = defaultAdlcVersion } = {}) {
  let inForest;
  try {
    inForest = segmentedMarkerPresent(root);
  } catch (e) {
    return fail(`toolkit-floor: ${e.message}`);
  }
  if (!inForest) {
    return pass('toolkit-floor: no segmented-manifest marker — floor not in force');
  }
  const { minToolkit, floor, reason } = readFloor(root);
  const r = run();
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      // No globally resolvable `adlc` — not a failure (CI has none; in-tree
      // code is what runs there, and the in-tree mode covers that surface).
      return pass('toolkit-floor: no global adlc on PATH — nothing to check');
    }
    // Any OTHER spawn failure (EACCES, resource limits, …) means an adlc may
    // exist whose version was NOT verified — fail closed, never "missing".
    return fail(
      `toolkit-floor: could not run the global adlc to verify the floor in ${FLOOR_FILE} ` +
      `(${r.error.code ?? r.error.message}) — fix the environment or reinstall with: ${UPGRADE_COMMAND}`
    );
  }
  const found = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  if (r.status !== 0 || !found) {
    return fail(
      `toolkit-floor: could not determine the global adlc version (exit ${r.status}, output ${JSON.stringify(String(r.stdout ?? '').trim())}). ` +
      `The floor in ${FLOOR_FILE} cannot be verified — reinstall with: ${UPGRADE_COMMAND}`
    );
  }
  if (!meetsFloor(found, floor)) {
    return fail(belowFloorMessage({ what: 'the global adlc CLI', found: found.version, minToolkit, reason }));
  }
  return pass(`toolkit-floor: global adlc ${found.version} meets the ${minToolkit} floor`);
}

function defaultAdlcVersion() {
  // Scrubbed PATH: see scrubNpmPath — under `npm run` the workspace's own
  // `node_modules/.bin/adlc` would shadow the global CLI this check exists to judge.
  return spawnSync('adlc', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: scrubNpmPath(process.env.PATH) },
  });
}

/**
 * CI mode: the branch-code gap. Judges the checked-out tree only — no PATH
 * lookups — so it holds on workflow_dispatch/push runs and on a branch that
 * downgrades the in-tree gate packages.
 */
export function checkInTree(root) {
  let inForest;
  try {
    inForest = segmentedMarkerPresent(root);
  } catch (e) {
    return fail(`toolkit-floor: ${e.message}`);
  }
  if (!inForest) {
    return pass('toolkit-floor: no segmented-manifest marker — floor not in force');
  }
  const { minToolkit, floor, reason } = readFloor(root);
  const manifestPath = join(root, IN_TREE_MANIFEST);
  let found;
  try {
    found = parseVersion(JSON.parse(readFileSync(manifestPath, 'utf8')).version);
  } catch (e) {
    return fail(`toolkit-floor: could not read ${IN_TREE_MANIFEST} to verify the floor in ${FLOOR_FILE}: ${e.message}`);
  }
  if (!found) {
    return fail(`toolkit-floor: ${IN_TREE_MANIFEST} has no parseable version to compare against the floor in ${FLOOR_FILE}`);
  }
  if (!meetsFloor(found, floor)) {
    return fail(belowFloorMessage({ what: `the in-tree toolkit (${IN_TREE_MANIFEST})`, found: found.version, minToolkit, reason }));
  }
  return pass(`toolkit-floor: in-tree toolkit ${found.version} meets the ${minToolkit} floor`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith('--'));
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 && args[rootFlag + 1] ? args[rootFlag + 1] : process.cwd();

  if (mode !== 'global' && mode !== 'in-tree') {
    console.error('usage: toolkit-floor-check.mjs <global|in-tree> [--root <dir>]');
    process.exit(1);
  }

  let result;
  try {
    result = mode === 'global' ? checkGlobal(root) : checkInTree(root);
  } catch (e) {
    console.error(`toolkit-floor: ${e.message}`);
    process.exit(1);
  }
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}
