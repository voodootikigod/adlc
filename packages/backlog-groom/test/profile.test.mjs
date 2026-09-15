// profile.test.mjs — AC21.
//
// The profile is the one machine-parsed config in this package, and §2.1 makes
// it fail closed for the same reason model-router's floor does: a config that
// silently ignores what it does not understand hands the operator a setting they
// believe is in force and is not. A typo'd key is therefore an error, never a
// shrug.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROFILE, parseProfile } from '../lib/profile.mjs';

/**
 * Return the error a thunk threw. `assert.throws` returns undefined, so it
 * cannot be used to inspect the error it caught; this keeps the assertions
 * about `isOpError` and the message honest.
 */
function caught(fn, why) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(why ?? 'expected the call to throw, and it did not');
}

test('AC21: every key except schemaVersion is optional and has its documented default', () => {
  const p = parseProfile({ schemaVersion: 1 });
  assert.deepEqual(p.autonomyFloor, ['close'], 'omitted floor is the conservative default, not permissive');
  assert.deepEqual(p.units, []);
  assert.deepEqual(p.frozenPaths, []);
  assert.equal(p.labels.areaPrefix, 'area:');
  assert.deepEqual(p.labels.priority, { high: 'P1-high', medium: 'P2-medium', low: 'P3-low' });
  assert.deepEqual(p.providers, {});
});

test('AC21: an unknown top-level key is an operational error naming the key', () => {
  const err = caught(() => parseProfile({ schemaVersion: 1, autonmyFloor: [] }));
  assert.equal(err.isOpError, true, 'must be an operational error, not a generic throw');
  assert.match(err.message, /autonmyFloor/, 'the message must name the offending key so a typo is findable');
});

test('AC21: an unknown NESTED key is an error too — a typo under labels or providers is the same hazard', () => {
  const labels = caught(() => parseProfile({ schemaVersion: 1, labels: { areaPrefix: 'area:', aeraPrefix: 'x' } }));
  assert.equal(labels.isOpError, true);
  assert.match(labels.message, /aeraPrefix/);

  const providers = caught(() => parseProfile({ schemaVersion: 1, providers: { decider: 'anthropic', reviewr: 'openai' } }));
  assert.equal(providers.isOpError, true);
  assert.match(providers.message, /reviewr/);

  const priority = caught(() => parseProfile({ schemaVersion: 1, labels: { priority: { high: 'P1', urgent: 'P0' } } }));
  assert.equal(priority.isOpError, true);
  assert.match(priority.message, /urgent/);
});

test('AC21: schemaVersion is required and must be a known version', () => {
  const missing = caught(() => parseProfile({}));
  assert.equal(missing.isOpError, true);
  assert.match(missing.message, /schemaVersion/);

  const unknown = caught(() => parseProfile({ schemaVersion: 99 }));
  assert.equal(unknown.isOpError, true);
  assert.match(unknown.message, /99/, 'the message must state the version it got');

  // A version that is a string, or a float, is not version 1.
  for (const bad of ['1', 1.5, null, true]) {
    const e = caught(() => parseProfile({ schemaVersion: bad }), `schemaVersion ${JSON.stringify(bad)} must be refused`);
    assert.equal(e.isOpError, true);
  }
});

test('AC21: a non-object profile is an operational error, not a crash', () => {
  for (const bad of [null, undefined, [], 'x', 3]) {
    const e = caught(() => parseProfile(bad), `profile ${JSON.stringify(bad)} must be refused`);
    assert.equal(e.isOpError, true);
  }
});

test('AC21: supplied values are taken verbatim and never merged field-wise into a default', () => {
  // A half-supplied `labels` must not silently inherit the missing half from the
  // default: an operator who writes one priority mapping has told us their whole
  // mapping, and quietly adding P2-medium back would invent a label they never
  // declared.
  const p = parseProfile({
    schemaVersion: 1,
    labels: { priority: { high: 'sev1' } },
  });
  assert.deepEqual(p.labels.priority, { high: 'sev1' }, 'the supplied mapping stands alone');
  assert.equal(p.labels.areaPrefix, 'area:', 'a sibling key still defaults independently');
});

test('AC21: the parsed profile is a fresh object — parsing twice cannot share mutable state', () => {
  const a = parseProfile({ schemaVersion: 1 });
  const b = parseProfile({ schemaVersion: 1 });
  a.autonomyFloor.push('relabel');
  assert.deepEqual(b.autonomyFloor, ['close'], 'one parse must not contaminate the next');
  assert.deepEqual(DEFAULT_PROFILE.autonomyFloor, ['close'], 'nor the exported default itself');
});

