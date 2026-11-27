#!/usr/bin/env node
// gemini-install-smoke.mjs — verify the adlc-gemini package shape,
// hooks.json schema (V3), always-exit-0 deny contract (V5), $HOME command path,
// name/dir invariant, doc framing, and run the plugin unit tests. No agent binary
// required. Exit 0 = pass, 2 = fail.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const PLUGIN = join(ROOT, 'plugins', 'adlc-gemini');
let failures = 0;
const fail = (m) => { console.error(`gemini-install-smoke: FAIL — ${m}`); failures++; };
const ok = (m) => console.log(`  ok — ${m}`);
const read = (p) => readFileSync(p, 'utf8');

// manifest + name/dir invariant (F3)
const manifest = JSON.parse(read(join(PLUGIN, 'plugin.json')));
if (manifest.name !== 'adlc-gemini') fail(`plugin.json name is ${manifest.name}`); else ok('plugin.json name == dir name');

// hooks.json V3 schema + $HOME command + catch-all matcher + .cjs entry
const hj = JSON.parse(read(join(PLUGIN, 'hooks.json')));
const spec = hj['adlc-rails']?.PreToolUse?.[0];
if (!spec) fail('hooks.json: adlc-rails.PreToolUse[0] missing'); else ok('hooks.json V3 shape (named hook → PreToolUse array)');
if (spec?.matcher !== '.*') fail(`matcher is "${spec?.matcher}", not catch-all`); else ok('catch-all matcher');
const cmd = spec?.hooks?.[0]?.command ?? '';
if (!/\$HOME\/\.gemini\/config\/plugins\/adlc-gemini\/hooks\/adlc-rails-guard\.cjs/.test(cmd)) fail(`command is not the $HOME .cjs path: ${cmd}`); else ok('command uses $HOME .cjs path (V9)');

// self-contained portability check: `[agent] plugin install`
// COPIES this plugin into ~/.gemini/config/plugins/<name>/ WITHOUT node_modules, so
// ANY runtime import of a workspace package (e.g. '@adlc/*') or third-party dep
// fails to resolve and the hook fails closed on every tool. The compiled bundle and
// shim must be fully self-contained (node: builtins or relative imports only).
const bundle = read(join(PLUGIN, 'hooks', 'adlc-rails-guard.bundle.mjs'));
const shim = read(join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs'));
const SELF_CONTAINED_FILES = [
  ['hooks/adlc-rails-guard.bundle.mjs', bundle],
  ['hooks/adlc-rails-guard.cjs', shim],
];
let selfContained = true;
for (const [label, src] of SELF_CONTAINED_FILES) {
  for (const m of src.matchAll(/(?:^|[\s;])import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !spec.startsWith('.')) {
      fail(`${label} imports non-node/non-relative module "${spec}" — plugin must be self-contained — copies without node_modules`);
      selfContained = false;
    }
  }
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !spec.startsWith('.')) {
      fail(`${label} requires non-node/non-relative module "${spec}" — plugin must be self-contained — copies without node_modules`);
      selfContained = false;
    }
  }
}
if (selfContained) ok('plugin is self-contained (node: + relative imports only, zero @adlc/* or third-party runtime imports)');

// always exit 0 + allow_tool contract: drive the shim with a rail-hit fixture.
// The fixture is removed whether or not the shim behaves.
const repo = mkdtempSync(join(tmpdir(), 'gemini-smoke-'));
try {
  mkdirSync(join(repo, '.adlc'));
  writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 't', body: 'b', scope: ['src/**'], rails: ['src/frozen.js'] }] }));
  writeFileSync(join(repo, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  mkdirSync(join(repo, 'src'));
  const SHIM = join(PLUGIN, 'hooks', 'adlc-rails-guard.cjs');
  const smokeHome = join(repo, '.smoke-home');
  mkdirSync(smokeHome, { recursive: true });
  const smokeEnv = { ...process.env, ADLC_P4_ENFORCEMENT: '1', HOME: smokeHome, USERPROFILE: smokeHome, ANTIGRAVITY_APP_DATA_DIR: smokeHome };
  for (const k of ['GEMINI_CONVERSATION_ID', 'JETSKI_CONVERSATION_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'CONVERSATION_ID', 'ADLC_SESSION_ID', 'AGY_SESSION_ID', 'GEMINI_SESSION_ID']) {
    delete smokeEnv[k];
  }
  const drive = (name, args) => {
    const out = execFileSync(process.execPath, [SHIM], { input: JSON.stringify({ workspacePaths: [repo], toolCall: { name, args } }), env: smokeEnv, encoding: 'utf8' });
    return JSON.parse(out);
  };
  if (drive('write_to_file', { TargetFile: join(repo, 'src', 'frozen.js') }).allow_tool !== false) fail('shim did not DENY a rail write'); else ok('shim denies a frozen-rail write (exit 0 + allow_tool:false)');
  if (drive('write_to_file', { TargetFile: join(repo, 'src', 'ok.js') }).allow_tool !== true) fail('shim did not ALLOW a non-rail write'); else ok('shim allows a non-rail write');
} finally {
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// doc framing
const doc = read(join(ROOT, 'docs', 'integrations', 'gemini.md'));
if (!/rails-guard-ci\.mjs|ci\/rails-guard\.yml/.test(doc)) fail('doc does not name the CI gate'); else ok('doc names the CI gate');
if (!/advisor/i.test(doc)) fail('doc does not frame the hook as advisory'); else ok('doc frames hook as advisory');
if (!/Formal ADLC Coverage/i.test(doc)) fail('doc missing Formal ADLC Coverage table'); else ok('doc has coverage table');

// run the plugin unit tests
try {
  const tests = readdirSync(join(PLUGIN, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join(PLUGIN, 'test', f));
  execFileSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'pipe' });
  ok('plugin unit tests pass');
} catch (e) { fail(`unit tests failed:\n${e.stdout?.toString() ?? e.message}`); }

if (failures) { console.error(`\ngemini-install-smoke: ${failures} failure(s)`); process.exit(2); }
console.log('\ngemini-install-smoke: PASS');
