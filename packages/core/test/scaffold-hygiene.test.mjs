// scaffold-hygiene.test.mjs — issue #97: consolidated coverage for the
// /adlc-init hygiene logic (.gitignore stanza management + formatter/linter
// ignore wiring) shared by every harness integration's scaffolder. This
// suite was previously hand-duplicated in plugins/adlc-cursor/test and
// plugins/adlc-opencode/test; both plugins now delegate here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureGitignore, ensureFormatterIgnores } from '../lib/scaffold-hygiene.mjs';
import { tmp } from '../lib/test-kit.mjs';

const mkRoot = (t) => tmp(t, 'adlc-core-scaffold-hygiene-');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---- ensureGitignore (#46: track .adlc/tickets.json + .adlc/specs/) ----

test('ensureGitignore creates the full stanza (including !.adlc/specs/) when no .gitignore exists', (t) => {
  const root = mkRoot(t);
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['.adlc/*', '!.adlc/tickets.json', '!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/manifest.jsonl', '!.adlc/manifest.d/', '!.adlc/manifest.d/**', '.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock', '.adlc/manifest.d/*.tmp-*']);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^\.adlc\/\*$/m);
  assert.match(body, /^!\.adlc\/tickets\.json$/m);
  assert.match(body, /^!\.adlc\/specs\/$/m);
});

