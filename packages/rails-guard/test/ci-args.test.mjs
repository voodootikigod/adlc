// Argument resolution for `adlc rails-guard-ci` (#140).
//
// Base-ref resolution is load-bearing, not cosmetic: pick the wrong ref and the gate
// diffs against the wrong tree. The dangerous direction is silent — an unfetched or
// mistyped base looks like "no rails declared", which is a fail-OPEN. These pin the
// resolution order and pin that an unknown flag is an error rather than a no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBase, parseArgs } from '../lib/ci/args.mjs';

test('defaultBase prefers RAILS_BASE over the Actions BASE_REF shape', () => {
  assert.equal(defaultBase({ RAILS_BASE: 'upstream/release', BASE_REF: 'main' }), 'upstream/release');
});

test('defaultBase turns the Actions BASE_REF branch name into a remote-tracking ref', () => {
  // GitHub supplies a BARE branch name. The workflow's fetch step creates
  // refs/remotes/origin/<branch>, so the origin/ prefix is what actually resolves.
  assert.equal(defaultBase({ BASE_REF: 'release-2' }), 'origin/release-2');
});

test('defaultBase falls back to origin/main when nothing is set', () => {
  assert.equal(defaultBase({}), 'origin/main');
});

test('an explicit --base wins over every environment default', () => {
  const parsed = parseArgs(['--base', 'origin/other'], { RAILS_BASE: 'origin/ignored', BASE_REF: 'main' });
  assert.equal(parsed.base, 'origin/other');
  assert.equal(parsed.command, 'rail-freeze');
});

test('the bootstrap subcommand is recognized and still resolves a base', () => {
  const parsed = parseArgs(['bootstrap'], { BASE_REF: 'main' });
  assert.equal(parsed.command, 'bootstrap');
  assert.equal(parsed.base, 'origin/main');
});

test('--trust-root is repeatable and order-preserving', () => {
  const parsed = parseArgs(['--trust-root', 'a.mjs', '--trust-root', 'b/**'], {});
  assert.deepEqual(parsed.trustRoots, ['a.mjs', 'b/**']);
});

test('bootstrap accepts --base after the subcommand', () => {
  const parsed = parseArgs(['bootstrap', '--base', 'origin/x'], {});
  assert.equal(parsed.command, 'bootstrap');
  assert.equal(parsed.base, 'origin/x');
});

// An unknown flag must NOT be silently ignored. A misspelled --trust-root would quietly
// narrow the frozen set, which is the failure mode this gate exists to prevent.
test('an unrecognized argument is an error, not a silently dropped flag', () => {
  const parsed = parseArgs(['--trust-roots', 'a.mjs'], {});
  assert.match(parsed.error, /unrecognized argument: --trust-roots/);
  assert.equal(parsed.base, undefined, 'an errored parse must not present a usable base');
});

test('a value-less --base is an error rather than an undefined ref', () => {
  assert.match(parseArgs(['--base'], {}).error, /--base requires a ref/);
});

test('a value-less --trust-root is an error rather than a dropped entry', () => {
  assert.match(parseArgs(['--trust-root'], {}).error, /--trust-root requires a path/);
});

test('--help short-circuits before any base resolution', () => {
  assert.equal(parseArgs(['--help'], {}).command, 'help');
  assert.equal(parseArgs(['-h'], {}).command, 'help');
  assert.equal(parseArgs(['bootstrap', '--help'], {}).command, 'help');
});
