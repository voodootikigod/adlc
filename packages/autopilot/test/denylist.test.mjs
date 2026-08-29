// The protected-path denylist (spec §4.2; AC 140 — the selection/triage half;
// the actual-diff half lives in diffcheck.test). The denylist is PARSED from
// the source TEXT of the two trust-root lists as the pinned blob would supply
// them, unioned with the static extras, and only ever extended by config.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { buildDenylist, parseTrustRootList, scopeIntersects, intersectingPairs, globsIntersect, stripComments, STATIC_EXTRAS, TRUST_ROOTS_IDENT, REPO_ROOTS_IDENT } from '../lib/denylist.mjs';
import { denylistSources, syntheticSources } from './helpers/select-fixtures.mjs';

export function ac140_denylistDerivesFromTrustRootLists() {
  // (1) built from the two source texts: the paths §4.2 names "today" are all denied
  const dl = buildDenylist(denylistSources());
  for (const p of ['scripts/preflight.mjs', 'scripts/test/preflight.test.mjs', 'scripts/toolkit-floor.json', 'scripts/toolkit-floor-check.mjs',
    'scripts/test/toolkit-floor.test.mjs', 'scripts/check-reviewer-directed-comments.mjs', 'scripts/test/check-reviewer-directed-comments.test.mjs',
    '.github/workflows/ci.yml', 'docs/ci/rails-guard.yml', '.adlc/config.json', 'packages/rails-guard/lib/ci/trust-roots.mjs',
    'packages/rails-guard/bin/rails-guard.mjs', 'CODEOWNERS', 'package.json', '.npmrc']) {
    assert.equal(dl.matches(p), true, `${p} is denied`);
  }
  assert.ok(dl.sources.trustRoots.includes('scripts/rails-guard-ci.mjs'), 'DEFAULT_IMMUTABLE_TRUST_ROOTS parsed');
  assert.ok(dl.sources.repoRoots.includes('scripts/preflight.mjs'), 'REPO_TRUST_ROOTS parsed');
  assert.ok(dl.sources.trustRoots.length >= 10 && dl.sources.repoRoots.length >= 5, 'both lists carry their real entries');
  for (const s of STATIC_EXTRAS) assert.ok(dl.globs.includes(s), `static extra ${s}`);
  // ordinary build scope is not denied
  for (const p of ['packages/autopilot/lib/select.mjs', 'docs/guides/x.md', 'scripts/other.mjs', 'packages/foo/package.json', 'README.md']) {
    assert.equal(dl.matches(p), false, `${p} is not denied`);
  }
  // (2) a shaped scope naming a trust root intersects (→ CLARIFY at triage)
  assert.deepEqual(scopeIntersects(['scripts/preflight.mjs'], dl), ['scripts/preflight.mjs']);
  assert.deepEqual(scopeIntersects(['scripts/toolkit-floor.json'], dl), ['scripts/toolkit-floor.json']);
  assert.deepEqual(scopeIntersects(['packages/foo/**', 'docs/guides/**'], dl), [], 'a packages/foo scope is clean');
  // (3) adding a path to EITHER source list in the fixture blob extends the denylist with no autopilot change
  assert.equal(dl.matches('scripts/brand-new-guard.mjs'), false);
  assert.equal(dl.matches('tools/frozen/x.json'), false);
  const viaRepo = buildDenylist(denylistSources({ extraRepoRoot: 'scripts/brand-new-guard.mjs' }));
  assert.equal(viaRepo.matches('scripts/brand-new-guard.mjs'), true, 'REPO_TRUST_ROOTS extension is picked up');
  const viaDefault = buildDenylist(denylistSources({ extraTrustRoot: 'tools/frozen/**' }));
  assert.equal(viaDefault.matches('tools/frozen/x.json'), true, 'DEFAULT_IMMUTABLE_TRUST_ROOTS extension is picked up');
  assert.deepEqual(scopeIntersects(['tools/frozen/**'], viaDefault), ['tools/frozen/**']);
  // (4) the parser reads TEXT: quotes inside comments and a decoy in a block comment are ignored
  const syn = syntheticSources();
  assert.deepEqual(parseTrustRootList(syn.trustRootsModuleText, TRUST_ROOTS_IDENT), ['.adlc/config.json', 'packages/rails-guard/lib/ci/**']);
  assert.deepEqual(parseTrustRootList(syn.railsGuardCiText, REPO_ROOTS_IDENT), ['scripts/preflight.mjs', 'scripts/toolkit-floor.json']);
  assert.equal(stripComments("a // 'x'\nb /* \"y\" */ c 'kept // here'"), "a \nb  c 'kept // here'");
  // (5) fail closed: a source without its list, an empty list, or a non-relative entry is refused — never an empty denylist
  assert.throws(() => buildDenylist({ ...syn, railsGuardCiText: 'const OTHER = ["x"];' }), { code: 'denylist-source-unparseable' });
  assert.throws(() => buildDenylist({ ...syn, trustRootsModuleText: 'export const DEFAULT_IMMUTABLE_TRUST_ROOTS = Object.freeze([]);' }), { code: 'denylist-source-unparseable' });
  assert.throws(() => buildDenylist({ ...syn, trustRootsModuleText: "export const DEFAULT_IMMUTABLE_TRUST_ROOTS = ['/etc/passwd'];" }), { code: 'denylist-source-unparseable' });
  assert.throws(() => buildDenylist({ ...syn, trustRootsModuleText: "export const DEFAULT_IMMUTABLE_TRUST_ROOTS = ['../x'];" }), { code: 'denylist-source-unparseable' });
  assert.throws(() => buildDenylist({ trustRootsModuleText: null, railsGuardCiText: syn.railsGuardCiText }), { code: 'denylist-source-unparseable' });
  assert.throws(() => buildDenylist({ ...syn, extras: 'not-an-array' }), { code: 'bad-config' });
  assert.throws(() => dl.matches(42), TypeError);
}
test('AC140: the denylist is parsed from the pinned DEFAULT_IMMUTABLE_TRUST_ROOTS and REPO_TRUST_ROOTS texts plus the static extras; scripts/preflight.mjs and scripts/toolkit-floor.json intersect a shaped scope; an entry added to either source list extends it with no autopilot change; a missing or empty list fails closed', ac140_denylistDerivesFromTrustRootLists);

