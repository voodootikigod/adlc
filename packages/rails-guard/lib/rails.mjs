// Rail-freeze enforcement: detect edits to frozen rail paths.
// Rails are declared as globs in ticket.rails or supplied via --rails flags.

import { globMatch } from '@adlc/core/tickets';
import { isManifestFile, isVersionOnlyChange } from './version-only.mjs';

/**
 * Resolve the full set of rail globs to enforce.
 *
 * Priority:
 *  1. Explicit --rails flags always win.
 *  2. Otherwise, the ticket's `rails` array (requires --ticket).
 *
 * Returns { globs: string[], error: string | null }
 */
export function resolveRailGlobs(cliRails, ticket) {
  if (cliRails && cliRails.length > 0) {
    return { globs: cliRails, error: null };
  }
  if (!ticket) {
    return { globs: [], error: 'no --rails supplied and no ticket loaded — cannot determine rail globs' };
  }
  const globs = ticket.rails ?? [];
  if (globs.length === 0) {
    return { globs: [], error: `ticket ${ticket.id} has no rails declared` };
  }
  return { globs, error: null };
}

/**
 * Check which changed files match any rail glob.
 * Returns [ { file, type: 'rail-edit', globs: [matched patterns] } ]
 *
 * @param {string[]} changedFiles
 * @param {string[]} railGlobs
 * @param {((file: string) => {before: string, after: string} | null) | null} [resolveContents]
 *        Optional accessor for a manifest's baseline and HEAD text, used to apply
 *        the #228 version-only exemption: a lockstep version bump is not a rail
 *        edit. OMITTING IT DISABLES THE EXEMPTION ENTIRELY — every caller that
 *        cannot supply real content keeps the original, stricter behaviour rather
 *        than silently exempting anything.
 * @param {Set<string> | null} [sanctionedAdditions]
 *        Exact file paths whose rail match is a SANCTIONED AUTHORING act
 *        (T-01M0122Y3JYM04D2VZC3026G3B): the first ADDITION of a rail path the
 *        declaring ticket froze before its build existed. This is MECHANISM only —
 *        membership is honored, nothing is inferred. The POLICY (pure addition at
 *        the trusted base, ticket-rail-only match, never a trust root) is computed
 *        by the CI wrapper (lib/ci/rail-freeze.mjs), the one caller that knows glob
 *        ownership and the pinned base. Omitting it keeps the original behaviour.
 */
export function checkRailEdits(changedFiles, railGlobs, resolveContents = null, sanctionedAdditions = null) {
  const violations = [];
  for (const file of changedFiles) {
    const matched = railGlobs.filter((g) => globMatch(g, file));
    if (matched.length === 0) continue;
    if (sanctionedAdditions?.has(file)) {
      continue; // sanctioned rail authoring — reported by the caller, never silent
    }
    if (resolveContents && isManifestFile(file) && isVersionOnlyEdit(file, resolveContents)) {
      continue; // #228 — mechanical version bump, not a behaviour edit
    }
    violations.push({ file, type: 'rail-edit', globs: matched });
  }
  return violations;
}

/**
 * Resolve a manifest's two revisions and ask whether the change is version-only.
 * Any failure to resolve — a throwing resolver, a null result, unreadable content
 * — yields false, so the edit is reported as an ordinary violation. Fails closed.
 */
function isVersionOnlyEdit(file, resolveContents) {
  // The predicate call stays INSIDE the try. It was outside once: a hostile
  // deeply-nested manifest threw out of the walk, escaped uncaught, and turned a
  // gate decision (exit 2, violation) into an operational crash (exit 1).
  try {
    const contents = resolveContents(file);
    if (!contents) return false;
    return isVersionOnlyChange(contents.before, contents.after, file);
  } catch {
    return false;
  }
}
