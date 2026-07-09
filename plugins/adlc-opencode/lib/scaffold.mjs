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

export const PLUGIN_PKG_NAME = '@adlc/opencode-package';

/**
 * The `plugin` array entry to register for a given package root. Registering
 * the npm name is only correct when the package is actually resolvable from
 * npm — i.e. it is running out of node_modules. From a source checkout the
 * npm name may not exist on the registry (the original T30 landmine), so the
 * RESOLVED LOCAL PATH is registered instead; OpenCode accepts both forms.
 */
export function pluginEntryFor(pkgRoot, pkgName = PLUGIN_PKG_NAME) {
  const normalized = String(pkgRoot ?? '').replace(/\\/g, '/');
  return normalized.includes('/node_modules/') ? pkgName : pkgRoot;
}

/**
 * Does a `plugin` array entry refer to THIS plugin, in any spelling? Matches
 * the exact npm name, a source-checkout / node_modules PATH to this package,
 * and the `[name, options]` tuple wrapping of either.
 *
 * The rules are split BY ENTRY SHAPE (T30 review round-3): an npm-name entry
 * (bare `name` or `@scope/name` — no path syntax) is ours ONLY on exact
 * equality with pkgName, so `@other/adlc-opencode` or a bare `adlc-opencode`
 * package is never claimed (removing a stranger's entry — or grafting their
 * tuple options onto ours — is silent data loss). The directory-basename
 * heuristic applies ONLY to filesystem paths, where a dir named like our
 * package dirs (`adlc-opencode` source checkout, `opencode-package` under
 * node_modules) is overwhelmingly this plugin or a stale spelling of it.
 */
export function isOwnPluginEntry(entry, pkgName = PLUGIN_PKG_NAME) {
  const name = Array.isArray(entry) ? entry[0] : entry;
  if (typeof name !== 'string' || !name) return false;
  if (name === pkgName) return true;
  const norm = name.replace(/\\/g, '/').replace(/\/+$/, '');
  // npm specifiers: bare names have no '/', scoped ones start with '@'.
  // Neither is a filesystem path — exact-equality (above) was their only shot.
  if (norm.startsWith('@') || !norm.includes('/')) return false;
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base === 'adlc-opencode' || base === 'opencode-package' ||
    norm.endsWith(`/node_modules/${pkgName}`);
}

/**
 * Register the plugin itself in .opencode/opencode.json's `plugin` array so
 * OpenCode actually LOADS the rails-guard hook. Commands/agents/skills are inert
 * markdown; the enforcing hook only runs if the plugin package is registered.
 * Idempotent and non-clobbering: preserves any other settings and plugin entries,
 * including `[name, options]` tuple entries.
 *
 * FAIL-CLOSED on an unparseable existing config: a malformed opencode.json is
 * exactly when the file must NOT be reset — hand-edits, other plugins, and
 * themes would be destroyed. Throws with a clear message instead.
 *
 * REPLACES stale spellings instead of appending a second one: a checkout that
 * moved (path A → path B) or a switch to the npm install must not leave two
 * entries that both load the plugin. The npm name is always canonical — if it
 * is already registered, any entry form counts as present. Options riding a
 * replaced tuple are preserved on the new entry.
 * Returns { registered, alreadyPresent, replaced, path }.
 */
export function ensurePluginRegistered(root, entry = PLUGIN_PKG_NAME, pkgName = PLUGIN_PKG_NAME) {
  const dir = join(root, '.opencode');
  const path = join(dir, 'opencode.json');
  let config = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${path} exists but is not valid JSON (${err?.message ?? err}). ` +
        'Refusing to overwrite it — fix the file and re-run.',
      );
    }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const nameOf = (e) => (Array.isArray(e) ? e[0] : e);
  const ours = plugins.filter((e) => isOwnPluginEntry(e, pkgName));
  // Exact spelling already there, or the canonical npm name is registered →
  // nothing to do (a source scaffold never displaces a working npm entry).
  if (ours.some((e) => nameOf(e) === entry || nameOf(e) === pkgName)) {
    return { registered: false, alreadyPresent: true, replaced: [], path };
  }
  // Preserve options from a tuple we are about to replace.
  const tupleOptions = ours.map((e) => (Array.isArray(e) ? e[1] : undefined)).find((o) => o && typeof o === 'object');
  const newEntry = tupleOptions ? [entry, tupleOptions] : entry;
  config.plugin = [...plugins.filter((e) => !isOwnPluginEntry(e, pkgName)), newEntry];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return { registered: true, alreadyPresent: false, replaced: ours.map(nameOf), path };
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
  if (!existsSync(srcDir)) return { deployed: [], preservedLegacy: [], deferredToClaude: [] };
  const deployed = [];
  const preservedLegacy = [];
  const deferredToClaude = [];
  const legacyDir = join(destRoot, '.opencode', 'skill');
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.md')) continue;
    const source = readFileSync(join(srcDir, name), 'utf8');
    const skillName = name.slice(0, -'.md'.length);
    const outDir = join(destRoot, '.opencode', 'skills', skillName);
    const outFile = join(outDir, 'SKILL.md');
    // OpenCode also discovers Claude-compatible skills at .claude/skills/<name>/
    // — if that copy exists (the Claude Code integration is installed), deploying
    // ours too would list the skill TWICE. Defer to the .claude copy; remove a
    // pristine .opencode duplicate from an earlier scaffold (never a user-
    // modified one — same preservation rule as the legacy migration below).
    const claudeCopy = join(destRoot, '.claude', 'skills', skillName, 'SKILL.md');
    if (existsSync(claudeCopy)) {
      deferredToClaude.push(skillName);
      if (existsSync(outFile) && readFileSync(outFile, 'utf8') === source) {
        rmSync(outFile);
        if (readdirSync(outDir).length === 0) rmSync(outDir, { recursive: true });
      }
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, source);
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
  return { deployed, preservedLegacy, deferredToClaude };
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
  const plugin = ensurePluginRegistered(root, pluginEntryFor(pkgRoot));
  const commands = deployDir(pkgRoot, root, 'command', 'commands');
  const agents = deployDir(pkgRoot, root, 'agent', 'agents');
  const {
    deployed: skills,
    preservedLegacy: preservedLegacySkills,
    deferredToClaude: deferredToClaudeSkills,
  } = deploySkills(pkgRoot, root);
  const gitignore = ensureGitignore(root);
  const formatterIgnores = ensureFormatterIgnores(root);
  return {
    config, plugin, commands, agents, skills,
    preservedLegacySkills, deferredToClaudeSkills, gitignore, formatterIgnores,
  };
}