test('ensureGitignore adds the missing !.adlc/specs/ negation to a pre-existing stanza without touching other content', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.adlc/*\n!.adlc/tickets.json\ndist/\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/manifest.jsonl', '!.adlc/manifest.d/', '!.adlc/manifest.d/**', '.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock', '.adlc/manifest.d/*.tmp-*']);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^!\.adlc\/specs\/$/m);
  assert.match(body, /node_modules\//);
  assert.match(body, /dist\//);
});

test('ensureGitignore is a no-op when the full stanza is already present (idempotent)', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n!.adlc/manifest.jsonl\n!.adlc/manifest.d/\n!.adlc/manifest.d/**\n.adlc/manifest.d/.lineage\n.adlc/manifest.d/*.lock\n.adlc/manifest.d/*.tmp-*\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, false);
  assert.deepEqual(r.added, []);
});

test('ensureGitignore does not duplicate a standalone negation line when the .adlc/* anchor is absent', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['.adlc/*', '!.adlc/tickets/', '!.adlc/tickets/**', '!.adlc/ticket-archive/', '!.adlc/ticket-archive/**', '!.adlc/specs/', '!.adlc/manifest.jsonl', '!.adlc/manifest.d/', '!.adlc/manifest.d/**', '.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock', '.adlc/manifest.d/*.tmp-*']);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  const occurrences = body.split('\n').filter((l) => l === '!.adlc/tickets.json').length;
  assert.equal(occurrences, 1, '!.adlc/tickets.json must not be duplicated');
  assert.match(body, /^\.adlc\/\*$/m);
  assert.match(body, /^!\.adlc\/specs\/$/m);
  // Order matters for git's last-match-wins semantics: `.adlc/*` MUST
  // come before the negation lines, otherwise it re-ignores them.
  const resultLines = body.split('\n').filter((l) => l.length > 0);
  const anchorPos = resultLines.indexOf('.adlc/*');
  const ticketsPos = resultLines.indexOf('!.adlc/tickets.json');
  const specsPos = resultLines.indexOf('!.adlc/specs/');
  assert.ok(anchorPos < ticketsPos, '.adlc/* must precede !.adlc/tickets.json');
  assert.ok(anchorPos < specsPos, '.adlc/* must precede !.adlc/specs/');
});

test('ensureGitignore relocates a negation line that precedes the .adlc/* anchor (last-match-wins hazard)', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n.adlc/*\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  const resultLines = body.split('\n').filter((l) => l.length > 0);
  const occurrences = resultLines.filter((l) => l === '!.adlc/tickets.json').length;
  assert.equal(occurrences, 1, '!.adlc/tickets.json must not be duplicated');
  const anchorPos = resultLines.indexOf('.adlc/*');
  const ticketsPos = resultLines.indexOf('!.adlc/tickets.json');
  const specsPos = resultLines.indexOf('!.adlc/specs/');
  assert.ok(anchorPos < ticketsPos, '.adlc/* must precede !.adlc/tickets.json after relocation');
  assert.ok(anchorPos < specsPos, '.adlc/* must precede !.adlc/specs/');
});

test('ensureGitignore relocates a misordered stanza even when every line is nominally present (no "missing" entries)', (t) => {
  const root = mkRoot(t);
  // All three stanza lines exist somewhere in the file, but in the wrong
  // order relative to the anchor — a naive "is everything present" check
  // would wrongly treat this as already-correct and skip fixing it.
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n!.adlc/tickets/\n!.adlc/tickets/**\n!.adlc/ticket-archive/\n!.adlc/ticket-archive/**\n!.adlc/specs/\n.adlc/*\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  const resultLines = body.split('\n').filter((l) => l.length > 0);
  const anchorPos = resultLines.indexOf('.adlc/*');
  const ticketsPos = resultLines.indexOf('!.adlc/tickets.json');
  const specsPos = resultLines.indexOf('!.adlc/specs/');
  assert.ok(anchorPos < ticketsPos, '.adlc/* must precede !.adlc/tickets.json after relocation');
  assert.ok(anchorPos < specsPos, '.adlc/* must precede !.adlc/specs/ after relocation');
});

test('ensureGitignore does not duplicate a negation line that already correctly follows the anchor elsewhere', (t) => {
  const root = mkRoot(t);
  // `!.adlc/tickets.json` appears twice: once misplaced before the anchor
  // (stale) and once correctly after it. Only the stale copy should be
  // removed; the correct copy must not be duplicated.
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n.adlc/*\n!.adlc/tickets.json\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  const resultLines = body.split('\n').filter((l) => l.length > 0);
  const occurrences = resultLines.filter((l) => l === '!.adlc/tickets.json').length;
  assert.equal(occurrences, 1, '!.adlc/tickets.json must not be duplicated');
  const anchorPos = resultLines.indexOf('.adlc/*');
  const ticketsPos = resultLines.indexOf('!.adlc/tickets.json');
  assert.ok(anchorPos < ticketsPos, '.adlc/* must precede !.adlc/tickets.json');
});

test('ensureGitignore repairs a duplicate .adlc/* anchor that re-ignores a negation placed after the first anchor', (t) => {
  const root = mkRoot(t);
  // Two `.adlc/*` anchors (e.g. from a merge of two branches that each
  // appended the stanza). Git's last-match-wins semantics mean the SECOND
  // anchor re-ignores `!.adlc/tickets.json`, which sits between the two
  // anchors — even though every stanza line is nominally "present" and
  // negations look correctly placed relative to the FIRST anchor alone.
  writeFileSync(join(root, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\nfoo\n.adlc/*\n!.adlc/specs/\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true, 'a duplicate anchor must be treated as a repair, not a no-op');
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  const resultLines = body.split('\n').filter((l) => l.length > 0);
  const anchorOccurrences = resultLines.filter((l) => l === '.adlc/*').length;
  assert.equal(anchorOccurrences, 1, 'duplicate .adlc/* anchor must be collapsed to one');
  assert.match(body, /foo/); // unrelated line untouched
  const anchorPos = resultLines.indexOf('.adlc/*');
  const ticketsPos = resultLines.indexOf('!.adlc/tickets.json');
  const specsPos = resultLines.indexOf('!.adlc/specs/');
  assert.ok(anchorPos < ticketsPos && anchorPos < specsPos, 'sole anchor must precede both negations');
  assert.ok(
    resultLines.lastIndexOf('.adlc/*') < ticketsPos && resultLines.lastIndexOf('.adlc/*') < specsPos,
    'no anchor may follow either negation (last-match-wins hazard)'
  );
});

test('ensureGitignore is idempotent after repairing a duplicate anchor (second call reports no-op)', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\nfoo\n.adlc/*\n!.adlc/specs/\n');
  ensureGitignore(root);
  const r2 = ensureGitignore(root);
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.added, []);
});

// ---- ensureFormatterIgnores (#42: keep formatters/linters off .adlc/) ----

test('ensureFormatterIgnores adds a .adlc/** override to an existing biome.json', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, 'biome.json'), JSON.stringify({ formatter: { enabled: true } }));
  const { biome } = ensureFormatterIgnores(root);
  assert.equal(biome.detected, true);
  assert.equal(biome.changed, true);
  const cfg = readJson(join(root, 'biome.json'));
  assert.ok(cfg.overrides.some((o) => o.include.includes('.adlc/**')));
  assert.equal(cfg.formatter.enabled, true);
});

test('ensureFormatterIgnores is idempotent on biome.json (no duplicate override)', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, 'biome.json'), JSON.stringify({}));
  ensureFormatterIgnores(root);
  const { biome } = ensureFormatterIgnores(root);
  assert.equal(biome.changed, false);
  const cfg = readJson(join(root, 'biome.json'));
  assert.equal(cfg.overrides.length, 1);
});

test('ensureFormatterIgnores appends .adlc/ to an existing .prettierignore', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.prettierignore'), 'dist/\n');
  const { prettier } = ensureFormatterIgnores(root);
  assert.equal(prettier.changed, true);
  const body = readFileSync(join(root, '.prettierignore'), 'utf8');
  assert.match(body, /^dist\/$/m);
  assert.match(body, /^\.adlc\/$/m);
});

test('ensureFormatterIgnores adds ignorePatterns to an existing .eslintrc.json', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.eslintrc.json'), JSON.stringify({ extends: ['eslint:recommended'] }));
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, true);
  const cfg = readJson(join(root, '.eslintrc.json'));
  assert.ok(cfg.ignorePatterns.includes('.adlc/**'));
  assert.deepEqual(cfg.extends, ['eslint:recommended']);
});

test('ensureFormatterIgnores appends .adlc/ to an existing .eslintignore', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.eslintignore'), 'dist/\n');
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, true);
  const body = readFileSync(join(root, '.eslintignore'), 'utf8');
  assert.match(body, /^dist\/$/m);
  assert.match(body, /^\.adlc\/$/m);
});

test('ensureFormatterIgnores detects but does not silently mutate a flat eslint.config.js', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, 'eslint.config.js'), 'export default [];\n');
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, false);
  assert.ok(eslint.skipped, 'must document the manual fallback');
  const body = readFileSync(join(root, 'eslint.config.js'), 'utf8');
  assert.equal(body, 'export default [];\n'); // untouched
});

test('ensureFormatterIgnores reports BOTH .eslintrc.json and .eslintignore outcomes when a repo has both', (t) => {
  const root = mkRoot(t);
  writeFileSync(join(root, '.eslintrc.json'), JSON.stringify({ extends: ['eslint:recommended'] }));
  writeFileSync(join(root, '.eslintignore'), 'dist/\n');
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, true);
  // Both files must actually be mutated on disk...
  const rc = readJson(join(root, '.eslintrc.json'));
  assert.ok(rc.ignorePatterns.includes('.adlc/**'));
  const ignoreBody = readFileSync(join(root, '.eslintignore'), 'utf8');
  assert.match(ignoreBody, /^\.adlc\/$/m);
  // ...and the returned report must not silently drop either mutation.
  assert.ok(eslint.sources, 'must expose per-file detail when both are present');
  assert.equal(eslint.sources.eslintrc.changed, true);
  assert.equal(eslint.sources.eslintignore.changed, true);
});

test('ensureFormatterIgnores reports nothing detected when no formatter/linter configs exist', (t) => {
  const root = mkRoot(t);
  const { biome, prettier, eslint } = ensureFormatterIgnores(root);
  assert.equal(biome.detected, false);
  assert.equal(prettier.detected, false);
  assert.equal(eslint.detected, false);
});
