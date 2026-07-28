import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { INTEGRATIONS, integrationFor } from '../lib/integration-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..');

function listEntries(relDir, { dirs = false, files = false, ext = null } = {}) {
  const abs = path.join(repoRoot, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).filter((entry) => {
    if (dirs && !entry.isDirectory()) return false;
    if (files && !entry.isFile()) return false;
    if (ext && !entry.name.endsWith(ext)) return false;
    return !entry.name.startsWith('.');
  });
}

const HOOK_EVENT_NAMES = new Set([
  'PreToolUse', 'PostToolUse', 'SessionStart', 'Stop',
  'preToolUse', 'afterFileEdit', 'beforeShellExecution', 'stop', 'beforeSubmitPrompt',
  'sessionStart', 'preCompact', 'subagentStart', 'subagentStop',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop',
]);

function hookEventCount(pluginDir) {
  for (const candidate of ['hooks/hooks.json', 'hooks.json']) {
    const abs = path.join(repoRoot, pluginDir, candidate);
    if (!existsSync(abs)) continue;
    const json = JSON.parse(readFileSync(abs, 'utf8'));
    // Codex/Claude/Cursor: { hooks: { Event: [...] } }
    // Antigravity: { "hook-name": { PreToolUse: [...] } } — count known event keys only.
    if (json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks)) {
      const keys = Object.keys(json.hooks);
      const unknown = keys.filter((key) => !HOOK_EVENT_NAMES.has(key));
      if (unknown.length > 0) {
        throw new Error(`${pluginDir}: unrecognized hook event(s): ${unknown.join(', ')}`);
      }
      return keys.length;
    }
    const nestedEvents = new Set();
    const unknown = new Set();
    for (const value of Object.values(json)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const key of Object.keys(value)) {
        if (HOOK_EVENT_NAMES.has(key)) nestedEvents.add(key);
        else unknown.add(key);
      }
    }
    if (unknown.size > 0) {
      throw new Error(`${pluginDir}: unrecognized nested hook event(s): ${[...unknown].join(', ')}`);
    }
    if (nestedEvents.size > 0) return nestedEvents.size;
    throw new Error(`${pluginDir}: hooks file present but no recognized events`);
  }
  throw new Error(`no hooks.json found under ${pluginDir}`);
}

function surfaceCount(integration, key) {
  return integration.surfaces.find((s) => s.key === key)?.count;
}

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
    assert.ok(['installer', 'source', 'local', 'marketplace'].includes(i.status), `${i.slug}: status "${i.status}"`);
    assert.ok(Array.isArray(i.install) && i.install.length > 0, `${i.slug}: install commands`);
    for (const cmd of i.install) assert.ok(cmd.trim().length > 0, `${i.slug}: empty install command`);
  }
});

