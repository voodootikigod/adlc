#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`codex-install-smoke: ${message}`);
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read ${path}: ${err.message}`);
  }
}

function realCodexPaths() {
  const home = process.env.HOME;
  if (!home) return [];
  return [
    join(home, '.codex'),
    join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'codex'),
    join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'codex'),
    join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'codex'),
  ];
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isVolatileRuntimeEntry(root, relativePath) {
  if (!root.endsWith('/.codex')) return false;
  return (
    /^logs_\d+\.sqlite(?:-(?:shm|wal))?$/.test(relativePath) ||
    /^state_\d+\.sqlite(?:-(?:shm|wal))?$/.test(relativePath) ||
    /^goals_\d+\.sqlite(?:-(?:shm|wal))?$/.test(relativePath) ||
    /^memories_\d+\.sqlite(?:-(?:shm|wal))?$/.test(relativePath) ||
    relativePath === 'models_cache.json' ||
    relativePath === 'history.jsonl' ||
    relativePath === 'session_index.jsonl' ||
    relativePath === 'sessions' ||
    relativePath.startsWith('sessions/') ||
    relativePath === 'shell_snapshots' ||
    relativePath.startsWith('shell_snapshots/') ||
    relativePath === 'plugins/data/omo-sisyphuslabs/sessions' ||
    relativePath.startsWith('plugins/data/omo-sisyphuslabs/sessions/')
  );
}

function snapshotPath(root) {
  if (!existsSync(root)) return { root, exists: false, entries: [] };
  const entries = [];
  const visit = (path, relativePath) => {
    if (relativePath && isVolatileRuntimeEntry(root, relativePath)) return;
    const stat = lstatSync(path);
    const entry = {
      path: relativePath,
      type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : 'file',
      mode: stat.mode,
    };
    if (stat.isFile()) {
      entry.size = stat.size;
      entry.hash = sha256File(path);
    }
    if (stat.isSymbolicLink()) {
      entry.size = stat.size;
      entry.target = readlinkSync(path);
    }
    entries.push(entry);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visit(join(path, entry.name), relativePath ? `${relativePath}/${entry.name}` : entry.name);
    }
  };
  visit(root, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root, exists: true, entries };
}

function snapshotRealCodexHomes() {
  return realCodexPaths().map(snapshotPath);
}

function assertUnchangedSnapshots(before, after) {
  const beforeText = JSON.stringify(before);
  const afterText = JSON.stringify(after);
  if (beforeText !== afterText) {
    const changed = before.map((snapshot, index) => changedSnapshotEntries(snapshot, after[index])).flat();
    fail(`isolated Codex install mutated the caller real HOME/XDG Codex state: ${changed}`);
  }
}

function changedSnapshotEntries(before, after) {
  if (!after) return [`${before.root}:missing-after-snapshot`];
  if (before.exists !== after.exists) return [`${before.root}:existence`];
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changed = [];
  for (const [path, entry] of beforeEntries) {
    if (!afterEntries.has(path)) changed.push(`${before.root}/${path}:removed`);
    else if (JSON.stringify(entry) !== JSON.stringify(afterEntries.get(path))) changed.push(`${before.root}/${path}:changed`);
  }
  for (const path of afterEntries.keys()) {
    if (!beforeEntries.has(path)) changed.push(`${before.root}/${path}:added`);
  }
  return changed.slice(0, 10);
}

const repo = resolve(process.argv[2] ?? '.');
const marketplacePath = join(repo, '.agents/plugins/marketplace.json');
const marketplace = readJson(marketplacePath);
if (marketplace.name !== 'adlc') fail('marketplace name must be adlc');

const entry = marketplace.plugins?.find((plugin) => plugin.name === 'adlc-codex');
if (!entry) fail('missing adlc-codex marketplace entry');
if (entry.source?.source !== 'local') fail('adlc-codex source must be local');

const pluginRoot = resolve(repo, entry.source.path);
const manifestPath = join(pluginRoot, '.codex-plugin/plugin.json');
const manifest = readJson(manifestPath);
if (manifest.name !== 'adlc-codex') fail('plugin manifest name must be adlc-codex');
if (manifest.skills !== './skills/') fail('plugin manifest skills must be ./skills/');
if (manifest.hooks !== './hooks/hooks.json') fail('plugin manifest hooks must be ./hooks/hooks.json');

const sentinels = {
  'skills/adlc/SKILL.md': 'ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1',
  'skills/adlc-spec/SKILL.md': 'ADLC_CODEX_SENTINEL_SPEC_V1',
  'skills/adlc-rail-build/SKILL.md': 'ADLC_CODEX_SENTINEL_RAIL_BUILD_V1',
  'skills/adlc-prosecute/SKILL.md': 'ADLC_CODEX_SENTINEL_PROSECUTE_V1',
  'skills/adlc-distill/SKILL.md': 'ADLC_CODEX_SENTINEL_DISTILL_V1',
};

for (const [relative, sentinel] of Object.entries(sentinels)) {
  const path = join(pluginRoot, relative);
  if (!existsSync(path)) fail(`missing skill file: ${relative}`);
  if (!readFileSync(path, 'utf8').includes(sentinel)) fail(`missing sentinel ${sentinel} in ${relative}`);
}

const hookPath = join(pluginRoot, 'hooks/adlc-rails-guard.mjs');
if (!existsSync(hookPath)) fail('missing hooks/adlc-rails-guard.mjs');
const hookSource = readFileSync(hookPath, 'utf8');
if (hookSource.includes('from \'@adlc/') || hookSource.includes('from "@adlc/')) {
  fail('rails guard hook must not depend on workspace package imports');
}

const hooksConfigPath = join(pluginRoot, 'hooks/hooks.json');
const hooksConfig = readJson(hooksConfigPath);
const preToolUse = hooksConfig.hooks?.PreToolUse;
if (!Array.isArray(preToolUse)) fail('hooks/hooks.json must register PreToolUse hooks');
const railsHookRegistration = preToolUse.find((entry) =>
  typeof entry.matcher === 'string' &&
  entry.matcher.includes('apply_patch') &&
  entry.matcher.includes('functions\\.apply_patch') &&
  Array.isArray(entry.hooks) &&
  entry.hooks.some((hook) => hook.command?.includes('${PLUGIN_ROOT}/hooks/adlc-rails-guard.mjs'))
);
if (!railsHookRegistration) fail('hooks/hooks.json must register adlc-rails-guard.mjs for edit tools');

function runCodexJson(codexEnv, args) {
  const result = spawnSync('codex', args, {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      TERM: process.env.TERM,
      NO_COLOR: process.env.NO_COLOR,
      CI: '1',
      ...codexEnv,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`codex ${args.join(' ')} failed: status=${result.status} stderr=${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`codex ${args.join(' ')} did not return JSON: ${err.message}: ${result.stdout}`);
  }
}

