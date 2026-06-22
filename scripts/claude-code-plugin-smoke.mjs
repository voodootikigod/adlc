#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

// NOTE: This smoke test validates file structure and content only. It does NOT
// exercise the live CC marketplace resolver to confirm that a non-root
// `plugins[].source` value is supported by `/plugin marketplace add`.
// That live-install path is an unverified assumption — see docs/adr/0003-adlc-claude-code-plugin.md
// for the full caveat. A manual `/plugin marketplace add voodootikigod/adlc` test
// should be performed before announcing GA availability.

// --- root .claude-plugin/marketplace.json (authoritative for remote /plugin marketplace add) ---
const rootMarketplacePath = join(repo, '.claude-plugin/marketplace.json');
if (!existsSync(rootMarketplacePath)) fail('missing root .claude-plugin/marketplace.json — required for /plugin marketplace add voodootikigod/adlc');
const rootMarketplace = readJson(rootMarketplacePath);

// Guard: _comment must be absent — CC marketplace schema uses additionalProperties:false
if (typeof rootMarketplace._comment !== 'undefined') {
  fail('_comment field must be absent from root .claude-plugin/marketplace.json — CC schema may reject additionalProperties');
}

// Guard: stale root plugin.json must not exist — only the subdirectory copy is authoritative
const rootPluginJsonPath = join(repo, '.claude-plugin/plugin.json');
if (existsSync(rootPluginJsonPath)) {
  fail('stale .claude-plugin/plugin.json found at repo root — plugin.json must only exist at plugins/adlc-claude-code/.claude-plugin/plugin.json');
}

// Guard: root .claude-plugin/ must contain ONLY marketplace.json.
// NOTE: The root .claude-plugin/ directory is intentionally PRESENT — it is the authoritative
// location for marketplace.json (consumed by /plugin marketplace add voodootikigod/adlc).
// A pre-restructuring check that treated any .claude-plugin/ presence at root as a failure
// ("SHOULD BE GONE") was wrong for the current design. The correct invariant is that
// .claude-plugin/ exists at root AND contains ONLY marketplace.json — plugin.json must NOT
// be here (it lives under plugins/adlc-claude-code/.claude-plugin/). This check enforces
// that invariant. Do NOT change this to "directory must be absent" — that would break the
// /plugin marketplace add flow entirely.
const rootClaudePluginDir = join(repo, '.claude-plugin');
const rootClaudePluginFiles = readdirSync(rootClaudePluginDir);
const unexpectedFiles = rootClaudePluginFiles.filter((f) => f !== 'marketplace.json');
if (unexpectedFiles.length > 0) {
  fail(`root .claude-plugin/ must contain ONLY marketplace.json — unexpected files found: ${unexpectedFiles.join(', ')}\n` +
    `  If plugin.json is present here, it is stale — move or remove it (authoritative copy is at plugins/adlc-claude-code/.claude-plugin/plugin.json).`);
}

if (!rootMarketplace.name) fail('root .claude-plugin/marketplace.json missing "name" field');
const rootEntry = rootMarketplace.plugins?.find((p) => p.name === 'adlc');
if (!rootEntry) fail('root .claude-plugin/marketplace.json missing plugin entry with name "adlc"');
if (rootEntry.source !== './plugins/adlc-claude-code/') {
  fail(`root .claude-plugin/marketplace.json plugin entry "source" must be "./plugins/adlc-claude-code/" (got ${JSON.stringify(rootEntry.source)})`);
}

