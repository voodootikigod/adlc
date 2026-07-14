// scaffold.mjs — deterministic, idempotent setup of the Cursor integration into a
// user's repo. Writes `.cursor/hooks.json` (wiring the rails-guard + audit hooks),
// `.cursor/rules/adlc.mdc` (the gate-router rule), and `.cursor/commands/*.md`
// (the /adlc-* command palette). Never clobbers a user's existing hooks — it
// MERGES the ADLC entries into the hooks map.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Import the matcher from the dependency-free constants module — NOT rails-checker
// (which imports @adlc/core). The scaffolder must run in a fresh source checkout
// before `npm install` has linked the workspace packages.
import { PRETOOL_MATCHER } from '../constants.mjs';
// The .gitignore stanza + formatter-ignore hygiene logic (issue #97) is shared
// with plugins/adlc-opencode via @adlc/core, which this package already
// depends on and already imports elsewhere (rails-checker.mjs) — unlike
// PRETOOL_MATCHER above, this is not part of the pre-npm-install-critical
// bootstrap path, so depending on @adlc/core here is safe.
import { ensureGitignore, ensureFormatterIgnores, ensureTicketStore } from '@adlc/core';
export { ensureGitignore, ensureFormatterIgnores, ensureTicketStore };

// The installed @adlc/cursor root (this file lives at <root>/lib/scaffold.mjs).
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRETOOL_REL = 'hooks/adlc-pretool.mjs';
const AUDIT_REL = 'hooks/adlc-audit.mjs';
const SHELL_ADVISORY_REL = 'hooks/adlc-shell-advisory.mjs';
// DISABLED BY DEFAULT (T18): the `stop` / `beforeSubmitPrompt` events are NOT
// pinned against Cursor documentation (ADR 0006), so these two scripts ship in
// the package but are wired ONLY on explicit opt-in (`wireUnpinned` option /
// ADLC_CURSOR_WIRE_UNPINNED=1). No invented event is wired as if real.
const STOP_REL = 'hooks/adlc-stop.mjs';
const PREFLIGHT_REL = 'hooks/adlc-preflight.mjs';
// Catch-all (".*"): every tool reaches the dispatcher so the classifier — not an
// allowlist matcher — is the single decision point (see PRETOOL_MATCHER in the
// checker). Imported, not duplicated, so the scaffold and template can't drift.

/** A hook entry is "ours" if its command points at one of our hook scripts.
 * `adlc-rails-guard` stays in the pattern so a pre-T18 direct rails-guard entry
 * is MIGRATED to the dispatcher (filtered out, dispatcher re-added).
 *
 * The `adlc-<name>.mjs` basename must sit at a path-segment boundary (preceded
 * by a separator, quote, whitespace, or start) so a USER hook whose command
 * merely CONTAINS one of these as a suffix (e.g. `node run-adlc-audit.mjs`) is
 * NOT misclassified as ours and silently dropped — the module's invariant is
 * that user hooks are always preserved. */