test('AC21: autonomyFloor is carried through verbatim — validation of its members belongs to the write path', () => {
  // This half parses the floor; it does not enforce it. An explicitly empty
  // floor is legal per §3.7 and must survive parsing so the write path can see
  // that it was written deliberately rather than omitted.
  assert.deepEqual(parseProfile({ schemaVersion: 1, autonomyFloor: [] }).autonomyFloor, []);
  assert.deepEqual(parseProfile({ schemaVersion: 1, autonomyFloor: ['close', 'relabel'] }).autonomyFloor, ['close', 'relabel']);
});

test('AC21: every priority band is a known key — high, medium and low all parse', () => {
  // Dropping a band from the known set would make a legitimate mapping an
  // error, and `low` is the band 166 of this repo's issues actually carry.
  const p = parseProfile({ schemaVersion: 1, labels: { priority: { high: 'H', medium: 'M', low: 'L' } } });
  assert.deepEqual(p.labels.priority, { high: 'H', medium: 'M', low: 'L' });
});

test('AC21: both provider roles are known keys — decider and reviewer', () => {
  // `reviewer` dropping out of the known set would make a correct profile an
  // error, and it is the key the write path needs to require a distinct reviewer.
  const p = parseProfile({ schemaVersion: 1, providers: { decider: 'anthropic', reviewer: 'openai' } });
  assert.deepEqual(p.providers, { decider: 'anthropic', reviewer: 'openai' });
});

test('AC21: a malformed UNIT is refused — a pathsx typo must not silently disable a unit', () => {
  // Raised in cross-model review. Validating only that `units` is an array let a
  // typo through: the unit matched nothing, its issues fell out of every cluster,
  // its area relabel proposals were suppressed, and the run still looked healthy.
  const typo = caught(() => parseProfile({ schemaVersion: 1, units: [{ name: 'x', pathsx: ['a/**'] }] }));
  assert.equal(typo.isOpError, true);
  assert.match(typo.message, /pathsx/);

  for (const bad of [
    { units: [{ name: 'x' }] },
    { units: [{ name: 'x', paths: [] }] },
    { units: [{ paths: ['a/**'] }] },
    { units: [{ name: '', paths: ['a/**'] }] },
    { units: [{ name: 'x', paths: [42] }] },
    { units: ['not an object'] },
  ]) {
    const e = caught(() => parseProfile({ schemaVersion: 1, ...bad }), `${JSON.stringify(bad)} must be refused`);
    assert.equal(e.isOpError, true, `${JSON.stringify(bad)} must be an operational error`);
  }

  assert.doesNotThrow(() => parseProfile({ schemaVersion: 1, units: [{ name: 'x', paths: ['a/**'] }] }));
});

test('AC21: frozenPaths and autonomyFloor must hold non-empty strings', () => {
  for (const bad of [{ frozenPaths: [1] }, { frozenPaths: [''] }, { autonomyFloor: [null] }]) {
    const e = caught(() => parseProfile({ schemaVersion: 1, ...bad }));
    assert.equal(e.isOpError, true, `${JSON.stringify(bad)} must be refused`);
  }
});

test('AC21: an empty areaPrefix is refused — it would make every label look like the area label', () => {
  // Raised in cross-model review. With an empty prefix, `bug` reads as the area
  // label, so a proposal would name an unrelated label as the one to replace and
  // a consumer applying it would overwrite something it was never about.
  const e = caught(() => parseProfile({ schemaVersion: 1, labels: { areaPrefix: '' } }));
  assert.equal(e.isOpError, true);
  assert.match(e.message, /areaPrefix/);
  assert.equal(caught(() => parseProfile({ schemaVersion: 1, labels: { areaPrefix: 42 } })).isOpError, true);
});

test('AC21: priority labels must be non-empty strings, and unique across bands', () => {
  // Two bands mapping to one label makes a relabel proposal meaningless: `from`
  // and `to` would be the same string.
  assert.equal(caught(() => parseProfile({ schemaVersion: 1, labels: { priority: { high: '' } } })).isOpError, true);
  assert.equal(caught(() => parseProfile({ schemaVersion: 1, labels: { priority: { high: 1 } } })).isOpError, true);
  const dup = caught(() => parseProfile({ schemaVersion: 1, labels: { priority: { high: 'P1', medium: 'P1' } } }));
  assert.equal(dup.isOpError, true);
  assert.match(dup.message, /more than one band/);
});

test('AC21: a provider role must name a non-empty string', () => {
  assert.equal(caught(() => parseProfile({ schemaVersion: 1, providers: { decider: '' } })).isOpError, true);
});
