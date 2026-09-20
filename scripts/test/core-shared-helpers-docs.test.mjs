import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// POLICY_DOCS enumerates the canonical repository-wide policy and contract documents.
// Individual package READMEs that document legacy local helper copies (the "Core gaps"
// sections in coldstart, model-router, etc.) are retired in dedicated follow-up
// helper promotion lanes (#139, #937, #731) as each helper is promoted into @adlc/core.
const POLICY_DOCS = [
  'CONVENTIONS.md',
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'packages/core/README.md',
  'docs/tools/core.md',
  'apps/docs/content/docs/reference/conventions.mdx',
  'apps/docs/content/docs/reference/index.mdx',
  'apps/docs/content/docs/toolkit/index.mdx',
  'apps/docs/content/docs/toolkit/core.mdx',
];

const REPEALED = [
  /\bcore\b[^.\n]{0,40}\bfrozen\b/i,
  /\bfrozen[ -](core|contract|shared)\b/i,
  /package is frozen/i,
  /core gaps/i,
  /do not edit core/i,
];

test('REPEALED patterns match historical core-freeze lines and spare live rail lines', () => {
  const OLD_SAMPLES = [
    '2. **Core is frozen to ADDITIONS.** Never *add* to `packages/core/`. If core',
    '2. **`@adlc/core` is frozen.** Never edit `packages/core/`. If core lacks something,',
    '- [ ] `packages/core/` is unchanged (it is frozen).',
    '# @adlc/core — FROZEN CONTRACT',
    'Shared library for all ADLC tools. **This package is frozen during tool',
    'the gap in your README — do not edit core.',
    'your README under "Core gaps".',
    'layout, zero dependencies, frozen core, `--json`/`--prompt-only`',
    '| [core](/docs/toolkit/core) | Frozen shared library: exit-code helpers |',
    'The full import surface and frozen-contract notes:',
  ];
  const LIVE_SAMPLES = [
    '| rail-freeze | no frozen rail edited, and no *existing* ticket changed |',
    '| [rails-guard](/docs/toolkit/rails-guard) | Enforce frozen rails, declared suppressions, and manifest recording. |',
    'rejects any PR that edits a path frozen on the base branch.',
  ];

  for (const sample of OLD_SAMPLES) {
    const matched = REPEALED.some((rx) => rx.test(sample));
    assert.ok(matched, `Expected sample to match at least one REPEALED pattern: ${sample}`);
  }

  for (const sample of LIVE_SAMPLES) {
    const matched = REPEALED.some((rx) => rx.test(sample));
    assert.strictEqual(matched, false, `Expected live sample NOT to match any REPEALED pattern: ${sample}`);
  }
});

for (const relPath of POLICY_DOCS) {
  test(`${relPath} contains no repealed core-freeze statements`, () => {
    const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const lines = content.split('\n');
    const hits = [];
    lines.forEach((line, idx) => {
      if (REPEALED.some((rx) => rx.test(line))) {
        hits.push(`${relPath}:${idx + 1}: ${line}`);
      }
    });
    assert.strictEqual(
      hits.length,
      0,
      `Found repealed core-freeze statements:\n${hits.join('\n')}`
    );
  });
}

test('CONVENTIONS.md teaches helper promotion and keeps defect-fix guidance', () => {
  const content = fs.readFileSync(path.join(ROOT, 'CONVENTIONS.md'), 'utf8');
  assert.match(content, /^2\. \*\*Shared helpers live in core\.\*\*/m);
  assert.match(content, /\*\*A defect in a core primitive is fixed in core\*\*/);
  assert.match(content, /#1005/);
  assert.match(content, /packages\/core\/test\//);
  assert.match(content, /no runtime dependency/);
});

test('CONTRIBUTING.md and conventions.mdx carry rule-2 heading', () => {
  const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /^2\. \*\*Shared helpers live in `@adlc\/core`\.\*\*/m);

  const conventionsMdx = fs.readFileSync(path.join(ROOT, 'apps/docs/content/docs/reference/conventions.mdx'), 'utf8');
  assert.match(conventionsMdx, /^2\. \*\*Shared helpers live in core\.\*\*/m);
});

test('docs/tools/core.md mirrors the core README introduction verbatim', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'packages/core/README.md'), 'utf8');
  const mirror = fs.readFileSync(path.join(ROOT, 'docs/tools/core.md'), 'utf8');
  const readmeParagraph = readme.split('\n\n')[1];
  assert.ok(readmeParagraph && readmeParagraph.length > 80, 'README paragraph should be > 80 chars');
  assert.ok(mirror.includes(readmeParagraph), 'docs/tools/core.md must include the README first paragraph verbatim');
});
