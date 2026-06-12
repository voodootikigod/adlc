// Tests for lens file rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTitle,
  anonymizeAuthor,
  truncateQuote,
  renderLensFile,
  buildDefaultCharter,
  planLensEmissions,
} from '../lib/lens.mjs';

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

test('deriveTitle: uses LLM title when provided', () => {
  const signals = [{ body: 'avoid hardcoding' }];
  const llm = { title: 'Hardcoded Secrets', charter: 'something' };
  assert.strictEqual(deriveTitle(signals, llm), 'Hardcoded Secrets');
});

test('deriveTitle: falls back to slug-derived title', () => {
  const signals = [{ body: 'missing null check in property access' }];
  const title = deriveTitle(signals, null);
  assert(typeof title === 'string');
  assert(title.length > 0);
  // Title-cased words
  assert(/[A-Z]/.test(title));
});

test('deriveTitle: handles empty signals', () => {
  const title = deriveTitle([]);
  assert.strictEqual(title, 'Unknown');
});

// ---------------------------------------------------------------------------
// anonymizeAuthor
// ---------------------------------------------------------------------------

test('anonymizeAuthor: first initial + ***', () => {
  assert.strictEqual(anonymizeAuthor('alice'), 'A***');
  assert.strictEqual(anonymizeAuthor('Bob'), 'B***');
});

test('anonymizeAuthor: unknown → "reviewer"', () => {
  assert.strictEqual(anonymizeAuthor('unknown'), 'reviewer');
  assert.strictEqual(anonymizeAuthor(''), 'reviewer');
  assert.strictEqual(anonymizeAuthor(null), 'reviewer');
});

// ---------------------------------------------------------------------------
// truncateQuote
// ---------------------------------------------------------------------------

test('truncateQuote: short string unchanged', () => {
  const s = 'This is short';
  assert.strictEqual(truncateQuote(s), s);
});

test('truncateQuote: long string gets truncated with ellipsis', () => {
  const long = 'x'.repeat(300);
  const result = truncateQuote(long, 200);
  assert(result.length <= 200);
  assert(result.endsWith('…'));
});

test('truncateQuote: collapses whitespace', () => {
  const result = truncateQuote('foo\n\nbar\tbaz');
  assert(!result.includes('\n'));
  assert(!result.includes('\t'));
});

// ---------------------------------------------------------------------------
// buildDefaultCharter
// ---------------------------------------------------------------------------

test('buildDefaultCharter: references sample body', () => {
  const signals = [{ body: 'avoid hardcoding secrets' }];
  const charter = buildDefaultCharter(signals);
  assert(charter.includes('avoid hardcoding secrets'));
});

test('buildDefaultCharter: empty signals → fallback', () => {
  const charter = buildDefaultCharter([]);
  assert(typeof charter === 'string');
  assert(charter.length > 0);
});

// ---------------------------------------------------------------------------
// renderLensFile
// ---------------------------------------------------------------------------

test('renderLensFile: contains required sections', () => {
  const signals = [
    { body: "don't hardcode credentials", author: 'alice', prNumber: 12 },
    { body: "never put secrets in code", author: 'bob', prNumber: 15 },
  ];
  const prNumbers = new Set([12, 15]);
  const content = renderLensFile({
    slug: 'hardcode-credentials',
    title: 'Hardcoded Credentials',
    charter: 'hardcoding of secrets or credentials in source code',
    signals,
    prNumbers,
  });

  assert(content.includes('# Lens: Hardcoded Credentials'));
  assert(content.includes('## Charter'));
  assert(content.includes('## Checklist'));
  assert(content.includes('## Example Objections'));
  assert(content.includes('mined from 2 review comments across 2 PRs'));
});

test('renderLensFile: anonymizes authors', () => {
  const signals = [
    { body: "don't do this", author: 'charlie', prNumber: 3 },
  ];
  const content = renderLensFile({
    slug: 'test',
    title: 'Test Lens',
    charter: 'test charter',
    signals,
    prNumbers: new Set([3]),
  });
  assert(content.includes('C***'));
  assert(!content.includes('charlie'));
});

test('renderLensFile: includes PR number in quotes', () => {
  const signals = [
    { body: 'avoid this pattern', author: 'alice', prNumber: 99 },
  ];
  const content = renderLensFile({
    slug: 'avoid-pattern',
    title: 'Avoid Pattern',
    charter: 'patterns that should be avoided',
    signals,
    prNumbers: new Set([99]),
  });
  assert(content.includes('PR #99'));
});

test('renderLensFile: singular PR count grammar', () => {
  const signals = [
    { body: 'missing error handling', author: 'dave', prNumber: 5 },
    { body: 'missing error handling here', author: 'eve', prNumber: 5 },
  ];
  const content = renderLensFile({
    slug: 'error-handling',
    title: 'Error Handling',
    charter: 'missing error handling patterns',
    signals,
    prNumbers: new Set([5]),
  });
  assert(content.includes('1 PR'));
  assert(!content.includes('1 PRs'));
});

// ---------------------------------------------------------------------------
// planLensEmissions
// ---------------------------------------------------------------------------

test('planLensEmissions: one plan per cluster', () => {
  const signals = [
    { body: "don't hardcode credentials here", author: 'a', prNumber: 1 },
    { body: "never hardcode credentials in source", author: 'b', prNumber: 2 },
    { body: 'missing null check causes crash', author: 'c', prNumber: 3 },
  ];
  const clusters = [
    { slug: 'hardcode-creds', indices: [0, 1], count: 2, prNumbers: new Set([1, 2]) },
    { slug: 'null-check', indices: [2], count: 1, prNumbers: new Set([3]) },
  ];
  const plans = planLensEmissions(clusters, signals, '.adlc/lenses');
  assert.strictEqual(plans.length, 2);
  assert.strictEqual(plans[0].slug, 'hardcode-creds');
  assert(plans[0].path.startsWith('.adlc/lenses/lens-'));
  assert(plans[0].path.endsWith('.md'));
  assert(typeof plans[0].content === 'string');
  assert(plans[0].content.length > 0);
});

test('planLensEmissions: applies outDir prefix', () => {
  const signals = [{ body: 'avoid mutation', author: 'a', prNumber: 1 }];
  const clusters = [
    { slug: 'avoid-mutation', indices: [0], count: 1, prNumbers: new Set([1]) },
  ];
  const plans = planLensEmissions(clusters, signals, '/custom/out');
  assert(plans[0].path.startsWith('/custom/out/'));
});

test('planLensEmissions: LLM title used when provided', () => {
  const signals = [
    { body: "don't expose internal errors", author: 'a', prNumber: 1 },
  ];
  const clusters = [
    { slug: 'error-exposure', indices: [0], count: 1, prNumbers: new Set([1]) },
  ];
  const llmRefinements = new Map([[0, { title: 'Error Exposure Leak', charter: 'exposing internal errors to callers' }]]);
  const plans = planLensEmissions(clusters, signals, '.adlc/lenses', llmRefinements);
  assert(plans[0].content.includes('# Lens: Error Exposure Leak'));
});
