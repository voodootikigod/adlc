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
//            `adlc --version` reports a version below the floor — or a
//            standalone manifest-writer bin (`gate-manifest`, `adlc-spend`,
//            published by @adlc/gate-manifest) resolves on the same PATH with
//            its owning package below the floor. Standalone versions are read
//            from the owning package.json, never by executing the (possibly
//            stale) writer. A MISSING bin is not a failure: CI has none, and
//            in-tree code is what runs there.
//   in-tree  (CI rails-guard job) fail when the marker exists in the checked-
//            out tree but packages/gate-manifest/package.json is versioned
//            below the floor — guards CI runs that execute branch code without
//            merging base (workflow_dispatch / push), and a branch that
//            downgrades the in-tree gate packages.
//
// The floor value lives ONLY in scripts/toolkit-floor.json. This script reads
// it at runtime; nothing else may hardcode it.

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FLOOR_FILE = 'scripts/toolkit-floor.json';
export const MARKER_FILE = '.adlc/manifest.d/.store.json';
const IN_TREE_MANIFEST = 'packages/gate-manifest/package.json';
const UPGRADE_COMMAND = 'npm i -g @adlc/cli@latest';
// A standalone @adlc/gate-manifest install is a SEPARATE top-level package: the
// umbrella upgrade nests its own copy and leaves the standalone one — and its
// writer links — untouched, so its remediation must name the package itself.
const STANDALONE_UPGRADE_COMMAND = 'npm i -g @adlc/gate-manifest@latest (or npm rm -g @adlc/gate-manifest to rely on the umbrella CLI)';

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
 * Drop the `node_modules/.bin` entries NPM ITSELF injects from a PATH string.
 * Under `npm run preflight` npm PREPENDS one entry per directory from the
 * workspace upward, and this workspace installs its own (current-version)
 * `adlc` there — which would shadow the developer's stale GLOBAL CLI and make
 * the global check vacuously pass through the documented entry point. The
 * global check must see the PATH a normal shell sees.
 *
 * Workspace-scoped, not a blanket filter: a `node_modules/.bin` entry whose
 * prefix directory is NOT the workspace or one of its ancestors is a
 * deliberate, user-managed PATH entry (e.g. `/opt/adlc/node_modules/.bin`) —
 * the shell resolves writers from it, so the probes must see it too.
 *
 * Platform-aware: entries split on the OS PATH delimiter (`;` on Windows, `:`
 * elsewhere — injectable for tests) and matched with either slash style, so a
 * Windows `C:\repo\node_modules\.bin` entry is scrubbed too.
 */