export function ac140_scopeIntersectionIsConservative() {
  const dl = buildDenylist({ ...syntheticSources(), extras: ['docs/x/**'] });
  assert.ok(dl.globs.includes('.adlc/**') && dl.globs.includes('packages/core/**') && dl.globs.includes('docs/x/**'), 'union: parsed + static + extras');
  const cases = [
    // [scope glob, intersects?]
    ['**', true], ['**/*', true], ['**/x.mjs', true], ['*', true],
    ['packages/core/**', true], ['packages/core/lib/**', true], ['packages/**', true], ['packages/*/lib/**', true],
    ['.adlc/tickets/**', true], ['docs/**', true], ['docs/ci/x.yml', true], ['docs/x/y/**', true],
    ['scripts/*.mjs', true], ['scripts/pre*', true], ['scripts/preflight.mjs', true], ['package.json', true], ['*.json', true],
    ['packages/autopilot/**', false], ['packages/autopilot/package.json', false], ['docs/guides/**', false],
    ['scripts/other/**', false], ['scripts/preflight.mjs.bak', false], ['README.md', false], ['src/**', false],
  ];
  for (const [glob, expect] of cases) {
    assert.equal(scopeIntersects([glob], dl).length > 0, expect, `${glob} ${expect ? 'intersects' : 'is clean'}`);
  }
  assert.deepEqual(scopeIntersects(['packages/autopilot/**', 'packages/core/**', 'docs/guides/**', 'packages/core/**'], dl), ['packages/core/**'], 'offending globs, deduplicated, scope order');
  assert.deepEqual(scopeIntersects([42], dl), ['42'], 'a malformed scope entry fails closed');
  assert.deepEqual(scopeIntersects([], dl), []);
  assert.ok(intersectingPairs(['packages/core/**'], dl).some((p) => p.deny === 'packages/core/**'));
  assert.equal(globsIntersect('packages/autopilot/**', 'packages/rails-guard/**'), false);
  assert.equal(globsIntersect('./packages/core/lib/x.mjs', 'packages/core/**'), true, 'a ./ prefix is normalized');
}
test('AC140: scope ∩ denylist is conservative — a root **, a subtree containing a trust root, a path inside a denied subtree, or a direct glob match all intersect; sibling scopes do not', ac140_scopeIntersectionIsConservative);
