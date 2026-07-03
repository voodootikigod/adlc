// scaffold.test.mjs — the scaffolder writes valid Cursor config, merges hooks
// without clobbering the user's other hooks, and is idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scaffold,
  mergeHooks,
  ensureCursorHooks,
  ensureGitignore,
  ensureFormatterIgnores,
} from '../lib/scaffold.mjs';

const mkRepo = () => mkdtempSync(join(tmpdir(), 'adlc-cursor-scaffold-'));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('scaffold creates config, hooks.json (rails-guard + audit) and the rule', () => {
  const root = mkRepo();
  const res = scaffold(root);
  assert.ok(existsSync(join(root, '.adlc', 'config.json')));
  assert.ok(existsSync(join(root, '.cursor', 'rules', 'adlc.mdc')));

  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.equal(hooks.version, 1);
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-rails-guard\.mjs/);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, false);
  assert.match(hooks.hooks.afterFileEdit[0].command, /adlc-audit\.mjs/);
  assert.ok(res.config.created && res.rule.created);
});

test('mergeHooks preserves a user existing hook and does not duplicate ADLC entries', () => {
  const userHooks = {
    version: 1,
    hooks: {
      preToolUse: [{ command: './scripts/my-guard.sh', matcher: 'curl' }],
      beforeShellExecution: [{ command: './scripts/net.sh' }],
    },
  };
  const once = mergeHooks(userHooks);
  // user's entries survive
  assert.ok(once.hooks.preToolUse.some((e) => e.command === './scripts/my-guard.sh'));
  assert.ok(once.hooks.beforeShellExecution.some((e) => e.command === './scripts/net.sh'));
  // ours added
  assert.ok(once.hooks.preToolUse.some((e) => /adlc-rails-guard/.test(e.command)));
  // idempotent: merging again does not add a second ADLC entry
  const twice = mergeHooks(once);
  const adlcCount = twice.hooks.preToolUse.filter((e) => /adlc-rails-guard/.test(e.command)).length;
  assert.equal(adlcCount, 1);
});

test('ensureCursorHooks BACKS UP an unparseable existing hooks.json instead of dropping it', () => {
  const root = mkRepo();
  mkdirSync(join(root, '.cursor'), { recursive: true });
  const original = '{ not json — a company hook lived here';
  writeFileSync(join(root, '.cursor', 'hooks.json'), original);
  const res = ensureCursorHooks(root);
  // ADLC hook is installed...
  const hooks = readJson(join(root, '.cursor', 'hooks.json'));
  assert.match(hooks.hooks.preToolUse[0].command, /adlc-rails-guard/);
  // ...but the original content is preserved verbatim in a backup, not lost.
  assert.ok(res.backedUp, 'a backup path must be reported');
  assert.equal(readFileSync(res.backedUp, 'utf8'), original, 'backup must hold the original bytes');
});

// ---- ensureGitignore (#46: track .adlc/specs/) ----
test('ensureGitignore creates the full stanza (including !.adlc/specs/) when no .gitignore exists', () => {
  const root = mkRepo();
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['.adlc/*', '!.adlc/tickets.json', '!.adlc/specs/']);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^!\.adlc\/specs\/$/m);
});

