// usage.test.mjs — the CLI's documented surface.
//
// Help text written as one prose literal can only be asserted against itself,
// which is a source-text test and worth nothing. Rendering it from the flag
// table makes it a function of the option set, so these assertions are about
// behaviour: every flag the CLI accepts is documented, and each one that takes a
// value says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FLAGS, renderUsage, validateThreshold, validateApplyArgs, describeError } from '../lib/usage.mjs';

/** Return the error a thunk threw; `assert.throws` returns undefined. */
function caughtUsage(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
}

test('every flag is documented, and value-taking flags show their placeholder', () => {
  const usage = renderUsage();
  for (const f of FLAGS) {
    assert.match(usage, new RegExp(`--${f.name}\\b`), `--${f.name} is undocumented`);
    if (f.arg) assert.ok(usage.includes(`--${f.name} <${f.arg}>`), `--${f.name} must show <${f.arg}>`);
    else assert.ok(!usage.includes(`--${f.name} <`), `--${f.name} takes no value and must not show one`);
  }
});

test('the placeholder is angle-bracketed — the convention the rest of the toolkit uses', () => {
  const usage = renderUsage([{ name: 'x', arg: 'path', help: 'h' }]);
  assert.match(usage, /--x <path>/);
});

test('help states plainly that the command never writes to GitHub', () => {
  // The read-only boundary is the whole reason this half can run unattended.
  assert.match(renderUsage(), /never writes to GitHub/);
});

test('the usage block separates its header from the flag list with a blank line', () => {
  // Rendered layout, not prose: the flag list must be visually distinct from the
  // summary line or the help reads as one wall of text.
  const lines = renderUsage([{ name: 'x', arg: null, help: 'h' }]).split('\n');
  assert.match(lines[0], /backlog-groom/);
  assert.equal(lines[1], '', 'a blank line must follow the header');
  assert.match(lines[2], /--x/);
});

test('--threshold accepts both boundaries: 0 grooms every pair, 1 grooms none', () => {
  // Both ends are legal and meaningful, so the comparison must be inclusive at
  // each. A gate that rejected 0 or 1 would rule out the two settings an
  // operator reaches for when calibrating the filter.
  assert.equal(validateThreshold('0'), 0);
  assert.equal(validateThreshold('1'), 1);
  assert.equal(validateThreshold('0.2'), 0.2);
});

test('--threshold rejects anything outside 0..1, and non-numbers, naming what it got', () => {
  for (const bad of ['-0.1', '1.1', '5', 'abc', '', 'NaN', 'Infinity']) {
    const err = caughtUsage(() => validateThreshold(bad));
    assert.equal(err.isOpError, true, `${JSON.stringify(bad)} must be an operational error`);
    assert.ok(err.message.includes(String(bad)), 'the message names the value it got');
  }
});

test('a flag longer than the help column still gets a separating space', () => {
  // padEnd collapses to nothing once the flag outgrows the column, and the help
  // then abuts the flag name — reading as one longer flag that does not exist.
  const usage = renderUsage([{ name: 'a-very-long-flag-name-indeed', arg: null, help: 'HELPTEXT' }]);
  assert.ok(!usage.includes('indeedHELPTEXT'), 'help must not abut the flag name');
  assert.match(usage, /--a-very-long-flag-name-indeed\s+HELPTEXT/);
});

test('short flags align their help at a fixed column', () => {
  // The column is the POINT of padding — help that starts wherever each flag
  // happens to end is not a table. Pinned exactly, so the column constant is
  // observable rather than free to drift.
  const usage = renderUsage([
    { name: 'a', arg: null, help: 'AAA' },
    { name: 'bbb', arg: 'x', help: 'BBB' },
  ]);
  const [l1, l2] = usage.split('\n').filter((l) => l.includes('AAA') || l.includes('BBB'));
  assert.equal(l1.indexOf('AAA'), l2.indexOf('BBB'), 'both help strings must start at the same column');
  assert.equal(l1.indexOf('AAA'), 24, 'two leading spaces plus a 22-character flag column');
});

test('a flag that overruns the column is separated by exactly one space', () => {
  // Not "at least one": an overrun flag that kept padding to some larger column
  // would silently re-align the whole table around its longest entry.
  const usage = renderUsage([{ name: 'x'.repeat(30), arg: null, help: 'HELP' }]);
  const line = usage.split('\n').find((l) => l.includes('HELP'));
  assert.match(line, /^ {2}--x+ HELP$/, 'exactly one space between an overrun flag and its help');
});

// ---- the --apply guard, out of the binary ----------------------------------

test('--apply without --set is refused, and the message names the flag and its value', () => {
  // Naming the flag is not enough to act on: an operator who reads "--set" still
  // has to guess whether it takes a value. The message has to carry the
  // placeholder, so it is asserted whole rather than by substring.
  assert.equal(validateApplyArgs({ apply: true }), '--apply requires --set <path> — the groomed set to act on');
});

test('--apply with --set is accepted', () => {
  assert.equal(validateApplyArgs({ apply: true, set: 'groomed.json' }), null);
});

test('without --apply the set is not required', () => {
  // The read path must stay usable with no write flags at all; demanding --set
  // unconditionally would make the read-only mode unreachable.
  assert.equal(validateApplyArgs({}), null);
  assert.equal(validateApplyArgs({ set: 'x.json' }), null);
});

test('describeError passes an operational message through untouched', () => {
  const err = Object.assign(new Error('profile: unknown key "x"'), { isOpError: true });
  assert.equal(describeError(err, 'apply failed'), 'profile: unknown key "x"');
});

test('describeError prefixes an unexpected failure with its context', () => {
  // A bare ENOENT tells the operator nothing about which file or which step.
  assert.equal(describeError(new Error('ENOENT'), 'apply failed'), 'apply failed: ENOENT');
});