function isAdlcHook(entry) {
  return typeof entry?.command === 'string'
    && /(^|[/\\"'\s])adlc-(rails-guard|pretool|audit|shell-advisory|stop|preflight)\.mjs/.test(entry.command);
}

/** Coerce a hooks.json event value to an array. A hand-edited file can carry a
 * valid-JSON but non-array value (an object or string) for an event; `?? []`
 * only defaults null/undefined, so a bare `.filter` on it throws an uncaught
 * TypeError and crashes the scaffolder with a raw stack trace. Coerce first —
 * any non-array (non-standard) value is replaced by our canonical entry. */
const asHookList = (v) => (Array.isArray(v) ? v : []);

/** Build the hook command strings, resolved against the installed plugin. */
export function buildHookCommands(pluginRoot = PLUGIN_ROOT) {
  return {
    pretool: `node "${join(pluginRoot, PRETOOL_REL)}"`,
    audit: `node "${join(pluginRoot, AUDIT_REL)}"`,
    shellAdvisory: `node "${join(pluginRoot, SHELL_ADVISORY_REL)}"`,
    stop: `node "${join(pluginRoot, STOP_REL)}"`,
    preflight: `node "${join(pluginRoot, PREFLIGHT_REL)}"`,
  };
}

/**
 * Merge the ADLC hook entries into an existing hooks.json object (or a fresh one),
 * returning a NEW object (no mutation of the input). Idempotent: re-running does
 * not duplicate our entries, and user hooks are always preserved.
 *
 * preToolUse is rewired to the SINGLE dispatcher (hooks/adlc-pretool.mjs):
 * Cursor's multi-entry ordering/permission-combination semantics are unpinned
 * (ADR 0006), so rails + buildgate share one entry with rails deciding first.
 * A pre-existing direct adlc-rails-guard.mjs entry is migrated (replaced).
 *
 * `wireUnpinned` (default false, env ADLC_CURSOR_WIRE_UNPINNED=1) additionally
 * wires the UNPINNED `stop` / `beforeSubmitPrompt` events to the disabled-by-
 * default stop-audit / preflight scripts. Without it, any previously wired
 * ADLC entry on those events is REMOVED, restoring the verified-events-only
 * default (preToolUse, afterFileEdit, beforeShellExecution).
 */
export function mergeHooks(existing, pluginRoot = PLUGIN_ROOT, { wireUnpinned = false } = {}) {
  const cmds = buildHookCommands(pluginRoot);
  const base = existing && typeof existing === 'object' ? existing : {};
  const hooks = { ...(base.hooks ?? {}) };

  const preToolUse = asHookList(hooks.preToolUse).filter((e) => !isAdlcHook(e));
  preToolUse.push({ command: cmds.pretool, matcher: PRETOOL_MATCHER, timeout: 10, failClosed: false });

  const afterFileEdit = asHookList(hooks.afterFileEdit).filter((e) => !isAdlcHook(e));
  afterFileEdit.push({ command: cmds.audit, timeout: 10, failClosed: false });

  const beforeShellExecution = asHookList(hooks.beforeShellExecution).filter((e) => !isAdlcHook(e));
  beforeShellExecution.push({ command: cmds.shellAdvisory, timeout: 10, failClosed: false });

  const merged = { ...hooks, preToolUse, afterFileEdit, beforeShellExecution };

  // Unpinned events: strip our entries first (so turning the flag OFF restores
  // the default), then re-add only on explicit opt-in. A user's own entries on
  // these events are preserved either way.
  for (const [event, cmd] of [['stop', cmds.stop], ['beforeSubmitPrompt', cmds.preflight]]) {
    const kept = asHookList(hooks[event]).filter((e) => !isAdlcHook(e));
    if (wireUnpinned) kept.push({ command: cmd, timeout: 10, failClosed: false });
    if (kept.length) merged[event] = kept;
    else delete merged[event];
  }

  return { ...base, version: base.version ?? 1, hooks: merged };
}

/** Write `.cursor/hooks.json`, merging into any existing config. Returns the action taken. */
export function ensureCursorHooks(projectRoot, {
  pluginRoot = PLUGIN_ROOT,
  wireUnpinned = process.env.ADLC_CURSOR_WIRE_UNPINNED === '1',
} = {}) {
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
  const merged = mergeHooks(existing, pluginRoot, { wireUnpinned });
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

/**
 * Deploy the package's command/*.md files into the project's .cursor/commands/
 * so Cursor discovers the /adlc-* palette. Mirrors deployDir() in
 * plugins/adlc-opencode/lib/scaffold.mjs. Idempotent: re-running overwrites
 * from the package source (the package is the source of truth) but never
 * deletes unrelated files. Returns the deployed file names.
 */
export function deployCommands(projectRoot, { pluginRoot = PLUGIN_ROOT } = {}) {
  const srcDir = join(pluginRoot, 'command');
  if (!existsSync(srcDir)) return [];
  const outDir = join(projectRoot, '.cursor', 'commands');
  mkdirSync(outDir, { recursive: true });
  const deployed = [];
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.md')) continue;
    writeFileSync(join(outDir, name), readFileSync(join(srcDir, name), 'utf8'));
    deployed.push(name);
  }
  return deployed;
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

/** Full bootstrap: config + hooks + rule + commands + .gitignore contract + formatter ignores. */
export function scaffold(projectRoot, opts = {}) {
  const ticketStore = ensureTicketStore(projectRoot);
  const config = ensureConfig(projectRoot);
  const { hooks, rule } = ensurePluginRegistered(projectRoot, opts);
  const commands = deployCommands(projectRoot, opts);
  const gitignore = ensureGitignore(projectRoot);
  const formatterIgnores = ensureFormatterIgnores(projectRoot);
  return { ticketStore, config, hooks, rule, commands, gitignore, formatterIgnores };
}
