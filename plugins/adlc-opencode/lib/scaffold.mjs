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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The .gitignore stanza + formatter-ignore hygiene logic (issue #97) is shared
// with plugins/adlc-cursor via @adlc/core, which this package already
// depends on.
import { ensureGitignore, ensureFormatterIgnores } from '@adlc/core';
export { ensureGitignore, ensureFormatterIgnores };

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
 * Deploy the plugin's skill/*.md sources as NATIVE OpenCode Agent Skills:
 * .opencode/skills/<name>/SKILL.md (the shape the `skill` tool discovers).
 * Also migrates away the legacy flat deployment (.opencode/skill/<name>.md)
 * that pre-dated native skill support — a legacy file is removed ONLY when its
 * content is pristine (byte-identical to what this plugin deploys), so a
 * user-customized copy is never silently destroyed; the legacy dir is dropped
 * only when left empty. Idempotent; returns { deployed, preservedLegacy }.
 */
export function deploySkills(pkgRoot, destRoot) {
  const srcDir = join(pkgRoot, 'skill');
  if (!existsSync(srcDir)) return { deployed: [], preservedLegacy: [] };
  const deployed = [];
  const preservedLegacy = [];
  const legacyDir = join(destRoot, '.opencode', 'skill');
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.md')) continue;
    const source = readFileSync(join(srcDir, name), 'utf8');
    const skillName = name.slice(0, -'.md'.length);
    const outDir = join(destRoot, '.opencode', 'skills', skillName);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'SKILL.md'), source);
    deployed.push(`${skillName}/SKILL.md`);
    const legacy = join(legacyDir, name);
    if (existsSync(legacy)) {
      if (readFileSync(legacy, 'utf8') === source) rmSync(legacy);
      else preservedLegacy.push(`.opencode/skill/${name}`); // user-modified — keep it
    }
  }
  if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
    rmSync(legacyDir, { recursive: true });
  }
  return { deployed, preservedLegacy };
}

/**
 * Full scaffold: ensure config, REGISTER the plugin (so the rails-guard hook
 * loads), deploy command/, agent/, and skill/ into .opencode/, ensure the
 * .gitignore contract stanza, and exclude .adlc/ from any detected repo
 * formatter/linter. OpenCode's canonical project layout is PLURAL:
 * commands under .opencode/commands/, subagents under .opencode/agents/, and
 * native skills under .opencode/skills/<name>/SKILL.md; the plugin ships its
 * sources under command/, agent/, and skill/ respectively. Returns a summary.
 */
export function scaffold(root, pkgRoot) {
  const config = ensureConfig(root);
  const plugin = ensurePluginRegistered(root);
  const commands = deployDir(pkgRoot, root, 'command', 'commands');
  const agents = deployDir(pkgRoot, root, 'agent', 'agents');
  const { deployed: skills, preservedLegacy: preservedLegacySkills } = deploySkills(pkgRoot, root);
  const gitignore = ensureGitignore(root);
  const formatterIgnores = ensureFormatterIgnores(root);
  return { config, plugin, commands, agents, skills, preservedLegacySkills, gitignore, formatterIgnores };
}
