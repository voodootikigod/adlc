import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const integrationsDir = path.join(__dirname, '..', 'content', 'docs', 'integrations');

const HARNESSES = ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'antigravity'];

test('antigravity.mdx exists in the integrations directory', () => {
  const p = path.join(integrationsDir, 'antigravity.mdx');
  assert.ok(existsSync(p), 'apps/docs/content/docs/integrations/antigravity.mdx should exist');
});

test('antigravity.mdx has real frontmatter (title + description) and is not a stub', () => {
  const p = path.join(integrationsDir, 'antigravity.mdx');
  const content = readFileSync(p, 'utf8');

  assert.match(content, /^---\n/, 'file should start with frontmatter');
  assert.match(content, /^title:\s*.+$/m, 'frontmatter should declare a title');
  assert.match(content, /^description:\s*.+$/m, 'frontmatter should declare a description');

  assert.doesNotMatch(
    content,
    /coming soon/i,
    'antigravity.mdx should be real content, not the "coming soon" stub'
  );
  assert.doesNotMatch(
    content,
    /This page is being written/i,
    'antigravity.mdx should be real content, not the stub body'
  );

  // Spot-check a couple of facts that must survive the port from docs/integrations/antigravity.md
  assert.match(content, /rails-guard-ci\.mjs/, 'should mention the CI rail-freeze gate script');
  assert.match(content, /ADLC_P4_ENFORCEMENT/, 'should mention the enforcement env var');
});

test("meta.json's pages array includes antigravity alongside the other five harnesses", () => {
  const p = path.join(integrationsDir, 'meta.json');
  const meta = JSON.parse(readFileSync(p, 'utf8'));

  assert.ok(Array.isArray(meta.pages), 'meta.json should have a pages array');
  assert.ok(meta.pages.includes('antigravity'), 'pages array should include "antigravity"');

  for (const harness of HARNESSES) {
    assert.ok(meta.pages.includes(harness), `pages array should include "${harness}"`);
  }
});

test('index.mdx is a real landing page (no "coming soon" stub) enumerating all six harnesses', () => {
  const p = path.join(integrationsDir, 'index.mdx');
  const content = readFileSync(p, 'utf8');

  assert.doesNotMatch(content, /coming soon/i, 'index.mdx should no longer be the stub');
  assert.doesNotMatch(content, /This page is being written/i, 'index.mdx should no longer be the stub body');

  for (const harness of HARNESSES) {
    assert.match(
      content,
      new RegExp(`\\(/docs/integrations/${harness}\\)`),
      `index.mdx should link to /docs/integrations/${harness}`
    );
  }
});

test('index.mdx discloses that the stub harness pages (codex, cursor, opencode, pi) are still being written', () => {
  const p = path.join(integrationsDir, 'index.mdx');
  const content = readFileSync(p, 'utf8');

  const STUB_HARNESSES = ['codex', 'cursor', 'opencode', 'pi'];
  const WRITTEN_HARNESSES = ['claude-code', 'antigravity'];

  for (const harness of STUB_HARNESSES) {
    const bulletMatch = content.match(
      new RegExp(`- \\*\\*\\[[^\\]]+\\]\\(/docs/integrations/${harness}\\)\\*\\*[\\s\\S]*?(?=\\n- \\*\\*|\\n\\nSee)`)
    );
    assert.ok(bulletMatch, `index.mdx should have a bullet for ${harness}`);
    assert.match(
      bulletMatch[0],
      /full walkthrough still being written/,
      `the ${harness} bullet should disclose that its full walkthrough is still being written`
    );
  }

  // The two harnesses with real, complete pages must NOT carry the disclosure —
  // otherwise it would misleadingly undersell finished documentation.
  for (const harness of WRITTEN_HARNESSES) {
    const bulletMatch = content.match(
      new RegExp(`- \\*\\*\\[[^\\]]+\\]\\(/docs/integrations/${harness}\\)\\*\\*[\\s\\S]*?(?=\\n- \\*\\*|\\n\\nSee)`)
    );
    assert.ok(bulletMatch, `index.mdx should have a bullet for ${harness}`);
    assert.doesNotMatch(
      bulletMatch[0],
      /still being written/,
      `the ${harness} bullet documents a finished page and should not claim it is still being written`
    );
  }
});
