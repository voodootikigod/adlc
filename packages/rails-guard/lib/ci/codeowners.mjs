// CODEOWNERS reading for the two questions the CI gate asks of it (#140).
//
//   1. COVERAGE (bootstrap step): is the deployed workflow file owned by somebody?
//      A pull_request from a same-repository branch runs the PR BRANCH's copy of the
//      workflow, so this gate cannot defend itself against a PR that deletes it. The
//      only real defense is branch protection requiring owner review; all this check
//      can do mechanically is refuse to be configured as a required check while the
//      workflow path is ownerless. It cannot prove the owners are TRUSTED.
//
//   2. OWNERSHIP (#141 ceremony): which logins own the trust-root paths a PR changed?
//
// Both read CODEOWNERS at the BASE ref, never HEAD — otherwise a PR could add itself
// as an owner in the same change it needs approval for.
//
// The two questions have genuinely different resolution rules and both are load-bearing:
// COVERAGE follows GitHub's real precedence (first file that exists wins outright; within
// it, LAST matching line wins, so a later no-owner or negated entry can un-own a path an
// earlier catch-all owned). OWNERSHIP takes the UNION across files, because for the
// ceremony a broader owner set only makes approval HARDER to forge, never easier.
// They share one pattern matcher so the two can never disagree about what a glob means.

import { codeownersMatch } from '../trust-root-authorization.mjs';

// GitHub's search order. The FIRST of these that exists is authoritative; the others
// are ignored entirely, not merged.
export const CODEOWNERS_FILES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * Parse CODEOWNERS text into { pattern, negated, owners } rows, in file order.
 *
 * A comment is stripped only when it is preceded by whitespace or starts the line, so a
 * `#` inside a pattern is not treated as the start of a comment.
 */
export function parseCodeowners(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const [rawPattern, ...owners] = line.split(/\s+/);
    if (!rawPattern) continue;
    const negated = rawPattern.startsWith('!');
    rows.push({
      pattern: negated ? rawPattern.slice(1) : rawPattern,
      negated,
      owners: owners.map((owner) => owner.replace(/^@/, '')),
    });
  }
  return rows;
}

/**
 * COVERAGE. True when the effective CODEOWNERS gives the workflow path at least one
 * owner.
 *
 * Fails closed by construction: an unreadable or absent CODEOWNERS yields false, and a
 * negation or a no-owner line AFTER a matching catch-all wins, because that is what
 * GitHub itself would resolve. The alternative — first-match-wins, or unioning across
 * files — would report a path as owned that GitHub treats as ownerless.
 */
export function pathHasCodeowner(git, baseRef, path) {
  for (const file of CODEOWNERS_FILES) {
    const shown = git(['show', `${baseRef}:${file}`], `git show base ${file}`);
    if (shown.status !== 0) continue; // absent at base — fall through to the next file
    let owned = false;
    // Last match wins, matching GitHub. Do NOT early-return on the first match.
    for (const row of parseCodeowners(shown.stdout)) {
      if (!codeownersMatch(row.pattern, path)) continue;
      owned = !row.negated && row.owners.length > 0;
    }
    return owned; // this file is authoritative; later files are not consulted
  }
  return false;
}

/**
 * OWNERSHIP. The logins (without a leading @) who own any of `paths`.
 *
 * Applies GitHub's resolution rules in both dimensions:
 *   * only the FIRST CODEOWNERS file that exists is consulted (the others are ignored
 *     outright, not merged), and
 *   * within it, the LAST matching row wins for a given path.
 *
 * Both were unions once, on the argument that a wider owner set "can only make the ceremony
 * harder to satisfy". That is backwards — the ceremony needs an approval from ANY owner, so
 * a wider set makes it EASIER. Unioning ROWS meant a catch-all `* @alice` kept granting
 * Alice ownership of `.adlc/config.json` even after a later, more specific
 * `/.adlc/config.json @bob` had taken it away, so Alice could authorize a trust-root change
 * GitHub would never let her approve (cross-model review, #363 rounds 3 and 5).
 *
 * A last-matching row that is NEGATED, or that names no owners, leaves the path ownerless —
 * the same reading coverage uses.
 *
 * RESIDUAL: when several trust-root paths change at once, this returns the UNION across
 * paths, so an owner of ONE changed path satisfies the ceremony for the set. GitHub would
 * require an owner of EACH. Narrowing this to an intersection would deny a legitimate
 * trust-root RENAME, where the old and new paths can have different owners, so the union is
 * deliberate. The un-forgeable backstop is unaffected: GitHub's own branch-protection
 * CODEOWNERS review still gates the merge.
 */
export function ownersForPaths(git, baseRef, paths) {
  const owners = new Set();
  for (const file of CODEOWNERS_FILES) {
    const shown = git(['show', `${baseRef}:${file}`], `git show base ${file}`);
    if (shown.status !== 0) continue; // absent at base — fall through to the next file
    const rows = parseCodeowners(shown.stdout);
    for (const path of paths) {
      let winner = null;
      // Do NOT break on the first match: a later row overrides an earlier one.
      for (const row of rows) {
        if (codeownersMatch(row.pattern, path)) winner = row;
      }
      if (!winner || winner.negated) continue;
      for (const owner of winner.owners) owners.add(owner);
    }
    return [...owners]; // this file is authoritative; later files are not consulted
  }
  return [...owners];
}
