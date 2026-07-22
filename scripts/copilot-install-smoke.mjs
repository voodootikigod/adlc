#!/usr/bin/env node
// copilot-install-smoke.mjs — offline contract proof for the adlc-copilot plugin
// (issue #242), modeled on scripts/codex-install-smoke.mjs.
//
// The OFFLINE leg (always runs) validates the manifest/hook/skill/agent/MCP file
// contract AND behaviorally proves the verified Copilot deny shape (a rail edit →
// non-empty {reason} object on stdout, exit 0 — NOT exit 2, NOT permissionDecision;
// see docs/integrations/copilot-probe-appendix.md).
//
// The LIVE leg (only when ADLC_COPILOT_LIVE_INSTALL=1 and a `copilot` binary is
// present) additionally resolves the plugin through the real CLI. Note: an
// end-to-end in-session DENY cannot be proven without a model turn, which an org
// Copilot policy may block — the live leg therefore asserts plugin resolution,
// not tool denial.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

class SmokeFailure extends Error {}
function fail(message) { throw new SmokeFailure(message); }
function ok(message) { console.log(`  ✓ ${message}`); }
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`could not read ${path}: ${error.message}`); }
}

const repo = resolve(process.argv[2] ?? '.');
const plugin = join(repo, 'plugins/adlc-copilot');

// --- 1. marketplace manifest ---------------------------------------------
function checkMarketplace() {
  const path = join(repo, '.github/plugin/marketplace.json');
  if (!existsSync(path)) fail('missing .github/plugin/marketplace.json (required for `copilot plugin marketplace add voodootikigod/adlc`)');
  const m = readJson(path);
  if (!m.name) fail('marketplace.json missing "name"');
  const entry = (m.plugins ?? []).find((p) => p.name === 'adlc-copilot');
  if (!entry) fail('marketplace.json missing plugin entry name "adlc-copilot"');
  if (entry.source !== './plugins/adlc-copilot') fail(`marketplace entry source must be "./plugins/adlc-copilot" (got ${JSON.stringify(entry.source)})`);
  ok('marketplace.json resolves adlc-copilot → ./plugins/adlc-copilot');
}

// --- 2. plugin manifest ---------------------------------------------------
function checkPluginManifest() {
  const path = join(plugin, 'plugin.json');
  if (!existsSync(path)) fail('missing plugins/adlc-copilot/plugin.json');
  const p = readJson(path);
  for (const field of ['name', 'version']) if (!p[field]) fail(`plugin.json missing "${field}"`);
  if (p.name !== 'adlc-copilot') fail(`plugin.json name must be "adlc-copilot" (got ${p.name})`);
  if (p.hooks !== './hooks/hooks.json') fail('plugin.json must point hooks → ./hooks/hooks.json');
  ok(`plugin.json declares ${p.name}@${p.version} with hooks/skills/agents/mcp`);
}

// --- 3. hooks.json — verified Copilot shape -------------------------------
function checkHooks() {
  const raw = readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8');
  if (/"command"\s*:/.test(raw)) fail('hooks.json uses a "command" field — Copilot hook entries use "bash", not the Claude Code "command" shape');
  if (/"timeout"\s*:/.test(raw)) fail('hooks.json uses "timeout" — Copilot uses "timeoutSec"');
  const h = JSON.parse(raw);
  if (h.version !== 1) fail('hooks.json must declare version 1');
  const events = Object.keys(h.hooks ?? {});
  for (const required of ['preToolUse', 'sessionStart', 'postToolUse', 'agentStop']) {
    if (!events.includes(required)) fail(`hooks.json missing camelCase event "${required}"`);
  }
  for (const [event, entries] of Object.entries(h.hooks)) {
    for (const entry of entries) {
      if (entry.type !== 'command') fail(`${event}: hook entry type must be "command"`);
      if (typeof entry.bash !== 'string') fail(`${event}: hook entry must carry a "bash" command string`);
      if (typeof entry.timeoutSec !== 'number') fail(`${event}: hook entry must set numeric "timeoutSec"`);
      if (!entry.bash.includes('${COPILOT_PLUGIN_ROOT}')) fail(`${event}: hook bash must resolve via \${COPILOT_PLUGIN_ROOT}`);
    }
  }
  const preTool = h.hooks.preToolUse.map((e) => e.bash).join('\n');
  if (!preTool.includes('adlc-rails-guard.mjs')) fail('preToolUse must wire adlc-rails-guard.mjs');
  if (!preTool.includes('adlc-build-gate.mjs')) fail('preToolUse must wire adlc-build-gate.mjs');
  ok('hooks.json uses camelCase events + bash/timeoutSec + COPILOT_PLUGIN_ROOT (no CC command/timeout shape)');
}

// --- 4. referenced hook adapters + generated readers exist ----------------
function checkHookFiles() {
  for (const f of ['adlc-rails-guard.mjs', 'adlc-build-gate.mjs', 'adlc-lifecycle.mjs', 'generated-ticket-reader.mjs', 'generated-active-ticket.mjs']) {
    if (!existsSync(join(plugin, 'hooks', f))) fail(`missing hooks/${f}`);
  }
  ok('all hook adapters + generated canonical readers present');
}

