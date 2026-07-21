// version-only.test.mjs — #228: a lockstep version bump must not read as a rail edit.
//
// The exemption compares TEXT, not parsed JSON — see the header of
// lib/version-only.mjs for why. Fixtures are therefore written exactly as
// JSON.stringify(obj, null, 2) produces them, because that is what
// scripts/release.mjs writes and the check is line-structural.
//
// Most tests below assert `false`. That is deliberate: a change which merely
// weakened the guard would satisfy "the release is unblocked" while silently
// unfreezing real code, so the negative cases are the ones carrying the weight.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isManifestFile, isVersionOnlyChange } from '../lib/version-only.mjs';

const PKG = 'package.json';
const MKT = '.claude-plugin/marketplace.json';

/** A realistic package.json, formatted the way the release tool writes it. */
const pkg = (version, deps = {}, extra = {}) => JSON.stringify({
  name: '@adlc/build-gate',
  version,
  main: 'lib/tier.mjs',
  dependencies: deps,
  ...extra,
}, null, 2) + '\n';

const marketplace = (metaV, pluginV, source = './plugins/adlc-claude-code') =>
  JSON.stringify({
    name: 'adlc',
    metadata: { description: 'd', version: metaV },
    plugins: [{ name: 'adlc', version: pluginV, source }],
  }, null, 2) + '\n';

// ---------------------------------------------------------------- file scoping

test('only manifest basenames are eligible', () => {
  assert.equal(isManifestFile('packages/build-gate/package.json'), true);
  assert.equal(isManifestFile('plugins/adlc-codex/.codex-plugin/plugin.json'), true);
  assert.equal(isManifestFile('.claude-plugin/marketplace.json'), true);

  assert.equal(isManifestFile('packages/build-gate/lib/tier.mjs'), false);
  assert.equal(isManifestFile('package-lock.json'), false);
  assert.equal(isManifestFile('.adlc/config.json'), false);
  assert.equal(isManifestFile('tsconfig.json'), false);
});

test('basename matching is exact', () => {
  assert.equal(isManifestFile('package.json'), true);
  assert.equal(isManifestFile('docs/package.json.md'), false);
  assert.equal(isManifestFile('scripts/not-package.json'), false);
});

test('isManifestFile rejects empty and non-string input', () => {
  assert.equal(isManifestFile(''), false);
  assert.equal(isManifestFile(null), false);
  assert.equal(isManifestFile(undefined), false);
  assert.equal(isManifestFile(42), false);
});

test('an unknown manifest kind is never exempt', () => {
  // Omitting the filename must not open the exemption.
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1')), false);
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1'), 'lib/thing.mjs'), false);
});

// ------------------------------------------------- the genuine release shapes

test('a plain version bump is exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1'), PKG), true);
});

test('every operator style repins in lockstep', () => {
  for (const op of ['', '^', '~']) {
    assert.equal(
      isVersionOnlyChange(
        pkg('1.5.0', { '@adlc/core': `${op}1.5.0` }),
        pkg('1.5.1', { '@adlc/core': `${op}1.5.1` }),
        PKG),
      true, `operator "${op}" must repin`);
  }
});

test('several dependencies repin together, leaving third-party pins alone', () => {
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '1.5.0', '@adlc/tickets': '1.5.0', chalk: '^5.0.0' }),
    pkg('1.5.1', { '@adlc/core': '1.5.1', '@adlc/tickets': '1.5.1', chalk: '^5.0.0' }),
    PKG), true);
});

test('an identical file is exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.0'), PKG), true);
});

test('marketplace metadata.version and plugins[].version are exempt', () => {
  assert.equal(isVersionOnlyChange(marketplace('1.5.0', '1.5.0'), marketplace('1.5.1', '1.5.1'), MKT), true);
});

// ------------------------------------------------- behaviour must stay frozen

test('a smuggled field change alongside a bump is NOT exempt', () => {
  const after = JSON.stringify({
    name: '@adlc/build-gate', version: '1.5.1', main: 'lib/EVIL.mjs', dependencies: {},
  }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), after, PKG), false);
});

