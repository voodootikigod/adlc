// scaffold.mjs — deterministic, idempotent setup of the Cursor integration into a
// user's repo. Writes `.cursor/hooks.json` (wiring the rails-guard + audit hooks)
// and `.cursor/rules/adlc.mdc` (the gate-router rule). Never clobbers a user's
// existing hooks — it MERGES the ADLC entries into the hooks map.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRETOOL_MATCHER } from '../rails-checker.mjs';

// The installed @adlc/cursor-package root (this file lives at <root>/lib/scaffold.mjs).
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RAILS_GUARD_REL = 'hooks/adlc-rails-guard.mjs';
const AUDIT_REL = 'hooks/adlc-audit.mjs';
// Catch-all (".*"): every tool reaches the guard so the classifier — not an
// allowlist matcher — is the single decision point (see PRETOOL_MATCHER in the
// checker). Imported, not duplicated, so the scaffold and template can't drift.

/** A hook entry is "ours" if its command points at one of our hook scripts. */
function isAdlcHook(entry) {
  return typeof entry?.command === 'string' && /adlc-(rails-guard|audit)\.mjs/.test(entry.command);
}

/** Build the two hook command strings, resolved against the installed plugin. */
export function buildHookCommands(pluginRoot = PLUGIN_ROOT) {
  return {
    railsGuard: `node "${join(pluginRoot, RAILS_GUARD_REL)}"`,
    audit: `node "${join(pluginRoot, AUDIT_REL)}"`,
  };
}

/**
 * Merge the ADLC hook entries into an existing hooks.json object (or a fresh one),
 * returning a NEW object (no mutation of the input). Idempotent: re-running does
 * not duplicate our entries.
 */
export function mergeHooks(existing, pluginRoot = PLUGIN_ROOT) {
  const cmds = buildHookCommands(pluginRoot);
  const base = existing && typeof existing === 'object' ? existing : {};
  const hooks = { ...(base.hooks ?? {}) };

  const preToolUse = (hooks.preToolUse ?? []).filter((e) => !isAdlcHook(e));
  preToolUse.push({ command: cmds.railsGuard, matcher: PRETOOL_MATCHER, timeout: 10, failClosed: false });

  const afterFileEdit = (hooks.afterFileEdit ?? []).filter((e) => !isAdlcHook(e));
  afterFileEdit.push({ command: cmds.audit, timeout: 10, failClosed: false });

  return { ...base, version: base.version ?? 1, hooks: { ...hooks, preToolUse, afterFileEdit } };
}

/** Write `.cursor/hooks.json`, merging into any existing config. Returns the action taken. */
export function ensureCursorHooks(projectRoot, { pluginRoot = PLUGIN_ROOT } = {}) {
  const cursorDir = join(projectRoot, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  const hooksPath = join(cursorDir, 'hooks.json');

  let existing;
  let backedUp;
  if (existsSync(hooksPath)) {
    const raw = readFileSync(hooksPath, 'utf8');
    try {
      existing = JSON.parse(raw);
    } catch {
      // Unparseable existing config: do NOT silently drop the user's other hooks.
      // Preserve the original VERBATIM in a sibling .bak (never overwriting an
      // existing backup), then write a fresh valid file. The merge promise can't be
      // honored on corrupt JSON, but data loss is unacceptable.
      backedUp = `${hooksPath}.bak`;
      let n = 0;
      while (existsSync(backedUp)) backedUp = `${hooksPath}.bak.${++n}`;
      writeFileSync(backedUp, raw);
      existing = undefined;
    }
  }
  const merged = mergeHooks(existing, pluginRoot);
  writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { path: hooksPath, created: !existing, backedUp };
}

/** Copy the gate-router rule into `.cursor/rules/adlc.mdc`. Never clobbers a user edit. */
export function ensureRule(projectRoot, { pluginRoot = PLUGIN_ROOT } = {}) {
  const rulesDir = join(projectRoot, '.cursor', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const dest = join(rulesDir, 'adlc.mdc');
  if (existsSync(dest)) return { path: dest, created: false };
  copyFileSync(join(pluginRoot, 'rules', 'adlc.mdc'), dest);
  return { path: dest, created: true };
}

/**
 * Register the Cursor integration in the user's repo: wire the hooks and install
 * the rule. Named to parallel the sibling scaffolds. Returns a summary.
 */
export function ensurePluginRegistered(projectRoot, opts = {}) {
  const hooks = ensureCursorHooks(projectRoot, opts);
  const rule = ensureRule(projectRoot, opts);
  return { hooks, rule };
}

/** Create `.adlc/config.json` with defaults if absent (never clobber). */
export function ensureConfig(projectRoot) {
  const adlcDir = join(projectRoot, '.adlc');
  mkdirSync(adlcDir, { recursive: true });
  const cfgPath = join(adlcDir, 'config.json');
  if (existsSync(cfgPath)) return { path: cfgPath, created: false };
  writeFileSync(cfgPath, `${JSON.stringify({ securityMode: 'unsigned-fallback' }, null, 2)}\n`);
  return { path: cfgPath, created: true };
}

/** Full bootstrap: config + hooks + rule. */
export function scaffold(projectRoot, opts = {}) {
  const config = ensureConfig(projectRoot);
  const { hooks, rule } = ensurePluginRegistered(projectRoot, opts);
  return { config, hooks, rule };
}