test('ensureGitignore adds the missing !.adlc/specs/ negation to a pre-existing stanza without touching other content', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.adlc/*\n!.adlc/tickets.json\ndist/\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['!.adlc/specs/']);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^!\.adlc\/specs\/$/m);
  assert.match(body, /node_modules\//);
  assert.match(body, /dist\//);
});

test('ensureGitignore is a no-op when the full stanza is already present (idempotent)', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.gitignore'), '.adlc/*\n!.adlc/tickets.json\n!.adlc/specs/\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, false);
  assert.deepEqual(r.added, []);
});

test('ensureGitignore does not duplicate a standalone negation line when the .adlc/* anchor is absent', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n');
  const r = ensureGitignore(root);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['.adlc/*', '!.adlc/specs/']);
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

test('ensureGitignore relocates a negation line that precedes the .adlc/* anchor (last-match-wins hazard)', () => {
  const root = mkRepo();
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

test('ensureGitignore relocates a misordered stanza even when every line is nominally present (no "missing" entries)', () => {
  const root = mkRepo();
  // All three stanza lines exist somewhere in the file, but in the wrong
  // order relative to the anchor — a naive "is everything present" check
  // would wrongly treat this as already-correct and skip fixing it.
  writeFileSync(join(root, '.gitignore'), '!.adlc/tickets.json\n!.adlc/specs/\n.adlc/*\n');
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

test('ensureGitignore does not duplicate a negation line that already correctly follows the anchor elsewhere', () => {
  const root = mkRepo();
  // `!.adlc/tickets.json` appears twice: once misplaced before the anchor
  // (stale) and once correctly after it. Only the stale copy should be
  // removed; the correct copy must not be duplicated.
  writeFileSync(
    join(root, '.gitignore'),
    '!.adlc/tickets.json\n.adlc/*\n!.adlc/tickets.json\n'
  );
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

test('ensureGitignore repairs a duplicate .adlc/* anchor that re-ignores a negation placed after the first anchor', () => {
  const root = mkRepo();
  // Two `.adlc/*` anchors (e.g. from a merge of two branches that each
  // appended the stanza). Git's last-match-wins semantics mean the SECOND
  // anchor re-ignores `!.adlc/tickets.json`, which sits between the two
  // anchors — even though every stanza line is nominally "present" and
  // negations look correctly placed relative to the FIRST anchor alone.
  writeFileSync(
    join(root, '.gitignore'),
    '.adlc/*\n!.adlc/tickets.json\nfoo\n.adlc/*\n!.adlc/specs/\n'
  );
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

test('ensureGitignore is idempotent after repairing a duplicate anchor (second call reports no-op)', () => {
  const root = mkRepo();
  writeFileSync(
    join(root, '.gitignore'),
    '.adlc/*\n!.adlc/tickets.json\nfoo\n.adlc/*\n!.adlc/specs/\n'
  );
  ensureGitignore(root);
  const r2 = ensureGitignore(root);
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.added, []);
});

test('scaffold() wires ensureGitignore in so /adlc-init tracks specs/ by default', () => {
  const root = mkRepo();
  const out = scaffold(root);
  const body = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(body, /^!\.adlc\/specs\/$/m);
  assert.equal(out.gitignore.changed, true);
});

// ---- ensureFormatterIgnores (#42: keep formatters/linters off .adlc/) ----
test('ensureFormatterIgnores adds a .adlc/** override to an existing biome.json', () => {
  const root = mkRepo();
  writeFileSync(join(root, 'biome.json'), JSON.stringify({ formatter: { enabled: true } }));
  const { biome } = ensureFormatterIgnores(root);
  assert.equal(biome.detected, true);
  assert.equal(biome.changed, true);
  const cfg = readJson(join(root, 'biome.json'));
  assert.ok(cfg.overrides.some((o) => o.include.includes('.adlc/**')));
  assert.equal(cfg.formatter.enabled, true);
});

test('ensureFormatterIgnores is idempotent on biome.json (no duplicate override)', () => {
  const root = mkRepo();
  writeFileSync(join(root, 'biome.json'), JSON.stringify({}));
  ensureFormatterIgnores(root);
  const { biome } = ensureFormatterIgnores(root);
  assert.equal(biome.changed, false);
  const cfg = readJson(join(root, 'biome.json'));
  assert.equal(cfg.overrides.length, 1);
});

test('ensureFormatterIgnores appends .adlc/ to an existing .prettierignore', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.prettierignore'), 'dist/\n');
  const { prettier } = ensureFormatterIgnores(root);
  assert.equal(prettier.changed, true);
  const body = readFileSync(join(root, '.prettierignore'), 'utf8');
  assert.match(body, /^dist\/$/m);
  assert.match(body, /^\.adlc\/$/m);
});

test('ensureFormatterIgnores adds ignorePatterns to an existing .eslintrc.json', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.eslintrc.json'), JSON.stringify({ extends: ['eslint:recommended'] }));
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, true);
  const cfg = readJson(join(root, '.eslintrc.json'));
  assert.ok(cfg.ignorePatterns.includes('.adlc/**'));
  assert.deepEqual(cfg.extends, ['eslint:recommended']);
});

test('ensureFormatterIgnores appends .adlc/ to an existing .eslintignore', () => {
  const root = mkRepo();
  writeFileSync(join(root, '.eslintignore'), 'dist/\n');
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, true);
  const body = readFileSync(join(root, '.eslintignore'), 'utf8');
  assert.match(body, /^dist\/$/m);
  assert.match(body, /^\.adlc\/$/m);
});

test('ensureFormatterIgnores detects but does not silently mutate a flat eslint.config.js', () => {
  const root = mkRepo();
  writeFileSync(join(root, 'eslint.config.js'), 'export default [];\n');
  const { eslint } = ensureFormatterIgnores(root);
  assert.equal(eslint.detected, true);
  assert.equal(eslint.changed, false);
  assert.ok(eslint.skipped, 'must document the manual fallback');
  const body = readFileSync(join(root, 'eslint.config.js'), 'utf8');
  assert.equal(body, 'export default [];\n'); // untouched
});

test('ensureFormatterIgnores reports BOTH .eslintrc.json and .eslintignore outcomes when a repo has both', () => {
  const root = mkRepo();
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

test('ensureFormatterIgnores reports nothing detected when no formatter/linter configs exist', () => {
  const root = mkRepo();
  const { biome, prettier, eslint } = ensureFormatterIgnores(root);
  assert.equal(biome.detected, false);
  assert.equal(prettier.detected, false);
  assert.equal(eslint.detected, false);
});