// --- 5. skills ------------------------------------------------------------
function checkSkills() {
  const dir = join(plugin, 'skills');
  for (const name of ['adlc', 'adlc-init', 'adlc-ticket', 'adlc-prosecute', 'adlc-distill', 'adlc-maintain']) {
    if (!existsSync(join(dir, name, 'SKILL.md'))) fail(`missing skills/${name}/SKILL.md`);
  }
  ok('six ADLC skills present (adlc, init, ticket, prosecute, distill, maintain)');
}

// --- 6. agents — six read-only lenses -------------------------------------
function checkAgents() {
  const dir = join(plugin, 'agents');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.agent.md')) : [];
  const expected = ['correctness', 'contract', 'security', 'tests', 'diff', 'verifier'];
  for (const lens of expected) {
    if (!files.includes(`adlc-prosecutor-${lens}.agent.md`)) fail(`missing agents/adlc-prosecutor-${lens}.agent.md`);
    const body = readFileSync(join(dir, `adlc-prosecutor-${lens}.agent.md`), 'utf8');
    const fm = body.match(/tools:\s*\[([^\]]*)\]/i);
    if (!fm) fail(`agents/adlc-prosecutor-${lens}.agent.md must declare a tools: allowlist`);
    if (/\b(write|edit|execute|shell|bash|agent)\b/i.test(fm[1])) fail(`agents/adlc-prosecutor-${lens}.agent.md must be READ-ONLY (no write/edit/execute/shell in tools)`);
  }
  ok('six prosecutor lenses present, all read-only (tools ⊆ read/search)');
}

// --- 7. mcp ---------------------------------------------------------------
function checkMcp() {
  const m = readJson(join(plugin, '.mcp.json'));
  const server = m.mcpServers?.adlc;
  if (!server) fail('.mcp.json must declare mcpServers.adlc (Copilot uses the mcpServers wrapper)');
  if (server.command !== 'adlc') fail('.mcp.json adlc.command must be "adlc"');
  if (!(server.args ?? []).includes('mcp-server')) fail('.mcp.json adlc.args must include "mcp-server"');
  ok('.mcp.json wires the adlc gate server (mcpServers.adlc → adlc mcp-server)');
}

// --- 8. BEHAVIORAL deny-shape proof (the contract, not just the files) ----
function checkDenyShape() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-smoke-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'S', scope: ['src/**'], rails: ['test/**'], edges: [] }] }));
    writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}');
    const hook = join(plugin, 'hooks/adlc-rails-guard.mjs');
    const { ADLC_P4_ENFORCEMENT: _e, ...env } = process.env;
    const r = spawnSync(process.execPath, [hook], {
      cwd: root, env,
      input: JSON.stringify({ toolName: 'write', toolArgs: JSON.stringify({ path: 'test/frozen.test.mjs' }), cwd: root }),
      encoding: 'utf8',
    });
    if (r.status !== 0) fail(`rails-guard denied a rail edit with exit ${r.status} — Copilot honors exit 0 + stdout object, not exit codes (this would FAIL OPEN)`);
    if (/permissionDecision/.test(r.stdout)) fail('rails-guard emitted permissionDecision — the CLI does not honor that field');
    const out = JSON.parse(r.stdout.trim() || '{}');
    if (!out.reason || typeof out.reason !== 'string') fail('rails-guard deny must be a non-empty {reason} object on stdout');
    if (!/blocked rail edit for T1/.test(out.reason)) fail(`unexpected deny reason: ${out.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  ok('rails-guard denies a rail edit via {reason} on stdout + exit 0 (verified Copilot deny shape)');
}

// --- LIVE leg (opt-in) ----------------------------------------------------
function liveLeg() {
  if (process.env.ADLC_COPILOT_LIVE_INSTALL !== '1') {
    console.log('  (live install leg skipped — set ADLC_COPILOT_LIVE_INSTALL=1 with a `copilot` binary to resolve the plugin through the real CLI)');
    return;
  }
  const which = spawnSync('copilot', ['--version'], { encoding: 'utf8' });
  if (which.status !== 0) fail('ADLC_COPILOT_LIVE_INSTALL=1 but no working `copilot` binary found');
  const list = spawnSync('copilot', ['plugin', 'list', '--plugin-dir', plugin], { cwd: repo, encoding: 'utf8' });
  if (list.status !== 0) fail(`copilot plugin list --plugin-dir failed: ${list.stderr}`);
  ok(`live: copilot ${which.stdout.trim()} resolved the plugin via --plugin-dir`);
  console.log('  note: this smoke asserts plugin resolution + deny-SHAPE only. The end-to-end');
  console.log('  in-session DENY (a real model turn blocked against a frozen rail) is proven');
  console.log('  by scripts/copilot-live-deny.mjs (opt-in: ADLC_COPILOT_LIVE_INSTALL=1, entitled login).');
}

function main() {
  console.log('adlc-copilot install smoke (offline contract + deny-shape proof):');
  checkMarketplace();
  checkPluginManifest();
  checkHooks();
  checkHookFiles();
  checkSkills();
  checkAgents();
  checkMcp();
  checkDenyShape();
  liveLeg();
  console.log('adlc-copilot install smoke: PASS');
}

try {
  main();
} catch (error) {
  if (error instanceof SmokeFailure) {
    console.error(`copilot-install-smoke: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
