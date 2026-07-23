// Concern: trust-root-tier classifier (T39 AC1).
//
// classifyTrustRootTier({ changedFiles, tickets }) is pure/offline/deterministic.
// A change is trust-root tier iff any changed file matches ANY surface class:
//   1. an exact trust-root file,
//   2. an enforcement-package prefix,
//   3. a gated-artifact producer-package prefix,
//   4. a rails deny-path glob declared on any ticket.
// Positive AND negative fixtures for every surface class; an ordinary diff is FALSE.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTrustRootTier } from '../lib/tier.mjs';

const TICKETS = [
  { id: 'T7', title: 'auth', scope: ['src/**'], rails: ['test/auth/**'], edges: [] },
  { id: 'T8', title: 'noise', scope: ['src/**'], rails: [], edges: [] },
];

describe('classifyTrustRootTier — positive surface classes', () => {
  it('TRUE for an exact trust-root file (rails-guard-ci.mjs)', () => {
    const r = classifyTrustRootTier({ changedFiles: ['scripts/rails-guard-ci.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('scripts/rails-guard-ci.mjs')));
  });

  it('TRUE for the CI workflow template and hash pin and tickets.json', () => {
    for (const f of ['docs/ci/rails-guard.yml', 'scripts/test/rails-guard-workflow-hashes.json', '.adlc/tickets.json']) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${f} should be trust-root`);
      assert.ok(r.reasons.some((x) => x.includes(f)));
    }
  });

  it('TRUE for an enforcement-package prefix (packages/prosecute/…)', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages/prosecute/lib/run.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('packages/prosecute/')));
  });

  it('TRUE for every enforcement package', () => {
    for (const p of ['packages/rails-guard/', 'packages/prosecute/', 'packages/gate-manifest/', 'packages/build-gate/']) {
      const r = classifyTrustRootTier({ changedFiles: [`${p}lib/x.mjs`], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${p} should be trust-root`);
    }
  });

  it('TRUE for a gated-artifact producer package (ticket-prune / ticket-sync)', () => {
    for (const p of ['packages/ticket-prune/', 'packages/ticket-sync/']) {
      const r = classifyTrustRootTier({ changedFiles: [`${p}lib/y.mjs`], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${p} should be trust-root`);
      assert.ok(r.reasons.some((x) => x.includes(p)));
    }
  });

  it('TRUE for a change that hits a ticket rails deny-path glob', () => {
    const r = classifyTrustRootTier({ changedFiles: ['test/auth/login.test.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('T7') && x.includes('test/auth/**')));
  });

  // The sharded backend is the SAME trust root as `.adlc/tickets.json`. When a
  // repo migrates, the exact-file entry stops matching and every shard edit would
  // declassify unless the store directory itself is a trust-root surface.
  it('TRUE for a shard in the sharded ticket store', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['.adlc/tickets/t64--ec791ef8cffb458098b48e73556d0f644cd8c1845bf94cc167060c1e3aca4a42.json'],
      tickets: TICKETS,
    });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('.adlc/tickets/')));
  });

  it('TRUE for the sharded store manifest and for the archive', () => {
    for (const f of ['.adlc/tickets/.store.json', '.adlc/ticket-archive/.store.json', '.adlc/ticket-archive/t1--abc.json']) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${f} should be trust-root`);
    }
  });

  // The test-path exemption applies to package prefixes only. A shard is DATA the
  // gate reads, so a ticket id that happens to look test-ish must not exempt it.
  it('TRUE for a shard whose name would trip the test-file heuristic', () => {
    const r = classifyTrustRootTier({ changedFiles: ['.adlc/tickets/t-test--abc.test.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
  });
});

describe('classifyTrustRootTier — negative / ordinary diffs', () => {
  it('FALSE for a lookalike path outside the ticket store directory', () => {
    for (const f of ['.adlc/tickets-notes.md', '.adlc/specs/x.md', 'docs/.adlc/tickets/x.json']) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, false, `${f} should NOT be trust-root`);
    }
  });

  it('FALSE for a docs-only change', () => {
    const r = classifyTrustRootTier({ changedFiles: ['apps/docs/x.mdx'], tickets: TICKETS });
    assert.deepEqual(r, { isTrustRootTier: false, reasons: [] });
  });

  it('FALSE for a non-enforcement package change', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages/spec-lint/lib/y.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, false);
    assert.deepEqual(r.reasons, []);
  });

  it('FALSE for a source change outside any rails deny-path', () => {
    const r = classifyTrustRootTier({ changedFiles: ['src/app.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, false);
  });

  it('FALSE for empty inputs / defaults', () => {
    assert.deepEqual(classifyTrustRootTier({}), { isTrustRootTier: false, reasons: [] });
    assert.deepEqual(classifyTrustRootTier(), { isTrustRootTier: false, reasons: [] });
  });
});

describe('classifyTrustRootTier — hygiene', () => {
  it('dedups repeated reasons across multiple files hitting the same surface', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['packages/prosecute/lib/a.mjs', 'packages/prosecute/lib/b.mjs'],
      tickets: TICKETS,
    });
    const enforcement = r.reasons.filter((x) => x.includes('packages/prosecute/'));
    assert.equal(enforcement.length, 1);
  });

  it('normalizes backslash paths to POSIX before matching', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages\\prosecute\\lib\\a.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
  });

  it('collects reasons from several distinct surfaces at once', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['scripts/rails-guard-ci.mjs', 'packages/ticket-sync/lib/z.mjs', 'test/auth/x.test.mjs'],
      tickets: TICKETS,
    });
    assert.equal(r.isTrustRootTier, true);
    assert.equal(r.reasons.length, 3);
  });
});

