#!/usr/bin/env node
// cursor-install-smoke.mjs — local verification for the ADLC Cursor integration
// integration. Mirrors scripts/opencode-install-smoke.mjs: validates the package
// shape, the hooks.json wiring (preToolUse dispatcher + afterFileEdit audit +
// beforeShellExecution advisory), the rule registration, the command palette, the
// @adlc/core delegation (no inlined rail engine), the shipped documentation's
// honesty strings (T19), and runs the real enforcement unit tests. Does NOT
// require the Cursor binary and does not mutate the user environment. Exit 0 =
// all checks pass; exit 2 = a check failed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-cursor');
let failures = 0;
const fail = (m) => { console.error(`cursor-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// ---- AC1: package + manifest shape ----
const pkgPath = join(PLUGIN, 'package.json');
if (!existsSync(pkgPath)) fail('plugins/adlc-cursor/package.json missing');
else {
  const pkg = JSON.parse(read(pkgPath));
  if (pkg.name !== '@adlc/cursor') fail(`package name is ${pkg.name}`); else ok('package name');
  if (pkg.type !== 'module') fail('package is not type:module'); else ok('type:module');
  if (!pkg.dependencies?.['@adlc/core']) fail('missing @adlc/core dependency'); else ok('dependency @adlc/core');
  // T18 AC2 companion: the buildgate/flail deep-subpath imports resolve via the
  // workspace root inside THIS repo even when undeclared, which would mask a
  // broken standalone install — the declarations must be asserted here.
  if (!pkg.dependencies?.['@adlc/build-gate']) fail('missing @adlc/build-gate dependency (deep-subpath imports would break on a standalone install)');
  else ok('dependency @adlc/build-gate declared');
  if (!pkg.dependencies?.['@adlc/flail-detector']) fail('missing @adlc/flail-detector dependency (deep-subpath imports would break on a standalone install)');
  else ok('dependency @adlc/flail-detector declared');
  if (!pkg.dependencies?.['@adlc/tickets']) fail('missing @adlc/tickets dependency (sessionStart/rails store detection)');
  else ok('dependency @adlc/tickets declared');
  if (!pkg.cursor?.hooks) fail('package.json cursor.hooks entry missing'); else ok('cursor.hooks manifest entry');
  if (!pkg.cursor?.rules) fail('package.json cursor.rules entry missing'); else ok('cursor.rules manifest entry');
  if (pkg.cursor?.mcpServers !== './mcp.json') fail('package.json cursor.mcpServers must be ./mcp.json');
  else ok('cursor.mcpServers manifest entry');
}

// ---- T65: mcp.json Roots proxy wrapper (not raw adlc mcp-server) ----
{
  const mcpPath = join(PLUGIN, 'mcp.json');
  if (!existsSync(mcpPath)) fail('plugins/adlc-cursor/mcp.json missing');
  else {
    const mcp = JSON.parse(read(mcpPath));
    const adlc = mcp.mcpServers?.adlc;
    if (!adlc) fail('mcp.json missing mcpServers.adlc');
    else if (adlc.command !== 'node' || !(adlc.args ?? []).some((a) => /adlc-mcp-wrapper\.mjs/.test(String(a)))) {
      fail('mcp.json must launch node ./bin/adlc-mcp-wrapper.mjs (Roots proxy)');
    } else if (JSON.stringify(adlc).includes('mcp-server')) {
      fail('mcp.json must not wire raw adlc mcp-server (use the wrapper)');
    } else ok('mcp.json wires Roots proxy wrapper');
  }
  if (!existsSync(join(PLUGIN, 'bin', 'adlc-mcp-wrapper.mjs'))) fail('bin/adlc-mcp-wrapper.mjs missing');
  else ok('bin/adlc-mcp-wrapper.mjs present');
  const manifest = JSON.parse(read(join(PLUGIN, '.cursor-plugin', 'plugin.json')));
  if (manifest.mcpServers !== './mcp.json') fail('.cursor-plugin/plugin.json mcpServers must be ./mcp.json');
  else ok('plugin.json discovers mcp.json');
}

// ---- AC1 + T47: hooks wiring (dispatcher + audit + shell + stop + preflight) ----
function assertHookConfig(label, hooksJsonPath, { relativeNeedle }) {
  if (!existsSync(hooksJsonPath)) { fail(`${label} missing`); return; }
  const hj = JSON.parse(read(hooksJsonPath));
  if (hj.version !== 1) fail(`${label} version is not 1`); else ok(`${label} version 1`);
  const pre = hj.hooks?.preToolUse ?? [];
  if (!pre.some((e) => /adlc-pretool\.mjs/.test(e.command ?? ''))) fail(`${label}: preToolUse does not wire the adlc-pretool.mjs dispatcher`);
  else ok(`${label}: preToolUse wires the single dispatcher`);
  if (pre.some((e) => /adlc-rails-guard\.mjs/.test(e.command ?? ''))) fail(`${label}: preToolUse still wires adlc-rails-guard.mjs directly`);
  else ok(`${label}: no direct rails-guard preToolUse entry`);
  if (pre.filter((e) => /adlc-/.test(e.command ?? '')).length !== 1) fail(`${label}: preToolUse must carry exactly ONE ADLC entry`);
  else ok(`${label}: exactly one ADLC preToolUse entry`);
  if (!pre.every((e) => typeof e.command === 'string' && e.command.includes(relativeNeedle) && !/^node\s+"?\//.test(e.command))) {
    fail(`${label}: hook commands must be relative (needle=${relativeNeedle}), not absolute`);
  } else ok(`${label}: relative hook command paths`);
  const after = hj.hooks?.afterFileEdit ?? [];
  if (!after.some((e) => /adlc-audit\.mjs/.test(e.command ?? ''))) fail(`${label}: afterFileEdit missing audit`);
  else ok(`${label}: afterFileEdit audit`);
  const shell = hj.hooks?.beforeShellExecution ?? [];
  if (!shell.some((e) => /adlc-shell-advisory\.mjs/.test(e.command ?? ''))) fail(`${label}: beforeShellExecution missing`);
  else ok(`${label}: beforeShellExecution advisory`);

  const sessionStart = hj.hooks?.sessionStart ?? [];
  if (!sessionStart.some((e) => /adlc-session-start\.mjs/.test(e.command ?? ''))) fail(`${label}: sessionStart missing adlc-session-start.mjs`);
  else ok(`${label}: sessionStart wired`);
  if (!sessionStart.every((e) => e.failClosed === false && e.timeout === 10)) fail(`${label}: sessionStart must use failClosed:false timeout:10`);
  else ok(`${label}: sessionStart failClosed/timeout lockstep`);
  const stop = hj.hooks?.stop ?? [];
  if (!stop.some((e) => /adlc-stop\.mjs/.test(e.command ?? ''))) fail(`${label}: stop must wire adlc-stop.mjs by default (T47)`);
  else ok(`${label}: stop wired by default`);
  const preflight = hj.hooks?.beforeSubmitPrompt ?? [];
  if (!preflight.some((e) => /adlc-preflight\.mjs/.test(e.command ?? ''))) fail(`${label}: beforeSubmitPrompt must wire adlc-preflight.mjs by default (T47)`);
  else ok(`${label}: beforeSubmitPrompt wired by default`);
  const VERIFIED_EVENTS = new Set([
    'sessionStart', 'preToolUse', 'afterFileEdit', 'beforeShellExecution', 'beforeReadFile',
    'stop', 'beforeSubmitPrompt', 'preCompact', 'subagentStart', 'subagentStop',
  ]);
  const unverified = Object.keys(hj.hooks ?? {}).filter((k) => !VERIFIED_EVENTS.has(k));
  if (unverified.length) fail(`${label}: unverified event(s): ${unverified.join(', ')}`);
  else ok(`${label}: only documented Cursor events`);
  for (const ev of ['preCompact', 'subagentStart', 'subagentStop']) {
    const entries = hj.hooks?.[ev] ?? [];
    if (!entries.length) fail(`${label}: ${ev} missing (T67)`);
    else if (!entries.every((e) => e.failClosed === false && e.timeout === 10)) fail(`${label}: ${ev} must use failClosed:false timeout:10`);
    else ok(`${label}: ${ev} wired`);
  }
  if (!(hj.hooks?.preCompact ?? []).some((e) => /adlc-precompact\.mjs/.test(e.command ?? ''))) {
    fail(`${label}: preCompact must wire adlc-precompact.mjs`);
  }
  if (!(hj.hooks?.subagentStart ?? []).some((e) => /adlc-subagent\.mjs/.test(e.command ?? ''))) {
    fail(`${label}: subagentStart must wire adlc-subagent.mjs`);
  }
  if (!(hj.hooks?.subagentStop ?? []).some((e) => /adlc-subagent\.mjs/.test(e.command ?? ''))) {
    fail(`${label}: subagentStop must wire adlc-subagent.mjs`);
  }
  if (pre[0]?.failClosed !== false) fail(`${label}: preToolUse failClosed must be false`);
  else ok(`${label}: failClosed:false`);
  const matcher = pre.find((e) => /adlc-pretool/.test(e.command ?? ''))?.matcher ?? '';
  const re = new RegExp(matcher, 'i');
  const routed = ['Write', 'str_replace', 'modify_file', 'frobnicate', 'Read'].every((t) => re.test(t));
  if (!routed) fail(`${label}: preToolUse matcher is not catch-all`);
  else ok(`${label}: catch-all matcher`);
}

assertHookConfig('hooks/hooks.json', join(PLUGIN, 'hooks', 'hooks.json'), { relativeNeedle: './hooks/' });
assertHookConfig('hooks.json', join(PLUGIN, 'hooks.json'), { relativeNeedle: './node_modules/@adlc/cursor/hooks/' });

// ---- T47: marketplace + plugin manifest + skills ----
const pkg = JSON.parse(read(join(PLUGIN, 'package.json')));
const pkgVersion = pkg.version;
const marketplacePath = join(ROOT, '.cursor-plugin', 'marketplace.json');
if (!existsSync(marketplacePath)) fail('root .cursor-plugin/marketplace.json missing');
else {
  const m = JSON.parse(read(marketplacePath));
  if (m.name === 'adlc') fail('marketplace name must not be bare "adlc" (collides with Claude Code plugin identity)');
  else if (m.name !== 'adlc-plugins') fail(`marketplace name is ${m.name}, expected adlc-plugins`);
  else ok('marketplace name is adlc-plugins (no Claude Code name collision)');
  if (m.metadata?.pluginRoot !== 'plugins') fail('marketplace metadata.pluginRoot must be "plugins"');
  else ok('marketplace pluginRoot=plugins');
  const entry = (m.plugins ?? []).find((p) => p.name === 'adlc-cursor');
  if (!entry) fail('marketplace missing adlc-cursor plugin entry');
  else if (entry.source !== 'adlc-cursor') fail(`marketplace source is ${entry.source}`);
  else if (entry.version !== pkgVersion) fail(`marketplace plugin version ${entry.version} != package ${pkgVersion}`);
  else if (m.metadata?.version !== pkgVersion) fail(`marketplace metadata.version ${m.metadata?.version} != package ${pkgVersion}`);
  else ok('marketplace lists adlc-cursor → plugins/adlc-cursor (version lockstep)');
  if (!/Cursor/i.test(entry.description ?? '') || /Claude Code/i.test(entry.description ?? '')) {
    fail('marketplace plugin description must say Cursor and must not say Claude Code');
  } else ok('marketplace description is Cursor-branded');
  if (entry.logo !== 'plugins/adlc-cursor/assets/logo.png') fail(`marketplace logo is ${entry.logo}`);
  else ok('marketplace logo path resolves under plugins/adlc-cursor');
  if (entry.displayName !== 'ADLC for Cursor') fail(`marketplace displayName is ${entry.displayName}`);
  else ok('marketplace displayName is ADLC for Cursor');
}
const logoPng = join(PLUGIN, 'assets', 'logo.png');
const logoSvg = join(PLUGIN, 'assets', 'logo.svg');
if (!existsSync(logoPng)) fail('plugins/adlc-cursor/assets/logo.png missing');
else ok('plugin logo assets/logo.png');
if (!existsSync(logoSvg)) fail('plugins/adlc-cursor/assets/logo.svg missing');
else ok('plugin logo assets/logo.svg');
const pluginManifestPath = join(PLUGIN, '.cursor-plugin', 'plugin.json');
if (!existsSync(pluginManifestPath)) fail('plugins/adlc-cursor/.cursor-plugin/plugin.json missing');
else {
  const pm = JSON.parse(read(pluginManifestPath));
  if (pm.name !== 'adlc-cursor') fail(`plugin.json name is ${pm.name}`); else ok('plugin.json name');
  if (pm.displayName !== 'ADLC for Cursor') fail(`plugin.json displayName is ${pm.displayName}`); else ok('plugin.json displayName');
  if (pm.version !== pkg.version) fail(`plugin.json version ${pm.version} != package ${pkg.version}`); else ok('plugin.json version lockstep');
  if (pm.logo !== 'assets/logo.png') fail(`plugin.json logo is ${pm.logo}`); else ok('plugin.json logo');
  if (/Claude Code/i.test(pm.description ?? '')) fail('plugin.json description must not mention Claude Code');
  else ok('plugin.json description is Cursor-only');
}
for (const skill of ['adlc', 'adlc-init']) {
  const skillPath = join(PLUGIN, 'skills', skill, 'SKILL.md');
  if (!existsSync(skillPath)) fail(`skills/${skill}/SKILL.md missing`);
  else {
    const body = read(skillPath);
    if (!new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(body)) fail(`skills/${skill} missing name frontmatter`);
    else if (!/^description:/m.test(body)) fail(`skills/${skill} missing description frontmatter`);
    else ok(`skills/${skill}/SKILL.md`);
  }
}

// ---- AC1: hook scripts present + contract ----
const guardPath = join(PLUGIN, 'hooks', 'adlc-rails-guard.mjs');
const auditPath = join(PLUGIN, 'hooks', 'adlc-audit.mjs');
if (!existsSync(guardPath)) fail('hooks/adlc-rails-guard.mjs missing');
else {
  const g = read(guardPath);
  if (!/permission/.test(g)) fail('rails-guard does not emit a Cursor {permission} verdict'); else ok('rails-guard emits {permission} verdict');
  if (!/export function decide\b/.test(g)) fail('rails-guard does not export decide()'); else ok('rails-guard exports decide()');
}
if (!existsSync(auditPath)) fail('hooks/adlc-audit.mjs missing');
else {
  const a = read(auditPath);
  if (/permission['"]?\s*:\s*['"]deny/.test(a)) fail('afterFileEdit audit must NOT emit a deny (it cannot block)');
  else ok('afterFileEdit audit never denies (observational only)');
  // T18 AC3 companion: the flail heuristic must be IMPORTED from
  // @adlc/flail-detector's lib subpath, never hand-copied.
  if (!a.includes('@adlc/flail-detector/lib/')) fail('audit hook does not import the flail heuristics from @adlc/flail-detector lib subpaths');
  else ok('audit hook imports flail heuristics from @adlc/flail-detector');
  if (/function\s+detectEditChurn\s*\(/.test(a)) fail('audit hook hand-copies detectEditChurn (must delegate to @adlc/flail-detector)');
  else ok('no inlined flail heuristic in the audit hook');
}

// ---- T18: the dispatcher + shell advisory hook scripts ----
const pretoolPath = join(PLUGIN, 'hooks', 'adlc-pretool.mjs');
if (!existsSync(pretoolPath)) fail('hooks/adlc-pretool.mjs missing');
else {
  const d = read(pretoolPath);
  if (!/import \{ decide[^}]*\} from '\.\/adlc-rails-guard\.mjs'/.test(d)) fail('dispatcher does not delegate the rails verdict to the frozen guard decide()');
  else ok('dispatcher delegates the rails verdict to the frozen guard decide()');
  if (!/ADLC_BUILD_GATE_ENFORCEMENT/.test(d)) fail('dispatcher is missing the ADLC_BUILD_GATE_ENFORCEMENT default-off flag');
  else ok('buildgate is default-off behind ADLC_BUILD_GATE_ENFORCEMENT=1');
  if (!/@adlc\/build-gate\/lib\//.test(d)) fail('dispatcher does not import @adlc/build-gate lib subpaths');
  else ok('dispatcher imports @adlc/build-gate deep subpaths');
  if (/function\s+(deriveRiskSignals|computeRiskTier|isDegraded|decideBuildGate)\s*\(/.test(d)) fail('dispatcher hand-copies build-gate risk/decide logic (must delegate to @adlc/build-gate)');
  else ok('no inlined risk/decide copy in the dispatcher');
  if (!/NO unbypassable backstop/.test(d)) fail('dispatcher does not state the buildgate no-backstop fact (honesty requirement)');
  else ok('dispatcher states the buildgate has no unbypassable backstop');
}
const shellAdvisoryPath = join(PLUGIN, 'hooks', 'adlc-shell-advisory.mjs');
if (!existsSync(shellAdvisoryPath)) fail('hooks/adlc-shell-advisory.mjs missing');
else {
  const s = read(shellAdvisoryPath);
  if (/permission['"]?\s*:\s*['"]deny/.test(s)) fail('shell advisory must NEVER emit a deny (advisory by design)');
  else ok('shell advisory never denies');
  if (!/TRIVIALLY BYPASSABLE/i.test(s)) fail('shell advisory does not document that the string match is trivially bypassable');
  else ok('shell advisory documents its trivial bypassability');
}
for (const f of ['adlc-stop.mjs', 'adlc-preflight.mjs']) {
  if (!existsSync(join(PLUGIN, 'hooks', f))) fail(`hooks/${f} missing`);
  else ok(`hooks/${f} ships`);
}


// ---- T64: sessionStart + alwaysApply ticket context + comment truth ----
if (!existsSync(join(PLUGIN, 'hooks', 'adlc-session-start.mjs'))) fail('hooks/adlc-session-start.mjs missing');
else ok('hooks/adlc-session-start.mjs ships');
const ticketRule = join(PLUGIN, 'rules', 'adlc-ticket-context.mdc');
if (!existsSync(ticketRule)) fail('rules/adlc-ticket-context.mdc missing');
else {
  const tr = read(ticketRule);
  if (!/alwaysApply:\s*true/.test(tr)) fail('adlc-ticket-context.mdc must set alwaysApply: true');
  else ok('adlc-ticket-context.mdc alwaysApply: true');
  if (!/best-effort/i.test(tr)) fail('adlc-ticket-context.mdc must mention sessionStart best-effort');
  else ok('adlc-ticket-context.mdc documents best-effort sessionStart');
}
for (const f of ['adlc-stop.mjs', 'adlc-preflight.mjs']) {
  const body = read(join(PLUGIN, 'hooks', f));
  if (/DISABLED BY DEFAULT/.test(body)) fail(`hooks/${f} still says DISABLED BY DEFAULT`);
  else ok(`hooks/${f} does not say DISABLED BY DEFAULT`);
}
if (!existsSync(join(ROOT, '.adlc', 'specs', 'cursor-deeper-native.md'))) fail('.adlc/specs/cursor-deeper-native.md missing');
else ok('umbrella spec cursor-deeper-native.md present');

// ---- AC1: rule registration ----
if (!existsSync(join(PLUGIN, 'rules', 'adlc.mdc'))) fail('rules/adlc.mdc missing');
else {
  const r = read(join(PLUGIN, 'rules', 'adlc.mdc'));
  if (!/^---\n[\s\S]*?description:[\s\S]*?\n---/.test(r)) fail('rules/adlc.mdc lacks frontmatter'); else ok('rules/adlc.mdc has frontmatter');
}

// ---- AC2: delegate to @adlc/core, do NOT re-implement the rail engine ----
const checkerPath = join(PLUGIN, 'rails-checker.mjs');
if (!existsSync(checkerPath)) fail('rails-checker.mjs missing');
else {
  const chk = read(checkerPath);
  if (!/from '@adlc\/core'/.test(chk)) fail('rails-checker does not import @adlc/core'); else ok('rails-checker imports @adlc/core');
  if (!/globMatch/.test(chk)) fail('rails-checker does not use globMatch from core'); else ok('delegates globMatch to core');
  if (/function\s+globMatch\s*\(/.test(chk)) fail('rails-checker RE-IMPLEMENTS globMatch (must delegate to @adlc/core)'); else ok('no inlined globMatch (engine delegated)');
  // deny-path source must not pull a third-party runtime dependency
  const imports = [...chk.matchAll(/from '([^']+)'/g), ...read(guardPath).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  if (!/detectTicketStore/.test(chk) || !/allowLegacyPointer:\s*true/.test(chk)) fail('rails-checker must use detectTicketStore + allowLegacyPointer: true (T64)');
  else ok('rails-checker aligns store detection + allowLegacyPointer');
  const thirdParty = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core' && s !== '@adlc/tickets');
  if (thirdParty.length) fail(`deny path imports third-party deps: ${thirdParty.join(', ')}`); else ok('deny path: only node: builtins + @adlc/core + @adlc/tickets');
}

// ---- AC1: scaffolder registers the integration ----
const scaffoldPath = join(PLUGIN, 'lib', 'scaffold.mjs');
if (!existsSync(scaffoldPath)) fail('lib/scaffold.mjs missing');
else {
  const sc = read(scaffoldPath);
  if (!/export function ensurePluginRegistered\b/.test(sc)) fail('scaffold does not register the integration (hooks would not wire)');
  else ok('scaffold registers the integration (.cursor/hooks.json + rule)');
}
if (!existsSync(join(PLUGIN, 'lib', 'scaffold-cli.mjs'))) fail('lib/scaffold-cli.mjs missing'); else ok('scaffold-cli present');
if (!existsSync(join(PLUGIN, 'command', 'adlc-init.md'))) fail('command/adlc-init.md missing'); else ok('command/adlc-init.md present');

// ---- T16 AC1: the scaffolder must DEPLOY command/ into .cursor/commands/ ----
if (existsSync(scaffoldPath)) {
  const sc = read(scaffoldPath);
  if (!/export function deployCommands\b/.test(sc)) fail('scaffold does not export deployCommands() (command palette would be unreachable)');
  else ok('scaffold deploys the command palette (deployCommands)');
}

// ---- T16 AC3: full phase-command suite, mirroring the OpenCode per-command checks ----
const cmdDir = join(PLUGIN, 'command');
const CURSOR_CMDS = [
  'adlc-init.md',
  'adlc-ticket.md',
  'adlc-spec.md',
  'adlc-approve-spec.md',
  'adlc-decompose.md',
  'adlc-verify-build.md',
  'adlc-prosecute.md',
  'adlc-distill.md',
  'adlc-maintain.md',
];
for (const c of CURSOR_CMDS) {
  const p = join(cmdDir, c);
  if (!existsSync(p)) { fail(`command/${c} missing`); continue; }
  const body = read(p);
  if (!/^---\n[\s\S]*?description:\s*\S+[\s\S]*?\n---/.test(body)) fail(`command/${c} lacks description frontmatter`);
  else ok(`command/${c} valid`);
  // Binding design decision 1 (cursor-native-parity spec): Cursor has no plugin
  // namespace — command bodies must use the bare /adlc-<name> form, never the
  // Claude Code /adlc:adlc-<name> form.
  if (/\/adlc:adlc-/.test(body)) fail(`command/${c} uses the namespaced /adlc:adlc-* form (Cursor commands are bare /adlc-*)`);
}
// The generated router rule must reference the bare command palette (T16 AC4 companion).
const rulePath = join(PLUGIN, 'rules', 'adlc.mdc');
if (existsSync(rulePath)) {
  const rule = read(rulePath);
  const missing = CURSOR_CMDS.map((c) => `/${c.replace(/\.md$/, '')}`).filter((name) => !rule.includes(name));
  if (missing.length) fail(`rules/adlc.mdc does not reference: ${missing.join(', ')}`);
  else ok('rules/adlc.mdc references every /adlc-* command');
}

// ---- T17 AC5 + AC7: /adlc-prosecute is the full sequential multi-lens loop ----
const prosecutePath = join(cmdDir, 'adlc-prosecute.md');
if (!existsSync(prosecutePath)) fail('command/adlc-prosecute.md missing (T17)');
else {
  const pr = read(prosecutePath);
  // All five lens briefs + the verifier must live INLINE in the command body
  // (T17 amendment: no separate lens files — the scaffolder would deploy them
  // as fake palette commands).
  for (const lens of ['Correctness', 'Security', 'Contract conformance', 'Spec-vs-implementation diff', 'Test audit']) {
    if (!pr.includes(lens)) fail(`adlc-prosecute.md missing the ${lens} lens brief`);
    else ok(`adlc-prosecute.md has the ${lens} lens`);
  }
  // Lens COUNT derives from @adlc/core's registry, not a hardcoded number: a
  // lens added to or removed from the shared registry must be reflected in
  // the command, and a shrink of the hardcoded title list above cannot
  // silently weaken this assertion (the titles are a readability check; this
  // is the load-bearing one).
  const { LENSES } = await import('@adlc/core');
  const lensBriefCount = (pr.match(/^### Lens \d+ —/gm) ?? []).length;
  if (lensBriefCount !== LENSES.length) {
    fail(`adlc-prosecute.md has ${lensBriefCount} lens briefs; @adlc/core's registry declares ${LENSES.length}`);
  } else ok(`adlc-prosecute.md lens-brief count matches the @adlc/core registry (${LENSES.length})`);
  if (!/verifier/i.test(pr)) fail('adlc-prosecute.md missing the verifier pass');
  else ok('adlc-prosecute.md has the verifier pass');
  // T66: Task fan-out preferred; sequential is degraded fallback (weaker independence).
  if (/no subagent fan-out/i.test(pr)) fail('adlc-prosecute.md must not claim Cursor has no subagent fan-out (T66)');
  else ok('adlc-prosecute.md does not claim Cursor has no subagent fan-out');
  if (!/\bTask\b/.test(pr) || !/prosecutor-correctness/.test(pr) || !/prosecutor-verifier/.test(pr)) {
    fail('adlc-prosecute.md must require Task/custom-agent fan-out of packaged prosecutor agents');
  } else ok('adlc-prosecute.md requires Task fan-out of prosecutor agents');
  if (!/degraded fallback/i.test(pr) || !/weaker independence/.test(pr)) {
    fail('adlc-prosecute.md must label sequential same-context as degraded fallback with weaker independence');
  } else ok('adlc-prosecute.md states degraded-fallback weaker-independence caveat');
  if (!/writeP5Marker|P5 marker/i.test(pr) || !/clearP5Marker|clear.*marker/i.test(pr)) {
    fail('adlc-prosecute.md must instruct write/clear of the session P5 marker');
  } else ok('adlc-prosecute.md instructs P5 marker write/clear');
  if (!/adlc prosecute|adlc_prosecute/.test(pr)) fail('adlc-prosecute.md must require adlc prosecute / adlc_prosecute evidence recording');
  else ok('adlc-prosecute.md requires prosecute evidence recording');
  if (!/adversarial-review --providers/.test(pr)) fail('adlc-prosecute.md does not recommend `npx adversarial-review --providers` for the cross-model risk gate');
  else ok('adlc-prosecute.md recommends the cross-model adversarial review');
  if (!/gate-manifest record adversarial-review --ticket/.test(pr)) fail('adlc-prosecute.md missing the `adlc gate-manifest record adversarial-review --ticket` instruction (ticket-scoped form required)');
  else ok('adlc-prosecute.md instructs recording the adversarial-review gate, ticket-scoped');
  if (!/gate-manifest record prosecution --ticket/.test(pr)) fail('adlc-prosecute.md missing the `adlc gate-manifest record prosecution --ticket` instruction (ticket-scoped form required)');
  else ok('adlc-prosecute.md instructs recording the prosecution gate, ticket-scoped');
}

