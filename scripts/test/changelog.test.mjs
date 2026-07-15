// Unit coverage for scripts/changelog.mjs — the release changelog generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousTag, parseSubject, buildSections, buildEntry, insertEntry } from '../changelog.mjs';

test('previousTag returns the highest v-tag strictly below the target', () => {
  const tags = ['v1.2.1', 'v1.3.0', 'v1.4.0', 'v1.4.1', 'not-a-tag', 'v1.10.0'];
  assert.equal(previousTag('1.4.1', tags), 'v1.4.0');
  assert.equal(previousTag('1.5.0', tags), 'v1.4.1'); // v1.10.0 (=1.10.0) is ABOVE 1.5.0 → excluded
  assert.equal(previousTag('1.11.0', tags), 'v1.10.0'); // numeric sort: 1.10.0 > 1.4.1, not lexical
  assert.equal(previousTag('1.0.0', ['v1.0.0']), null); // no earlier tag
});

test('parseSubject splits conventional commits and rejects free-form', () => {
  assert.deepEqual(parseSubject('feat(fleet): parallel orchestration (#165)'),
    { type: 'feat', scope: 'fleet', description: 'parallel orchestration (#165)' });
  assert.deepEqual(parseSubject('fix: bare fix'), { type: 'fix', scope: null, description: 'bare fix' });
  assert.equal(parseSubject('merge branch main'), null);
});

test('buildSections categorizes and drops non-user-facing noise', () => {
  const body = buildSections([
    'feat(fleet): parallel orchestration (#165)',
    'fix(core): symlink revision (#182)',
    'perf(fleet): concurrent execution (#166)',
    'refactor(router): consolidate routers',
    'chore: bump version to 1.4.0',
    'test(prosecute): guard (#183)',
    'docs(site): refresh install',
  ]);
  assert.match(body, /### Added\n- \*\*fleet:\*\* parallel orchestration \(#165\)/);
  assert.match(body, /### Fixed\n- \*\*core:\*\* symlink revision \(#182\)/);
  assert.match(body, /### Performance/);
  assert.match(body, /### Changed/);
  assert.doesNotMatch(body, /bump version/, 'the bump commit is excluded');
  assert.doesNotMatch(body, /guard \(#183\)/, 'test commits are excluded');
  assert.doesNotMatch(body, /refresh install/, 'docs commits are excluded');
});

test('buildEntry falls back to a placeholder when nothing is user-facing', () => {
  const entry = buildEntry({ version: '1.4.2', date: '2026-08-01', subjects: ['chore: housekeeping', 'test: more'] });
  assert.match(entry, /^## \[1\.4\.2\] - 2026-08-01/);
  assert.match(entry, /_No user-facing changes\._/);
});

test('insertEntry prepends above existing versions and never duplicates', () => {
  const entry = buildEntry({ version: '1.5.0', date: '2026-08-01', subjects: ['feat: new thing'] });
  const base = '# Changelog\n\nintro\n\n## [1.4.1] - 2026-07-14\n\n### Fixed\n- x\n';
  const once = insertEntry(base, entry, '1.5.0');
  assert.ok(once.indexOf('## [1.5.0]') < once.indexOf('## [1.4.1]'), 'new entry sits above the old');
  assert.equal(insertEntry(once, entry, '1.5.0'), once, 'a second run is a no-op (idempotent)');
});

test('insertEntry seeds a header when the changelog does not exist yet', () => {
  const entry = buildEntry({ version: '1.0.0', date: '2026-06-13', subjects: ['feat: initial release'] });
  const out = insertEntry('', entry, '1.0.0');
  assert.match(out, /^# Changelog/);
  assert.match(out, /## \[1\.0\.0\] - 2026-06-13/);
});
