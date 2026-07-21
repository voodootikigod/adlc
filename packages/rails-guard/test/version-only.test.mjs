// version-only.test.mjs — #228: a lockstep version bump must not read as a rail edit.
//
// The exemption requires each side to be its own canonical re-serialisation,
// then compares by structural PATH — see the header of lib/version-only.mjs for
// why neither parsing alone nor comparing text alone was sufficient. Fixtures
// are therefore written exactly as JSON.stringify(obj, null, 2) produces them,
// because that is canonical form and what scripts/release.mjs writes.
//
// Most tests below assert `false`. That is deliberate: a change which merely
// weakened the guard would satisfy "the release is unblocked" while silently
// unfreezing real code, so the negative cases are the ones carrying the weight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // NOTE what actually rejects this: the completeness pass, which requires every
  // baseline range to equal the baseline version (^0.9.0 does not equal 1.5.0).
  // This test previously claimed to kill the `versionChanged` mutant; it does
  // not, and saying so was the same hollow-test failure in comment form. That
  // guard is now redundant and is documented as such at its definition.
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

test('duplicate top-level version members are NOT exempt', () => {
  // Duplicates cannot survive the canonical round trip, so this is rejected at
  // the precondition and no target is ever selected. An earlier version of this
  // test claimed the LAST duplicate is chosen as the lockstep target, which
  // described the line-based design that no longer exists.
  const b = `{\n  "version": "9.9.9",\n  "version": "1.5.0",\n  "dependencies": {\n    "@adlc/core": "^1.5.0"\n  }\n}\n`;
  const a = `{\n  "version": "9.9.9",\n  "version": "1.5.1",\n  "dependencies": {\n    "@adlc/core": "^9.9.9"\n  }\n}\n`;
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('a CRLF manifest is NOT exempt', () => {
  // \r survives the newline split, so no line parses as a plain member. Denying
  // is the safe direction; the release tool writes LF.
  assert.equal(isVersionOnlyChange('{\r\n  "version": "1.5.0"\r\n}\r\n', '{\r\n  "version": "1.5.1"\r\n}\r\n', PKG), false);
});

test('escaped quotes in a value cannot desync the member regex', () => {
  const b = `{\n  "version": "1.5.0",\n  "x": "a\\": \\"b"\n}\n`;
  const a = `{\n  "version": "1.5.1",\n  "x": "a\\": \\"EVIL"\n}\n`;
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
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

// ------------------------------- regressions from cross-model round 3
// Round 3 rejected the line-based design: text cannot see structure. These pin
// the three bypasses it reproduced, all of which the canonical-form precondition
// plus path-based comparison now deny.

test('scripts.version is a LIFECYCLE COMMAND, not the package version', () => {
  // The line-based check read indentation as structure, so a "version" member
  // nested inside `scripts` looked top-level. Changing it changes what runs on
  // `npm version`, while the package version does not move at all.
  const b = JSON.stringify({ version: '1.5.0', scripts: { version: '1.5.0' } }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.0', scripts: { version: '1.5.1' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('a duplicate top-level version cannot manufacture a "version changed"', () => {
  // Duplicates cannot survive the canonical round trip, so this denies at the
  // precondition. Under last-member semantics the effective version here is
  // UNCHANGED while the dependency redirects — it must never be exempt.
  const b = `{\n  "version": "1.5.0",\n  "version": "9.9.9",\n  "dependencies": {\n    "@adlc/core": "^1.5.0"\n  }\n}\n`;
  const a = `{\n  "version": "9.9.9",\n  "version": "9.9.9",\n  "dependencies": {\n    "@adlc/core": "^9.9.9"\n  }\n}\n`;
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('an @adlc key outside a dependency field is NOT a repin', () => {
  // `config["@adlc/core"]` is data a consumer can read, not a dependency.
  const b = JSON.stringify({ version: '1.5.0', config: { '@adlc/core': '^0.1.0' } }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.1', config: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('an @adlc key outside a dependency field is NOT a repin, even when lockstep-valid', () => {
  // The neighbouring test is MASKED: its value also violates lockstep, so the
  // baseline check rejects it whether or not dependency-field scoping exists.
  // This one is lockstep-perfect, so only the enclosing-field check can deny it.
  const b = JSON.stringify({ version: '1.5.0', config: { '@adlc/core': '^1.5.0' } }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.1', config: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('adding an EMPTY container is NOT exempt — it changes no leaf at all', () => {
  // Only the container-shape record can see this; every leaf comparison agrees.
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1', {}, { scripts: {} }), PKG), false);
  assert.equal(isVersionOnlyChange(pkg('1.5.0'), pkg('1.5.1', {}, { workspaces: [] }), PKG), false);
});

test('removing an EMPTY container is NOT exempt', () => {
  assert.equal(isVersionOnlyChange(pkg('1.5.0', {}, { scripts: {} }), pkg('1.5.1'), PKG), false);
});

test('lockstep is checked on the BASELINE side too', () => {
  // ^0.1.0 -> ^1.5.1 during a genuine bump crosses a major-resolution boundary.
  // Checking only the new target accepted it; the old range must equal the old
  // version, exactly as release.mjs writes it.
  assert.equal(isVersionOnlyChange(
    pkg('1.5.0', { '@adlc/core': '^0.1.0' }),
    pkg('1.5.1', { '@adlc/core': '^1.5.1' }), PKG), false);
});

test('marketplace version paths are matched STRUCTURALLY, not by indentation', () => {
  // A nested `version` that is not metadata.version or plugins[i].version is not
  // eligible even in a marketplace manifest.
  const b = JSON.stringify({ metadata: { version: '1.5.0' }, other: { version: '1.5.0' } }, null, 2) + '\n';
  const a = JSON.stringify({ metadata: { version: '1.5.1' }, other: { version: '1.5.1' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, MKT), false);
});

// ------------------------------------------- the canonical-form precondition

test('a non-canonical manifest is NOT exempt on either side', () => {
  const canonical = pkg('1.5.0');
  const bumped = pkg('1.5.1');
  // 4-space indent, tabs, and no trailing newline are all non-canonical.
  assert.equal(isVersionOnlyChange(JSON.stringify(JSON.parse(canonical), null, 4) + '\n', bumped, PKG), false);
  assert.equal(isVersionOnlyChange(canonical, JSON.stringify(JSON.parse(bumped), null, 4) + '\n', PKG), false);
  assert.equal(isVersionOnlyChange(canonical.trimEnd(), bumped.trimEnd(), PKG), false);
});

test('the precondition is what makes parse fidelity safe to rely on', () => {
  // Each of these defeated the JSON-walking design. They now fail the canonical
  // round trip before any comparison happens.
  const mk = (v, x) => `{\n  "version": "${v}",\n  "x": ${x}\n}\n`;
  assert.equal(isVersionOnlyChange(mk('1.5.0', '1e400'), mk('1.5.1', 'null'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('1.5.0', '-0'), mk('1.5.1', '0'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('1.5.0', '9007199254740993'), mk('1.5.1', '9007199254740992'), PKG), false);
});

test('the precondition rejects every form JSON.parse would misrepresent', () => {
  // This is the property the whole design rests on: if a document survives the
  // canonical round trip, its parse is a faithful account of its bytes. Each
  // input here is one the parser would silently alter, and each must be refused
  // BEFORE any comparison — so pairing it with an ordinary version bump must
  // still deny.
  const bump = (body) => `{\n  "version": "1.5.1",\n${body}\n}\n`;
  const base = (body) => `{\n  "version": "1.5.0",\n${body}\n}\n`;
  const lossy = [
    ['duplicate keys', '  "a": 1,\n  "a": 2'],
    ['precision-losing integer', '  "a": 9007199254740993'],
    ['negative zero', '  "a": -0'],
    ['overflow to Infinity', '  "a": 1e400'],
    ['exponent form', '  "a": 1e2'],
    ['trailing-zero float', '  "a": 1.0'],
    ['escaped key', '  "\\u0061": 1'],
    ['escaped value character', '  "a": "\\u0062"'],
  ];
  for (const [label, body] of lossy) {
    assert.equal(isVersionOnlyChange(base(body), bump(body), PKG), false, `${label} must not be exempt`);
  }
});

// -------------------------------- regressions from cross-model round 4

test('LOCKSTEP IS COMPLETE — an unchanged internal range still has to be right', () => {
  // Only inspecting ranges that CHANGED let a package finish a bump declaring
  // 1.5.1 while still depending on 1.5.0 of a sibling. Every internal range is
  // checked now, changed or not.
  const before = pkg('1.5.0', { '@adlc/core': '1.5.0', '@adlc/tickets': '1.5.0' });
  // @adlc/tickets left behind at the old version.
  const after = pkg('1.5.1', { '@adlc/core': '1.5.1', '@adlc/tickets': '1.5.0' });
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('a version bump that repins NOTHING is not a lockstep bump', () => {
  const before = pkg('1.5.0', { '@adlc/core': '1.5.0' });
  const after = pkg('1.5.1', { '@adlc/core': '1.5.0' });
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('completeness is checked on the BASELINE side, not only the result', () => {
  // The neighbouring tests all leave the AFTER side wrong, so an implementation
  // that inspected only `after` would pass every one of them. Here the after
  // side is internally consistent — version 1.6.0, dependency 1.6.0 — and the
  // defect is entirely in the baseline: it was already declaring 1.5.0 while
  // depending on 1.6.0. Only checking both halves rejects this.
  const before = `{\n  "version": "1.5.0",\n  "dependencies": {\n    "@adlc/core": "1.6.0"\n  }\n}\n`;
  const after  = `{\n  "version": "1.6.0",\n  "dependencies": {\n    "@adlc/core": "1.6.0"\n  }\n}\n`;
  assert.equal(isVersionOnlyChange(before, after, PKG), false);
});

test('a bump with no internal dependencies at all is still exempt', () => {
  // The completeness check must not require ranges that do not exist.
  assert.equal(isVersionOnlyChange(pkg('1.5.0', { chalk: '^5.0.0' }), pkg('1.5.1', { chalk: '^5.0.0' }), PKG), true);
});

test('plugins[i].version requires plugins to be a REAL array', () => {
  // A numeric-looking key is not an index. The container-kind record cannot
  // catch this because the shape is identical on both sides — wrong in both.
  const b = JSON.stringify({ plugins: { 0: { version: '1.5.0' } } }, null, 2) + '\n';
  const a = JSON.stringify({ plugins: { 0: { version: '1.5.1' } } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, MKT), false);
  // The genuine array form is still exempt.
  const bArr = JSON.stringify({ plugins: [{ version: '1.5.0' }] }, null, 2) + '\n';
  const aArr = JSON.stringify({ plugins: [{ version: '1.5.1' }] }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(bArr, aArr, MKT), true);
});

test('a string that cannot re-encode to itself is NOT exempt', () => {
  // NOTE what actually rejects this: canonical equality. `JSON.stringify`
  // escapes a lone surrogate, so the round trip differs from the input. The
  // re-encode guard is therefore redundant here rather than pinned by this test.
  // The real lossy-decode problem cannot be caught at this layer at all — a
  // string already holding U+FFFD re-encodes perfectly — and is handled at the
  // byte boundary in bin/rails-guard.mjs, covered in version-only-e2e.test.mjs.
  const withSurrogate = (v) => `{\n  "version": "${v}",\n  "d": "\uD800"\n}\n`;
  assert.equal(isVersionOnlyChange(withSurrogate('1.5.0'), withSurrogate('1.5.1'), PKG), false);
});

test('every REAL manifest in this repo is canonical', () => {
  // The precondition is only free because this holds. If release.mjs ever stops
  // writing JSON.stringify(o, null, 2) — or someone hand-edits a manifest — every
  // release starts failing the gate, and this says so here rather than
  // mid-release.
  //
  // An earlier version of this test asserted the property of a SYNTHETIC fixture
  // built with JSON.stringify, which is a tautology: it would have stayed green
  // while every real manifest went non-canonical. Cross-model review caught that
  // the ADR's claim about it was therefore false. It now reads the real files.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const manifests = [];
  for (const dir of ['packages', 'plugins']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(base, entry.name, 'package.json');
      if (existsSync(p)) manifests.push(p);
    }
  }
  assert.ok(manifests.length >= 20, `expected to find the real manifests, found ${manifests.length}`);

  const offenders = manifests.filter((p) => {
    const text = readFileSync(p, 'utf8');
    try {
      return JSON.stringify(JSON.parse(text), null, 2) + '\n' !== text;
    } catch {
      return true;
    }
  });
  assert.deepEqual(offenders.map((p) => p.slice(root.length + 1)), [],
    'these manifests are not canonical and would fail the version-only exemption');
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

test('container KIND is part of the shape record', () => {
  // An array and an object with numeric keys are different documents. Both are
  // canonical, so only the recorded kind distinguishes them.
  const b = JSON.stringify({ version: '1.5.0', x: ['a'] }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.1', x: { 0: 'a' } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('an @adlc range NESTED below a dependency field is not a repin', () => {
  // The path must be exactly [depField, name] — two levels. Anything deeper is
  // some other structure that merely contains a matching key.
  const b = JSON.stringify({ version: '1.5.0', dependencies: { nested: { '@adlc/core': '^1.5.0' } } }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.1', dependencies: { nested: { '@adlc/core': '^1.5.1' } } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

test('a non-object dependency field is NOT exempt', () => {
  const b = JSON.stringify({ version: '1.5.0', dependencies: ['@adlc/core'] }, null, 2) + '\n';
  const a = JSON.stringify({ version: '1.5.1', dependencies: ['@adlc/core'] }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(b, a, PKG), false);
});

// ------------------------------- round-6 coverage gaps, found by mutation

test('EACH dependency field is covered by the completeness pass', () => {
  // Removing any single field from DEP_FIELDS previously left the whole suite
  // green. There are no internal ranges in the other three fields today, but the
  // release tool and this ADR both promise to handle them, so each is pinned
  // independently rather than relying on `dependencies` to stand for all four.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const mk = (v, dep) => JSON.stringify({ version: v, [field]: { '@adlc/core': dep } }, null, 2) + '\n';
    assert.equal(isVersionOnlyChange(mk('1.5.0', '1.5.0'), mk('1.5.1', '1.5.1'), PKG), true,
      `${field}: a genuine lockstep repin must stay exempt`);
    assert.equal(isVersionOnlyChange(mk('1.5.0', '1.5.0'), mk('1.5.1', '1.5.0'), PKG), false,
      `${field}: a range left behind must deny`);
    assert.equal(isVersionOnlyChange(mk('1.5.0', '1.5.0'), mk('1.5.1', '9.9.9'), PKG), false,
      `${field}: a redirected range must deny`);
  }
});

test('a malformed MARKETPLACE version is rejected by value validation', () => {
  // The package-manifest malformed-version fixtures are all rejected later by
  // the completeness pass, so they do not pin the eligible-value check. A
  // marketplace manifest has no dependency fields, so nothing else can reject
  // this one.
  const mk = (v) => JSON.stringify({ metadata: { version: v } }, null, 2) + '\n';
  for (const bad of ['01.5.1', '1.5.1-', 'latest', '1.5']) {
    assert.equal(isVersionOnlyChange(mk('1.5.0'), mk(bad), MKT), false, `marketplace version "${bad}"`);
  }
  assert.equal(isVersionOnlyChange(mk('1.5.0'), mk('1.5.1'), MKT), true);
});

test('a non-object JSON document is NOT exempt', () => {
  // The exported predicate's contract, independent of the structural checks that
  // shadow it for ordinary documents.
  assert.equal(isVersionOnlyChange('[]\n', '[]\n', PKG), false);
  assert.equal(isVersionOnlyChange('"s"\n', '"s"\n', PKG), false);
  assert.equal(isVersionOnlyChange('null\n', 'null\n', PKG), false);
  assert.equal(isVersionOnlyChange('1\n', '2\n', PKG), false);
});

test('a dependency RANGE beyond npm limits is NOT exempt', () => {
  // NOTE what rejects this: the top-level VERSION check, not splitRange. The
  // fixture moves both together because lockstep requires a range to equal the
  // manifest version, which makes splitRange's own isVersion call unreachable —
  // documented as such at its definition. This test pins the outcome, not that
  // guard.
  const mk = (v, dep) => JSON.stringify({ version: v, dependencies: { '@adlc/core': dep } }, null, 2) + '\n';
  assert.equal(isVersionOnlyChange(mk('1.5.0', '^1.5.0'), mk('9007199254740992.0.0', '^9007199254740992.0.0'), PKG), false);
  assert.equal(isVersionOnlyChange(mk('1.5.0', '^1.5.0'), mk(`1.5.1-${'a'.repeat(266)}`, `^1.5.1-${'a'.repeat(266)}`), PKG), false);
});

test('npm MAX_LENGTH is an exact boundary, not an approximate one', () => {
  // Found by the mutation gate: changing MAX_LENGTH from 256 to 257 survived the
  // whole suite, because the nearest fixture used a 266-character version and
  // could not tell the two limits apart. npm classifies anything over 256 as a
  // dist-tag, so the boundary itself is load-bearing.
  const mk = (v) => JSON.stringify({ metadata: { version: v } }, null, 2) + '\n';
  const at256 = `1.5.1-${'a'.repeat(250)}`;   // exactly 256
  const at257 = `1.5.1-${'a'.repeat(251)}`;   // one over
  assert.equal(at256.length, 256);
  assert.equal(at257.length, 257);
  assert.equal(isVersionOnlyChange(mk('1.5.0'), mk(at256), MKT), true, '256 chars is a version');
  assert.equal(isVersionOnlyChange(mk('1.5.0'), mk(at257), MKT), false, '257 chars is a dist-tag');
});
