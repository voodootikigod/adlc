// Bidi stripping for terminal output — Trojan Source (CVE-2021-42574).
//
// These live in their OWN file, not appended to sanitize.test.mjs, because that
// file is a RAIL: ticket t-herdr-1 freezes it, so rails-guard denies edits and
// a PR touching it cannot merge. That is the point of a rail — the frozen
// contract test may not be rewritten by the change it is meant to constrain.
// New behavior gets new tests alongside it, and the frozen contract still has
// to pass.
//
// scripts/test/source-hygiene.test.mjs already refuses these characters in
// SOURCE files, because rendered text differing from real text is how a
// reviewer approves code that does something else. The same characters flowing
// the other way — out of an untrusted ticket title and into a terminal row —
// let a board row impersonate another ticket's id or status, so an operator
// focuses the wrong pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeToken } from '../lib/sanitize.mjs';

test('bidi overrides, embeddings and isolates are stripped', () => {
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
    const hostile = `safe${String.fromCharCode(code)}text`;
    assert.equal(sanitize(hostile), 'safetext', `U+${code.toString(16).toUpperCase()} must not survive`);
    assert.ok(!sanitizeToken(hostile).includes(String.fromCharCode(code)));
  }
});

test('stripping bidi leaves ordinary text and legitimate joiners alone', () => {
  // ZWJ and ZWNJ are load-bearing in Indic clusters and emoji sequences —
  // removing them would corrupt real content rather than protect anyone.
  assert.equal(sanitize('ticket t-b - P4'), 'ticket t-b - P4');
  assert.ok(sanitize('\u{1F468}‍\u{1F469}').includes('‍'), 'ZWJ must survive');
  assert.ok(sanitize('क्‌ष').includes('‌'), 'ZWNJ must survive');
});