// Guard: nested plugins/adlc-claude-code/.claude-plugin/ must contain EXACTLY plugin.json
// and nothing else. A stale marketplace.json accidentally left here after it was removed
// (pass 14 fix) could confuse a CC resolver reading the nested directory — rejecting the
// install or double-resolving the plugin. The nested marketplace.json was removed in
// adversarial review pass 14 to eliminate dual-resolution risk.
const nestedClaudePluginDir = join(repo, 'plugins/adlc-claude-code/.claude-plugin');
const nestedClaudePluginFiles = readdirSync(nestedClaudePluginDir).sort();
const expectedNestedFiles = ['plugin.json'];
const unexpectedNestedFiles = nestedClaudePluginFiles.filter((f) => !expectedNestedFiles.includes(f));
const missingNestedFiles = expectedNestedFiles.filter((f) => !nestedClaudePluginFiles.includes(f));
if (unexpectedNestedFiles.length > 0) {
  fail(`plugins/adlc-claude-code/.claude-plugin/ must contain ONLY plugin.json — unexpected files found: ${unexpectedNestedFiles.join(', ')}\n` +
    `  If marketplace.json was re-added here, remove it — the nested copy was deleted in pass 14 to eliminate CC resolver dual-resolution risk.`);
}
if (missingNestedFiles.length > 0) {
  fail(`plugins/adlc-claude-code/.claude-plugin/ is missing expected files: ${missingNestedFiles.join(', ')}`);
}

// Guard: no nested marketplace.json must exist under plugins/adlc-claude-code/.claude-plugin/.
// It was removed in adversarial review pass 14 because a second marketplace.json inside the
// plugin source directory could cause the CC resolver to recursively re-resolve the plugin,
// double-install it, or reject the install entirely. The root .claude-plugin/marketplace.json
// is the sole authoritative file.
const nestedMpPath = join(repo, 'plugins/adlc-claude-code/.claude-plugin/marketplace.json');
if (existsSync(nestedMpPath)) {
  fail(
    'plugins/adlc-claude-code/.claude-plugin/marketplace.json must NOT exist — it was removed in pass 14 to eliminate CC resolver dual-resolution risk.\n' +
    '  The only authoritative marketplace.json is .claude-plugin/marketplace.json at the repo root.'
  );
}

// --- plugin.json metadata ---
const pluginPath = join(repo, 'plugins/adlc-claude-code/.claude-plugin/plugin.json');
if (!existsSync(pluginPath)) fail('missing plugins/adlc-claude-code/.claude-plugin/plugin.json');
const plugin = readJson(pluginPath);
if (!plugin.name) fail('plugin.json missing "name" field');
if (!plugin.version) fail('plugin.json missing "version" field');
if (!plugin.description) fail('plugin.json missing "description" field');
if (!plugin.homepage) fail('plugin.json missing "homepage" field');
// Positive assertion: homepage must point at the current integration guide
if (!plugin.homepage.includes('docs/integrations/claude-code.md')) {
  fail(`plugin.json "homepage" must point at docs/integrations/claude-code.md (got ${JSON.stringify(plugin.homepage)})`);
}
// Guard: plugin.json must NOT contain extra fields beyond the CC-allowed core set.
// Confirmed via live install test (2026-06-22): CC plugin.json schema uses
// additionalProperties:false — any field beyond the core metadata fields causes an
// "invalid manifest" rejection. The fields hooks/commands/agents/skills were removed;
// CC discovers these assets by filesystem convention from the plugin source directory.
const allowedPluginJsonKeys = new Set([
  'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords',
]);
const extraPluginJsonKeys = Object.keys(plugin).filter((k) => !allowedPluginJsonKeys.has(k));
if (extraPluginJsonKeys.length > 0) {
  fail(
    `plugin.json contains extra fields that will cause CC to reject the install with "invalid manifest": ${extraPluginJsonKeys.join(', ')}\n` +
    `  CC plugin.json schema uses additionalProperties:false. Only these fields are allowed: ${[...allowedPluginJsonKeys].join(', ')}\n` +
    `  Remove the extra fields and rely on filesystem convention for hooks/commands/agents/skills discovery.`
  );
}

