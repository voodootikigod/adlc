#!/usr/bin/env node
// cursor-install-smoke.mjs — local verification for the ADLC Cursor integration
// MVP. Mirrors scripts/opencode-install-smoke.mjs: validates the package shape,
// the hooks.json wiring (preToolUse + afterFileEdit), the rule registration, the
// @adlc/core delegation (no inlined rail engine), and runs the real enforcement
// unit tests. Does NOT require the Cursor binary and does not mutate the user
// environment. Exit 0 = all checks pass; exit 2 = a check failed.

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
  if (pkg.name !== '@adlc/cursor-package') fail(`package name is ${pkg.name}`); else ok('package name');
  if (pkg.type !== 'module') fail('package is not type:module'); else ok('type:module');
  if (!pkg.dependencies?.['@adlc/core']) fail('missing @adlc/core dependency'); else ok('dependency @adlc/core');
  if (!pkg.cursor?.hooks) fail('package.json cursor.hooks entry missing'); else ok('cursor.hooks manifest entry');
  if (!pkg.cursor?.rules) fail('package.json cursor.rules entry missing'); else ok('cursor.rules manifest entry');
}

// ---- AC1: hooks.json wiring (preToolUse rails-guard + afterFileEdit audit) ----
const hooksJsonPath = join(PLUGIN, 'hooks.json');
if (!existsSync(hooksJsonPath)) fail('hooks.json missing');
else {
  const hj = JSON.parse(read(hooksJsonPath));
  if (hj.version !== 1) fail('hooks.json version is not 1'); else ok('hooks.json version 1');
  const pre = hj.hooks?.preToolUse ?? [];
  if (!pre.some((e) => /adlc-rails-guard\.mjs/.test(e.command ?? ''))) fail('preToolUse does not wire adlc-rails-guard.mjs');
  else ok('preToolUse wires the rails-guard adapter');
  const after = hj.hooks?.afterFileEdit ?? [];
  if (!after.some((e) => /adlc-audit\.mjs/.test(e.command ?? ''))) fail('afterFileEdit does not wire adlc-audit.mjs');
  else ok('afterFileEdit wires the observational audit hook');
  // advisory: failClosed must be false so a hook bug cannot brick the editor
  if (pre[0]?.failClosed !== false) fail('preToolUse failClosed is not false (advisory layer must not brick the editor)');
  else ok('preToolUse is advisory (failClosed:false)');
  // F1: the matcher must ROUTE every tool to the guard (catch-all) so a novel
  // mutator name can't bypass the fail-closed classifier. Anything narrower is an
  // allowlist with a hole.
  const matcher = pre.find((e) => /adlc-rails-guard/.test(e.command ?? ''))?.matcher ?? '';
  const re = new RegExp(matcher, 'i');
  const routed = ['Write', 'str_replace', 'modify_file', 'frobnicate', 'Read'].every((t) => re.test(t));
  if (!routed) fail(`preToolUse matcher is an allowlist, not catch-all (matcher="${matcher}") — novel mutators bypass the guard`);
  else ok('preToolUse matcher is catch-all (every tool reaches the guard; classifier decides)');
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
}

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
  if (!/globMatch/.test(chk) || !/loadTickets/.test(chk)) fail('rails-checker does not use globMatch+loadTickets from core'); else ok('delegates globMatch+loadTickets to core');
  if (/function\s+globMatch\s*\(/.test(chk)) fail('rails-checker RE-IMPLEMENTS globMatch (must delegate to @adlc/core)'); else ok('no inlined globMatch (engine delegated)');
  // deny-path source must not pull a third-party runtime dependency
  const imports = [...chk.matchAll(/from '([^']+)'/g), ...read(guardPath).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const thirdParty = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core');
  if (thirdParty.length) fail(`deny path imports third-party deps: ${thirdParty.join(', ')}`); else ok('deny path: only node: builtins + @adlc/core');
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
}

// ---- AC5: ADR exists and pins the Cursor hook facts ----
const adrPath = join(ROOT, 'docs', 'adr', '0006-adlc-cursor-integration.md');
if (!existsSync(adrPath)) fail('docs/adr/0006-adlc-cursor-integration.md missing');
else {
  const adr = read(adrPath);
  for (const needle of ['preToolUse', 'afterFileEdit', '## Threat Model']) {
    if (!adr.includes(needle)) fail(`ADR 0006 does not pin "${needle}"`); else ok(`ADR pins ${needle}`);
  }
}

if (failures) { console.error(`\ncursor-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\ncursor-install-smoke: PASS');

function globTests(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f)) : [];
}
