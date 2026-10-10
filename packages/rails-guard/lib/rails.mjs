// Rail-freeze enforcement: detect edits to frozen rail paths.
// Rails are declared as globs in ticket.rails or supplied via --rails flags.

import { globMatch } from '@adlc/core/tickets';
import { isManifestFile, isVersionOnlyChange } from './version-only.mjs';

export const NO_RAILS_ERROR = 'no active ticket declares rails and no --rails supplied — nothing to guard';

/**
 * Resolve the set of rails to enforce, each tagged with the ticket that declared it.
 *
 * Rails are frozen for EVERYONE, not only for the ticket that declared them (#1050), so
 * the set is the union over every active ticket — exactly the rule the CI gate
 * (lib/ci/rail-freeze.mjs) and tier.mjs apply. `--ticket` plays no part in which rails
 * exist; it only selects whose `allow-suppression` declarations apply (see check.mjs).
 *
 * Priority:
 *  1. Explicit --rails globs always win, with no owner.
 *  2. Otherwise the union of `rails` across every ticket whose `completed` is not the
 *     strict boolean `true` (T36: only a real completion expires a ticket's rails).
 *
 * De-duplicated by (glob, owner): the same glob frozen by two tickets is two entries,
 * so a violation can always name an owner. Pure — neither input is mutated.
 *
 * @param {{cliRails?: string[], ticket?: object|null, tickets?: object[]}} o
 * @returns {{ rails: Array<{glob: string, owner: string|null}>, error: string|null }}
 */
export function resolveRailSet({ cliRails = [], ticket = null, tickets = ticket ? [ticket] : [] } = {}) {
  if (cliRails.length > 0) {
    return { rails: dedupeRails(cliRails.map((glob) => ({ glob, owner: null }))), error: null };
  }
  const declared = [];
  for (const t of tickets) {
    if (!t || t.completed === true) continue;
    for (const glob of t.rails ?? []) declared.push({ glob, owner: t.id ?? null });
  }
  const rails = dedupeRails(declared);
  if (rails.length === 0) return { rails: [], error: NO_RAILS_ERROR };
  return { rails, error: null };
}

function dedupeRails(rails) {
  const seen = new Set();
  const out = [];
  for (const rail of rails) {
    const key = `${rail.owner ?? ''}\u0000${rail.glob}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ glob: rail.glob, owner: rail.owner });
  }
  return out;
}

/**
 * The first declaring ticket of each glob, in resolution order. A glob supplied by
 * --rails, or one that only cli globs cover, maps to null.
 * @param {Array<{glob: string, owner: string|null}>} rails
 * @returns {Map<string, string|null>}
 */
export function railOwners(rails) {
  const owners = new Map();
  for (const { glob, owner } of rails) {
    if (!owners.has(glob) || (owners.get(glob) === null && owner !== null)) owners.set(glob, owner);
  }
  return owners;
}

/**
 * Check which changed files match any rail glob.
 * Returns { violations, sanctioned } — violations: [ { file, type: 'rail-edit',
 * globs: [matched patterns] } ]; sanctioned: [ { file, globs } ] for every path
 * that matched a rail glob but was exempted via sanctionedAdditions (#739 — the
 * exemption must be disclosed, never silent, wherever the result is read). The
 * #228 version-only exemption is intentionally NOT included in `sanctioned` — it
 * is a separate, already-accepted exemption class this disclosure does not cover.
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
 * @param {Map<string, string|null> | null} [owners]
 *        glob → declaring ticket id (see railOwners). Each violation names the owner of
 *        the first matched glob that has one as `ownerTicket` (#1050), so an operator
 *        learns to go ask rather than to sign. Omitted → every `ownerTicket` is null.
 * @returns {{ violations: Array<{file: string, type: 'rail-edit', globs: string[], ownerTicket: string|null}>,
 *             sanctioned: Array<{file: string, globs: string[]}> }}
 */
export function checkRailEdits(changedFiles, railGlobs, resolveContents = null, sanctionedAdditions = null, owners = null) {
  const violations = [];
  const sanctioned = [];
  for (const file of changedFiles) {
    const matched = railGlobs.filter((g) => globMatch(g, file));
    if (matched.length === 0) continue;
    if (sanctionedAdditions?.has(file)) {
      sanctioned.push({ file, globs: matched }); // sanctioned rail authoring — reported by the caller, never silent
      continue;
    }
    if (resolveContents && isManifestFile(file) && isVersionOnlyEdit(file, resolveContents)) {
      continue; // #228 — mechanical version bump, not a behaviour edit
    }
    violations.push({ file, type: 'rail-edit', globs: matched, ownerTicket: ownerOf(matched, owners) });
  }
  return { violations, sanctioned };
}

function ownerOf(matchedGlobs, owners) {
  if (!owners) return null;
  for (const glob of matchedGlobs) {
    const owner = owners.get(glob);
    if (typeof owner === 'string') return owner;
  }
  return null;
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