// --- plugins/adlc-claude-code/hooks/hooks.json ---
const hooksConfigPath = join(repo, 'plugins/adlc-claude-code/hooks/hooks.json');
if (!existsSync(hooksConfigPath)) fail('missing plugins/adlc-claude-code/hooks/hooks.json');
const hooksConfig = readJson(hooksConfigPath);

// Guard: hooks.json must not contain unexpected top-level keys.
// If the CC hooks.json schema uses additionalProperties:false (same restriction as the
// marketplace.json schema), any unknown top-level key would cause the file to be
// silently rejected — disabling all 4 hooks including the security-critical rails-guard
// with no error surfaced to the user.
// NOTE: 'description' was deliberately removed from hooks.json (2026-06-22 adversarial review
// pass 14) because the CC hooks.json schema may use additionalProperties:false. Until confirmed
// safe by a live install, only the single top-level key 'hooks' is permitted.
const allowedHooksTopLevelKeys = new Set(['hooks']);
const unexpectedHooksKeys = Object.keys(hooksConfig).filter((k) => !allowedHooksTopLevelKeys.has(k));
if (unexpectedHooksKeys.length > 0) {
  fail(
    `hooks.json contains unexpected top-level keys that may be rejected by the CC schema: ${unexpectedHooksKeys.join(', ')}\n` +
    `  Allowed top-level keys: ${[...allowedHooksTopLevelKeys].join(', ')}\n` +
    `  Extra top-level keys risk silent rejection of the entire hooks file, disabling all hooks including the security-critical rails-guard.`
  );
}

const hooks = hooksConfig.hooks ?? {};

if (!Array.isArray(hooks.PreToolUse) || hooks.PreToolUse.length === 0) {
  fail('plugins/adlc-claude-code/hooks/hooks.json must register at least one PreToolUse hook');
}
// SessionStart, PostToolUse, and Stop must each have at least one entry invoking
// adlc-hook-run.mjs (the CWD-independent dispatcher wrapper) or adlc-hook.mjs directly.
// adlc-hook-run.mjs is the preferred form — it uses import.meta.url to find adlc-hook.mjs
// regardless of CWD, eliminating the $(...) shell substitution risk from Pass 14.
for (const eventType of ['SessionStart', 'PostToolUse', 'Stop']) {
  const entries = hooks[eventType];
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`plugins/adlc-claude-code/hooks/hooks.json must register at least one ${eventType} hook`);
  }
  const hasHookCmd = entries.some(
    (e) => Array.isArray(e.hooks) && e.hooks.some(
      (h) => h.command?.includes('adlc-hook-run.mjs') || h.command?.includes('adlc-hook.mjs')
    )
  );
  if (!hasHookCmd) {
    fail(`plugins/adlc-claude-code/hooks/hooks.json ${eventType} must contain at least one hook invoking adlc-hook-run.mjs (or adlc-hook.mjs)`);
  }
}

// Guard: hook commands must NOT use "${CLAUDE_PLUGIN_ROOT}/hooks/".
const allHookEntries = Object.values(hooks).flat().flatMap((e) => e.hooks ?? []);
const unsafeHookCmd = allHookEntries.find((h) =>
  /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\//.test(h.command ?? '')
);
if (unsafeHookCmd) {
  fail(
    `hooks.json contains a hook command that uses "\${CLAUDE_PLUGIN_ROOT}/hooks/": ${JSON.stringify(unsafeHookCmd.command)}\n` +
    `  Use the plugin-source-dir-relative literal path "./hooks/adlc-hook-run.mjs" instead.`
  );
}