test('adding a scripts block is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1', {}, { scripts: { postinstall: 'x' } }), PKG), false);
});

test('adding or removing a dependency is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0', { '@adlc/core': '1.5.0' }),
    pkg('1.5.1', { '@adlc/core': '1.5.1', evil: '^1.0.0' }), PKG), false);
  assert.equal(isVersionOnlyChange(pkg('1.5.0', { '@adlc/core': '1.5.0', chalk: '^5.0.0' }),
    pkg('1.5.1', { '@adlc/core': '1.5.1' }), PKG), false);
});

test('repinning a NON-@adlc dependency is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0', { chalk: '^5.0.0' }), pkg('1.5.1', { chalk: '^9.9.9' }), PKG), false);
});

test('changing a marketplace plugin source is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(marketplace('1.5.0', '1.5.0'), marketplace('1.5.1', '1.5.1', './EVIL'), MKT), false);
});

test('marketplace-only version paths are NOT accepted in a package.json', () => {
  const before = JSON.stringify({ version: '1.0.0', metadata: { version: '1.0.0' } }, null, 2) + '\n';
  const after = JSON.stringify({ version: '1.0.1', metadata: { version: '9.9.9' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
  assert.equal(isVersionOnlyChange(before, after, MKT), true);
});

// --------------------------------------------- lockstep is a real invariant

test('a dependency redirect with NO version change is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '^1.5.0' }),
    pkg('1.5.0', { '@adlc/core': '^9.0.0' }), PKG), false);
});

test('a repin that does not target the new version is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '^1.5.0' }),
    pkg('1.5.1', { '@adlc/core': '^9.9.9' }), PKG), false);
});

