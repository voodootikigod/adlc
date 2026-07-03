// scaffold.mjs — deterministic, idempotent setup of the Cursor integration into a
// user's repo. Writes `.cursor/hooks.json` (wiring the rails-guard + audit hooks)
// and `.cursor/rules/adlc.mdc` (the gate-router rule). Never clobbers a user's
// existing hooks — it MERGES the ADLC entries into the hooks map.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Import the matcher from the dependency-free constants module — NOT rails-checker
// (which imports @adlc/core). The scaffolder must run in a fresh source checkout
// before `npm install` has linked the workspace packages.
import { PRETOOL_MATCHER } from '../constants.mjs';

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

// ---------------------------------------------------------------------------
// .gitignore: track the ticket contract AND the P1 spec contract, ignore the
// rest of the runtime (T-issue #46). Never clobbers unrelated gitignore
// content — only appends the stanza, or the specific negation lines missing
// from an existing stanza.
// ---------------------------------------------------------------------------

const GITIGNORE_STANZA = ['.adlc/*', '!.adlc/tickets.json', '!.adlc/specs/'];

/**
 * Ensure `.gitignore` ignores all of `.adlc/` except the tracked contracts
 * (`tickets.json` and the `specs/` directory). Idempotent: if the stanza is
 * fully present, nothing is written. If `.adlc/*` is present but a negation
 * line (e.g. `!.adlc/specs/`) is missing, only the missing line(s) are
 * inserted right after the existing block — the rest of the file is
 * untouched. Returns { path, added: string[], changed: boolean }.
 */
export function ensureGitignore(projectRoot) {
  const path = join(projectRoot, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const hadTrailingNewline = existing.endsWith('\n');
  const lines = existing.length ? existing.split('\n') : [];
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  const missing = GITIGNORE_STANZA.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return { path, added: [], changed: false };

  const anchorIdx = lines.indexOf('.adlc/*');
  if (anchorIdx === -1) {
    // Push only the entries actually missing — some negation lines may
    // already exist standalone in the file (without the anchor immediately
    // preceding them); re-pushing the full stanza would duplicate those.
    if (lines.length > 0) lines.push('');
    lines.push(...missing);
  } else {
    let insertAt = anchorIdx + 1;
    while (insertAt < lines.length && lines[insertAt].startsWith('!')) insertAt++;
    lines.splice(insertAt, 0, ...missing);
  }
  writeFileSync(path, lines.join('\n') + '\n');
  return { path, added: missing, changed: true };
}

// ---------------------------------------------------------------------------
// Formatter/linter ignores: `.adlc/tickets.json` is a machine-written,
// frozen trust root once rails exist — a repo formatter reformatting it on a
// ticket branch trips rails-guard. Add `.adlc/` to whichever formatter/linter
// configs are ALREADY present in the repo (never invent a new tool). (#42)
// ---------------------------------------------------------------------------

/** Add a line to a plain-text ignore file (gitignore-style) if not already present. */
function ensureTextIgnoreFile(projectRoot, filename, entry) {
  const path = join(projectRoot, filename);
  if (!existsSync(path)) return { path, detected: false, changed: false };
  const existing = readFileSync(path, 'utf8');
  const lines = existing.split('\n');
  if (lines.includes(entry)) return { path, detected: true, changed: false };
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  writeFileSync(path, existing + (needsNewline ? '\n' : '') + entry + '\n');
  return { path, detected: true, changed: true };
}

/** Add a `.adlc/**` override entry to `biome.json` (Biome 1.x `overrides` shape) if present. */
function ensureBiomeIgnore(projectRoot) {
  const path = join(projectRoot, 'biome.json');
  if (!existsSync(path)) return { path, detected: false, changed: false };
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, detected: true, changed: false, skipped: 'unparseable JSON — add manually' };
  }
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  const already = overrides.some(
    (o) => Array.isArray(o?.include) && o.include.includes('.adlc/**')
  );
  if (already) return { path, detected: true, changed: false };
  const next = {
    ...config,
    overrides: [
      ...overrides,
      { include: ['.adlc/**'], formatter: { enabled: false }, linter: { enabled: false } },
    ],
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return { path, detected: true, changed: true };
}

/** Add an `ignorePatterns` entry to a legacy JSON `.eslintrc*` config if present. */
function ensureEslintRcIgnore(projectRoot) {
  for (const filename of ['.eslintrc.json', '.eslintrc']) {
    const path = join(projectRoot, filename);
    if (!existsSync(path)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { path, detected: true, changed: false, skipped: 'unparseable JSON — add manually' };
    }
    const ignorePatterns = Array.isArray(config.ignorePatterns) ? config.ignorePatterns : [];
    if (ignorePatterns.includes('.adlc/**')) return { path, detected: true, changed: false };
    const next = { ...config, ignorePatterns: [...ignorePatterns, '.adlc/**'] };
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
    return { path, detected: true, changed: true };
  }
  // Flat config (eslint.config.js/.mjs/.cjs) is executable JS — safe text
  // mutation isn't reliable, so only report detection; document the manual
  // fallback (an `{ ignores: ['.adlc/**'] }` object in the exported array).
  for (const filename of ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs']) {
    if (existsSync(join(projectRoot, filename))) {
      return {
        path: join(projectRoot, filename),
        detected: true,
        changed: false,
        skipped: 'flat config — add { ignores: [".adlc/**"] } manually',
      };
    }
  }
  return { path: null, detected: false, changed: false };
}

/**
 * Detect and update whichever formatter/linter configs already exist in the
 * repo so none of them touch `.adlc/`: Biome (`biome.json` overrides),
 * Prettier (`.prettierignore`), ESLint (`ignorePatterns` in a JSON
 * `.eslintrc*`, `.eslintignore`, or detection-only for flat config). Never
 * creates a config for a tool that isn't already in use. Returns a summary
 * keyed by tool.
 */
export function ensureFormatterIgnores(projectRoot) {
  const biome = ensureBiomeIgnore(projectRoot);
  const prettier = ensureTextIgnoreFile(projectRoot, '.prettierignore', '.adlc/');
  const eslintrc = ensureEslintRcIgnore(projectRoot);
  const eslintignore = ensureTextIgnoreFile(projectRoot, '.eslintignore', '.adlc/');
  return { biome, prettier, eslint: eslintrc.detected ? eslintrc : eslintignore };
}

/** Full bootstrap: config + hooks + rule + .gitignore contract + formatter ignores. */
export function scaffold(projectRoot, opts = {}) {
  const config = ensureConfig(projectRoot);
  const { hooks, rule } = ensurePluginRegistered(projectRoot, opts);
  const gitignore = ensureGitignore(projectRoot);
  const formatterIgnores = ensureFormatterIgnores(projectRoot);
  return { config, hooks, rule, gitignore, formatterIgnores };
}
