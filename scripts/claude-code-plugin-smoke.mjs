#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

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
if (rootEntry.source !== './plugins/adlc-claude-code') {
  fail(`root .claude-plugin/marketplace.json plugin entry "source" must be "./plugins/adlc-claude-code" (got ${JSON.stringify(rootEntry.source)})`);
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

// --- version lockstep (the Defect A guard) ---
// A truthiness check on plugin.version — which is all this file did until
// 1.5.1 — passes forever at any stale value. That is precisely how 0.2.0
// survived 1.3.0, 1.4.0 and 1.5.0: `/plugin` compares the DECLARED version
// string to decide whether an update exists, so a frozen string makes every
// release invisible to the updater even when main carries current content.
// scripts/cursor-install-smoke.mjs had this lockstep from the start and never
// drifted; this is the same check.
//
// adlc-claude-code ships no package.json of its own, so the ROOT package.json
// version is the lockstep target.
const rootPkgPath = join(repo, 'package.json');
if (!existsSync(rootPkgPath)) fail('missing root package.json — cannot verify version lockstep');
const rootVersion = readJson(rootPkgPath).version;
if (!rootVersion) fail('root package.json has no "version" — cannot verify version lockstep');

if (plugin.version !== rootVersion) {
  fail(
    `plugin.json version ${plugin.version} != root package.json version ${rootVersion}\n` +
    `  Run: node scripts/release.mjs ${rootVersion}  (the bump is glob-driven and covers every host manifest)`
  );
}
if (rootMarketplace.metadata?.version !== rootVersion) {
  fail(
    `root .claude-plugin/marketplace.json metadata.version ${rootMarketplace.metadata?.version} != root package.json version ${rootVersion}\n` +
    `  Run: node scripts/release.mjs ${rootVersion}`
  );
}
for (const entry of rootMarketplace.plugins ?? []) {
  if (entry.version !== rootVersion) {
    fail(
      `root .claude-plugin/marketplace.json plugin "${entry.name}" version ${entry.version} != root package.json version ${rootVersion}\n` +
      `  Run: node scripts/release.mjs ${rootVersion}`
    );
  }
}
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
// CC plugin.json schema uses additionalProperties:false (confirmed live install 2026-06-22).
// 'hooks' is tentatively re-added to test whether it is a recognized CC field — if
// install fails again with "invalid manifest", remove it and rely on convention discovery.
const allowedPluginJsonKeys = new Set([
  'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords', 'hooks',
]);
const extraPluginJsonKeys = Object.keys(plugin).filter((k) => !allowedPluginJsonKeys.has(k));
if (extraPluginJsonKeys.length > 0) {
  fail(
    `plugin.json contains extra fields that will cause CC to reject the install with "invalid manifest": ${extraPluginJsonKeys.join(', ')}\n` +
    `  CC plugin.json schema uses additionalProperties:false. Only these fields are allowed: ${[...allowedPluginJsonKeys].join(', ')}\n` +
    `  Remove the extra fields and rely on filesystem convention for hooks/commands/agents/skills discovery.`
  );
}
// Note: "hooks" field must NOT be present in plugin.json — CC auto-loads hooks/hooks.json
// by convention. An explicit hooks field causes a "duplicate hooks file" install error.

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

// Guard: hook commands must use ${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs.
// CC injects CLAUDE_PLUGIN_ROOT = absolute path to the plugin's install directory.
// Confirmed by research across 20+ production CC marketplace plugins (Dev-GOM/claude-code-marketplace,
// ruvnet/ruflo). All use the unquoted form: node ${CLAUDE_PLUGIN_ROOT}/scripts/foo.js
// Bad forms that were tried and failed (2026-06-22 live install testing):
//   - "./plugins/adlc-claude-code/hooks/" → not present in plugin install dir
//   - "./hooks/" → CWD is user's project dir, not plugin install dir
//   - "${PLUGIN_ROOT}/" → wrong var name, not set by CC (Codex uses PLUGIN_ROOT; CC uses CLAUDE_PLUGIN_ROOT)
//   - "node \"${CLAUDE_PLUGIN_ROOT}/...\"" with quotes → may interfere with CC's variable substitution
const allHookEntries = Object.values(hooks).flat().flatMap((e) => e.hooks ?? []);
const badPrefixCmd = allHookEntries.find((h) => {
  const cmd = h.command ?? '';
  return (
    cmd.includes('./plugins/adlc-claude-code/hooks/') ||
    /node ["']?\.\/hooks\//.test(cmd) ||
    cmd.includes('${PLUGIN_ROOT}')
  );
});
if (badPrefixCmd) {
  fail(
    `hooks.json command uses a bad path form: ${JSON.stringify(badPrefixCmd.command)}\n` +
    `  Use 'node \${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs <mode>' (unquoted, CLAUDE_PLUGIN_ROOT).`
  );
}
const missingClaudePluginRootCmd = allHookEntries.find(
  (h) => (h.command ?? '').includes('adlc-hook-run.mjs') && !(h.command ?? '').includes('${CLAUDE_PLUGIN_ROOT}')
);
if (missingClaudePluginRootCmd) {
  fail(
    `hooks.json adlc-hook-run.mjs command does not use \${CLAUDE_PLUGIN_ROOT}: ${JSON.stringify(missingClaudePluginRootCmd.command)}\n` +
    `  Correct form: node \${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs <mode>`
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

// Guard: adlc-hook-run.mjs must exist in the plugin source hooks/ directory.
// CC injects CLAUDE_PLUGIN_ROOT pointing at the install dir; hooks.json references
// "${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs" which maps to this file at install time.
const pluginSourceDir = join(repo, 'plugins/adlc-claude-code');
const hookRunPath = join(pluginSourceDir, 'hooks/adlc-hook-run.mjs');
if (!existsSync(hookRunPath)) {
  fail('plugins/adlc-claude-code/hooks/adlc-hook-run.mjs is missing — CC resolves ${PLUGIN_ROOT}/hooks/adlc-hook-run.mjs to this file at install time');
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
const requiredCommands = ['adlc-init.md', 'adlc-ticket.md', 'adlc-distill.md', 'adlc-maintain.md', 'adlc-prosecute.md'];
for (const cmd of requiredCommands) {
  if (!existsSync(join(repo, 'plugins/adlc-claude-code/commands', cmd))) fail(`missing plugins/adlc-claude-code/commands/${cmd}`);
}

// --- adlc-prosecute.md command must actually describe the fan-out/dedupe/verify/loop shape ---
// (issue #61: parity with plugins/adlc-opencode/command/adlc-prosecute.md — a passing smoke
// test must not be satisfiable by an empty stub file that merely exists.)
const prosecuteCmdPath = join(repo, 'plugins/adlc-claude-code/commands/adlc-prosecute.md');
const prosecuteCmdSource = readFileSync(prosecuteCmdPath, 'utf8');
if (prosecuteCmdSource.slice(0, 3) !== '---') {
  fail('plugins/adlc-claude-code/commands/adlc-prosecute.md must begin with YAML frontmatter (---)');
}
if (!/^description:\s*\S/m.test(prosecuteCmdSource)) {
  fail('plugins/adlc-claude-code/commands/adlc-prosecute.md frontmatter missing "description" field');
}
const requiredProsecuteMentions = [
  'prosecutor-correctness', 'prosecutor-security', 'prosecutor-contract', 'prosecutor-diff',
  'prosecutor-tests', 'prosecutor-verifier',
];
for (const name of requiredProsecuteMentions) {
  if (!prosecuteCmdSource.includes(name)) {
    fail(`plugins/adlc-claude-code/commands/adlc-prosecute.md must mention the ${name} subagent`);
  }
}
// Must describe all shape elements from the issue, not just fan-out.
const requiredProsecuteConcepts = [
  { label: 'dedupe', pattern: /dedup/i },
  { label: 'independent verification', pattern: /verif/i },
  { label: 'loop-until-dry convergence', pattern: /dry/i },
];
for (const { label, pattern } of requiredProsecuteConcepts) {
  if (!pattern.test(prosecuteCmdSource)) {
    fail(`plugins/adlc-claude-code/commands/adlc-prosecute.md must describe ${label}`);
  }
}

// --- agents ---
if (!existsSync(join(repo, 'plugins/adlc-claude-code/agents/prosecutor.md'))) fail('missing plugins/adlc-claude-code/agents/prosecutor.md');

// --- prosecutor-{correctness,security,contract,diff,tests,verifier} lens/verifier subagents ---
const requiredProsecutionAgents = [
  'prosecutor-correctness.md', 'prosecutor-security.md', 'prosecutor-contract.md',
  'prosecutor-diff.md', 'prosecutor-tests.md', 'prosecutor-verifier.md',
];
for (const agentFile of requiredProsecutionAgents) {
  const agentPath = join(repo, 'plugins/adlc-claude-code/agents', agentFile);
  if (!existsSync(agentPath)) fail(`missing plugins/adlc-claude-code/agents/${agentFile}`);
  const agentSource = readFileSync(agentPath, 'utf8');
  const agentName = agentFile.replace(/\.md$/, '');
  // Claude Code subagent frontmatter: name / description / tools (not OpenCode's
  // description / mode / permission block).
  if (!new RegExp(`^---\\nname:\\s*${agentName}\\s*\\n`).test(agentSource)) {
    fail(`plugins/adlc-claude-code/agents/${agentFile} frontmatter must open with "name: ${agentName}"`);
  }
  if (!/\ndescription:\s*\S/.test(agentSource)) {
    fail(`plugins/adlc-claude-code/agents/${agentFile} frontmatter missing "description" field`);
  }
  if (!/\ntools:\s*\S/.test(agentSource)) {
    fail(`plugins/adlc-claude-code/agents/${agentFile} frontmatter missing "tools" field`);
  }
  const frontmatterEnd = agentSource.indexOf('\n---', 4);
  if (frontmatterEnd === -1) fail(`plugins/adlc-claude-code/agents/${agentFile} frontmatter is unclosed`);
  const agentFrontmatter = agentSource.slice(0, frontmatterEnd);
  // These are hostile read-only reviewers (5 lenses + verifier): granting Edit/Write/
  // MultiEdit/Bash would let a "reviewer" tamper with the code or tests it is supposed
  // to adversarially assess, or silently mutate evidence instead of just reporting it.
  if (/tools:.*\b(Edit|Write|MultiEdit|Bash)\b/.test(agentFrontmatter)) {
    fail(`plugins/adlc-claude-code/agents/${agentFile} must not grant Edit/Write/MultiEdit/Bash tools (read-only prosecution lens)`);
  }
}

// --- lib/prosecutor.mjs: the pure dedupe/verify/convergence contract must exist and be
// wired into the workspace test suite, not just present as an inert file ---
const prosecutorLibPath = join(repo, 'plugins/adlc-claude-code/lib/prosecutor.mjs');
if (!existsSync(prosecutorLibPath)) fail('missing plugins/adlc-claude-code/lib/prosecutor.mjs');
const prosecutorLibSource = readFileSync(prosecutorLibPath, 'utf8');
for (const exportName of ['LENSES', 'VERIFIER', 'ALL_AGENTS', 'findingKey', 'dedupeFindings', 'survivesVerification', 'shouldContinue']) {
  if (!new RegExp(`export (const|function) ${exportName}\\b`).test(prosecutorLibSource)) {
    fail(`plugins/adlc-claude-code/lib/prosecutor.mjs must export ${exportName}`);
  }
}
const prosecutorLibTestPath = join(repo, 'plugins/adlc-claude-code/lib/test/prosecutor.test.mjs');
if (!existsSync(prosecutorLibTestPath)) fail('missing plugins/adlc-claude-code/lib/test/prosecutor.test.mjs');
// The contract is that CI ACTUALLY RUNS these tests. That used to be visible as a
// literal path in package.json's test script, but the script now delegates to a
// runner (so one failing suite cannot abort the rest), which moved the segment list
// one level down. Follow the delegation rather than grepping only the top level —
// otherwise this guard silently stops seeing the thing it exists to protect.
const rootTestScript = readJson(join(repo, 'package.json')).scripts?.test ?? '';
const runnerMatch = rootTestScript.match(/node\s+(scripts\/[\w.-]+\.mjs)/);
const testEntrypoints = [rootTestScript];
if (runnerMatch) {
  const runnerPath = join(repo, runnerMatch[1]);
  if (!existsSync(runnerPath)) fail(`root package.json "test" script delegates to ${runnerMatch[1]}, which does not exist`);
  testEntrypoints.push(readFileSync(runnerPath, 'utf8'));
}
if (!testEntrypoints.some((source) => source.includes('plugins/adlc-claude-code/lib/test'))) {
  fail('the root "test" script (or the runner it delegates to) must run plugins/adlc-claude-code/lib/test/*.test.mjs so the prosecution convergence contract is exercised in CI');
}

// --- T52: MCP server, auto-discovered by location (.mcp.json at plugin root) ---
// per the live Claude Code plugins reference — NOT a plugin.json pointer field
// (that is Codex's convention, not this platform's).
const mcpConfigPath = join(repo, 'plugins/adlc-claude-code/.mcp.json');
if (!existsSync(mcpConfigPath)) fail('missing plugins/adlc-claude-code/.mcp.json');
const mcpConfig = readJson(mcpConfigPath);
if (mcpConfig.adlc?.command !== 'adlc' || JSON.stringify(mcpConfig.adlc.args) !== JSON.stringify(['mcp-server'])) {
  fail('.mcp.json must use the stable adlc mcp-server entrypoint (shells to the globally-installed adlc binary, not a locally-resolved import)');
}
const mcpServerPath = join(repo, 'plugins/adlc-claude-code/mcp/server.mjs');
if (!existsSync(mcpServerPath)) fail('missing plugins/adlc-claude-code/mcp/server.mjs');
const mcpServerSource = readFileSync(mcpServerPath, 'utf8');
if (!/runStdioServer/.test(mcpServerSource)) fail('plugins/adlc-claude-code/mcp/server.mjs must delegate to @adlc/cli/lib/mcp-server.mjs runStdioServer');
if (readFileSync(pluginPath, 'utf8').includes('mcpServers')) {
  fail('plugin.json must NOT declare an mcpServers pointer field — Claude Code auto-discovers .mcp.json by its fixed plugin-root location');
}

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

// --- Guard: no bare, non-namespaced command recommendations (closes #50, #96) ---
// The plugin is named "adlc" (plugins/adlc-claude-code/.claude-plugin/plugin.json),
// so inside Claude Code the actual invocable form of a plugin command is the
// namespaced "/adlc:adlc-<name>" — a bare "/adlc-<name>" is not a real command and
// silently fails to invoke when a user (or the agent itself) follows the guidance.
// This scans every .md/.mjs file under commands/, skills/, agents/, and hooks/,
// plus every markdown doc in the repo (see the doc-wide scan below), for a bare
// reference to one of the plugin's real commands and fails loudly if found.
//
// The command-name list is DERIVED from the commands/ directory itself, not
// hardcoded — a hardcoded list (['init', 'ticket', 'distill', 'maintain']) is
// exactly the kind of allowlist #96 exists to eliminate: it silently missed
// '/adlc-prosecute' after #61 added a fifth command, and a live instance of that
// exact gap (docs/integrations/claude-code.md, and the command file's own
// heading) was found and fixed while building this guard.
const commandsDir = join(pluginSourceDir, 'commands');
const namespacedCommandNames = existsSync(commandsDir)
  ? readdirSync(commandsDir)
      .filter((name) => name.startsWith('adlc-') && name.endsWith('.md'))
      .map((name) => name.slice('adlc-'.length, -'.md'.length))
      // A filename of exactly "adlc-.md" (or similarly degenerate) would derive
      // an empty name, producing an empty alternative in the regex alternation
      // below. An empty alternative matches everywhere, silently widening
      // "/adlc-<name>" into "/adlc-" matching ANY bare command reference —
      // reintroducing exactly the "match too much" class the escaping fix
      // below exists to close. Drop empty names defensively; there is no
      // legitimate command with an empty name.
      .filter((name) => name.length > 0)
  : [];
if (namespacedCommandNames.length === 0) {
  fail('no adlc-*.md command files found under plugins/adlc-claude-code/commands — cannot derive namespacedCommandNames (the bare-command guard would silently match nothing)');
}
// Escape regex metacharacters in each derived name before splicing into the
// alternation below. Names come from filenames on disk, not a hardcoded
// literal list, so they must be treated as untrusted regex input: an
// unescaped "." would silently widen the match (matching any character, not
// a literal dot), and an unescaped "(" would throw an uncaught SyntaxError
// from `new RegExp(...)`, crashing the script instead of failing cleanly
// through `fail()`.
const escapedCommandNames = namespacedCommandNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
// Matches "/adlc-init" etc. but NOT "/adlc:adlc-init" (scoped form, via the
// negative lookbehind) and NOT a file-path or URL reference such as
// "commands/adlc-init.md", "docs/ci/adlc-maintenance.yml",
// "/adlc-init-helper.mjs", or "https://example.com/adlc-init-docs":
//   - the leading negative lookbehind requires the "/" to NOT be preceded by a
//     word character, ":", ".", "/" or "-" — this rules out nested paths and
//     URL path segments (e.g. "example.com/adlc-init"), where the "/" is just
//     a path separator, not the start of a slash-command.
//   - the trailing negative lookaheads require what follows the command name
//     to NOT continue as a longer identifier ("-helper") or a known file
//     extension (".md" / ".mjs" / ".yml" / ".yaml"), so "adlc-init-helper.mjs"
//     and "adlc-init.md" are not mistaken for the bare command "/adlc-init".
const bareCommandPattern = new RegExp(
  `(?<!adlc:)(?<![\\w:./-])/adlc-(?:${escapedCommandNames.join('|')})\\b(?!-)(?!\\.(?:md|mjs|yml|yaml))`,
  'g'
);
// Shared symlink-safe recursive file collector, used by BOTH the plugin-tree
// scan below and the doc-wide scan further down. Uses statSync (follows
// symlinks), not a Dirent's own type flags: Dirent.isDirectory() reports false
// for a symlink even when its target IS a directory, so a symlinked directory
// would otherwise be recursed into by neither branch — invisible to the scan
// with zero trace in the tool's output. An EARLIER version of this guard had
// two independent copies of this traversal (one for the plugin tree, one for
// docs/); the symlink fix was applied to only one of them and the other still
// had the exact same blind spot — the identical "silent gap in one of two
// hand-duplicated copies" failure class #96 exists to close in general. One
// shared implementation now, so a future fix here can't be applied to only
// one of two copies again.
function collectFilesRecursively(dirPath, matchExtensions, out = []) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    let isDir;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue; // broken symlink target — nothing to scan
    }
    if (isDir) {
      collectFilesRecursively(entryPath, matchExtensions, out);
    } else if (matchExtensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(entryPath);
    }
  }
  return out;
}
const guidanceDirs = ['commands', 'skills', 'agents', 'hooks'];
const guidanceFiles = [];
for (const dir of guidanceDirs) {
  const dirPath = join(pluginSourceDir, dir);
  if (!existsSync(dirPath)) continue;
  collectFilesRecursively(dirPath, ['.md', '.mjs'], guidanceFiles);
}
// Doc-wide scan (closes #96): the previous version of this guard scanned only a
// hardcoded allowlist of "extra" doc paths outside the plugin's own tree
// (docs/integrations/claude-code.md, README.md, the design ADR). Every one of
// #50/#89's adversarial-review rounds after the first found a NEW doc surface
// with a bare reference the allowlist hadn't been told about — the allowlist
// itself was the recurring vulnerability. Scan every markdown doc in the repo
// instead, with an explicit, reviewed EXCLUSION list for paths that are
// genuinely not Claude-Code-specific live guidance (each entry states why).
// Adding a new doc anywhere under docs/ or at the repo root is covered
// automatically from now on; nothing has to remember to list it.
const DOC_SCAN_ROOTS = ['docs', 'README.md'];
// AGENTS.md / CLAUDE.md are common cross-harness instruction files; scan them
// too if this repo ever adds one — they're exactly the kind of top-level
// guidance surface #50 was filed about.
for (const name of ['AGENTS.md', 'CLAUDE.md']) {
  if (existsSync(join(repo, name))) DOC_SCAN_ROOTS.push(name);
}
// Each entry is a POSIX-style path (file or directory prefix, relative to repo
// root) excluded from the doc-wide scan, with the reason it is not a live
// Claude-Code guidance surface. This list is reviewed, not implicit — a new doc
// that doesn't match any entry here is scanned by default.
const EXCLUDED_DOC_PATHS = [
  ['docs/archive/', 'superseded/historical record, not live guidance — see docs/archive/README.md'],
  ['docs/reviews/', 'completion-verification evidence records; they quote reviewed prose and other harnesses\' bare command syntax verbatim, not live Claude Code guidance'],
  ['docs/specs/', 'P1 spec/acceptance-criteria docs describe issues (including this bug class) as illustrative examples, not live guidance'],
  ['docs/superpowers/', 'internal planning/spec scratch docs for in-flight work, not published guidance'],
  ['docs/marketing/', "marketing-site spec/plan docs; quoted install snippets include other harnesses' bare command syntax (e.g. OpenCode's /adlc-init), not Claude Code guidance"],
  ['docs/tools/', 'harness-agnostic package reference docs (per docs/toolkit.md: "follow the linked README for command-specific detail"), not per-harness invocation guidance'],
  ['docs/integrations/gemini.md', "Gemini's own doc (Antigravity/JetSki); that harness has no plugin-namespace convention (verified in #50)"],
  ['docs/integrations/codex.md', "Codex's own doc; skill-driven, not command-namespaced (verified in #50)"],
  ['docs/integrations/cursor.md', "Cursor's own doc; bare \"/adlc-*\" is that harness's correct, intentional syntax"],
  ['docs/integrations/opencode.md', "OpenCode's own doc; bare \"/adlc-*\" is that harness's correct, intentional syntax"],
  ['docs/integrations/pi.md', "Pi's own doc; skill-driven, not command-namespaced (verified in #50)"],
  ['docs/adr/0004-adlc-opencode-integration.md', "ADR specific to the OpenCode integration; bare \"/adlc-*\" is that harness's correct, intentional syntax"],
  ['docs/adr/0006-adlc-cursor-integration.md', "ADR specific to the Cursor integration; bare form is Cursor's correct syntax"],
  ['docs/opencode-integration-plan.md', 'OpenCode-specific planning doc, not a Claude Code guidance surface'],
  ['docs/ticket-sync.md', 'uses "/adlc-ticket" as generic ADLC-lifecycle prose, not a Claude-Code-specific command recommendation (judged out of scope during #50\'s review)'],
];
function isExcludedDocPath(relPosixPath) {
  return EXCLUDED_DOC_PATHS.some(([prefix]) => relPosixPath === prefix || relPosixPath.startsWith(prefix));
}
for (const scanRoot of DOC_SCAN_ROOTS) {
  const fullPath = join(repo, scanRoot);
  if (!existsSync(fullPath)) continue;
  const candidates = statSync(fullPath).isDirectory() ? collectFilesRecursively(fullPath, ['.md']) : [fullPath];
  for (const filePath of candidates) {
    const relPosixPath = filePath.slice(repo.length + 1).split(sep).join('/');
    if (isExcludedDocPath(relPosixPath)) continue;
    guidanceFiles.push(filePath);
  }
}
for (const filePath of guidanceFiles) {
  const source = readFileSync(filePath, 'utf8');
  const matches = source.match(bareCommandPattern);
  if (matches) {
    const relPath = filePath.slice(repo.length + 1);
    fail(
      `bare, non-namespaced command reference found in ${relPath}: ${[...new Set(matches)].join(', ')}\n` +
      `  The plugin is namespaced "adlc" — the actual invocable form inside Claude Code is\n` +
      `  "/adlc:adlc-<name>", not the bare "/adlc-<name>". Update the guidance text to the\n` +
      `  scoped form (see issue #50).`
    );
  }
}

// IMPORTANT: A passing smoke test does NOT confirm hook execution correctness or
// live marketplace install behavior. Two unverified assumptions remain (see Pre-GA
// checklist in docs/adr/0003-adlc-claude-code-plugin.md):
//
//   Pre-GA "Live marketplace install test": RESOLVED. Source path uses no trailing slash
//      ("./plugins/adlc-claude-code"); plugin version bumped to 0.2.0 to prevent stale-cache
//      re-install failures. See docs/adr/0003-adlc-claude-code-plugin.md for full account.
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
  mcpServers: 1,
  hookTypes: Object.keys(hooks),
  commands: requiredCommands,
  agents: ['prosecutor.md', ...requiredProsecutionAgents],
  lib: ['prosecutor.mjs'],
  skills: ['adlc/SKILL.md'],
  docs: requiredDocs,
  warnings: [
    'RESOLVED (live install 2026-06-22 / fix 2026-06-26): CC marketplace resolver supports non-root source. Trailing slash removed from source path ("./plugins/adlc-claude-code/" → "./plugins/adlc-claude-code") and plugin.json bumped to 0.2.0 to fix stale-cache regression on re-install. See docs/adr/0003-adlc-claude-code-plugin.md.',
    'RESOLVED (pass 14 — dual marketplace.json): Nested plugins/adlc-claude-code/.claude-plugin/marketplace.json removed. Only the root .claude-plugin/marketplace.json now exists. Dual-resolution risk eliminated.',
    'RESOLVED (live install 2026-06-22 — hook CWD): CC runs hooks with CWD = user project dir (not plugin install dir). Hook commands use node ${CLAUDE_PLUGIN_ROOT}/hooks/adlc-hook-run.mjs <mode> — CC injects CLAUDE_PLUGIN_ROOT as the absolute plugin install path. Confirmed correct by research across 20+ production CC plugins. See docs/integrations/claude-code-plugin-hooks-investigation.md.',
    'RESOLVED (live install 2026-06-22 — plugin.json extra fields): CC schema uses additionalProperties:false; hooks/commands/agents/skills fields removed from plugin.json. CC discovers these assets by filesystem convention. See docs/adr/0003-adlc-claude-code-plugin.md.',
  ],
}, null, 2));
