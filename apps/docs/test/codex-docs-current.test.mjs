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
const marketing = read('apps/docs/components/marketing/integration-detail.tsx');
const marketingRoute = read('apps/docs/app/(home)/integrations/[slug]/page.tsx');
const facts = read('apps/docs/lib/integration-facts.mjs');

test('Codex guides match the shipped native payload counts', () => {
  const skills = readdirSync(path.join(repoRoot, 'plugins/adlc-codex/skills'));
  const agents = readdirSync(path.join(repoRoot, 'plugins/adlc-codex/agents')).filter((name) => name.endsWith('.toml'));
  const hooks = Object.keys(JSON.parse(read('plugins/adlc-codex/hooks/hooks.json')).hooks);
  const mcpTools = read('packages/cli/lib/mcp-server.mjs').match(/^    name: 'adlc_[a-z_]+',$/gm) ?? [];
  const marketingCounts = Object.fromEntries(
    integrationFor('codex').surfaces.map((surface) => [surface.key, surface.count]),
  );
  assert.equal(skills.length, 6);
  assert.equal(agents.length, 9);
  assert.equal(hooks.length, 8);
  assert.equal(mcpTools.length, 2);
  assert.deepEqual(marketingCounts, { skills: skills.length, hooks: hooks.length, mcp: mcpTools.length, agents: agents.length });
  assert.match(fumadocs, /six progressive-disclosure skills/);
  assert.match(fumadocs, /eight Codex lifecycle/);
  assert.match(fumadocs, /nine project-agent templates/);
});

test('Codex guides carry current install, update, and legacy recovery commands', () => {
  for (const command of [
    'npm install -g @adlc/cli@latest',
    'codex plugin marketplace add voodootikigod/adlc --ref main',
    'codex plugin add adlc-codex@adlc',
    'adlc init --root /absolute/path/to/project',
    'codex plugin marketplace upgrade adlc',
    'codex plugin remove adlc@plugins-cli',
  ]) assert.match(combinedDocs, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The documented floor is the handoff gate's, not the MCP transport's: below
  // 1.11.0 the gate fails closed and denies every mutating tool call, so a doc
  // naming the old 1.4.2 MCP floor as THE floor strands whoever follows it.
  // Asserted per-document — matching the concatenation let one of the two go
  // stale while the other kept the assertion green.
  for (const [name, doc] of [['codex.mdx', fumadocs], ['docs/integrations/codex.md', groundTruth]]) {
    assert.match(doc, /@adlc\/cli`\s+1\.11\.0 or newer/, `${name} must document the 1.11.0 handoff-gate floor`);
  }
  assert.match(integrationFor('codex').note, /1\.11\.0 or newer/);
});

test('Codex marketing page exposes the native surfaces instead of the generic install-only page', () => {
  assert.match(marketingRoute, /IntegrationDetailPage/);
  assert.doesNotMatch(marketingRoute, /IntegrationCard/);
  // Fact object carries the section kickers the shared layout reads; the layout
  // source must still wire those fields into MarketingSection (source contract).
  const codex = integrationFor('codex');
  assert.equal(codex.surfacesSection.kicker, 'Native surfaces');
  assert.equal(codex.phaseSection.kicker, 'Phase routing');
  assert.equal(codex.railsSection.kicker, 'Frozen rails');
  assert.match(marketing, /kicker=\{integration\.surfacesSection\.kicker\}/);
  assert.match(marketing, /kicker=\{integration\.phaseSection\.kicker\}/);
  assert.match(marketing, /kicker=\{integration\.railsSection\.kicker\}/);
  assert.match(marketing, /const \{ bundle \} = integration/);
  assert.match(marketing, /integration\.operate/);
  assert.match(marketing, /<NativeSurfaces integration=\{integration\} \/>/);
  assert.match(marketing, /<PhaseRouting integration=\{integration\} \/>/);
  assert.match(marketing, /<EnforcementBoundary integration=\{integration\} \/>/);
  assert.ok(codex.bundle.entries.some((e) => e.path.includes('.codex-plugin/plugin.json')));
  assert.ok(codex.operate.lines.includes('codex plugin marketplace upgrade adlc'));
  assert.ok(codex.operate.lines.includes('codex plugin remove adlc@plugins-cli'));
  assert.ok(codex.resources.some((r) => r.href.includes('developers.openai.com/codex/build-plugins')));
  assert.match(facts, /export const CODEX_INTEGRATION/);
});

test('every marketing integration page uses the shared rich detail layout', () => {
  assert.match(marketingRoute, /IntegrationDetailPage integration=\{integration\}/);
  for (const slug of ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'gemini']) {
    const fact = integrationFor(slug);
    assert.ok(fact?.surfaces?.length >= 3, `${slug} surfaces`);
    assert.ok(fact?.phaseRoutes?.length >= 4, `${slug} phaseRoutes`);
    assert.ok(fact?.enforcement?.ci?.body, `${slug} ci enforcement`);
    assert.equal(fact?.surfacesSection?.kicker, 'Native surfaces', `${slug} surfaces kicker`);
    assert.equal(fact?.phaseSection?.kicker, 'Phase routing', `${slug} phase kicker`);
    assert.equal(fact?.railsSection?.kicker, 'Frozen rails', `${slug} rails kicker`);
  }
});

test('published Codex install paths are npm-first and do not require a checkout', () => {
  const gettingStarted = read('apps/docs/content/docs/getting-started.mdx');
  for (const installDocs of [fumadocs, groundTruth, gettingStarted]) {
    assert.match(installDocs, /npm install -g @adlc\/cli@latest/);
    assert.match(installDocs, /adlc init --root \/absolute\/path\/to\/project/);
    assert.doesNotMatch(installDocs, /git clone https:\/\/github\.com\/voodootikigod\/adlc\.git/);
    assert.doesNotMatch(installDocs, /node packages\/init\/bin\/adlc-init\.mjs/);
  }
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