test('a repin to the manifest EXISTING version, with no bump, is NOT exempt', () => {
  // Kills the mutant that drops the `versionChanged` guard. The repin target
  // equals the manifest version, so the target comparison alone accepts it —
  // only "a version actually moved" rejects it. Real effect: @adlc/core is
  // redirected 0.9.0 -> 1.5.0 during a build that bumps nothing.
  const before = `{\n  "version": "1.5.0",\n  "dependencies": {\n    "@adlc/core": "^0.9.0"\n  }\n}\n`;
  const after  = `{\n  "version": "1.5.0",\n  "dependencies": {\n    "@adlc/core": "^1.5.0"\n  }\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('renaming another key INTO "version" is NOT exempt', () => {
  // Kills the mutant that drops the indent/key/comma comparison. Checking only
  // the AFTER key would see a well-formed version line and accept it, while the
  // BEFORE line was a different member entirely.
  const before = `{\n  "main": "1.5.0",\n  "x": 1\n}\n`;
  const after  = `{\n  "version": "1.5.1",\n  "x": 1\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('changing a trailing comma on a version line is NOT exempt', () => {
  const before = `{\n  "version": "1.5.0",\n  "x": 1\n}\n`;
  const after  = `{\n  "version": "1.5.1"\n  "x": 1\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('changing the operator STYLE is NOT exempt', () => {
  // exact -> caret widens what resolves; the release tool preserves style.
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '1.5.0' }),
    pkg('1.5.1', { '@adlc/core': '^1.5.1' }), PKG), false);
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '^1.5.0' }),
    pkg('1.5.1', { '@adlc/core': '~1.5.1' }), PKG), false);
});

// ------------------------------------- npm classification, not just grammar

test('a range npm reads as a dist-tag is NOT exempt', () => {
  // Empty prerelease identifier -> npm-package-arg says type=tag, so it resolves
  // to whatever that tag points at.
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '1.5.0' }),
    pkg('1.5.1', { '@adlc/core': '1.2.3-a..b' }), PKG), false);
});

test('versions beyond npm safe-integer and length limits are NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('9007199254740992.0.0'), PKG), false);
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg(`1.5.1-${'a'.repeat(266)}`), PKG), false);
});

test('malformed VERSIONS are NOT exempt, independently of any range', () => {
  // No dependencies here, so this can only be killed by version validation —
  // the earlier suite's equivalent was hollow because its fixture also violated
  // lockstep, so it passed even with the loose regex restored.
  for (const bad of ['01.2.3', '1.02.3', '1.2.3-', '1.2.3+', '1.2.3-alpha..1', '1.2.3+build..1', 'latest', '']) {
    assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg(bad), PKG), false, `version "${bad}" must not be exempt`);
  }
});

test('malformed RANGES are NOT exempt, at a version that satisfies lockstep', () => {
  // The range's target is otherwise lockstep-valid, so only range validation
  // can reject these.
  for (const bad of ['^01.5.1', '^1.5.1-', '^1.5.1-a..b', '>=1.5.1', '1.5.x', 'latest']) {
    assert.equal(isVersionOnlyChange(
      pkg('1.5.0', { '@adlc/core': '^1.5.0' }),
      pkg('1.5.1', { '@adlc/core': bad }), PKG), false, `range "${bad}" must not be exempt`);
  }
});

test('an invalid @adlc/ key is not a repin', () => {
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/': '1.5.0' }), pkg('1.5.1', { '@adlc/': '1.5.1' }), PKG), false);
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/foo/bar': '1.5.0' }), pkg('1.5.1', { '@adlc/foo/bar': '1.5.1' }), PKG), false);
});

// ------------------------------------------- structural / text-level integrity

test('inserting or deleting a line is NOT exempt', () => {
  const before = pkg('1.5.0');
  assert.equal(isVersionOnlyChange(before, before + '\n', PKG), false);
  assert.equal(isVersionOnlyChange(before, before.replace(/\n/g, '\n\n'), PKG), false);
});

test('renaming the key on a version line is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1').replace('"version"', '"versionX"'), PKG), false);
});

test('changing indentation on a version line is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1').replace('  "version"', '    "version"'), PKG), false);
});

test('a minified manifest is NOT exempt (no line structure to reason about)', () => {
  assert.equal(isVersionOnlyChange('{"version":"1.5.0"}', '{"version":"1.5.1"}', PKG), false);
});

test('parser-level collisions cannot help, because the parser is not consulted', () => {
  // Each of these defeated the previous JSON-walking implementations.
  const mk = (x) => `{\n  "version": "1.5.0",\n  "x": ${x}\n}\n`;
  const mk2 = (x) => `{\n  "version": "1.5.1",\n  "x": ${x}\n}\n`;
  assert.equal(isVersionOnlyChange(mk('1e400'), mk2('null'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('0'), mk2('-0'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('9007199254740992'), mk2('9007199254740993'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('1'), mk2('"1"'), PKG), false);
});

test('a duplicate key whose FIRST occurrence changes is NOT exempt', () => {
  const before = `{\n  "version": "1.5.0",\n  "main": "safe",\n  "main": "ok"\n}\n`;
  const after  = `{\n  "version": "1.5.1",\n  "main": "EVIL",\n  "main": "ok"\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('reordering object keys is NOT exempt — conditional exports are order-sensitive', () => {
  const before = `{\n  "version": "1.5.0",\n  "exports": {\n    "node": "./n.js",\n    "default": "./b.js"\n  }\n}\n`;
  const after  = `{\n  "version": "1.5.1",\n  "exports": {\n    "default": "./b.js",\n    "node": "./n.js"\n  }\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

// -------------------------------------------------------------------- fail closed

test('a missing side (added or deleted file) is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(null, pkg('1.5.0'), PKG), false);
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), null, PKG), false);
  assert.equal(isVersionOnlyChange(undefined, undefined, PKG), false);
});

test('no immutable trust root is eligible for the exemption', () => {
  for (const root of [
    '.adlc/config.json', '.adlc/tickets/.store.json', '.adlc/admin.pub',
    '.github/workflows/adlc-rails-guard.yml', 'CODEOWNERS', '.github/CODEOWNERS',
    'docs/CODEOWNERS', 'docs/ci/rails-guard.yml', 'scripts/rails-guard-ci.mjs',
    'scripts/test/rails-guard-workflow-hashes.json',
  ]) {
    assert.equal(isManifestFile(root), false, `${root} must not be exemptible`);
  }
});
