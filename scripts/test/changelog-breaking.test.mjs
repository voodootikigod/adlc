import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBreaking, buildSections, buildEntry, parseLog } from '../changelog.mjs';

test('isBreaking honours the ! marker on any type, with or without a scope', () => {
  assert.equal(isBreaking({ subject: 'refactor(tickets)!: drop a subpath export' }), true);
  assert.equal(isBreaking({ subject: 'fix!: require --ticket' }), true);
  assert.equal(isBreaking({ subject: 'chore(ci)!: move the gate' }), true);
  assert.equal(isBreaking({ subject: 'fix(parallax): require --ticket' }), false);
});

test('isBreaking honours a BREAKING CHANGE / BREAKING-CHANGE footer in the body', () => {
  assert.equal(isBreaking({ subject: 'fix(parallax): bind verdicts', body: 'why\n\nBREAKING CHANGE: --ticket is required' }), true);
  assert.equal(isBreaking({ subject: 'fix(parallax): bind verdicts', body: 'BREAKING-CHANGE: --ticket is required' }), true);
  // Only a footer at the start of a line counts; prose mentioning it does not.
  assert.equal(isBreaking({ subject: 'docs: explain', body: 'this is not a BREAKING CHANGE: really' }), false);
  assert.equal(isBreaking({ subject: 'not conventional', body: '' }), false);
});

test('a breaking commit lands in a Breaking section above every other section, not in its type bucket', () => {
  const body = buildSections([
    'feat(fleet): new thing',
    { subject: 'refactor(tickets)!: drop ./lib/generation-descriptor.mjs', body: '' },
    { subject: 'fix(parallax): bind verdicts', body: 'BREAKING CHANGE: --record-verdict now requires --ticket' },
  ]);
  assert.ok(body.startsWith('### Breaking\n'), body);
  const breaking = body.split('\n\n')[0];
  assert.match(breaking, /- \*\*tickets:\*\* drop \.\/lib\/generation-descriptor\.mjs/);
  assert.match(breaking, /- \*\*parallax:\*\* bind verdicts — --record-verdict now requires --ticket/);
  assert.doesNotMatch(body, /### Changed/);
  assert.doesNotMatch(body, /### Fixed/);
  assert.match(body, /### Added\n- \*\*fleet:\*\* new thing/);
});

test('a breaking commit of a normally omitted type is still reported', () => {
  const entry = buildEntry({ version: '2.0.0', date: '2026-10-01', subjects: ['chore(ci)!: rename the required check'] });
  assert.match(entry, /### Breaking\n- \*\*ci:\*\* rename the required check/);
  assert.doesNotMatch(entry, /No user-facing changes/);
});

test('plain subject strings keep their existing grouping', () => {
  assert.equal(buildSections(['fix: a', 'perf: b']), '### Fixed\n- a\n\n### Performance\n- b');
});

test('parseLog splits git log records into subject and body', () => {
  const raw = 'feat: one\x1fbody one\n\x1efix!: two\x1f\x1e\nrefactor: three\x1fBREAKING CHANGE: x\n\x1e';
  assert.deepEqual(parseLog(raw), [
    { subject: 'feat: one', body: 'body one' },
    { subject: 'fix!: two', body: '' },
    { subject: 'refactor: three', body: 'BREAKING CHANGE: x' },
  ]);
  assert.deepEqual(parseLog(''), []);
});
