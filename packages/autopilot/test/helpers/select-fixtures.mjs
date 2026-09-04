// Fixture builders for the selection / authorization / denylist tests
// (AC 3 19 33 79 85 97 109 140 155): gh-shaped issue objects, timeline events,
// a permission table, the 12-issue scoring fixture and the two trust-root
// source texts (read from the real files, optionally EXTENDED with an entry —
// AC 140's "adding a path to either source list extends the denylist").

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..', '..');

/** A fixed "now" every scoring/timeline fixture is relative to. */
export const NOW = Date.parse('2026-08-28T12:00:00Z');
export const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
export const at = (offsetMinutes) => new Date(NOW - 7 * 86_400_000 + offsetMinutes * 60_000).toISOString();

/** A `gh issue view --json` shaped issue. */
export function makeIssue({ number = 1, title = `Issue ${number}`, body = 'body', author = 'owner', association = 'OWNER', labels = [], milestone = null, createdAt = daysAgo(0), updatedAt = daysAgo(0) } = {}) {
  return {
    number, title, body, state: 'OPEN', createdAt, updatedAt,
    author: { login: author }, authorAssociation: association,
    labels: labels.map((name) => ({ name })),
    milestone: milestone ? { title: milestone } : null,
  };
}

let nextId = 100;
const ev = (event, actor, created, extra = {}) => ({ event, id: nextId++, created_at: created, actor: { login: actor }, ...extra });
export const labeled = (actor, created, name = 'adlc:autopilot') => ev('labeled', actor, created, { label: { name } });
export const unlabeled = (actor, created, name = 'adlc:autopilot') => ev('unlabeled', actor, created, { label: { name } });
export const renamed = (actor, created, from = 'old', to = 'new') => ev('renamed', actor, created, { rename: { from, to } });
export const commented = (actor, created) => ev('commented', actor, created);

/** The standard cast and their repository permissions. */
export const PERMS = Object.freeze({ owner: 'admin', admin: 'admin', maint: 'maintain', writer: 'write', triager: 'triage', reader: 'read', member: 'write', collab: 'write', outsider: null });
export const perms = (table = PERMS) => async (login) => table[login] ?? null;

/** `issueBodyEdits`-shaped edit history. */
export const edits = (editors = [], lastEditedAt = null) => ({ ok: true, lastEditedAt: lastEditedAt ?? (editors.length ? editors[editors.length - 1].editedAt : null), editors });
export const editBy = (login, editedAt) => ({ login, editedAt });
export const UNREADABLE = Object.freeze({ ok: false, reason: 'unreadable' });

/**
 * The 12-issue scoring fixture (AC 3) and its documented order:
 *   #12 autopilot-only (1000) outranks #3 P0+bug+security+area+age (465);
 *   #2 and #9 tie at 310 → lower number first; #11's 700-day age caps at +20;
 *   #4 carries two `area:` labels (no single-area bonus).
 */
export function scoringFixture() {
  const mk = (number, labels, days = 0) => makeIssue({ number, labels, createdAt: daysAgo(days) });
  return [
    mk(1, ['P1-high', 'documentation', 'area:core'], 14),      // 332
    mk(2, ['P1-high', 'area:core']),                            // 310 (tie with #9 → first)
    mk(3, ['P0-critical', 'bug', 'security', 'area:x'], 70),    // 465 (400+30+15+10+10 weeks)
    mk(4, ['P3-low', 'bug', 'area:a', 'area:b']),               // 130
    mk(5, ['P2-medium', 'bug']),                                // 230
    mk(6, ['bug'], 7),                                          // 31
    mk(7, ['P0-critical']),                                     // 400
    mk(8, [], 21),                                              // 3
    mk(9, ['P1-high', 'enhancement']),                          // 310
    mk(10, ['enhancement', 'security', 'area:x'], 42),          // 41
    mk(11, ['P2-medium'], 700),                                 // 220
    mk(12, ['adlc:autopilot']),                                 // 1000
  ];
}
export const SCORING_ORDER = Object.freeze([12, 3, 7, 1, 2, 9, 5, 11, 4, 10, 6, 8]);
export const SCORING_SCORES = Object.freeze({ 12: 1000, 3: 465, 7: 400, 1: 332, 2: 310, 9: 310, 5: 230, 11: 220, 4: 130, 10: 41, 6: 31, 8: 3 });

/* ---------- denylist source texts ---------- */

const TRUST_ROOTS_PATH = join(REPO_ROOT, 'packages', 'rails-guard', 'lib', 'ci', 'trust-roots.mjs');
const RAILS_GUARD_CI_PATH = join(REPO_ROOT, 'scripts', 'rails-guard-ci.mjs');

/** Insert `entry` as the first element of `const <ident> = [`/`Object.freeze([` in `text`. */
export function extendList(text, ident, entry) {
  const re = new RegExp(`(\\bconst\\s+${ident}\\s*=\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\[)`);
  if (!re.test(text)) throw new Error(`fixture: ${ident} not found`);
  return text.replace(re, `$1\n  ${JSON.stringify(entry)},`);
}

/**
 * The two source texts as the pinned blob would supply them, optionally
 * extended with one extra entry each.
 */
export function denylistSources({ extraTrustRoot = null, extraRepoRoot = null } = {}) {
  let trustRootsModuleText = readFileSync(TRUST_ROOTS_PATH, 'utf8');
  let railsGuardCiText = readFileSync(RAILS_GUARD_CI_PATH, 'utf8');
  if (extraTrustRoot) trustRootsModuleText = extendList(trustRootsModuleText, 'DEFAULT_IMMUTABLE_TRUST_ROOTS', extraTrustRoot);
  if (extraRepoRoot) railsGuardCiText = extendList(railsGuardCiText, 'REPO_TRUST_ROOTS', extraRepoRoot);
  return { trustRootsModuleText, railsGuardCiText };
}

/** A minimal synthetic pair of source texts (no dependency on the working tree). */
export function syntheticSources({ trustRoots = ['.adlc/config.json', 'packages/rails-guard/lib/ci/**'], repoRoots = ['scripts/preflight.mjs', 'scripts/toolkit-floor.json'] } = {}) {
  const lit = (arr) => arr.map((p) => `  '${p}', // ${p} is frozen (see 'quotes' in "comments")`).join('\n');
  return {
    trustRootsModuleText: `// header 'with a quote'\nexport const DEFAULT_IMMUTABLE_TRUST_ROOTS = Object.freeze([\n${lit(trustRoots)}\n]);\nexport function x() {}\n`,
    railsGuardCiText: `/* DEFAULT_IMMUTABLE_TRUST_ROOTS = [ 'not-this' ] */\nconst REPO_TRUST_ROOTS = [\n${lit(repoRoots)}\n];\nconst other = ['ignored'];\n`,
  };
}