describe('classifyTrustRootTier — test-only exemption (#154/T41)', () => {
  it('AC1: a diff touching ONLY test files in a producer/enforcement package is NOT trust-root tier', () => {
    for (const f of [
      'packages/ticket-prune/test/roundtrip.test.mjs',      // producer, under test/
      'packages/ticket-sync/test/pull.test.mjs',            // producer, under test/
      'packages/prosecute/test/run.test.mjs',               // enforcement, under test/
      'packages/rails-guard/test/guard.test.mjs',           // enforcement, under test/
      'packages/build-gate/lib/foo.test.mjs',               // enforcement, *.test.mjs basename (not under test/)
    ]) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, false, `${f} (test-only) must NOT tier`);
      assert.deepEqual(r.reasons, []);
    }
  });

  it('AC2: the same test-only diff PLUS one non-test file in the package DOES tier', () => {
    const r = classifyTrustRootTier({
      changedFiles: ['packages/ticket-prune/test/roundtrip.test.mjs', 'packages/ticket-prune/lib/run.mjs'],
      tickets: TICKETS,
    });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('packages/ticket-prune/')));
  });

  it('AC3: a trust-root EXACT file that is itself a TEST path still tiers (rails-guard-workflow-hashes.json)', () => {
    const r = classifyTrustRootTier({ changedFiles: ['scripts/test/rails-guard-workflow-hashes.json'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('rails-guard-workflow-hashes.json')));
  });

  it('AC4: a TEST path matching a ticket rails deny-path still tiers (rails surface is not exempted)', () => {
    // T7 rails = test/auth/**; a test file under it is a frozen rail.
    const r = classifyTrustRootTier({ changedFiles: ['test/auth/login.test.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true);
    assert.ok(r.reasons.some((x) => x.includes('rails deny-path of ticket T7')));
  });

  it('precision: a non-test path that merely CONTAINS "test" (test-utils/) is NOT exempted', () => {
    const r = classifyTrustRootTier({ changedFiles: ['packages/prosecute/test-utils/helper.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true, 'test-utils is not a test dir; a real helper edit must still tier');
  });

  it('precision (boundary): a segment that merely ENDS with "test" (latest/, contest/) is NOT a test dir — the ^|/ left-anchor must hold', () => {
    // "latest/" and "contest/" both CONTAIN the substring "test/"; a boundary-less
    // /test\// would wrongly exempt them. The ^|/ anchor requires `test` at a
    // segment start, so these shipped-code paths must still tier.
    for (const f of ['packages/prosecute/latest/run.mjs', 'packages/build-gate/contest/x.mjs']) {
      const r = classifyTrustRootTier({ changedFiles: [f], tickets: TICKETS });
      assert.equal(r.isTrustRootTier, true, `${f}: ends-with-"test" is not a test dir; must tier`);
    }
  });

  it('fail-safe: a non-canonical path with a ".." segment (e.g. test/../lib/...) is NOT exempted — it must tier', () => {
    // A `/test/` segment that resolves back into production must not exempt the
    // change. Out-of-contract input (the live caller feeds canonical git-diff
    // paths), but the exemption fails safe by tiering it.
    const r = classifyTrustRootTier({ changedFiles: ['packages/prosecute/test/../lib/run.mjs'], tickets: TICKETS });
    assert.equal(r.isTrustRootTier, true, 'a ..-containing test path must not be exempted');
  });
});

// The test-file exemption (#154/T41) is only SAFE if a test-classified path never
// holds production code imported by a gate. Enforce that invariant so a future
// convention violation can't silently open a tier bypass.
describe('trust-root tier — test-exemption assumption is enforced (#154/T41)', () => {
  const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const GATED_PACKAGES = ['rails-guard', 'prosecute', 'gate-manifest', 'build-gate', 'ticket-prune', 'ticket-sync'];

  function walkMjs(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkMjs(p));
      else if (entry.name.endsWith('.mjs')) out.push(p);
    }
    return out;
  }

  it('no production lib/bin module in a producer/enforcement package imports a test-classified file', () => {
    const importsTestPath =
      /(?:import\s[^;\n]*from|require\s*\()\s*['"`][^'"`]*(?:\.test\.(?:mjs|js|cjs)|\/test\/)[^'"`]*['"`]/;
    const offenders = [];
    for (const pkg of GATED_PACKAGES) {
      for (const sub of ['lib', 'bin']) {
        for (const file of walkMjs(join(REPO_ROOT, 'packages', pkg, sub))) {
          if (importsTestPath.test(readFileSync(file, 'utf8'))) {
            offenders.push(file.slice(REPO_ROOT.length));
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a production module importing a test-classified file would silently open the T41 test-exemption bypass — route shared code through a non-test path',
    );
  });
});
