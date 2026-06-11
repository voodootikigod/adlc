// Tests for signal extraction and filtering.
// Zero real gh calls — all from fixture data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasNegativeSignal, extractBodies, filterNegativeSignals } from '../lib/signal.mjs';

// ---------------------------------------------------------------------------
// hasNegativeSignal — positive fixture (must match)
// ---------------------------------------------------------------------------

test('hasNegativeSignal: matches "don\'t"', () => {
  assert(hasNegativeSignal("You don't need to do this here"));
});

test('hasNegativeSignal: matches "do not"', () => {
  assert(hasNegativeSignal("Please do not hardcode the URL"));
});

test('hasNegativeSignal: matches "should not"', () => {
  assert(hasNegativeSignal("This should not be in the public API"));
});

test('hasNegativeSignal: matches "must not"', () => {
  assert(hasNegativeSignal("Tests must not call the real network"));
});

test('hasNegativeSignal: matches "never"', () => {
  assert(hasNegativeSignal("Never expose raw stack traces to users"));
});

test('hasNegativeSignal: matches "avoid"', () => {
  assert(hasNegativeSignal("Avoid mutating the original object"));
});

test('hasNegativeSignal: matches "instead"', () => {
  assert(hasNegativeSignal("Use a Set instead of an array here"));
});

test('hasNegativeSignal: matches "wrong"', () => {
  assert(hasNegativeSignal("This approach is wrong for async code"));
});

test('hasNegativeSignal: matches "breaks"', () => {
  assert(hasNegativeSignal("This change breaks the existing contract"));
});

test('hasNegativeSignal: matches "missing"', () => {
  assert(hasNegativeSignal("Missing null check before accessing property"));
});

test('hasNegativeSignal: matches "remove this"', () => {
  assert(hasNegativeSignal("Please remove this commented-out code block"));
});

test('hasNegativeSignal: matches "why is"', () => {
  assert(hasNegativeSignal("Why is this duplicated across two files?"));
});

test('hasNegativeSignal: matches "why are"', () => {
  assert(hasNegativeSignal("Why are these tests disabled?"));
});

test('hasNegativeSignal: matches "why do"', () => {
  assert(hasNegativeSignal("Why do we need a separate config file?"));
});

test('hasNegativeSignal: matches "why does"', () => {
  assert(hasNegativeSignal("Why does this function return undefined?"));
});

test('hasNegativeSignal: case-insensitive matching', () => {
  assert(hasNegativeSignal("AVOID using global state"));
  assert(hasNegativeSignal("DO NOT commit secrets"));
  assert(hasNegativeSignal("NEVER call this on the hot path"));
});

// ---------------------------------------------------------------------------
// hasNegativeSignal — negative fixture (must NOT match)
// ---------------------------------------------------------------------------

test('hasNegativeSignal: LGTM → false', () => {
  assert(!hasNegativeSignal("LGTM! Great work on this feature."));
});

test('hasNegativeSignal: positive approval → false', () => {
  assert(!hasNegativeSignal("This looks good to me, approved."));
});

test('hasNegativeSignal: simple question without negative word → false', () => {
  assert(!hasNegativeSignal("Can you add a test for the happy path?"));
});

test('hasNegativeSignal: empty string → false', () => {
  assert(!hasNegativeSignal(''));
});

test('hasNegativeSignal: null → false', () => {
  assert(!hasNegativeSignal(null));
});

test('hasNegativeSignal: suggestion without signal words → false', () => {
  assert(!hasNegativeSignal("Consider extracting this into a helper function."));
});

test('hasNegativeSignal: positive nit → false', () => {
  assert(!hasNegativeSignal("Nit: rename this variable to be more descriptive."));
});

// ---------------------------------------------------------------------------
// extractBodies
// ---------------------------------------------------------------------------

test('extractBodies: extracts reviews and comments', () => {
  const detail = {
    reviews: [
      { body: 'This should not be public', author: { login: 'alice' } },
      { body: '', author: { login: 'bob' } }, // empty — skipped
    ],
    comments: [
      { body: 'Why is this here?', author: { login: 'carol' } },
    ],
  };
  const items = extractBodies(detail, 42);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].source, 'review');
  assert.strictEqual(items[0].prNumber, 42);
  assert.strictEqual(items[0].author, 'alice');
  assert.strictEqual(items[1].source, 'comment');
  assert.strictEqual(items[1].author, 'carol');
});

test('extractBodies: handles missing reviews/comments', () => {
  const detail = {};
  const items = extractBodies(detail, 1);
  assert.deepStrictEqual(items, []);
});

test('extractBodies: handles author as plain string', () => {
  const detail = {
    reviews: [{ body: 'avoid this pattern', author: 'dave' }],
    comments: [],
  };
  const items = extractBodies(detail, 7);
  assert.strictEqual(items[0].author, 'dave');
});

test('extractBodies: skips whitespace-only bodies', () => {
  const detail = {
    reviews: [{ body: '   \n  ', author: { login: 'eve' } }],
    comments: [],
  };
  const items = extractBodies(detail, 5);
  assert.strictEqual(items.length, 0);
});

// ---------------------------------------------------------------------------
// filterNegativeSignals
// ---------------------------------------------------------------------------

test('filterNegativeSignals: only returns items with negative signals', () => {
  const items = [
    { body: 'LGTM', author: 'alice', prNumber: 1, source: 'review' },
    { body: "don't merge this yet", author: 'bob', prNumber: 2, source: 'comment' },
    { body: 'Nice refactor!', author: 'carol', prNumber: 3, source: 'review' },
    { body: 'missing test coverage', author: 'dave', prNumber: 4, source: 'comment' },
  ];
  const filtered = filterNegativeSignals(items);
  assert.strictEqual(filtered.length, 2);
  assert(filtered.every((i) => hasNegativeSignal(i.body)));
});

test('filterNegativeSignals: empty input returns empty', () => {
  assert.deepStrictEqual(filterNegativeSignals([]), []);
});

test('filterNegativeSignals: all positive → empty output', () => {
  const items = [
    { body: 'LGTM', author: 'a', prNumber: 1, source: 'review' },
    { body: 'Approved!', author: 'b', prNumber: 2, source: 'review' },
  ];
  assert.deepStrictEqual(filterNegativeSignals(items), []);
});
