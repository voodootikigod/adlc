#!/usr/bin/env node
// opencode-install-smoke.mjs — local verification for the ADLC OpenCode plugin
// MVP. Mirrors scripts/codex-install-smoke.mjs / claude-code-plugin-smoke.mjs:
// validates the plugin package shape, the hook wiring, skill registration, the
// @adlc/core delegation (no inlined rail engine), and runs the real enforcement
// unit test. Does NOT require the opencode binary and does not mutate the user
// environment.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-opencode');
let failures = 0;
const fail = (m) => { console.error(`opencode-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// ---- AC1: package + manifest shape ----
const pkgPath = join(PLUGIN, 'package.json');
if (!existsSync(pkgPath)) fail('plugins/adlc-opencode/package.json missing');
else {
  const pkg = JSON.parse(read(pkgPath));
  if (pkg.name !== '@adlc/opencode-package') fail(`package name is ${pkg.name}`); else ok('package name');
  if (pkg.type !== 'module') fail('package is not type:module'); else ok('type:module');
  if (!pkg.peerDependencies?.['@opencode-ai/plugin']) fail('missing @opencode-ai/plugin peerDependency'); else ok('peerDependency @opencode-ai/plugin');
  if (!pkg.dependencies?.['@adlc/core']) fail('missing @adlc/core dependency'); else ok('dependency @adlc/core');
  if (!pkg.opencode?.plugin) fail('package.json opencode.plugin entry missing'); else ok('opencode.plugin manifest entry');
}

// ---- AC1: hook wiring + plugin export ----
const indexPath = join(PLUGIN, 'index.mjs');
if (!existsSync(indexPath)) fail('index.mjs missing');
else {
  const idx = read(indexPath);
  if (!/tool\.execute\.before/.test(idx)) fail('index.mjs does not wire tool.execute.before'); else ok('wires tool.execute.before');
  if (!/export (const|default) /.test(idx)) fail('index.mjs has no plugin export'); else ok('exports a plugin');
  // Phase C (T4): advisory session hooks
  if (!/session\.created/.test(idx)) fail('index.mjs does not wire session.created'); else ok('wires session.created (advisory preflight)');
  if (!/session\.idle/.test(idx)) fail('index.mjs does not wire session.idle'); else ok('wires session.idle (advisory gate-manifest audit)');
  if (!existsSync(join(PLUGIN, 'lib', 'session-hooks.mjs'))) fail('lib/session-hooks.mjs missing'); else ok('session-hooks helper present');
}

// ---- AC1: skill registration ----
if (!existsSync(join(PLUGIN, 'skill', 'adlc.md'))) fail('skill/adlc.md missing'); else ok('skill/adlc.md present');

// ---- AC2: delegate to @adlc/core, do NOT re-implement the rail engine ----
const checkerPath = join(PLUGIN, 'rails-checker.mjs');
if (!existsSync(checkerPath)) fail('rails-checker.mjs missing');
else {
  const chk = read(checkerPath);
  if (!/from '@adlc\/core'/.test(chk)) fail('rails-checker does not import @adlc/core'); else ok('rails-checker imports @adlc/core');
  if (!/globMatch/.test(chk) || !/loadTickets/.test(chk)) fail('rails-checker does not use globMatch+loadTickets from core'); else ok('delegates globMatch+loadTickets to core');
  if (/function\s+globMatch\s*\(/.test(chk)) fail('rails-checker RE-IMPLEMENTS globMatch (must delegate to @adlc/core)'); else ok('no inlined globMatch (engine delegated)');
  // deny-path source must not pull a third-party runtime dependency
  const imports = [...chk.matchAll(/from '([^']+)'/g), ...read(indexPath).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const thirdParty = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core');
  if (thirdParty.length) fail(`deny path imports third-party deps: ${thirdParty.join(', ')}`); else ok('deny path: only node: builtins + @adlc/core');
}

// ---- AC3: run the real enforcement unit test (always-on proof) ----
try {
  execFileSync(process.execPath, ['--test', ...globTests(join(PLUGIN, 'test'))], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass (rails-checker + scaffold)');
} catch (e) {
  fail(`enforcement unit test failed:\n${e.stdout?.toString() ?? e.message}`);
}

// ---- AC8: two-layer enforcement framing in the doc; no competing CI workflow ----
const docPath = join(ROOT, 'docs', 'integrations', 'opencode.md');
if (!existsSync(docPath)) fail('docs/integrations/opencode.md missing');
else {
  const doc = read(docPath);
  if (/no integration exists yet/.test(doc)) fail("opencode.md still has the 'no integration exists yet' stub banner");
  else ok('stub banner removed');
  if (!/ci\/rails-guard\.yml/.test(doc)) fail('opencode.md does not point at the mandatory CI gate (docs/ci/rails-guard.yml)'); else ok('links the unbypassable CI gate');
  if (!/advisor/i.test(doc)) fail('opencode.md does not frame the in-session hook as advisory'); else ok('frames in-session hook as advisory');
}

// ---- Phase A (T2): command suite + gate-bin dependency mapping ----
const pkg2 = existsSync(pkgPath) ? JSON.parse(read(pkgPath)) : {};
if (!pkg2.opencode?.command) fail('package.json opencode.command entry missing'); else ok('opencode.command manifest entry');
const cmdDir = join(PLUGIN, 'command');
const PHASE_A_CMDS = ['adlc-init.md', 'adlc-ticket.md', 'adlc-spec.md', 'adlc-approve-spec.md', 'adlc-decompose.md'];
for (const c of PHASE_A_CMDS) {
  const p = join(cmdDir, c);
  if (!existsSync(p)) { fail(`command/${c} missing`); continue; }
  if (!/^---\n[\s\S]*?description:\s*\S+[\s\S]*?\n---/.test(read(p))) fail(`command/${c} lacks description frontmatter`);
  else ok(`command/${c} valid`);
}
if (!existsSync(join(PLUGIN, 'lib', 'scaffold.mjs'))) fail('lib/scaffold.mjs missing'); else ok('scaffold helper present');

// ---- Phase B (T3): keyless LLM-gate bridge ----
const bridgePath = join(PLUGIN, 'lib', 'keyless-bridge.mjs');
if (!existsSync(bridgePath)) fail('lib/keyless-bridge.mjs missing');
else {
  const br = read(bridgePath);
  for (const fn of ['extractPrompts', 'runGateKeyless', 'makeAsk']) {
    if (!new RegExp(`export function ${fn}\\b`).test(br)) fail(`keyless-bridge missing export ${fn}`);
  }
  if (!/--prompt-only/.test(br)) fail('keyless-bridge does not run gates in --prompt-only mode');
  ok('keyless bridge present (extractPrompts/runGateKeyless/makeAsk, prompt-only)');
}

if (!existsSync(join(PLUGIN, 'gate-bins.mjs'))) fail('gate-bins.mjs missing');
else {
  const gb = read(join(PLUGIN, 'gate-bins.mjs'));
  for (const b of ['rails-guard', 'spec-lint', 'coldstart', 'merge-forecast', 'preflight']) {
    if (!gb.includes(`'${b}'`)) fail(`gate-bins missing ${b}`);
  }
  ok('gate-bins declares the core gate tools');
}

// ---- Phase E (T5): prosecutor lenses + verifier, G4/prosecute/distill commands ----
if (!pkg2.opencode?.agent) fail('package.json opencode.agent entry missing'); else ok('opencode.agent manifest entry');
const agentDir = join(PLUGIN, 'agent');
const AGENTS = ['prosecutor-correctness', 'prosecutor-security', 'prosecutor-contract', 'prosecutor-diff', 'prosecutor-tests', 'prosecutor-verifier'];
for (const a of AGENTS) {
  const p = join(agentDir, `${a}.md`);
  if (!existsSync(p)) { fail(`agent/${a}.md missing`); continue; }
  if (!/^---\n[\s\S]*?mode:\s*subagent[\s\S]*?\n---/.test(read(p))) fail(`agent/${a}.md lacks subagent frontmatter`);
  else ok(`agent/${a}.md valid`);
}
for (const c of ['adlc-verify-build.md', 'adlc-prosecute.md', 'adlc-distill.md']) {
  if (!existsSync(join(cmdDir, c))) fail(`command/${c} missing`); else ok(`command/${c} present`);
}
if (!existsSync(join(PLUGIN, 'lib', 'prosecutor.mjs'))) fail('lib/prosecutor.mjs missing'); else ok('prosecutor registry/helpers present');

// AC7 (live deny proof against the real opencode binary) is the remaining GA gate;
// it requires a disposable OpenCode install and is tracked in ADR 0004.
console.log('  note — AC7 live-binary deny proof is a maintainer/CI follow-up (no opencode binary here).');

if (failures) { console.error(`\nopencode-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\nopencode-install-smoke: PASS');

function globTests(dir) {
  // node --test wants explicit files on this runtime; expand *.test.mjs ourselves.
  return readFileSync && existsSync(dir)
    ? execFileSync('ls', [dir]).toString().split('\n').filter((f) => f.endsWith('.test.mjs')).map((f) => join(dir, f))
    : [];
}