// Guard: hook commands must NOT use the old repo-root-relative prefix.
// Confirmed via live install (2026-06-22): CC runs hook commands with CWD = plugin
// install directory, not the user's repo root. The path
// "./plugins/adlc-claude-code/hooks/adlc-hook-run.mjs" does not exist inside the
// installed plugin directory and causes silent hook failure (MODULE_NOT_FOUND → exit 0).
// The correct form is "./hooks/adlc-hook-run.mjs" (relative to plugin source dir).
const repoRelativeHookCmd = allHookEntries.find((h) =>
  (h.command ?? '').includes('./plugins/adlc-claude-code/hooks/')
);
if (repoRelativeHookCmd) {
  fail(
    `hooks.json contains a hook command with the old repo-root-relative prefix: ${JSON.stringify(repoRelativeHookCmd.command)}\n` +
    `  CC runs hooks with CWD = plugin install directory (confirmed 2026-06-22).\n` +
    `  Use "./hooks/adlc-hook-run.mjs <mode>" (plugin-source-dir-relative).`
  );
}

// Guard: hook commands must NOT use $(...) shell substitution.
// If CC executes hook commands via execFile() rather than a POSIX shell, $(...) is not
// expanded — node would try to open a file literally named "$([ -f ...])" and fail with
// MODULE_NOT_FOUND, blocking every structured-edit hook (rails-guard included).
// The safe replacement is adlc-hook-run.mjs, which uses import.meta.url to locate itself.
const shellSubstHookCmd = allHookEntries.find((h) => {
  const cmd = h.command ?? '';
  return /\$\([^)]+\)/.test(cmd);
});
if (shellSubstHookCmd) {
  fail(
    `hooks.json contains a hook command with a $(...) shell substitution: ${JSON.stringify(shellSubstHookCmd.command)}\n` +
    `  Shell substitution is unsafe: if CC executes hooks via execFile() the expression is not expanded\n` +
    `  and node fails with MODULE_NOT_FOUND, blocking every structured-edit (including the security-critical rails-guard).\n` +
    `  Use adlc-hook-run.mjs (literal path) instead — it resolves adlc-hook.mjs via import.meta.url, CWD-independently.`
  );
}

// Guard: hook command paths must exist relative to the plugin source directory.
// Confirmed via live install (2026-06-22): CC runs hook commands with CWD = plugin
// install directory (the contents of the source subtree from marketplace.json).
// Paths are therefore relative to plugins/adlc-claude-code/ in this repo.
const pluginSourceDir = join(repo, 'plugins/adlc-claude-code');
const hookRunPath = join(pluginSourceDir, 'hooks/adlc-hook-run.mjs');
if (!existsSync(hookRunPath)) {
  fail('plugins/adlc-claude-code/hooks/adlc-hook-run.mjs is missing — required as the CWD-independent dispatcher wrapper for all hook commands');
}
for (const hookEntry of allHookEntries) {
  const cmd = hookEntry.command ?? '';
  if (!cmd.includes('adlc-hook-run.mjs') && !cmd.includes('adlc-hook.mjs')) continue;
  const pathMatch = cmd.match(/node\s+"([^"]+)"/) ?? cmd.match(/node\s+(\S+)/);
  if (!pathMatch) continue;
  const scriptPath = pathMatch[1];
  // Path must exist relative to plugin source dir (confirmed CWD for installed hooks)
  const fromPluginDir = join(pluginSourceDir, scriptPath);
  if (!existsSync(fromPluginDir)) {
    fail(
      `hooks.json command script path does not exist relative to plugin source dir:\n` +
      `  command: ${JSON.stringify(cmd)}\n` +
      `  resolved: ${fromPluginDir}\n` +
      `  CC runs hooks with CWD = plugin install directory. Use a path relative to plugins/adlc-claude-code/.`
    );
  }
}

// rails PreToolUse hook must match the structured-edit tools
const railsEntry = hooks.PreToolUse.find((e) => {
  const matcher = e.matcher ?? '';
  return matcher.includes('Edit') && matcher.includes('Write');
});
if (!railsEntry) {
  fail('plugins/adlc-claude-code/hooks/hooks.json PreToolUse must include a matcher covering Edit and Write (rails-guard)');
}
const railsHookCmd = railsEntry.hooks?.find(
  (h) => h.command?.includes('adlc-hook-run.mjs') || h.command?.includes('adlc-hook.mjs')
);
if (!railsHookCmd) {
  fail('plugins/adlc-claude-code/hooks/hooks.json PreToolUse rails entry must invoke adlc-hook-run.mjs (or adlc-hook.mjs)');
}

