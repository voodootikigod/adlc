#!/usr/bin/env node
// antigravity-install-smoke.mjs — verify the adlc-antigravity package shape,
// hooks.json schema (V3), always-exit-0 deny contract (V5), $HOME command path,
// name/dir invariant, doc framing, and run the plugin unit tests. No agy binary
// required. Exit 0 = pass, 2 = fail.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-antigravity');
let failures = 0;
const fail = (m) => { console.error(`antigravity-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// manifest + name/dir invariant (F3)
const manifest = JSON.parse(read(join(PLUGIN, 'plugin.json')));
if (manifest.name !== 'adlc-antigravity') fail(`plugin.json name is ${manifest.name}`); else ok('plugin.json name == dir name');

// hooks.json V3 schema + $HOME command + catch-all matcher + .cjs entry
const hj = JSON.parse(read(join(PLUGIN, 'hooks.json')));
const spec = hj['adlc-rails']?.PreToolUse?.[0];
if (!spec) fail('hooks.json: adlc-rails.PreToolUse[0] missing'); else ok('hooks.json V3 shape (named hook → PreToolUse array)');
if (spec?.matcher !== '.*') fail(`matcher is "${spec?.matcher}", not catch-all`); else ok('catch-all matcher');
const cmd = spec?.hooks?.[0]?.command ?? '';
if (!/\$HOME\/\.gemini\/config\/plugins\/adlc-antigravity\/hooks\/adlc-rails-guard\.cjs/.test(cmd)) fail(`command is not the $HOME .cjs path: ${cmd}`); else ok('command uses $HOME .cjs path (V9)');

// deny path: only node: + @adlc/core
const chk = read(join(PLUGIN, 'rails-checker.mjs'));
const guard = read(join(PLUGIN, 'hooks', 'adlc-rails-guard.mjs'));
const imports = [...chk.matchAll(/from '([^']+)'/g), ...guard.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
if (imports.some((s) => !s.startsWith('node:') && !s.startsWith('.') && s !== '@adlc/core')) fail('deny path imports third-party deps'); else ok('deny path: node: + @adlc/core only');

// always exit 0 + allow_tool contract: drive the shim with a rail-hit fixture
const repo = mkdtempSync(join(tmpdir(), 'agy-smoke-'));
mkdirSync(join(repo, '.adlc'), { recursive: true });
writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: ['src/frozen.js'] }] }));
writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
mkdirSync(join(repo, 'src'), { recursive: true });
const SHIM = join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs');
const drive = (name, args) => {
  const out = execFileSync(process.execPath, [SHIM], { input: JSON.stringify({ toolCall: { name, args } }), env: { ...process.env, ADLC_P4_ENFORCEMENT: '1' }, encoding: 'utf8' });
  return JSON.parse(out);
};
if (drive('write_to_file', { TargetFile: join(repo, 'src', 'frozen.js') }).allow_tool !== false) fail('shim did not DENY a rail write'); else ok('shim denies a frozen-rail write (exit 0 + allow_tool:false)');
if (drive('write_to_file', { TargetFile: join(repo, 'src', 'ok.js') }).allow_tool !== true) fail('shim did not ALLOW a non-rail write'); else ok('shim allows a non-rail write');

// doc framing
const doc = read(join(ROOT, 'docs', 'integrations', 'antigravity.md'));
if (!/rails-guard-ci\.mjs|ci\/rails-guard\.yml/.test(doc)) fail('doc does not name the CI gate'); else ok('doc names the CI gate');
if (!/advisor/i.test(doc)) fail('doc does not frame the hook as advisory'); else ok('doc frames hook as advisory');
if (!/Formal ADLC Coverage/.test(doc)) fail('doc missing Formal ADLC Coverage table'); else ok('doc has coverage table');

// run the plugin unit tests
try {
  const tests = readdirSync(join(PLUGIN, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join(PLUGIN, 'test', f));
  execFileSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass');
} catch (e) { fail(`unit tests failed:\n${e.stdout?.toString() ?? e.message}`); }

if (failures) { console.error(`\nantigravity-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\nantigravity-install-smoke: PASS');