export function scrubNpmPath(path, pathDelimiter = delimiter, workspaceDir = process.cwd()) {
  const trimSlashes = (p) => String(p).replace(/[\\/]+$/, '');
  // Canonicalize both sides of the ancestry comparison: a symlinked workspace
  // (macOS's /tmp → /private/tmp is the everyday case) otherwise never matches
  // the PATH entry npm derived from the same directory. A path that does not
  // exist is compared as spelled.
  const canonical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const workspace = canonical(trimSlashes(workspaceDir));
  return String(path ?? '')
    .split(pathDelimiter)
    .filter((entry) => {
      const m = trimSlashes(entry).match(/^(.*)[\\/]node_modules[\\/]\.bin$/);
      if (!m) return true;
      const prefix = canonical(m[1]);
      return !(workspace === prefix || workspace.startsWith(`${prefix}/`) || workspace.startsWith(`${prefix}\\`));
    })
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

function belowFloorMessage({ what, found, minToolkit, reason, fix = UPGRADE_COMMAND }) {
  return [
    `toolkit-floor: ${what} is ${found}, below the minimum ${minToolkit} pinned in ${FLOOR_FILE}.`,
    `  Why: ${reason}`,
    `  Toolkits below the floor predate the full contract for the segmented manifest`,
    `  (${MARKER_FILE}); the oldest append evidence to the frozen manifest root.`,
    `  Fix: ${fix}`,
  ].join('\n');
}

// Standalone manifest-writer bins published by @adlc/gate-manifest (#489). The
// umbrella `adlc` probe cannot see them: a developer with only a stale
// standalone install — no `adlc` at all — would pass the umbrella probe and
// then run a documented writer command (`gate-manifest record …`) against the
// frozen root.
const STANDALONE_WRITER_BINS = ['gate-manifest', 'adlc-spend'];
const STANDALONE_WRITER_PACKAGE = '@adlc/gate-manifest';

/**
 * The PATH entry the SHELL would execute for `bin`, or null. Matches shell
 * resolution semantics: a non-existent, non-regular, or (on POSIX)
 * non-executable candidate is skipped and the search continues — otherwise an
 * above-floor decoy earlier on PATH could be validated while the shell runs a
 * stale executable writer later on PATH. Same scrubbed-PATH contract as the
 * adlc probe.
 */
function lookupOnPath(bin, pathValue) {
  for (const entry of String(pathValue ?? '').split(delimiter)) {
    // POSIX resolution treats an EMPTY component as the current directory —
    // skipping it would classify a writer the shell can run as absent.
    const candidate = join(entry === '' ? process.cwd() : entry, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * The owning @adlc/gate-manifest package.json for a resolved writer bin,
 * WITHOUT executing the bin — a stale writer is exactly what must not run.
 * Follows the bin symlink (npm's global layout links <prefix>/bin/<name> into
 * <prefix>/lib/node_modules/@adlc/gate-manifest/bin/) and walks up to the
 * nearest package.json whose name matches. Throws when ownership cannot be
 * established: a resolvable writer of unverifiable version fails closed.
 */
function standaloneWriterManifest(binPath) {
  let real;
  try {
    real = realpathSync(binPath);
  } catch (e) {
    throw new Error(`found ${binPath} on PATH but could not resolve it (${e.message}) — reinstall with: ${STANDALONE_UPGRADE_COMMAND}`);
  }
  let dir = dirname(real);
  for (let depth = 0; depth < 10; depth += 1) {
    // Two layouts: the POSIX npm symlink resolves INTO the package (its own
    // package.json is an ancestor of the realpath), while npm's WINDOWS shims
    // are plain files beside the prefix's node_modules — the package sits in
    // the ADJACENT tree, never above the shim. The adjacent candidate is
    // Windows-only: on POSIX npm always symlinks, so a plain file named like a
    // writer is NOT npm's layout, and attributing it to a neighbouring
    // package's version would certify a wrapper that dispatches elsewhere.
    // Such a file fails closed via the not-locatable error below.
    const candidates = [join(dir, 'package.json')];
    if (process.platform === 'win32') {
      candidates.push(join(dir, 'node_modules', '@adlc', 'gate-manifest', 'package.json'));
    }
    for (const manifestPath of candidates) {
      if (!existsSync(manifestPath)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        throw new Error(`found ${binPath} on PATH but its candidate manifest ${manifestPath} cannot be parsed (${e.message}) — reinstall with: ${STANDALONE_UPGRADE_COMMAND}`);
      }
      if (parsed?.name === STANDALONE_WRITER_PACKAGE) return parsed;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`found ${binPath} on PATH but could not locate its owning ${STANDALONE_WRITER_PACKAGE} package.json — its version cannot be verified against the floor; reinstall with: ${STANDALONE_UPGRADE_COMMAND}`);
}

/**
 * Preflight mode: the stale-GLOBAL-CLI gap. `run` is injectable for tests and
 * must behave like spawnSync('adlc', ['--version']). The umbrella probe and
 * the standalone-writer probes are independent: EVERY resolvable surface must
 * meet the floor, and only genuine absence is exempt.
 */
export function checkGlobal(root, { run = defaultAdlcVersion, pathValue = process.env.PATH } = {}) {
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
  const surfaces = [];
  const r = run();
  if (r.error) {
    if (r.error.code !== 'ENOENT') {
      // Any spawn failure other than a missing binary (EACCES, resource
      // limits, …) means an adlc may exist whose version was NOT verified —
      // fail closed, never "missing".
      return fail(
        `toolkit-floor: could not run the global adlc to verify the floor in ${FLOOR_FILE} ` +
        `(${r.error.code ?? r.error.message}) — fix the environment or reinstall with: ${UPGRADE_COMMAND}`
      );
    }
    // No globally resolvable `adlc` — not by itself a failure (CI has none);
    // the standalone-writer probes below still run.
    surfaces.push('no global adlc on PATH');
  } else {
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
    surfaces.push(`adlc ${found.version}`);
  }
  const scrubbed = scrubNpmPath(pathValue);
  for (const bin of STANDALONE_WRITER_BINS) {
    const binPath = lookupOnPath(bin, scrubbed);
    if (binPath === null) continue; // absent is not a failure
    let manifest;
    try {
      manifest = standaloneWriterManifest(binPath);
    } catch (e) {
      return fail(`toolkit-floor: ${e.message}`);
    }
    const found = parseVersion(manifest.version);
    if (!found) {
      return fail(`toolkit-floor: ${STANDALONE_WRITER_PACKAGE} owning ${binPath} has no parseable version to compare against the floor in ${FLOOR_FILE} — reinstall with: ${STANDALONE_UPGRADE_COMMAND}`);
    }
    if (!meetsFloor(found, floor)) {
      return fail(belowFloorMessage({ what: `the standalone ${bin} CLI (${STANDALONE_WRITER_PACKAGE} ${found.version})`, found: found.version, minToolkit, reason, fix: STANDALONE_UPGRADE_COMMAND }));
    }
    surfaces.push(`${bin} ${found.version}`);
  }
  return pass(`toolkit-floor: ${surfaces.join(', ')} — the ${minToolkit} floor holds`);
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