// ---- T66: prosecutor agents roster packaged ----
{
  const agentsDir = join(PLUGIN, 'agents');
  const required = [
    'prosecutor-correctness.md',
    'prosecutor-security.md',
    'prosecutor-contract.md',
    'prosecutor-diff.md',
    'prosecutor-tests.md',
    'prosecutor-verifier.md',
  ];
  for (const f of required) {
    const p = join(agentsDir, f);
    if (!existsSync(p)) { fail(`agents/${f} missing`); continue; }
    const body = read(p);
    if (!/readonly:\s*true/.test(body)) fail(`agents/${f} missing readonly: true`);
    else if (/^tools:/m.test(body.split('---')[1] ?? '')) fail(`agents/${f} must not use tools: frontmatter`);
    else ok(`agents/${f} readonly:true`);
  }
  const manifest = JSON.parse(read(join(PLUGIN, '.cursor-plugin', 'plugin.json')));
  if (manifest.agents !== './agents/') fail('plugin.json must register agents: ./agents/');
  else ok('plugin.json registers agents/');
}

// ---- AC3: run the real enforcement unit tests (always-on proof) ----
try {
  execFileSync(process.execPath, ['--test', ...globTests(join(PLUGIN, 'test'))], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass (rails-guard adapter + audit + scaffold)');
} catch (e) {
  fail(`enforcement unit test failed:\n${e.stdout?.toString() ?? e.message}`);
}

// ---- AC4: two-layer framing in the doc; no competing CI workflow ----
const docPath = join(ROOT, 'docs', 'integrations', 'cursor.md');
if (!existsSync(docPath)) fail('docs/integrations/cursor.md missing');
else {
  const doc = read(docPath);
  if (!/ci\/rails-guard\.yml/.test(doc)) fail('cursor.md does not point at the mandatory CI gate (docs/ci/rails-guard.yml)'); else ok('links the unbypassable CI gate');
  if (!/advisor/i.test(doc)) fail('cursor.md does not frame the in-session hook as advisory'); else ok('frames in-session hook as advisory');
  if (!/Formal ADLC Coverage/.test(doc)) fail('cursor.md missing the Formal ADLC Coverage table'); else ok('has Formal ADLC Coverage table');
  if (/no plugin marketplace/i.test(doc)) fail('cursor.md still claims Cursor has no plugin marketplace (T47)');
  else ok('cursor.md does not claim Cursor has no plugin marketplace');
  if (!/\.cursor-plugin\/marketplace\.json|cursor marketplace|marketplace plugin/i.test(doc)) fail('cursor.md does not describe marketplace plugin install');
  else ok('cursor.md describes marketplace plugin install');
}

// ---- AC5: ADR exists and pins the Cursor hook facts ----
const adrPath = join(ROOT, 'docs', 'adr', '0006-adlc-cursor-integration.md');
if (!existsSync(adrPath)) fail('docs/adr/0006-adlc-cursor-integration.md missing');
else {
  const adr = read(adrPath);
  for (const needle of ['preToolUse', 'afterFileEdit', '## Threat Model', 'stop', 'beforeSubmitPrompt']) {
    if (!adr.includes(needle)) fail(`ADR 0006 does not pin "${needle}"`); else ok(`ADR pins ${needle}`);
  }
  if (/no plugin marketplace/i.test(adr)) fail('ADR 0006 still claims Cursor has no plugin marketplace (T47)');
  else ok('ADR 0006 does not claim Cursor has no plugin marketplace');
  if (!/ADLC_CURSOR_SESSION_ID/.test(adr) || !/session_id/.test(adr)) fail('ADR 0006 must pin session_id / ADLC_CURSOR_SESSION_ID (T64)');
  else ok('ADR pins session_id / ADLC_CURSOR_SESSION_ID');
  if (!/best-effort/i.test(adr) || !/adlc-ticket-context/.test(adr)) fail('ADR 0006 must mark sessionStart context best-effort and name always-apply rule');
  else ok('ADR documents sessionStart best-effort + always-apply fallback');

}

// ---- T19: the docs must tell the exact truth about T16-T18 — the honesty
// ---- strings are ENFORCED here (mirrors how opencode-install-smoke asserts doc
// ---- language). Strip any one of these from docs/integrations/cursor.md and
// ---- this smoke fails (RED-probed).
if (existsSync(docPath)) {
  const doc = read(docPath);
  // buildgate honesty string (spec decision 7): advisory, default-off behind the
  // enforcement flag, and NO unbypassable backstop (unlike the rails guard).
  if (!/buildgate is advisory/i.test(doc)) fail('cursor.md does not state the buildgate is advisory');
  else ok('cursor.md states the buildgate is advisory');
  if (!/ADLC_BUILD_GATE_ENFORCEMENT=1/.test(doc)) fail('cursor.md does not state the buildgate default-off flag (ADLC_BUILD_GATE_ENFORCEMENT=1)');
  else ok('cursor.md states the buildgate default-off flag');
  if (!/no unbypassable backstop/i.test(doc)) fail('cursor.md does not state the buildgate has NO unbypassable backstop (honesty requirement)');
  else ok('cursor.md states the buildgate has no unbypassable backstop');
  // HARDENING (review loop): the honesty checks above pin that the required
  // phrases EXIST, but a future edit could keep them AND add a contradictory
  // overclaim. "unbypassable" is truthful ONLY for the commit-time CI
  // rail-freeze gate — it must NEVER be applied to the in-session
  // hook/buildgate/advisory, which are advisory/best-effort. A NEGATIVE guard.
  //
  // Design (v2, cross-model review): DON'T allowlist CI-context phrases — that
  // was both leaky (a generic "required check" nearby excused an overclaim) and
  // brittle (exact hyphenation + a fixed char window false-failed honest text).
  // Instead isolate the CLAUSE containing each occurrence and fail only a
  // POSITIVE assertion about an IN-SESSION subject. Honest CI-gate uses ("the
  // commit-time CI gate is unbypassable") and negated uses ("no unbypassable
  // backstop", "not unbypassable") pass regardless of phrasing.
  {
    const DELIMS = '.;\n—';
    let overclaim = 0;
    for (const m of doc.matchAll(/unbypassable/gi)) {
      let s = 0, e = doc.length;
      for (let i = m.index - 1; i >= 0; i--) { if (DELIMS.includes(doc[i])) { s = i + 1; break; } }
      for (let i = m.index + 'unbypassable'.length; i < doc.length; i++) { if (DELIMS.includes(doc[i])) { e = i; break; } }
      const clause = doc.slice(s, e).replace(/\s+/g, ' ').trim();
      const before = clause.slice(0, clause.toLowerCase().indexOf('unbypassable'));
      const negated = /\b(no|not|never)\b/i.test(before) || /unbypassable\s+backstop/i.test(clause);
      const inSession = /\b(in-session|buildgate|hook|advisory|pretooluse|shell)\b/i.test(clause);
      if (!negated && inSession) { overclaim++; fail(`cursor.md calls the in-session layer "unbypassable" — it is advisory/best-effort; only the commit-time CI rail-freeze gate is unbypassable: "…${clause}…"`); }
    }
    if (!overclaim) ok('cursor.md never positively calls the in-session layer "unbypassable" (clause-scoped negative guard)');
  }
  // Sequential-lens independence caveat (spec decision 3).
  if (!/weaker independence/i.test(doc)) fail('cursor.md does not state the sequential-lens weaker-independence caveat');
  else ok('cursor.md states the sequential-lens weaker-independence caveat');
  if (!/adversarial-review --providers/.test(doc)) fail('cursor.md does not recommend `npx adversarial-review --providers` for the cross-model gate');
  else ok('cursor.md recommends the cross-model adversarial review');
  // Shell writes are advisory-only (spec decision 8): beforeShellExecution never
  // denies and the match is trivially bypassable.
  if (!/Shell writes are advisory-only/i.test(doc)) fail('cursor.md does not state that shell writes are advisory-only');
  else ok('cursor.md states shell writes are advisory-only');
  if (!/never denies/i.test(doc)) fail('cursor.md does not state the shell advisory never denies');
  else ok('cursor.md states the shell advisory never denies');
  // The command palette is deployed by the scaffolder (T16) — no more "run
  // /adlc-init and the suite is follow-on" lie.
  if (!/\.cursor\/commands\//.test(doc)) fail('cursor.md does not describe the .cursor/commands/ palette deployment');
  else ok('cursor.md describes the command palette deployment');
  if (/prosecutor subagents/i.test(doc)) fail('cursor.md still calls the P5 prosecution a follow-on "prosecutor subagents" gap (shipped in T17)');
  else ok('cursor.md no longer lists the prosecutor as a follow-on gap');
}


// ---- T68: deny-proof runbook ----
{
  const denyReadme = join(ROOT, 'scripts', 'cursor-deny-proof', 'README.md');
  if (!existsSync(denyReadme)) fail('scripts/cursor-deny-proof/README.md missing');
  else {
    const body = read(denyReadme);
    if (!/sentinel/i.test(body) || !/enforcement-off/i.test(body) || !/hash/i.test(body)) {
      fail('deny-proof README missing sentinel/hash/enforcement-off ordering');
    } else ok('deny-proof runbook ordering strings');
  }
  if (!existsSync(join(ROOT, 'scripts', 'cursor-deny-proof.mjs'))) fail('scripts/cursor-deny-proof.mjs missing');
  else ok('deny-proof entry script');
  if (existsSync(docPath)) {
    const doc = read(docPath);
    if (!/cursor-deny-proof/.test(doc)) fail('cursor.md Gaps must link cursor-deny-proof');
    else ok('cursor.md links deny-proof');
  }
}

// ---- T69: marketplace publish checklist honesty ----
{
  if (!existsSync(docPath)) fail('docs/integrations/cursor.md missing for publish checklist');
  else {
    const body = read(docPath);
    if (!/Marketplace publish checklist/i.test(body) && !/cursor-marketplace-publish/.test(body)) {
      fail('cursor.md must include marketplace publish checklist');
    } else ok('cursor.md has marketplace publish checklist');
    if (!/cursor\.com\/marketplace\/publish/.test(body)) fail('checklist must point at publish flow, not a fake listing');
    else ok('publish checklist points at cursor.com/marketplace/publish');
    if (/cursor\.com\/marketplace\/adlc-cursor\/?/.test(body)) {
      fail('docs must not fabricate a live marketplace listing URL before submit succeeds');
    } else ok('no fabricated live marketplace listing URL');
  }
}

if (failures) { console.error(`\ncursor-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\ncursor-install-smoke: PASS');

function globTests(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f)) : [];
}