test('every integration carries Codex-depth marketing structure', () => {
  for (const i of INTEGRATIONS) {
    assert.ok(i.hero?.kicker, `${i.slug}: hero.kicker`);
    assert.ok(i.hero?.title, `${i.slug}: hero.title`);
    assert.ok(i.hero?.identity, `${i.slug}: hero.identity`);
    assert.ok(Array.isArray(i.hero?.badges) && i.hero.badges.length >= 1, `${i.slug}: hero.badges`);
    assert.ok(
      i.hero.badges.some((b) => b.accent === true),
      `${i.slug}: hero has an accented (primary) badge`,
    );
    assert.ok(i.bundle?.title && i.bundle?.ariaLabel && i.bundle?.root, `${i.slug}: bundle meta`);
    assert.ok(Array.isArray(i.bundle.entries) && i.bundle.entries.length >= 3, `${i.slug}: bundle entries`);
    assert.ok(i.surfacesSection?.kicker && i.surfacesSection?.title, `${i.slug}: surfacesSection`);
    assert.ok(Array.isArray(i.surfaces) && i.surfaces.length >= 3, `${i.slug}: surfaces`);
    for (const surface of i.surfaces) {
      assert.ok(surface.key && surface.label && surface.title && surface.detail, `${i.slug}: surface fields`);
      assert.ok(Number.isInteger(surface.count) && surface.count > 0, `${i.slug}: surface.count`);
      assert.ok(Array.isArray(surface.items) && surface.items.length > 0, `${i.slug}: surface.items`);
      assert.equal(surface.items.length, surface.count, `${i.slug}: ${surface.key} items must match count`);
    }
    assert.ok(Array.isArray(i.phaseRoutes) && i.phaseRoutes.length >= 4, `${i.slug}: phaseRoutes`);
    assert.ok(i.phaseSection?.kicker && i.phaseSection?.title && i.phaseSection?.entryHeader && i.phaseSection?.intro, `${i.slug}: phaseSection`);
    assert.ok(i.enforcement?.session?.body && i.enforcement?.ci?.body, `${i.slug}: enforcement`);
    assert.ok(i.railsSection?.kicker && i.railsSection?.title, `${i.slug}: railsSection`);
    assert.ok(i.installSection?.kicker && i.installSection?.title, `${i.slug}: installSection`);
    assert.ok(Array.isArray(i.operate?.lines) && i.operate.lines.length > 0, `${i.slug}: operate`);
    assert.ok(Array.isArray(i.resources) && i.resources.length >= 2, `${i.slug}: resources`);
    assert.ok(i.resources.some((r) => r.href === `/docs/integrations/${i.slug}`), `${i.slug}: docs resource`);
    assert.ok(existsSync(path.join(repoRoot, i.pluginDir)), `${i.slug}: pluginDir ${i.pluginDir}`);
  }
});

test('integrationFor resolves known slugs and returns undefined for unknown', () => {
  assert.equal(integrationFor('claude-code')?.name, 'Claude Code');
  assert.equal(integrationFor('nope'), undefined);
});

