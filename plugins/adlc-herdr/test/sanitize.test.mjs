// RAIL (t-herdr-1): frozen contract for lib/sanitize.mjs.
//
// Every string the plugin hands to a terminal surface (report-metadata tokens,
// notifications, board rendering, pane titles) passes through sanitize() or
// sanitizeToken(). Ticket bodies, branch names, and log lines are untrusted
// input; terminal escape injection in a multiplexer is an escalation channel
// (plan §6.1). These tests define the contract — the implementation may not
// weaken them during the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeToken } from '../lib/sanitize.mjs';

test('plain text passes through unchanged, including multibyte UTF-8', () => {
  assert.equal(sanitize('hello world'), 'hello world');
  assert.equal(sanitize('t51 · P4 — ✓ 火车'), 't51 · P4 — ✓ 火车');
});

test('newline and tab are preserved by sanitize()', () => {
  assert.equal(sanitize('a\nb\tc'), 'a\nb\tc');
});

test('non-string input fails closed to the empty string', () => {
  for (const bad of [null, undefined, 42, {}, [], Symbol('x'), () => {}]) {
    assert.equal(sanitize(bad), '');
    assert.equal(sanitizeToken(bad), '');
  }
});

test('CSI sequences are removed entirely (colors, cursor movement, clears)', () => {
  assert.equal(sanitize('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(sanitize('a\x1b[2Ab'), 'ab');
  assert.equal(sanitize('a\x1b[2J\x1b[Hb'), 'ab');
  // parameters + intermediates before the final byte
  assert.equal(sanitize('x\x1b[38;5;196;48;2;0;0;0my'), 'xy');
});

test('OSC sequences are removed with their entire body (BEL and ST terminated)', () => {
  // window title
  assert.equal(sanitize('\x1b]0;evil title\x07visible'), 'visible');
  // ST (ESC \) terminator
  assert.equal(sanitize('\x1b]0;evil\x1b\\visible'), 'visible');
});

test('OSC 8 hyperlinks are stripped, keeping only the anchor text', () => {
  const s = '\x1b]8;;https://evil.example\x07click me\x1b]8;;\x07';
  assert.equal(sanitize(s), 'click me');
});

test('DCS / SOS / PM / APC string sequences are removed to ST', () => {
  assert.equal(sanitize('a\x1bPq#payload\x1b\\b'), 'ab'); // DCS
  assert.equal(sanitize('a\x1b^private\x1b\\b'), 'ab'); // PM
  assert.equal(sanitize('a\x1b_app\x1b\\b'), 'ab'); // APC
});

test('single-character ESC sequences and lone ESC are removed', () => {
  assert.equal(sanitize('a\x1bcb'), 'ab'); // RIS
  assert.equal(sanitize('a\x1b'), 'a'); // dangling ESC at end
  assert.equal(sanitize('a\x1b['), 'a'); // truncated CSI at end
  assert.equal(sanitize('a\x1b]0;unterminated'), 'a'); // unterminated OSC
});

test('a CSI aborted by a non-CSI byte stops consuming; the text survives', () => {
  // \n is neither a CSI param, intermediate, nor final byte — the malformed
  // sequence ends there and the newline itself must not be swallowed.
  assert.equal(sanitize('a\x1b[\nb'), 'a\nb');
});

test('raw C1 controls are consumed as full sequences, not leaked as text', () => {
  // 0x9B is 8-bit CSI: its parameter/final bytes must be consumed too.
  assert.equal(sanitize('\x9b31mred'), 'red');
  // 0x9D is 8-bit OSC: consume to BEL/ST.
  assert.equal(sanitize('\x9d0;title\x07ok'), 'ok');
  // other C1 bytes are stripped; 0x90 (DCS) opens a string sequence that
  // consumes everything to ST or end-of-string
  assert.equal(sanitize('a\x85b\x90c\x9fd'), 'ab');
  assert.equal(sanitize('a\x90data\x9cb'), 'ab'); // 0x9C ST terminates DCS
});

test('C0 controls other than newline and tab are stripped, including DEL', () => {
  assert.equal(sanitize('a\x00b\x07c\x08d\x0be\x7ff'), 'abcdef');
  assert.equal(sanitize('a\rb'), 'ab'); // bare CR must not survive (line-injection)
});

test('sanitize() is idempotent', () => {
  const hostile = '\x1b]8;;x\x07t\x1b]8;;\x07 \x9b1m \x1b[31mz\x1b[0m\x7f';
  assert.equal(sanitize(sanitize(hostile)), sanitize(hostile));
});

test('sanitizeToken() collapses all whitespace to single spaces and trims', () => {
  assert.equal(sanitizeToken('  a\n\tb   c  '), 'a b c');
});

test('sanitizeToken() strips escapes before collapsing', () => {
  assert.equal(sanitizeToken('\x1b[31m t51 \x1b[0m\n P4 '), 't51 P4');
});

test('sanitizeToken() hard-caps length (default 64)', () => {
  const long = 'x'.repeat(200);
  assert.equal(sanitizeToken(long).length, 64);
  assert.equal(sanitizeToken(long, 10), 'x'.repeat(10));
});

test('sanitizeToken() fails closed on a non-positive length cap', () => {
  assert.equal(sanitizeToken('abc', 0), '');
  assert.equal(sanitizeToken('abc', -5), '');
});