// --- key docs files ---
// Guard: integration guide and archive docs must exist.
// The plugin.json homepage URL is checked above but does not existsSync; these guards
// close the regression gap — a future commit that accidentally removes a doc file will
// fail the smoke test before CI can go green.
const requiredDocs = [
  'docs/integrations/claude-code.md',
  'docs/integrations/codex.md',
  'docs/integrations/pi.md',
  'docs/integrations/opencode.md',
  'docs/archive/README.md',
  'docs/archive/claude-code-plan.md',
  'docs/archive/gap-analysis-cc-vs-codex.md',
];
for (const docPath of requiredDocs) {
  if (!existsSync(join(repo, docPath))) fail(`missing required docs file: ${docPath}`);
}

// Guard: cross-doc relative links in docs/integrations/ must resolve on disk.
// These are internal cross-references that break silently if files are moved.
// The links below are validated as file-system paths (not rendered URLs) so that
// a future restructuring that forgets to update a cross-reference fails CI rather
// than shipping a dead link.
//
// Format: { from: 'source file (for error messages)', link: 'relative path as it
// appears in the source file', resolvedFrom: 'directory to resolve relative to' }
const crossDocLinks = [
  // docs/integrations/codex.md → ./claude-code.md  (lines 142, 158)
  { from: 'docs/integrations/codex.md', link: './claude-code.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ../../ADLC.md  (line 9)
  { from: 'docs/integrations/claude-code.md', link: '../../ADLC.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ../adr/0003-adlc-claude-code-plugin.md  (line 8)
  { from: 'docs/integrations/claude-code.md', link: '../adr/0003-adlc-claude-code-plugin.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ../ticket-authoring.md  (referenced in commands table)
  { from: 'docs/integrations/claude-code.md', link: '../ticket-authoring.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/codex.md → ../adr/0001-codex-native-adlc-integration.md  (line 7)
  { from: 'docs/integrations/codex.md', link: '../adr/0001-codex-native-adlc-integration.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/codex.md → ../ticket-authoring.md  (line 8)
  { from: 'docs/integrations/codex.md', link: '../ticket-authoring.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ./codex.md  (line 142)
  { from: 'docs/integrations/claude-code.md', link: './codex.md', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ../ci/rails-guard.yml  (line 96)
  { from: 'docs/integrations/claude-code.md', link: '../ci/rails-guard.yml', resolvedFrom: 'docs/integrations' },
  // docs/integrations/claude-code.md → ../ci/adlc-maintenance.yml  (line 99)
  { from: 'docs/integrations/claude-code.md', link: '../ci/adlc-maintenance.yml', resolvedFrom: 'docs/integrations' },
  // docs/adr/0003-adlc-claude-code-plugin.md → ../integrations/claude-code.md
  // (layout note in Decision section — previously unchecked by smoke test)
  { from: 'docs/adr/0003-adlc-claude-code-plugin.md', link: '../integrations/claude-code.md', resolvedFrom: 'docs/adr' },
];
for (const { from, link, resolvedFrom } of crossDocLinks) {
  const resolvedPath = join(repo, resolvedFrom, link);
  const normalised = resolve(resolvedPath);
  if (!existsSync(normalised)) {
    fail(
      `broken cross-doc link in ${from}: "${link}" resolves to ${normalised} which does not exist.\n` +
      `  If the target file was moved, update the link in ${from} to match the new path.`
    );
  }
}

// Guard: fragment anchor targets referenced by cross-doc links must exist as headings.
// docs/integrations/codex.md line 142 links to ./claude-code.md#gaps — the anchor only
// resolves if a "## Gaps" heading exists in claude-code.md. Without this check, the
// section heading can be silently renamed and the anchor becomes a broken dead link in
// any rendered view (GitHub, docs site) with no CI guard to catch the regression.
const fragmentAnchorChecks = [
  // docs/integrations/codex.md → ./claude-code.md#gaps (line 142)
  {
    from: 'docs/integrations/codex.md',
    targetFile: 'docs/integrations/claude-code.md',
    anchor: 'gaps',
    // Matches "## Gaps" heading (case-insensitive, optional trailing whitespace)
    headingPattern: /^##\s+Gaps\s*$/im,
    description: '"## Gaps" section heading',
  },
];
for (const { from, targetFile, anchor, headingPattern, description } of fragmentAnchorChecks) {
  const targetPath = join(repo, targetFile);
  if (!existsSync(targetPath)) {
    // File existence already validated above; skip the anchor check if file is missing
    // (the earlier guard will have already failed).
    continue;
  }
  const targetSource = readFileSync(targetPath, 'utf8');
  if (!headingPattern.test(targetSource)) {
    fail(
      `broken fragment anchor in ${from}: "#${anchor}" target not found in ${targetFile}.\n` +
      `  Expected ${description} — it may have been renamed or removed.\n` +
      `  Either restore the heading in ${targetFile} or update the anchor in ${from}.`
    );
  }
}

// --- plugins/adlc-claude-code/hooks/adlc-hook.mjs ---
const hookPath = join(repo, 'plugins/adlc-claude-code/hooks/adlc-hook.mjs');
if (!existsSync(hookPath)) fail('missing plugins/adlc-claude-code/hooks/adlc-hook.mjs');
const hookSource = readFileSync(hookPath, 'utf8');
// Strip block comments and line comments before checking for @adlc/* imports so
// that multi-line imports are found and comment text does not cause false positives.
const strippedHookSource = hookSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
// Detect all forms of @adlc/* imports: static (with or without from clause),
// side-effect (import '@adlc/...'), CJS require(), and dynamic import().
// Quote character class includes backticks to catch template literal imports.
if (
  /from\s+['"`]@adlc\//.test(strippedHookSource) ||
  /import\s+['"`]@adlc\//.test(strippedHookSource) ||
  /require\s*\(\s*['"`]@adlc\//.test(strippedHookSource) ||
  /import\s*\(\s*['"`]@adlc\//.test(strippedHookSource)
) {
  fail('plugins/adlc-claude-code/hooks/adlc-hook.mjs must not import @adlc/* packages (hook must remain zero-dependency)');
}

// --- commands ---
const requiredCommands = ['adlc-init.md', 'adlc-ticket.md', 'adlc-distill.md', 'adlc-maintain.md'];
for (const cmd of requiredCommands) {
  if (!existsSync(join(repo, 'plugins/adlc-claude-code/commands', cmd))) fail(`missing plugins/adlc-claude-code/commands/${cmd}`);
}

// --- agents ---
if (!existsSync(join(repo, 'plugins/adlc-claude-code/agents/prosecutor.md'))) fail('missing plugins/adlc-claude-code/agents/prosecutor.md');

// --- plugins/adlc-claude-code/skills/adlc/SKILL.md + frontmatter + sentinel ---
const skillPath = join(repo, 'plugins/adlc-claude-code/skills/adlc/SKILL.md');
if (!existsSync(skillPath)) fail('missing plugins/adlc-claude-code/skills/adlc/SKILL.md');
const skillSource = readFileSync(skillPath, 'utf8');
// Verify YAML frontmatter is well-formed: starts with ---, has a closing ---
// before the body, and contains required metadata fields.
const skillLines = skillSource.split('\n');
if (skillLines[0]?.trim() !== '---') {
  fail('plugins/adlc-claude-code/skills/adlc/SKILL.md must begin with a YAML frontmatter opening separator (---)');
}
const closingIdx = skillLines.slice(1).findIndex((l) => l.trim() === '---');
if (closingIdx === -1) {
  fail('plugins/adlc-claude-code/skills/adlc/SKILL.md YAML frontmatter is unclosed — missing closing separator (---)');
}
const frontmatter = skillLines.slice(1, closingIdx + 1).join('\n');
if (!/^name:\s*\S/m.test(frontmatter)) fail('plugins/adlc-claude-code/skills/adlc/SKILL.md frontmatter missing "name" field');
if (!/^description:\s*\S/m.test(frontmatter)) fail('plugins/adlc-claude-code/skills/adlc/SKILL.md frontmatter missing "description" field');
if (!skillSource.includes('ADLC_CC_SENTINEL_PHASE_ROUTER_V1')) {
  fail('plugins/adlc-claude-code/skills/adlc/SKILL.md missing sentinel ADLC_CC_SENTINEL_PHASE_ROUTER_V1');
}

// IMPORTANT: A passing smoke test does NOT confirm hook execution correctness or
// live marketplace install behavior. Two unverified assumptions remain (see Pre-GA
// checklist in docs/adr/0003-adlc-claude-code-plugin.md):
//
//   Pre-GA "Live marketplace install test": CC marketplace resolver is assumed to support
//      "source": "./plugins/adlc-claude-code/" — this is unverified. A live
//      `/plugin marketplace add voodootikigod/adlc` test is required before GA.
//
//   Pre-GA resolved concern (pass 14). Dual marketplace.json: The nested
//      plugins/adlc-claude-code/.claude-plugin/marketplace.json was removed in pass 14.
//      Only the root .claude-plugin/marketplace.json exists. The guard at lines 58-87
//      asserts the nested copy does NOT exist; re-introducing it would cause a
//      dual-resolution failure on live install.
//
//   Pre-GA "Hook CWD assumption — live install confirmation required": hook commands now
//      use adlc-hook-run.mjs (Form C dispatcher wrapper). The wrapper uses import.meta.url
//      to locate adlc-hook.mjs regardless of CWD, eliminating the $(...) shell substitution
//      risk (pass 14). The guard above verifies adlc-hook-run.mjs exists at the
//      repo-root-relative path. Still unverified: the actual CWD CC uses when executing
//      hook commands (repo root vs plugin source dir). Confirm preflight fires during the
//      live install test.
//
// These warnings are emitted in the JSON output so they appear in CI logs.
console.log(JSON.stringify({
  ok: true,
  rootMarketplaceJson: rootMarketplacePath,
  pluginJson: pluginPath,
  hooksJson: hooksConfigPath,
  hookTypes: Object.keys(hooks),
  commands: requiredCommands,
  agents: ['prosecutor.md'],
  skills: ['adlc/SKILL.md'],
  docs: requiredDocs,
  warnings: [
    'RESOLVED (live install 2026-06-22 — marketplace resolver): CC marketplace resolver supports non-root source "./plugins/adlc-claude-code/". Plugin installed without error. See docs/adr/0003-adlc-claude-code-plugin.md.',
    'RESOLVED (pass 14 — dual marketplace.json): Nested plugins/adlc-claude-code/.claude-plugin/marketplace.json removed. Only the root .claude-plugin/marketplace.json now exists. Dual-resolution risk eliminated.',
    'RESOLVED (live install 2026-06-22 — hook CWD): CC runs hooks with CWD = plugin install directory. hooks.json updated to "./hooks/adlc-hook-run.mjs" (plugin-source-dir-relative). Repo-root-relative prefix guard added to smoke test. See docs/adr/0003-adlc-claude-code-plugin.md.',
    'RESOLVED (live install 2026-06-22 — plugin.json extra fields): CC schema uses additionalProperties:false; hooks/commands/agents/skills fields removed from plugin.json. CC discovers these assets by filesystem convention. See docs/adr/0003-adlc-claude-code-plugin.md.',
  ],
}, null, 2));
