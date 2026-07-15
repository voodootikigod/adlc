import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { integrationFor } from '../lib/integration-facts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const fumadocs = read('apps/docs/content/docs/integrations/codex.mdx');
const groundTruth = read('docs/integrations/codex.md');
const combinedDocs = `${fumadocs}\n${groundTruth}`;
const marketing = read('apps/docs/components/marketing/codex-integration.tsx');
const marketingRoute = read('apps/docs/app/(home)/integrations/[slug]/page.tsx');

test('Codex guides match the shipped native payload counts', () => {
  const skills = readdirSync(path.join(repoRoot, 'plugins/adlc-codex/skills'));
  const agents = readdirSync(path.join(repoRoot, 'plugins/adlc-codex/agents')).filter((name) => name.endsWith('.toml'));
  const hooks = Object.keys(JSON.parse(read('plugins/adlc-codex/hooks/hooks.json')).hooks);
  const mcpTools = read('plugins/adlc-codex/mcp/server.mjs').match(/^    name: 'adlc_[a-z_]+',$/gm) ?? [];
  const marketingCounts = Object.fromEntries(
    integrationFor('codex').surfaces.map((surface) => [surface.key, surface.count]),
  );
  assert.equal(skills.length, 6);
  assert.equal(agents.length, 3);
  assert.equal(hooks.length, 8);
  assert.equal(mcpTools.length, 2);
  assert.deepEqual(marketingCounts, { skills: skills.length, hooks: hooks.length, mcp: mcpTools.length, agents: agents.length });
  assert.match(fumadocs, /six progressive-disclosure skills/);
  assert.match(fumadocs, /eight Codex lifecycle/);
  assert.match(fumadocs, /three project-agent templates/);
});

test('Codex guides carry current install, update, and legacy recovery commands', () => {
  for (const command of [
    'node packages/init/bin/adlc-init.mjs --root /absolute/path/to/project',
    'codex plugin marketplace add "$PWD"',
    'codex plugin marketplace add voodootikigod/adlc --ref main',
    'codex plugin add adlc-codex@adlc',
    'codex plugin marketplace upgrade adlc',
    'codex plugin remove adlc@plugins-cli',
  ]) assert.match(combinedDocs, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Codex marketing page exposes the native surfaces instead of the generic install-only page', () => {
  assert.match(marketingRoute, /integration\.slug === 'codex'/);
  assert.match(marketing, /Native surfaces/);
  assert.match(marketing, /Phase routing/);
  assert.match(marketing, /Frozen rails/);
  assert.match(marketing, /adlc-codex\//);
  assert.match(marketing, /├─ \.codex-plugin\/plugin\.json/);
  assert.match(marketing, /codex plugin marketplace upgrade adlc/);
  assert.match(marketing, /codex plugin remove adlc@plugins-cli/);
  assert.match(marketing, /developers\.openai\.com\/codex\/build-plugins/);
});

test('unpublished initializer paths are labeled and have a working checkout command', () => {
  const installDocs = `${combinedDocs}\n${read('apps/docs/content/docs/getting-started.mdx')}\n${read('plugins/adlc-codex/README.md')}`;
  assert.match(installDocs, /does not publish|not in the older\s+registry release/);
  assert.match(installDocs, /node packages\/init\/bin\/adlc-init\.mjs --root \/absolute\/path\/to\/project/);
  assert.match(installDocs, /\$adlc-init[^.]*becomes available with that release/);
});

test('Codex docs reject superseded checkout-only and environment-only claims', () => {
  assert.doesNotMatch(combinedDocs, /five phase skills|exactly two Codex surfaces|Git-backed marketplace install is not supported|no user-facing install path/i);
  assert.doesNotMatch(combinedDocs, /inactive.*unless `ADLC_P4_ENFORCEMENT=1`/is);
});

test('model guidance does not claim an unpinned model powers Codex', () => {
  const modelDocs = `${read('docs/models-by-phase.md')}\n${read('apps/docs/content/docs/reference/models-by-phase.mdx')}`;
  assert.doesNotMatch(modelDocs, /powers Codex/);
  assert.match(modelDocs, /GPT-5\.4 is this repository's operator default/);
  assert.match(modelDocs, /official catalog also documents\s+the GPT-5\.6 family/);
  assert.match(modelDocs, /https:\/\/developers\.openai\.com\/api\/docs\/models/);
  assert.match(modelDocs, /plugin does not select or pin a Codex model/);
  assert.doesNotMatch(modelDocs, /\| cheap \| Mistral Small 3\.2|Codestral \(\$/);
  assert.match(modelDocs, /Mistral Small 4/);
  assert.match(modelDocs, /Gemini 3\.1 Pro Preview/);
  assert.match(modelDocs, /do not make it a production gate dependency/);
});

test('homepage metadata distinguishes deterministic and human gates', () => {
  const homepage = `${read('apps/docs/app/(home)/page.tsx')}\n${read('apps/docs/lib/routes.mjs')}\n${read('apps/docs/lib/vs-sdlc.mjs')}`;
  assert.doesNotMatch(homepage, /machine-checkable (?:gate|artifacts) at every phase/);
  assert.match(homepage, /deterministic gates produce evidence, and human gates record attestation/);
});