test('filesystem-derived surface counts match marketing facts for every harness', () => {
  // Codex
  const codex = integrationFor('codex');
  assert.equal(surfaceCount(codex, 'skills'), listEntries('plugins/adlc-codex/skills', { dirs: true }).length);
  assert.equal(surfaceCount(codex, 'hooks'), hookEventCount('plugins/adlc-codex'));
  const codexHookKeys = Object.keys(JSON.parse(readFileSync(path.join(repoRoot, 'plugins/adlc-codex/hooks/hooks.json'), 'utf8')).hooks);
  assert.deepEqual(codex.surfaces.find((s) => s.key === 'hooks')?.items, codexHookKeys);
  assert.equal(surfaceCount(codex, 'agents'), listEntries('plugins/adlc-codex/agents', { files: true, ext: '.toml' }).length);
  const mcpTools = readFileSync(path.join(repoRoot, 'packages/cli/lib/mcp-server.mjs'), 'utf8')
    .match(/^    name: 'adlc_[a-z_]+',$/gm) ?? [];
  assert.equal(surfaceCount(codex, 'mcp'), mcpTools.length);

  // Claude Code
  const cc = integrationFor('claude-code');
  assert.equal(surfaceCount(cc, 'commands'), listEntries('plugins/adlc-claude-code/commands', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(cc, 'hooks'), hookEventCount('plugins/adlc-claude-code'));
  assert.equal(surfaceCount(cc, 'agents'), listEntries('plugins/adlc-claude-code/agents', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(cc, 'skill'), listEntries('plugins/adlc-claude-code/skills', { dirs: true }).length);

  // Cursor
  const cursor = integrationFor('cursor');
  assert.equal(surfaceCount(cursor, 'commands'), listEntries('plugins/adlc-cursor/command', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(cursor, 'hooks'), hookEventCount('plugins/adlc-cursor'));
  assert.equal(surfaceCount(cursor, 'skills'), listEntries('plugins/adlc-cursor/skills', { dirs: true }).length);
  assert.equal(surfaceCount(cursor, 'rules'), listEntries('plugins/adlc-cursor/rules', { files: true, ext: '.mdc' }).length);

  // OpenCode — command/agent dirs on disk; tools from builder return maps; hooks from plugin export keys
  const oc = integrationFor('opencode');
  assert.equal(surfaceCount(oc, 'commands'), listEntries('plugins/adlc-opencode/command', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(oc, 'agents'), listEntries('plugins/adlc-opencode/agent', { files: true, ext: '.md' }).length);
  const ocToolNames = ['gate-tool.mjs', 'prosecute-tool.mjs'].flatMap((file) => {
    const src = readFileSync(path.join(repoRoot, 'plugins/adlc-opencode/lib', file), 'utf8');
    const match = src.match(/return \{\s*([a-z_]+):\s*\{/m);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(ocToolNames.sort(), ['adlc_gate', 'adlc_prosecute']);
  assert.equal(surfaceCount(oc, 'tools'), ocToolNames.length);
  const ocIndex = readFileSync(path.join(repoRoot, 'plugins/adlc-opencode/index.mjs'), 'utf8');
  assert.match(ocIndex, /\.\.\.buildGateTool\(/);
  assert.match(ocIndex, /\.\.\.buildProsecuteTool\(/);
  const ocBeforeHooks = [...ocIndex.matchAll(/['"]tool\.execute\.before['"]\s*:/g)];
  // Marketing surfaces the enforcing before-hook(s) as the control tile.
  assert.equal(surfaceCount(oc, 'hooks'), ocBeforeHooks.length);

  // Pi — skills on disk; commands from registerCommand call sites
  const pi = integrationFor('pi');
  assert.equal(surfaceCount(pi, 'skills'), listEntries('plugins/adlc-pi/skills', { dirs: true }).length);
  const piSources = [
    readFileSync(path.join(repoRoot, 'plugins/adlc-pi/lib/extension.mjs'), 'utf8'),
    readFileSync(path.join(repoRoot, 'plugins/adlc-pi/lib/commands.mjs'), 'utf8'),
  ].join('\n');
  const piCommands = [...piSources.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.equal(surfaceCount(pi, 'commands'), new Set(piCommands).size);
  assert.ok(piCommands.includes('ticket'));
  assert.ok(piCommands.includes('adlc-ticket'));

  // Antigravity — prosecutor is an agent, not a second command
  const ag = integrationFor('antigravity');
  assert.equal(surfaceCount(ag, 'commands'), listEntries('plugins/adlc-antigravity/commands', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(ag, 'agents'), listEntries('plugins/adlc-antigravity/agents', { files: true, ext: '.md' }).length);
  assert.equal(surfaceCount(ag, 'skills'), listEntries('plugins/adlc-antigravity/skills', { dirs: true }).length);
  assert.equal(surfaceCount(ag, 'hooks'), hookEventCount('plugins/adlc-antigravity'));
  assert.equal(surfaceCount(ag, 'commands'), 3);
  assert.deepEqual(ag.surfaces.find((s) => s.key === 'commands')?.items, ['/adlc-init', '/adlc-status', '/adlc-doctor']);

  // Bundle notes that declare a surfaceKey must stay tied to that surface's count.
  for (const integration of INTEGRATIONS) {
    for (const entry of integration.bundle.entries) {
      if (!entry.surfaceKey) continue;
      const surface = integration.surfaces.find((s) => s.key === entry.surfaceKey);
      assert.ok(surface, `${integration.slug}: bundle surfaceKey ${entry.surfaceKey}`);
      assert.doesNotMatch(entry.note, /^\d+\b/, `${integration.slug}: bundle note must not hardcode a count`);
    }
  }
});

test('Cursor marketing facts describe the marketplace plugin install', () => {
  const cursor = integrationFor('cursor');
  assert.equal(cursor?.status, 'marketplace');
  assert.ok(cursor?.install.some((c) => c.includes('adlc init --harness cursor')));
  assert.ok(cursor?.install.some((c) => /adlc-cursor|marketplace/i.test(c)));
  assert.ok(!cursor?.install.some((c) => c.includes('git clone')), 'marketing install must not lead with a clone-from-source path');
  assert.match(cursor?.tagline ?? '', /marketplace|plugin/i);
  assert.match(cursor?.note ?? '', /marketplace|\.cursor-plugin/i);
});

test('Codex marketing facts describe the native marketplace surface', () => {
  const codex = integrationFor('codex');
  assert.equal(codex?.status, 'marketplace');
  assert.deepEqual(codex?.install, [
    'npm install -g @adlc/cli@latest',
    'codex plugin marketplace add voodootikigod/adlc --ref main',
    'codex plugin add adlc-codex@adlc',
    'adlc init --root /absolute/path/to/project',
  ]);
  assert.match(codex?.tagline ?? '', /native Codex plugin/);
  assert.deepEqual(codex?.phaseRoutes.map(({ phase, entry }) => [phase, entry]), [
    ['P0', '$adlc'],
    ['P1-P2', '$adlc-spec'],
    ['P3-P4', '$adlc-rail-build'],
    ['P5-P6', '$adlc-prosecute'],
    ['P7', '$adlc-distill'],
  ]);
  assert.match(codex?.note ?? '', /1\.4\.2 or newer/);
  assert.doesNotMatch(codex?.note ?? '', /checkout|unreleased/i);
  assert.equal(codex?.surfacesSection.kicker, 'Native surfaces');
  assert.equal(codex?.phaseSection.kicker, 'Phase routing');
  assert.equal(codex?.railsSection.kicker, 'Frozen rails');
  assert.ok(codex?.bundle.entries.some((e) => e.path.includes('.codex-plugin/plugin.json')));
  assert.ok(codex?.operate.lines.includes('codex plugin marketplace upgrade adlc'));
  assert.ok(codex?.operate.lines.includes('codex plugin remove adlc@plugins-cli'));
  assert.ok(codex?.resources.some((r) => r.href.includes('developers.openai.com/codex/build-plugins')));
});

test('Claude Code marketing facts describe slash commands and prosecutor panel', () => {
  const cc = integrationFor('claude-code');
  assert.equal(cc?.status, 'installer');
  assert.ok(cc?.install.some((c) => c.includes('npx plugins add')));
  assert.match(cc?.enforcement.session.body ?? '', /Bash is not gated/i);
});

test('OpenCode marketing facts claim enforce-by-default rails', () => {
  const oc = integrationFor('opencode');
  assert.match(oc?.tagline ?? '', /Enforce-by-default|enforcing/i);
  assert.match(oc?.enforcement.session.body ?? '', /Enforcing by default/i);
});

test('Pi marketing facts emphasize proactive/reactive gates and team install', () => {
  const pi = integrationFor('pi');
  assert.ok(pi?.install.some((c) => c.includes('pi install -l')));
  assert.ok(pi?.surfaces.some((s) => s.key === 'gates' && s.count === 2));
  assert.match(pi?.note ?? '', /teammates|trusted startup/i);
});

test('Antigravity marketing facts keep CI as the real backstop', () => {
  const ag = integrationFor('antigravity');
  assert.equal(ag?.status, 'local');
  assert.match(ag?.enforcement.session.body ?? '', /fail-open|Advisory/i);
  assert.match(ag?.enforcement.ci.body ?? '', /unbypassable|rails-guard-ci/i);
  assert.match(ag?.note ?? '', /ADLC_P4_ENFORCEMENT=1/);
  assert.match(ag?.note ?? '', /npm install -g @adlc\/antigravity/);
});

test('Pi marketing publication claim matches a non-private @adlc/pi package', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'plugins/adlc-pi/package.json'), 'utf8'));
  assert.equal(pkg.name, '@adlc/pi');
  assert.notEqual(pkg.private, true);
  assert.match(integrationFor('pi')?.installSection.title ?? '', /published @adlc\/pi/i);
});

test('each marketing install command appears in the matching docs-site mdx guide', () => {
  for (const integration of INTEGRATIONS) {
    const mdx = readFileSync(
      path.join(repoRoot, 'apps/docs/content/docs/integrations', `${integration.slug}.mdx`),
      'utf8',
    );
    for (const line of integration.install) {
      if (line.startsWith('#')) continue;
      // Marketing may chain with &&; docs may split across lines — require each segment.
      for (const segment of line.split(/\s*&&\s*/).map((s) => s.trim()).filter(Boolean)) {
        assert.ok(
          mdx.includes(segment),
          `${integration.slug}: docs mdx missing install segment ${segment}`,
        );
      }
    }
  }
});
