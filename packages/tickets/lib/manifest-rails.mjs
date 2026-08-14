// #235 — decide whether a rail glob would freeze a manifest file.
//
// A rail exists to freeze BEHAVIOUR during a build. A rail over `packages/x/**`
// also freezes `packages/x/package.json`, which a lockstep release must rewrite —
// the collision #228/#234 worked around. Rejecting such a rail at ticket-authoring
// time is the complementary hygiene fix: steer authors to `packages/x/lib/**`.
//
// SELF-CONTAINED ON PURPOSE. `@adlc/core` depends on `@adlc/tickets`, so importing
// `globMatch` from core here would create a dependency cycle. It takes the same
// GENERATED verbatim copy of core's matcher the installed harnesses take, so the
// semantics cannot drift; manifest-rails.test.mjs still cross-checks it against
// core's globMatch on a shared corpus.

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
// Generated verbatim from packages/core/lib/glob.mjs — see that file. Imported
// rather than re-implemented so this cannot drift from the matcher the rails
// are actually enforced with.
import { globMatch } from './generated-glob-match.mjs';

export const MANIFEST_BASENAMES = Object.freeze(['package.json', 'plugin.json', 'marketplace.json']);

// Directories a manifest a release rewrites never lives in, and which are large
// or noisy. Skipping them keeps the walk fast and its results honest.
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', 'coverage', '.next']);
const MAX_DEPTH = 8; // release manifests sit shallow; deeper is not a release target

/**
 * The repo's ACTUAL manifest paths under `root`, as POSIX repo-relative strings —
 * every file whose basename is a host manifest. Testing a rail against real paths
 * is exact: `packages/x/**` matches `packages/x/package.json` and is flagged,
 * while `packages/x/lib/**` matches no real manifest and is not, even though it
 * could match a hypothetical `packages/x/lib/package.json` that no release
 * touches.
 *
 * A filesystem walk (not `git ls-files`) so the check works in any checkout,
 * including a temp dir or a non-git tree, and does not depend on what git happens
 * to be tracking. Fails soft: an unreadable directory is skipped, and an
 * unreadable root yields an empty list, so authoring degrades to "flag nothing"
 * rather than throwing. This is hygiene, not a security boundary — the real
 * freeze enforcement is rails-guard.
 */
export function discoverManifests(root = process.cwd()) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && MANIFEST_BASENAMES.includes(entry.name)) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(root, 0);
  return found;
}

/**
 * True when `glob` matches at least one manifest a lockstep release rewrites.
 *
 * @param {unknown} glob a rail glob
 * @param {unknown} manifestPaths the manifest corpus to test against — the ticket
 *        service passes `discoverManifests()`. REQUIRED: there is no default,
 *        because a wrong default (guessed shapes, or an empty list) would silently
 *        flag nothing or the wrong things. A caller with no manifests to check
 *        should pass `[]` explicitly.
 * @returns {boolean}
 */
export function coversManifest(glob, manifestPaths) {
  if (!Array.isArray(manifestPaths)) {
    throw new TypeError('coversManifest requires an explicit manifestPaths array (use discoverManifests())');
  }
  if (typeof glob !== 'string' || glob === '') return false;
  return manifestPaths.some((path) => globMatch(glob, path));
}

/**
 * The rails on `ticket` that cover a manifest, for a caller that wants to report
 * exactly which globs are the problem.
 */
export function manifestCoveringRails(rails, manifestPaths) {
  if (!Array.isArray(rails)) return [];
  return rails.filter((rail) => coversManifest(rail, manifestPaths));
}
