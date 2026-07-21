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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
