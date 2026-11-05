// deployed-doc-links.test.mjs — links in deployed plugin markdown must resolve
// where the file is read (T-01M6MX13GCQYV7VGD9VRQHE35V,
// .adlc/specs/deployed-doc-links.md).
//
// Plugin markdown is copied out of this repository: into a consumer's
// .opencode/skills/, .cursor/, the Claude Code plugin cache, or a skills.sh
// install. A relative link that climbs out of the plugin directory
// (../../../docs/...) resolves here and dangles everywhere else. Links to this
// repo's docs are absolute GitHub URLs pinned to main, so (b) also checks that
// the target still exists here: moving a doc turns this test red instead of
// silently breaking every installed copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractClaims } from '../../packages/skill-rot/lib/extract-claims.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_BLOB = /^https:\/\/github\.com\/voodootikigod\/adlc\/(?:blob|tree)\/main\/([^?#]+)/;

/** Tracked markdown that a plugin or skills.sh deploys, with the directory it is deployed with. */
export function deployedMarkdown(files) {
  const out = [];
  for (const file of files) {
    if (!/\.(md|mdc)$/.test(file)) continue;
    const parts = file.split('/');
    if (parts.length < 3 || !['plugins', 'skills'].includes(parts[0])) continue;
    if (parts.includes('test') || parts.includes('node_modules')) continue;
    if (parts[0] === 'plugins' && /^(README|CHANGELOG)\.md$/.test(parts.at(-1))) continue;
    out.push({ file, root: parts.slice(0, 2).join('/') });
  }
  return out;
}

/** Every inline markdown link target in `text`, with its line number. */
export function linkTargets(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

/** Problems with one file's links: escapes, missing relative targets, and dead repo URLs. */
export function linkProblems({ file, root }, text, exists) {
  const problems = [];
  for (const { target, line } of linkTargets(text)) {
    const where = `${file}:${line} -> ${target}`;
    const repoUrl = REPO_BLOB.exec(target);
    if (repoUrl) {
      const path = decodeURIComponent(repoUrl[1]).replace(/\/$/, '');
      if (!exists(path)) problems.push(`${where}: no ${path} in this repo`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
    const path = target.split('#')[0];
    if (!path) continue;
    const resolved = relative(REPO, resolve(REPO, dirname(file), decodeURIComponent(path))).split(sep).join('/');
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      problems.push(`${where}: resolves to ${resolved}, outside ${root}/ (dangles once deployed)`);
    } else if (!exists(resolved)) {
      problems.push(`${where}: no ${resolved}`);
    }
  }
  return problems;
}

const existsInRepo = (path) => existsSync(join(REPO, path));

test('deployed plugin and skill markdown has no link that dangles once deployed (AC3a, AC3b)', () => {
  const files = execFileSync('git', ['ls-files', 'plugins', 'skills'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
  const deployed = deployedMarkdown(files);
  assert.ok(deployed.length > 50, `expected the deployed markdown set, found ${deployed.length} files`);
  const problems = deployed.flatMap((d) => linkProblems(d, readFileSync(join(REPO, d.file), 'utf8'), existsInRepo));
  assert.deepEqual(problems, []);
});

test('the checks bite: an escaping link, a missing target and a dead repo URL are all reported (AC3c)', () => {
  const d = { file: 'plugins/adlc-x/skill/adlc.md', root: 'plugins/adlc-x' };
  const exists = (path) => path === 'docs/real.md' || path === 'plugins/adlc-x/skill/near.md';
  const text = [
    'See [a](../../../docs/integrations/x.md).',
    'See [b](./missing.md) and [c](near.md) and [d](#anchor).',
    'See [e](https://github.com/voodootikigod/adlc/blob/main/docs/gone.md) and [f](https://github.com/voodootikigod/adlc/blob/main/docs/real.md#top).',
    'See [g](https://example.com/x).',
  ].join('\n');
  const problems = linkProblems(d, text, exists);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0], /:1 -> \.\.\/\.\.\/\.\.\/docs\/integrations\/x\.md: resolves to docs\/integrations\/x\.md, outside plugins\/adlc-x\//);
  assert.match(problems[1], /:2 -> \.\/missing\.md: no plugins\/adlc-x\/skill\/missing\.md/);
  assert.match(problems[2], /:3 -> .*docs\/gone\.md: no docs\/gone\.md in this repo/);
});

test('deployedMarkdown keeps deployed files and drops READMEs, CHANGELOGs, tests and non-markdown', () => {
  const kept = deployedMarkdown([
    'plugins/adlc-x/skill/adlc.md',
    'plugins/adlc-x/rules/adlc.mdc',
    'plugins/adlc-x/README.md',
    'plugins/adlc-x/CHANGELOG.md',
    'plugins/adlc-x/test/fixture.md',
    'plugins/adlc-x/lib/x.mjs',
    'skills/adlc/SKILL.md',
    'skills/adlc/README.md',
    'docs/integrations/x.md',
    'README.md',
  ]);
  assert.deepEqual(kept, [
    { file: 'plugins/adlc-x/skill/adlc.md', root: 'plugins/adlc-x' },
    { file: 'plugins/adlc-x/rules/adlc.mdc', root: 'plugins/adlc-x' },
    { file: 'skills/adlc/SKILL.md', root: 'skills/adlc' },
    { file: 'skills/adlc/README.md', root: 'skills/adlc' },
  ]);
});

test('the deployed prosecutor agents link the text-scanning lens by its absolute main URL (AC2)', () => {
  const url = 'https://github.com/voodootikigod/adlc/blob/main/docs/review-lenses/text-scanning-gates.md';
  for (const file of ['plugins/adlc-cursor/agents/prosecutor.md', 'plugins/adlc-claude-code/agents/prosecutor.md']) {
    const targets = linkTargets(readFileSync(join(REPO, file), 'utf8')).map((l) => l.target);
    assert.ok(targets.includes(url), `${file} links ${url}`);
  }
});

test('the deployed OpenCode router yields no docs/ path claim for skill-rot (AC4)', () => {
  const text = readFileSync(join(REPO, 'plugins/adlc-opencode/skill/adlc.md'), 'utf8');
  const docPaths = extractClaims(text).filter((c) => c.type === 'path' && c.value.startsWith('docs/'));
  assert.deepEqual(docPaths, []);
});
