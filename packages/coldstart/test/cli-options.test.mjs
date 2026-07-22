// cli-options.test.mjs — exercises the REAL parseArgs default-resolution for
// coldstart's CLI options (not injected/mocked), so a mutation to a default
// value in lib/cli-options.mjs is actually caught (mutation-gate CI finding
// on PR #291: bin/coldstart.mjs's inline options object had zero test
// coverage for its own default values — force:true and max-age:'31' both
// survived mutation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '@adlc/core';
import { USAGE, OPTIONS, parseMaxAgeDays } from '../lib/cli-options.mjs';

test('--force defaults to false when omitted (caching stays ON by default)', () => {
  const { values } = parseArgs({ options: OPTIONS, args: ['T1'] });
  assert.equal(values.force, false);
});

test('--force is true when the flag is passed', () => {
  const { values } = parseArgs({ options: OPTIONS, args: ['T1', '--force'] });
  assert.equal(values.force, true);
});

test('--max-age defaults to "30" (days) when omitted', () => {
  const { values } = parseArgs({ options: OPTIONS, args: ['T1'] });
  assert.equal(values['max-age'], '30');
});

test('--max-age is overridable', () => {
  const { values } = parseArgs({ options: OPTIONS, args: ['T1', '--max-age', '7'] });
  assert.equal(values['max-age'], '7');
});

test('other existing defaults are unchanged (tickets path, tier, all, prompt-only, json)', () => {
  const { values } = parseArgs({ options: OPTIONS, args: ['T1'] });
  assert.equal(values.tickets, '.adlc/tickets.json');
  assert.equal(values.tier, 'cheap');
  assert.equal(values.all, false);
  assert.equal(values['prompt-only'], false);
  assert.equal(values.json, false);
});

test('USAGE documents every flag the options config actually declares', () => {
  for (const flag of Object.keys(OPTIONS)) {
    assert.match(USAGE, new RegExp(`--${flag}\\b`), `USAGE string is missing --${flag}`);
  }
  assert.match(USAGE, /--force/);
  assert.match(USAGE, /--max-age <days>/);
});

// ── parseMaxAgeDays ─────────────────────────────────────────────────────────

test('parseMaxAgeDays: "0" is VALID — "treat every cache entry as stale", not an error', () => {
  const result = parseMaxAgeDays('0');
  assert.equal(result.ok, true);
  assert.equal(result.maxAgeMs, 0);
});

test('parseMaxAgeDays: "30" (the default) converts to 30 days in ms', () => {
  const result = parseMaxAgeDays('30');
  assert.equal(result.ok, true);
  assert.equal(result.maxAgeMs, 30 * 24 * 60 * 60 * 1000);
});

test('parseMaxAgeDays: "1" converts to exactly one day in ms (boundary against an off-by-one)', () => {
  const result = parseMaxAgeDays('1');
  assert.equal(result.ok, true);
  assert.equal(result.maxAgeMs, 24 * 60 * 60 * 1000);
});

test('parseMaxAgeDays: a negative number is rejected', () => {
  const result = parseMaxAgeDays('-1');
  assert.equal(result.ok, false);
  assert.match(result.error, /--max-age must be a non-negative number of days/);
});

test('parseMaxAgeDays: a non-numeric string is rejected', () => {
  const result = parseMaxAgeDays('abc');
  assert.equal(result.ok, false);
  assert.match(result.error, /--max-age must be a non-negative number of days/);
});

test('parseMaxAgeDays: "Infinity" is rejected, not silently treated as "no limit"', () => {
  assert.equal(parseMaxAgeDays('Infinity').ok, false);
});

test('parseMaxAgeDays: "NaN" and other unparseable text are rejected', () => {
  assert.equal(parseMaxAgeDays('NaN').ok, false);
  assert.equal(parseMaxAgeDays('thirty').ok, false);
});
