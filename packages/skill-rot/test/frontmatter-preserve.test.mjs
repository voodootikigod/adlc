import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertFrontmatter } from '../lib/frontmatter.mjs';
import { stampVerified } from '../lib/rot-checker.mjs';

const FOLDED_SKILL = [
  '---',
  'name: demo',
  'description: >',
  '  A long description',
  '  spanning lines',
  'allowed-tools:',
  '  - Read',
  '  - Bash',
  '# a comment',
  'license: MIT',
  '---',
  '',
  '# Demo',
  'body text here',
  '',
].join('\n');

test('upsertFrontmatter preserves a folded scalar, a YAML list, and a comment byte-identical', () => {
  const updated = upsertFrontmatter(FOLDED_SKILL, 'last-verified', '2026-08-29');
  const lines = updated.split('\n');

  assert.ok(lines.includes('description: >'), 'folded scalar header must survive');
  assert.ok(lines.includes('  A long description'), 'folded scalar continuation line 1 must survive');
  assert.ok(lines.includes('  spanning lines'), 'folded scalar continuation line 2 must survive');
  assert.ok(lines.includes('allowed-tools:'), 'list header must survive');
  assert.ok(lines.includes('  - Read'), 'list item 1 must survive');
  assert.ok(lines.includes('  - Bash'), 'list item 2 must survive');
  assert.ok(lines.includes('# a comment'), 'comment line must survive');
  assert.ok(lines.includes('license: MIT'), 'unrelated key must survive');
  assert.ok(lines.includes('last-verified: 2026-08-29'), 'new key must be present');

  // Body after the closing --- is untouched.
  assert.ok(updated.includes('# Demo\nbody text here'), 'body must be unchanged');
});

test('upsertFrontmatter re-run replaces only the existing key line, no duplicate, rest preserved', () => {
  const once = upsertFrontmatter(FOLDED_SKILL, 'last-verified', '2026-08-29');
  const twice = upsertFrontmatter(once, 'last-verified', '2026-08-30');

  const lines = twice.split('\n');
  const verifiedLines = lines.filter((l) => l.startsWith('last-verified:'));
  assert.equal(verifiedLines.length, 1, 'must not duplicate the key on a second upsert');
  assert.equal(verifiedLines[0], 'last-verified: 2026-08-30');

  assert.ok(lines.includes('description: >'));
  assert.ok(lines.includes('  A long description'));
  assert.ok(lines.includes('  spanning lines'));
  assert.ok(lines.includes('allowed-tools:'));
  assert.ok(lines.includes('  - Read'));
  assert.ok(lines.includes('  - Bash'));
  assert.ok(lines.includes('# a comment'));
});

test('upsertFrontmatter inserts a new key line immediately before the closing ---', () => {
  const NO_STAMP = [
    '---',
    'name: demo',
    'description: simple',
    '---',
    '',
    'body',
    '',
  ].join('\n');

  const updated = upsertFrontmatter(NO_STAMP, 'last-verified', '2026-08-29');
  const lines = updated.split('\n');
  const closingIdx = lines.indexOf('---', 1);

  assert.equal(lines[closingIdx - 1], 'last-verified: 2026-08-29', 'new key must sit directly before closing ---');
  assert.equal(lines.filter((l) => l === '---').length, 2, 'exactly two delimiters');
});

test('upsertFrontmatter with no existing frontmatter block still prepends one (unchanged behaviour)', () => {
  const NO_FM = 'just a body, no frontmatter\n';
  const updated = upsertFrontmatter(NO_FM, 'last-verified', '2026-08-29');
  assert.ok(updated.startsWith('---\n'));
  assert.ok(updated.includes('last-verified: 2026-08-29'));
  assert.ok(updated.includes('just a body, no frontmatter'));
  assert.equal(updated, '---\nlast-verified: 2026-08-29\n---\njust a body, no frontmatter\n');
});

test('upsertFrontmatter with an opening --- but NO closing --- prepends a new block around the whole original content', () => {
  const MALFORMED = '---\nname: demo\nno closing delimiter\n';
  const updated = upsertFrontmatter(MALFORMED, 'last-verified', '2026-08-29');
  assert.equal(
    updated,
    '---\nlast-verified: 2026-08-29\n---\n---\nname: demo\nno closing delimiter\n'
  );
});

test('upsertFrontmatter finds a closing --- that sits immediately after the opening --- (empty block)', () => {
  const EMPTY_BLOCK = '---\n---\nbody\n';
  const updated = upsertFrontmatter(EMPTY_BLOCK, 'last-verified', '2026-08-29');
  const lines = updated.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], 'last-verified: 2026-08-29');
  assert.equal(lines[2], '---');
  assert.equal(lines[3], 'body');
});

test('upsertFrontmatter preserves CRLF line endings when the input used CRLF', () => {
  const crlf = FOLDED_SKILL.split('\n').join('\r\n');
  const updated = upsertFrontmatter(crlf, 'last-verified', '2026-08-29');

  assert.ok(updated.includes('\r\n'), 'must contain CRLF sequences');
  assert.ok(!/[^\r]\n/.test(updated), 'every newline must be preceded by \\r (no bare LF introduced)');
  assert.ok(updated.includes('description: >\r\n  A long description\r\n  spanning lines\r\n'));
  assert.ok(updated.includes('last-verified: 2026-08-29'));
});

test('the real write path (stampVerified) uses temp-file + rename: a failed rename leaves the original untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-rot-write-'));
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, FOLDED_SKILL, 'utf8');

  const failingRename = () => {
    throw new Error('simulated rename failure');
  };

  assert.throws(() => stampVerified(skillPath, '2026-08-29', { rename: failingRename }));

  const onDisk = readFileSync(skillPath, 'utf8');
  assert.equal(onDisk, FOLDED_SKILL, 'original file must be untouched when rename fails');
});

test('stampVerified applies the update atomically on the success path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-rot-write-'));
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, FOLDED_SKILL, 'utf8');

  stampVerified(skillPath, '2026-08-29');

  const onDisk = readFileSync(skillPath, 'utf8');
  assert.ok(onDisk.includes('last-verified: 2026-08-29'));
  assert.ok(onDisk.includes('  A long description'));
  assert.ok(onDisk.includes('  - Read'));
});
