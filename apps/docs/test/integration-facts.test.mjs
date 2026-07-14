import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { INTEGRATIONS, integrationFor } from '../lib/integration-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..');

test('slugs are unique', () => {
  const slugs = INTEGRATIONS.map((i) => i.slug);
  assert.equal(new Set(slugs).size, INTEGRATIONS.length);
});

test('module covers every docs-site integration page (derived, not hardcoded)', () => {
  // Bidirectional grounding: a new content/docs/integrations/<slug>.mdx page
  // without a marketing entry fails here, pointing at exactly what to add.
  const pagesDir = path.join(__dirname, '..', 'content', 'docs', 'integrations');
  const pageSlugs = readdirSync(pagesDir)
    .filter((f) => f.endsWith('.mdx') && f !== 'index.mdx')
    .map((f) => f.replace(/\.mdx$/, ''))
    .sort();
  const moduleSlugs = INTEGRATIONS.map((i) => i.slug).sort();
  assert.deepEqual(moduleSlugs, pageSlugs);
});

test('every integration is grounded in a docs/integrations ground-truth file', () => {
  for (const i of INTEGRATIONS) {
    const p = path.join(repoRoot, 'docs', 'integrations', `${i.slug}.md`);
    assert.ok(existsSync(p), `${i.slug}: missing ground truth ${p}`);
  }
});

test('every integration has a name, tagline, valid status, and at least one install command', () => {
  for (const i of INTEGRATIONS) {
    assert.ok(i.name.length > 0, `${i.slug}: name`);
    assert.ok(i.tagline.length > 0, `${i.slug}: tagline`);
    assert.ok(['installer', 'source', 'local'].includes(i.status), `${i.slug}: status "${i.status}"`);
    assert.ok(Array.isArray(i.install) && i.install.length > 0, `${i.slug}: install commands`);
    for (const cmd of i.install) assert.ok(cmd.trim().length > 0, `${i.slug}: empty install command`);
  }
});

test('integrationFor resolves known slugs and returns undefined for unknown', () => {
  assert.equal(integrationFor('claude-code')?.name, 'Claude Code');
  assert.equal(integrationFor('nope'), undefined);
});

test('Codex marketing facts describe the native marketplace surface', () => {
  const codex = integrationFor('codex');
  assert.equal(codex?.status, 'source');
  assert.deepEqual(codex?.install, [
    'git clone https://github.com/voodootikigod/adlc.git && cd adlc',
    'npm install --ignore-scripts',
    'npm install -g @adlc/cli',
    'node packages/init/bin/adlc-init.mjs --root /absolute/path/to/project',
    'codex plugin marketplace add "$PWD"',
    'codex plugin add adlc-codex@adlc',
  ]);
  assert.match(codex?.tagline ?? '', /six skills/);
  assert.match(codex?.tagline ?? '', /MCP gates/);
});
