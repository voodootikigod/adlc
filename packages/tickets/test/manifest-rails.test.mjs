// #235 — a rail glob must not freeze a manifest file.
//
// A rail over `packages/x/**` freezes that package's package.json along with its
// code. That is almost never the author's intent, and it is the collision #228
// spent seven review rounds working around: a lockstep release rewrites every
// manifest, so any such rail fails every release. #234 exempts the release edit;
// this stops the over-broad rail being written in the first place.
//
// The matcher is deliberately self-contained (no @adlc/core import) because core
// depends on @adlc/tickets, so importing globMatch from core would create a
// cycle. A cross-check test below asserts it agrees with core's globMatch on a
// shared corpus, so the duplication cannot silently diverge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coversManifest, discoverManifests, MANIFEST_BASENAMES } from '../lib/manifest-rails.mjs';

// A realistic manifest corpus, shaped like the repo's actual release-rewritten
// manifests. Passed explicitly so these are pure unit tests: no git, no FS.
const MANIFESTS = [
  'package.json',
  'packages/build-gate/package.json',
  'packages/ticket-sync/package.json',
  'plugins/adlc-codex/package.json',
  'plugins/adlc-codex/.codex-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];
const covers = (glob) => coversManifest(glob, MANIFESTS);

// ---------------------------------------------------------- rails that COVER a manifest

test('a directory rail covering a package.json is flagged', () => {
  assert.equal(covers('packages/build-gate/**'), true);
  assert.equal(covers('plugins/adlc-codex/**'), true);
});

test('a bare ** covers everything, including manifests', () => {
  assert.equal(covers('**'), true);
  assert.equal(covers('**/*'), true);
});

test('an exact manifest path is flagged', () => {
  assert.equal(covers('packages/build-gate/package.json'), true);
  assert.equal(covers('plugins/adlc-codex/.codex-plugin/plugin.json'), true);
  assert.equal(covers('.claude-plugin/marketplace.json'), true);
  assert.equal(covers('package.json'), true);
});

test('a rail matching manifests by wildcard basename is flagged', () => {
  assert.equal(covers('packages/build-gate/*.json'), true);   // matches package.json
  assert.equal(covers('**/package.json'), true);
  assert.equal(covers('packages/*/package.json'), true);
});

test('a nested host manifest is covered by a directory rail', () => {
  // plugins/adlc-codex/.codex-plugin/plugin.json lives two levels down.
  assert.equal(covers('plugins/adlc-codex/**'), true);
});

// -------------------------------------------------------- rails that do NOT cover a manifest

test('a rail scoped to a source subtree is not flagged', () => {
  assert.equal(covers('packages/build-gate/lib/**'), false);
  assert.equal(covers('packages/build-gate/test/**'), false);
  assert.equal(covers('plugins/adlc-codex/hooks/**'), false);
});

test('a rail scoped by source extension is not flagged', () => {
  assert.equal(covers('packages/build-gate/**/*.mjs'), false);
  assert.equal(covers('packages/build-gate/lib/*.ts'), false);
});

test('a rail over a schemas or data dir is not flagged (no manifest lives there)', () => {
  assert.equal(covers('packages/ticket-sync/schemas/**'), false);
  assert.equal(covers('packages/build-gate/fixtures/**'), false);
});

test('a specific non-manifest json file is not flagged', () => {
  assert.equal(covers('packages/build-gate/lib/config.json'), false);
  assert.equal(covers('.adlc/config.json'), false);
});

// ---------------------------------------------------------------------- input hygiene

test('a non-string or empty rail does not throw and is not flagged', () => {
  assert.equal(covers(''), false);
  assert.equal(covers(null), false);
  assert.equal(covers(undefined), false);
  assert.equal(covers(42), false);
});

test('coversManifest requires an explicit manifest corpus', () => {
  assert.throws(() => coversManifest('packages/x/**'), /explicit manifestPaths/);
});

test('discoverManifests walks a tree, finds manifests, excludes node_modules', () => {
  // Build a fixture and pass its root EXPLICITLY. An earlier version called
  // discoverManifests() with no argument and asserted the real repo layout was
  // below cwd — true under `run-tests.mjs` (cwd = repo root) but false under
  // `npm test --workspace @adlc/tickets` (cwd = packages/tickets), where CI
  // caught it. The function is correct; the test must not assume cwd.
  const root = mkdtempSync(join(tmpdir(), 'adlc-discover-'));
  try {
    mkdirSync(join(root, 'packages', 'build-gate', 'lib'), { recursive: true });
    mkdirSync(join(root, 'plugins', 'x', '.claude-plugin'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'packages', 'build-gate', 'package.json'), '{}\n');
    writeFileSync(join(root, 'plugins', 'x', '.claude-plugin', 'plugin.json'), '{}\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'package.json'), '{}\n');

    const found = discoverManifests(root);
    assert.ok(found.includes('package.json'), 'root manifest present');
    assert.ok(found.includes('packages/build-gate/package.json'), 'package manifest present');
    assert.ok(found.includes('plugins/x/.claude-plugin/plugin.json'), 'nested host manifest present');
    assert.ok(!found.some((p) => p.includes('node_modules')), 'node_modules excluded');

    assert.equal(coversManifest('packages/build-gate/**', found), true);
    assert.equal(coversManifest('packages/build-gate/lib/**', found), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A nested git checkout is not this checkout's content. This repo keeps its
// worktrees under `.claude/worktrees/`, not the `.worktrees` the SKIP_DIRS set
// names, so the walk used to descend into stale branches and return their
// manifests as if they were ours — 95 of 146 paths in a working checkout.
// Detect the checkout itself rather than guessing directory names: a linked
// worktree has a `.git` FILE, a submodule or nested clone a `.git` DIRECTORY.
test('discoverManifests skips nested git checkouts, whatever they are named', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-nested-')));
  try {
    // this checkout's own content
    writeFileSync(join(root, 'package.json'), '{}\n');
    mkdirSync(join(root, 'packages', 'real'), { recursive: true });
    writeFileSync(join(root, 'packages', 'real', 'package.json'), '{}\n');

    // a linked worktree: `.git` is a FILE, and the directory name is not in SKIP_DIRS
    const worktree = join(root, '.claude', 'worktrees', 'stale');
    mkdirSync(join(worktree, 'packages', 'real'), { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/stale\n');
    writeFileSync(join(worktree, 'package.json'), '{}\n');
    writeFileSync(join(worktree, 'packages', 'real', 'package.json'), '{}\n');

    // a submodule / nested clone: `.git` is a DIRECTORY
    const submodule = join(root, 'vendor', 'dep');
    mkdirSync(join(submodule, '.git'), { recursive: true });
    writeFileSync(join(submodule, 'package.json'), '{}\n');

    const found = discoverManifests(root);
    assert.ok(found.includes('package.json'), 'our root manifest present');
    assert.ok(found.includes('packages/real/package.json'), 'our package manifest present');
    assert.deepEqual(found.filter((p) => p.startsWith('.claude/')), [], 'no worktree manifest');
    assert.deepEqual(found.filter((p) => p.startsWith('vendor/')), [], 'no submodule manifest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The bug that made this matter: `#assertNoManifestRails` rejects a rail that
// covers any discovered manifest, so a phantom path turns ticket creation into
// a RAIL_COVERS_MANIFEST failure that depends on the operator's disk rather than
// on the commit. Same tree, same rail, must reach the same verdict.
test('a rail verdict does not depend on whether a nested checkout is present', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-verdict-')));
  try {
    writeFileSync(join(root, 'package.json'), '{}\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{}\n'); // not a manifest basename

    const before = discoverManifests(root);
    const verdictBefore = coversManifest('.claude/**', before);

    const worktree = join(root, '.claude', 'worktrees', 'stale');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    writeFileSync(join(worktree, 'package.json'), '{}\n');

    const after = discoverManifests(root);
    assert.deepEqual([...after].sort(), [...before].sort(), 'the walk is unchanged by a worktree');
    assert.equal(coversManifest('.claude/**', after), verdictBefore, 'the rail verdict is unchanged');
    assert.equal(verdictBefore, false, 'and `.claude/**` covers no real manifest here');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// MAX_DEPTH is a real bound, and the depth counter that feeds it must advance by
// exactly one level per level. A counter that overshoots still finds shallow
// manifests, so the existing cases cannot see it — it silently stops descending
// early and quietly under-reports, which is the same failure shape as the
// worktree bug above: a manifest that exists is reported as absent.
test('the walk descends exactly one level per directory, up to MAX_DEPTH', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-depth-')));
  try {
    const nest = (...segments) => {
      mkdirSync(join(root, ...segments), { recursive: true });
      writeFileSync(join(root, ...segments, 'package.json'), '{}\n');
      return segments.join('/') + '/package.json';
    };
    const deep5 = nest('a', 'b', 'c', 'd', 'e');
    const atLimit = nest('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8');
    const past = nest('m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9');

    const found = discoverManifests(root);
    // reachable only if the counter advances by one: a step of two prices this
    // directory at depth 10 and abandons it before reading the manifest.
    assert.ok(found.includes(deep5), `a five-deep manifest is found: ${deep5}`);
    assert.ok(found.includes(atLimit), 'a manifest at MAX_DEPTH is found');
    assert.ok(!found.includes(past), 'a manifest past MAX_DEPTH is not walked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the manifest basename set is exactly the three host manifests', () => {
  assert.deepEqual([...MANIFEST_BASENAMES].sort(), ['marketplace.json', 'package.json', 'plugin.json']);
});

// The self-contained glob compiler must agree with @adlc/core's globMatch on a
// shared corpus. This is the safety net for reimplementing it here: if core's
// semantics ever change, this test fails and points at the divergence. Importing
// core in a TEST is fine — the cycle only matters for the package's runtime deps.
test('the internal glob semantics agree with @adlc/core globMatch', async () => {
  const { globMatch } = await import('@adlc/core');
  const patterns = [
    'packages/build-gate/**', 'packages/build-gate/lib/**', 'packages/*/package.json',
    '**/package.json', '**', '**/*', 'packages/x/**/*.mjs', 'a/b/c.json',
    'plugins/adlc-codex/.codex-plugin/plugin.json', 'packages/build-gate/*.json',
  ];
  const paths = [
    'package.json', 'packages/build-gate/package.json', 'packages/build-gate/lib/x.mjs',
    'plugins/adlc-codex/.codex-plugin/plugin.json', 'a/b/c.json', 'packages/x/y/z.mjs',
    'packages/build-gate/lib/deep/nested.json', '.claude-plugin/marketplace.json',
  ];
  // Reach the internal compiler through coversManifest by using a single-path
  // corpus: coversManifest(pattern, [path]) === globMatch(pattern, path).
  for (const pattern of patterns) {
    for (const path of paths) {
      assert.equal(
        coversManifest(pattern, [path]),
        globMatch(pattern, path),
        `divergence: glob "${pattern}" vs path "${path}"`
      );
    }
  }
});
