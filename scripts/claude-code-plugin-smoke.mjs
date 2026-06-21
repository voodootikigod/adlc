#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`claude-code-plugin-smoke: ${message}`);
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read ${path}: ${err.message}`);
  }
}

const repo = resolve(process.argv[2] ?? '.');

// --- marketplace.json ---
const marketplacePath = join(repo, '.claude-plugin/marketplace.json');
if (!existsSync(marketplacePath)) fail('missing .claude-plugin/marketplace.json');
const marketplace = readJson(marketplacePath);
if (!marketplace.name) fail('marketplace.json missing "name" field');
const entry = marketplace.plugins?.find((p) => p.name === 'adlc');
if (!entry) fail('marketplace.json missing plugin entry with name "adlc"');
if (entry.source !== './') fail(`marketplace plugin entry "source" must be "./" (got ${JSON.stringify(entry.source)})`);

// --- plugin.json metadata ---
const pluginPath = join(repo, '.claude-plugin/plugin.json');
if (!existsSync(pluginPath)) fail('missing .claude-plugin/plugin.json');
const plugin = readJson(pluginPath);
if (!plugin.name) fail('plugin.json missing "name" field');
if (!plugin.version) fail('plugin.json missing "version" field');
if (!plugin.description) fail('plugin.json missing "description" field');
if (!plugin.homepage) fail('plugin.json missing "homepage" field');
// Verify homepage does not point at the superseded planning doc
if (plugin.homepage.includes('claude-code-integration-plan')) {
  fail(`plugin.json "homepage" points at the superseded planning doc (${plugin.homepage}); update to docs/claude-code.md`);
}

// --- hooks/hooks.json ---
const hooksConfigPath = join(repo, 'hooks/hooks.json');
if (!existsSync(hooksConfigPath)) fail('missing hooks/hooks.json');
const hooksConfig = readJson(hooksConfigPath);
const hooks = hooksConfig.hooks ?? {};

if (!Array.isArray(hooks.PreToolUse) || hooks.PreToolUse.length === 0) {
  fail('hooks/hooks.json must register at least one PreToolUse hook');
}
// SessionStart, PostToolUse, and Stop must each have at least one entry invoking adlc-hook.mjs
for (const eventType of ['SessionStart', 'PostToolUse', 'Stop']) {
  const entries = hooks[eventType];
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`hooks/hooks.json must register at least one ${eventType} hook`);
  }
  const hasHookCmd = entries.some(
    (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command?.includes('adlc-hook.mjs'))
  );
  if (!hasHookCmd) {
    fail(`hooks/hooks.json ${eventType} must contain at least one hook invoking adlc-hook.mjs`);
  }
}

// rails PreToolUse hook must match the structured-edit tools
const railsEntry = hooks.PreToolUse.find((e) => {
  const matcher = e.matcher ?? '';
  return matcher.includes('Edit') && matcher.includes('Write');
});
if (!railsEntry) {
  fail('hooks/hooks.json PreToolUse must include a matcher covering Edit and Write (rails-guard)');
}
const railsHookCmd = railsEntry.hooks?.find((h) => h.command?.includes('adlc-hook.mjs'));
if (!railsHookCmd) {
  fail('hooks/hooks.json PreToolUse rails entry must invoke adlc-hook.mjs');
}

// --- hooks/adlc-hook.mjs ---
const hookPath = join(repo, 'hooks/adlc-hook.mjs');
if (!existsSync(hookPath)) fail('missing hooks/adlc-hook.mjs');
const hookSource = readFileSync(hookPath, 'utf8');
// Strip block comments and line comments before checking for @adlc/* imports so
// that multi-line imports are found and comment text does not cause false positives.
const strippedHookSource = hookSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
// Detect static imports (from '@adlc/'), CJS require(), and dynamic import() of @adlc/* packages.
if (
  /from\s+['"]@adlc\//.test(strippedHookSource) ||
  /require\s*\(\s*['"]@adlc\//.test(strippedHookSource) ||
  /import\s*\(\s*['"]@adlc\//.test(strippedHookSource)
) {
  fail('hooks/adlc-hook.mjs must not import @adlc/* packages (hook must remain zero-dependency)');
}

// --- commands ---
const requiredCommands = ['adlc-init.md', 'adlc-ticket.md', 'adlc-distill.md', 'adlc-maintain.md'];
for (const cmd of requiredCommands) {
  if (!existsSync(join(repo, 'commands', cmd))) fail(`missing commands/${cmd}`);
}

// --- agents ---
if (!existsSync(join(repo, 'agents/prosecutor.md'))) fail('missing agents/prosecutor.md');

// --- skills/adlc/SKILL.md + sentinel ---
const skillPath = join(repo, 'skills/adlc/SKILL.md');
if (!existsSync(skillPath)) fail('missing skills/adlc/SKILL.md');
const skillSource = readFileSync(skillPath, 'utf8');
if (!skillSource.includes('ADLC_CC_SENTINEL_PHASE_ROUTER_V1')) {
  fail('skills/adlc/SKILL.md missing sentinel ADLC_CC_SENTINEL_PHASE_ROUTER_V1');
}

console.log(JSON.stringify({
  ok: true,
  pluginJson: pluginPath,
  marketplaceJson: marketplacePath,
  hooksJson: hooksConfigPath,
  hookTypes: Object.keys(hooks),
  commands: requiredCommands,
  agents: ['prosecutor.md'],
  skills: ['adlc/SKILL.md'],
}, null, 2));
