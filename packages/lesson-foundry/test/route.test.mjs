// Tests for routing logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteLint, routeCluster, clusterName, extractLiteralPattern, escapeRegex } from '../lib/route.mjs';

// ---------------------------------------------------------------------------
// shouldRouteLint
// ---------------------------------------------------------------------------
test('shouldRouteLint: detects double-quoted literal', () => {
  const findings = [{ desc: 'Should use "require" instead of "import"', category: 'convention' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects single-quoted literal', () => {
  const findings = [{ desc: "Replace 'console.log' with proper logger" }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects backtick literal', () => {
  const findings = [{ desc: 'Avoid using `eval()` in production code' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects marker pattern TODO', () => {
  const findings = [{ desc: 'TODO comments left in production code' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects FIXME marker', () => {
  const findings = [{ desc: 'FIXME: remove before shipping' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects eslint-disable marker', () => {
  const findings = [{ desc: 'Found eslint-disable comment in auth module', evidence: '' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: detects in evidence field', () => {
  const findings = [{ desc: 'improper suppression', evidence: 'code has "TODO: fix later"' }];
  assert.strictEqual(shouldRouteLint(findings), true);
});

test('shouldRouteLint: returns false for plain text finding', () => {
  const findings = [{ desc: 'missing null check in query handler' }];
  assert.strictEqual(shouldRouteLint(findings), false);
});

test('shouldRouteLint: any member triggers lint routing', () => {
  const findings = [
    { desc: 'generic architecture issue' },
    { desc: 'found TODO marker in code' },
  ];
  assert.strictEqual(shouldRouteLint(findings), true);
});

// ---------------------------------------------------------------------------
// routeCluster
// ---------------------------------------------------------------------------
test('routeCluster: LINT takes priority over SKILL', () => {
  const findings = [{ desc: 'Should use "strict mode"', category: 'convention' }];
  assert.strictEqual(routeCluster(findings), 'lint');
});

test('routeCluster: convention category → skill (no literal)', () => {
  const findings = [{ desc: 'missing error handling in async functions', category: 'convention' }];
  assert.strictEqual(routeCluster(findings), 'skill');
});

test('routeCluster: pattern category → skill', () => {
  const findings = [{ desc: 'should use repository pattern for data access', category: 'pattern' }];
  assert.strictEqual(routeCluster(findings), 'skill');
});

test('routeCluster: architecture category → skill', () => {
  const findings = [{ desc: 'circular dependency between modules', category: 'architecture' }];
  assert.strictEqual(routeCluster(findings), 'skill');
});

test('routeCluster: style category → skill', () => {
  const findings = [{ desc: 'inconsistent naming convention', category: 'style' }];
  assert.strictEqual(routeCluster(findings), 'skill');
});

test('routeCluster: unknown category → spec-gap', () => {
  const findings = [{ desc: 'unclear requirement about data retention', category: 'security' }];
  assert.strictEqual(routeCluster(findings), 'spec-gap');
});

test('routeCluster: missing category → spec-gap', () => {
  const findings = [{ desc: 'something unclear happened' }];
  assert.strictEqual(routeCluster(findings), 'spec-gap');
});

// ---------------------------------------------------------------------------
// clusterName
// ---------------------------------------------------------------------------
test('clusterName: generates slug from desc', () => {
  const name = clusterName([{ desc: 'Missing null check in query handler' }]);
  assert(/^[a-z0-9-]+$/.test(name));
  assert(name.includes('null'));
});

test('clusterName: falls back for empty desc', () => {
  const name = clusterName([{ desc: '' }]);
  assert.strictEqual(name, 'cluster');
});

test('clusterName: max 50 chars', () => {
  const name = clusterName([{ desc: 'a'.repeat(200) }]);
  assert(name.length <= 50);
});

// ---------------------------------------------------------------------------
// extractLiteralPattern
// ---------------------------------------------------------------------------
test('extractLiteralPattern: extracts double-quoted literal', () => {
  const findings = [{ desc: 'Should use "require" syntax' }];
  assert.strictEqual(extractLiteralPattern(findings), 'require');
});

test('extractLiteralPattern: returns null when no literal', () => {
  const findings = [{ desc: 'plain text no quotes here' }];
  assert.strictEqual(extractLiteralPattern(findings), null);
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------
test('escapeRegex: escapes special regex chars', () => {
  const escaped = escapeRegex('foo.bar(baz)?');
  assert.strictEqual(escaped, 'foo\\.bar\\(baz\\)\\?');
});

test('escapeRegex: passes through plain strings unchanged', () => {
  assert.strictEqual(escapeRegex('hello world'), 'hello world');
});