const codexHome = mkdtempSync(join(tmpdir(), 'adlc-codex-home-'));
const isolatedHome = mkdtempSync(join(tmpdir(), 'adlc-codex-user-'));
const isolatedConfigHome = join(isolatedHome, '.config');
const isolatedCacheHome = join(isolatedHome, '.cache');
const isolatedDataHome = join(isolatedHome, '.local/share');
mkdirSync(isolatedConfigHome, { recursive: true });
mkdirSync(isolatedCacheHome, { recursive: true });
mkdirSync(isolatedDataHome, { recursive: true });
const codexEnv = {
  CODEX_HOME: codexHome,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: isolatedConfigHome,
  XDG_CACHE_HOME: isolatedCacheHome,
  XDG_DATA_HOME: isolatedDataHome,
};
const realHomeBefore = snapshotRealCodexHomes();
if (process.env.ADLC_CODEX_SMOKE_MUTATE_REAL_PLUGIN_DATA === '1' && process.env.HOME) {
  const mutationDir = join(process.env.HOME, '.codex/plugins/data/adlc-smoke-mutation-test');
  mkdirSync(mutationDir, { recursive: true });
  writeFileSync(join(mutationDir, 'mutation.json'), '{"mutated":true}\n');
}

if (process.env.ADLC_CODEX_LIVE_INSTALL !== '1') {
  assertUnchangedSnapshots(realHomeBefore, snapshotRealCodexHomes());
  console.log(JSON.stringify({
    ok: true,
    marketplace: marketplacePath,
    pluginRoot,
    isolatedHomeVerified: false,
    realHomeUnchanged: true,
    liveInstall: false,
    skills: Object.keys(sentinels).length,
    hooks: 1,
    hookRegistrations: 1,
  }, null, 2));
  process.exit(0);
}

