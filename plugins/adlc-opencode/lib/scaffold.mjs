// scaffold.mjs — deterministic /adlc-init scaffolding for OpenCode.
//
// Two jobs, both idempotent and non-clobbering (integration-plan §4.1 / §7
// Phase A):
//   1. ensure .adlc/config.json exists with safe defaults;
//   2. deploy the plugin's command + skill sources into the project's
//      .opencode/ directory so OpenCode discovers them.
//
// Pure-ish: every function takes explicit roots, so it is unit-testable against
// a temp dir without touching the real environment.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CONFIG = {
  securityMode: 'unsigned-fallback',
  signers: {},
  revokedKeys: [],
  securitySensitivePatterns: [],
  maxBundleAgeDays: 14,
};

/**
 * Create .adlc/config.json with defaults if absent. Never clobbers an existing
 * config. Returns { created: boolean, path }.
 */
export function ensureConfig(root, defaults = DEFAULT_CONFIG) {
  const dir = join(root, '.adlc');
  const path = join(dir, 'config.json');
  if (existsSync(path)) return { created: false, path };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(defaults, null, 2) + '\n');
  return { created: true, path };
}

/**
 * Copy *.md sources from a plugin subdir into the project's .opencode/<dest>/.
 * Idempotent: re-running overwrites with the current source (the package is the
 * source of truth) but never deletes unrelated files. Returns the deployed names.
 */
export function deployDir(pkgRoot, destRoot, sub, destSub = sub) {
  const srcDir = join(pkgRoot, sub);
  if (!existsSync(srcDir)) return [];
  const outDir = join(destRoot, '.opencode', destSub);
  mkdirSync(outDir, { recursive: true });
  const deployed = [];
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.md')) continue;
    writeFileSync(join(outDir, name), readFileSync(join(srcDir, name), 'utf8'));
    deployed.push(name);
  }
  return deployed;
}

/**
 * Register the plugin itself in .opencode/opencode.json's `plugin` array so
 * OpenCode actually LOADS the rails-guard hook. Commands/agents/skills are inert
 * markdown; the enforcing hook only runs if the plugin package is registered.
 * Idempotent and non-clobbering: preserves any other settings and plugin entries.
 * Returns { registered, alreadyPresent, path }.
 */
export function ensurePluginRegistered(root, pkgName = '@adlc/opencode-package') {
  const dir = join(root, '.opencode');
  const path = join(dir, 'opencode.json');
  let config = {};
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { config = {}; }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (plugins.includes(pkgName)) return { registered: false, alreadyPresent: true, path };
  config.plugin = [...plugins, pkgName];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return { registered: true, alreadyPresent: false, path };
}

/**
 * Full scaffold: ensure config, REGISTER the plugin (so the rails-guard hook
 * loads), and deploy command/, agent/, and skill/ into .opencode/. OpenCode
 * discovers project commands under .opencode/commands/, subagents under
 * .opencode/agents/, and skills under .opencode/skill/; the plugin ships them
 * under command/, agent/, and skill/ respectively. Returns a summary.
 */
export function scaffold(root, pkgRoot) {
  const config = ensureConfig(root);
  const plugin = ensurePluginRegistered(root);
  const commands = deployDir(pkgRoot, root, 'command', 'commands');
  const agents = deployDir(pkgRoot, root, 'agent', 'agents');
  const skills = deployDir(pkgRoot, root, 'skill', 'skill');
  return { config, plugin, commands, agents, skills };
}