let installedPluginRoot;
try {
  const marketplaceAdd = runCodexJson(codexEnv, ['plugin', 'marketplace', 'add', repo, '--json']);
  if (marketplaceAdd.marketplaceName !== 'adlc') fail('isolated Codex marketplace add did not register adlc');
  const pluginAdd = runCodexJson(codexEnv, ['plugin', 'add', 'adlc-codex', '--marketplace', 'adlc', '--json']);
  if (pluginAdd.pluginId !== 'adlc-codex@adlc') fail('isolated Codex plugin add returned wrong plugin id');
  installedPluginRoot = pluginAdd.installedPath;
  if (!installedPluginRoot?.startsWith(codexHome)) {
    fail(`isolated Codex install path escaped CODEX_HOME: ${installedPluginRoot}`);
  }
  const list = runCodexJson(codexEnv, ['plugin', 'list', '--json', '--available']);
  const installed = list.installed?.find((plugin) => plugin.pluginId === 'adlc-codex@adlc');
  if (!installed?.enabled) fail('isolated Codex plugin list does not show adlc-codex enabled');
  if (!existsSync(join(installedPluginRoot, 'hooks/hooks.json'))) {
    fail('isolated Codex install did not include hooks/hooks.json');
  }
  const installedManifest = readJson(join(installedPluginRoot, '.codex-plugin/plugin.json'));
  if (installedManifest.hooks !== './hooks/hooks.json') {
    fail('isolated Codex install manifest does not expose hooks/hooks.json');
  }
  if (!existsSync(join(installedPluginRoot, 'skills/adlc/SKILL.md'))) {
    fail('isolated Codex install did not include skills/adlc/SKILL.md');
  }
  assertUnchangedSnapshots(realHomeBefore, snapshotRealCodexHomes());
} finally {
  if (!installedPluginRoot) {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

const fixture = mkdtempSync(join(tmpdir(), 'adlc-codex-smoke-'));
try {
  mkdirSync(join(fixture, '.adlc'), { recursive: true });
  writeFileSync(join(fixture, '.adlc/tickets.json'), JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Smoke ticket', rails: ['test/**'], scope: ['src/**'], edges: [] },
    ],
  }));
  const installedHooksConfig = readJson(join(installedPluginRoot, 'hooks/hooks.json'));
  const installedRegistration = installedHooksConfig.hooks.PreToolUse.find((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes('${PLUGIN_ROOT}/hooks/adlc-rails-guard.mjs'))
  );
  if (!installedRegistration) fail('isolated Codex install lacks registered rails hook command');
  const command = installedRegistration.hooks
    .find((hook) => hook.command?.includes('${PLUGIN_ROOT}/hooks/adlc-rails-guard.mjs'))
    .command.replaceAll('${PLUGIN_ROOT}', installedPluginRoot);
  const blocked = spawnSync(command, {
    shell: true,
    cwd: fixture,
    env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
    input: JSON.stringify({ path: 'test/smoke.test.mjs' }),
    encoding: 'utf8',
  });
  if (blocked.status !== 2 || !blocked.stderr.includes('blocked rail edit')) {
    fail(`registered rails hook did not block simulated rail edit: status=${blocked.status} stderr=${blocked.stderr}`);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
}
assertUnchangedSnapshots(realHomeBefore, snapshotRealCodexHomes());

console.log(JSON.stringify({
  ok: true,
  marketplace: marketplacePath,
  pluginRoot,
  isolatedHomeVerified: true,
  realHomeUnchanged: true,
  liveInstall: true,
  skills: Object.keys(sentinels).length,
  hooks: 1,
  hookRegistrations: 1,
}, null, 2));
