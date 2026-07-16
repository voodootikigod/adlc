#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`could not read ${path}: ${error.message}`); }
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

function isVolatileRuntimeEntry(root, path) {
  if (!root.endsWith('/.codex')) return false;
  return /^(?:logs|state|goals|memories)_\d+\.sqlite(?:-(?:shm|wal))?$/.test(path)
    || ['history.jsonl', 'session_index.jsonl', 'models_cache.json'].includes(path)
    || path === 'sessions' || path.startsWith('sessions/')
    || path === 'shell_snapshots' || path.startsWith('shell_snapshots/');
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
      entry.hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    if (stat.isSymbolicLink()) entry.target = readlinkSync(path);
    entries.push(entry);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        visit(join(path, child.name), relativePath ? `${relativePath}/${child.name}` : child.name);
      }
    }
  };
  visit(root, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root, exists: true, entries };
}

function snapshotRealCodexHomes() {
  return realCodexPaths().map(snapshotPath);
}

function assertRealHomeUnchanged(before) {
  if (JSON.stringify(before) !== JSON.stringify(snapshotRealCodexHomes())) {
    fail('isolated Codex install mutated the caller real HOME/XDG Codex state');
  }
}

function runCodexJson(repo, env, args) {
  const result = spawnSync('codex', args, {
    cwd: repo,
    env: { PATH: process.env.PATH, TERM: process.env.TERM, NO_COLOR: '1', CI: '1', ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`codex ${args.join(' ')} failed: status=${result.status} stderr=${result.stderr}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { fail(`codex ${args.join(' ')} did not return JSON: ${error.message}: ${result.stdout}`); }
}

function isInside(root, target) {
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = realpathSync(target);
  const path = relative(canonicalRoot, canonicalTarget);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function exerciseInstalledMcp({ fixture, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: fixture, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    let statusResponse;
    let toolResponse;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolvePromise({ statusResponse, toolResponse });
    };
    const timer = setTimeout(() => finish(new SmokeFailure(`Codex MCP handshake timed out: ${stderr}`)), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', finish);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      try {
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ method: 'mcpServerStatus/list', id: 2, params: { detail: 'full' } })}\n`);
          } else if (message.id === 2) {
            statusResponse = message;
            child.stdin.write(`${JSON.stringify({
              method: 'thread/start',
              id: 3,
              params: {
                cwd: fixture,
                ephemeral: true,
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
              },
            })}\n`);
          } else if (message.id === 3) {
            const threadId = message.result?.thread?.id;
            if (!threadId) throw new Error(`Codex did not return an ephemeral thread: ${JSON.stringify(message)}`);
            child.stdin.write(`${JSON.stringify({
              method: 'mcpServer/tool/call',
              id: 4,
              params: {
                threadId,
                server: 'adlc',
                tool: 'adlc_gate',
                arguments: { gate: 'spec-lint', args: ['smoke-spec.md', '--json'] },
              },
            })}\n`);
          } else if (message.id === 4) {
            toolResponse = message;
            child.stdin.end();
          }
        }
      } catch (error) {
        finish(new SmokeFailure(`Codex app-server returned invalid MCP JSON: ${error.message}: ${stdout}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) finish(new SmokeFailure(`Codex app-server exited ${code}: ${stderr}`));
      else if (!statusResponse || !toolResponse) finish(new SmokeFailure(`Codex app-server omitted MCP responses: ${stdout}`));
      else finish();
    });
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'adlc_smoke', title: 'ADLC smoke', version: '1.0.0' } },
    })}\n`);
  });
}

function structuralContract(repo) {
  const marketplacePath = join(repo, '.agents/plugins/marketplace.json');
  const marketplace = readJson(marketplacePath);
  if (marketplace.name !== 'adlc') fail('marketplace name must be adlc');
  const entry = marketplace.plugins?.find((plugin) => plugin.name === 'adlc-codex');
  if (!entry || entry.source?.source !== 'local') fail('adlc-codex must be a local marketplace entry');
  const pluginRoot = resolve(repo, entry.source.path);
  const manifest = readJson(join(pluginRoot, '.codex-plugin/plugin.json'));
  const pkg = readJson(join(pluginRoot, 'package.json'));
  if (manifest.name !== 'adlc-codex' || pkg.name !== '@adlc/codex') fail('Codex plugin/package names do not match the public contract');
  if (manifest.version !== pkg.version) fail('Codex plugin manifest and npm package versions must match');
  if (manifest.skills !== './skills/' || manifest.hooks !== './hooks/hooks.json' || manifest.mcpServers !== './.mcp.json') fail('Codex manifest component paths are incomplete');

  const sentinels = {
    'skills/adlc/SKILL.md': 'ADLC_CODEX_SENTINEL_PHASE_ROUTER_V1',
    'skills/adlc-init/SKILL.md': 'ADLC_CODEX_SENTINEL_INIT_V1',
    'skills/adlc-spec/SKILL.md': 'ADLC_CODEX_SENTINEL_SPEC_V1',
    'skills/adlc-rail-build/SKILL.md': 'ADLC_CODEX_SENTINEL_RAIL_BUILD_V1',
    'skills/adlc-prosecute/SKILL.md': 'ADLC_CODEX_SENTINEL_PROSECUTE_V1',
    'skills/adlc-distill/SKILL.md': 'ADLC_CODEX_SENTINEL_DISTILL_V1',
  };
  for (const [path, sentinel] of Object.entries(sentinels)) {
    const source = readFileSync(join(pluginRoot, path), 'utf8');
    if (!source.includes(sentinel)) fail(`missing sentinel ${sentinel} in ${path}`);
    if (!existsSync(join(pluginRoot, path.replace('/SKILL.md', '/agents/openai.yaml')))) fail(`missing Codex interface metadata for ${path}`);
  }

  for (const name of ['adlc-explorer.toml', 'adlc-reviewer.toml', 'adlc-verifier.toml']) {
    if (!existsSync(join(pluginRoot, 'agents', name))) fail(`missing project agent template: ${name}`);
  }
  if (!existsSync(join(pluginRoot, 'hooks/adlc-rails-guard.mjs')) || !existsSync(join(pluginRoot, 'hooks/adlc-lifecycle.mjs'))) fail('missing native Codex hooks');
  if (!existsSync(join(pluginRoot, 'mcp/server.mjs'))) fail('missing bundled MCP server');
  const hooks = readJson(join(pluginRoot, 'hooks/hooks.json')).hooks;
  if (!hooks?.PreToolUse?.some((group) => group.hooks?.some((hook) => hook.command?.includes('${PLUGIN_ROOT}/hooks/adlc-rails-guard.mjs')))) fail('rails hook must use the Codex PLUGIN_ROOT contract');
  if (JSON.stringify(hooks).includes('CODEX_PLUGIN_ROOT')) fail('hooks must not use the non-existent CODEX_PLUGIN_ROOT variable');
  const mcp = readJson(join(pluginRoot, '.mcp.json'));
  if (mcp.adlc?.command !== 'adlc' || JSON.stringify(mcp.adlc.args) !== JSON.stringify(['mcp-server'])) {
    fail('MCP config must use the stable adlc mcp-server entrypoint');
  }
  if (JSON.stringify(mcp).includes('${PLUGIN_ROOT}') || JSON.stringify(mcp).includes('${CLAUDE_PLUGIN_ROOT}')) {
    fail('MCP config must not rely on plugin-root placeholder expansion');
  }
  return { marketplacePath, pluginRoot, sentinels, hooks };
}

async function main() {
  const repo = resolve(process.argv[2] ?? '.');
  const contract = structuralContract(repo);
  const realHomeBefore = snapshotRealCodexHomes();
  if (process.env.ADLC_CODEX_SMOKE_MUTATE_REAL_PLUGIN_DATA === '1' && process.env.HOME) {
    const mutationDir = join(process.env.HOME, '.codex/plugins/data/adlc-smoke-mutation-test');
    mkdirSync(mutationDir, { recursive: true });
    writeFileSync(join(mutationDir, 'mutation.json'), '{"mutated":true}\n');
  }

  if (process.env.ADLC_CODEX_LIVE_INSTALL !== '1') {
    assertRealHomeUnchanged(realHomeBefore);
    console.log(JSON.stringify({
      ok: true,
      marketplace: contract.marketplacePath,
      pluginRoot: contract.pluginRoot,
      isolatedHomeVerified: false,
      realHomeUnchanged: true,
      liveInstall: false,
      skills: Object.keys(contract.sentinels).length,
      agents: 3,
      hooks: Object.keys(contract.hooks).length,
      mcpServers: 1,
    }, null, 2));
    return;
  }

  const temporaryRoots = [];
  let codexHome;
  let isolatedHome;
  let fixture;
  let installedPluginRoot;
  try {
    codexHome = mkdtempSync(join(tmpdir(), 'adlc-codex-home-'));
    temporaryRoots.push(codexHome);
    isolatedHome = mkdtempSync(join(tmpdir(), 'adlc-codex-user-'));
    temporaryRoots.push(isolatedHome);
    fixture = mkdtempSync(join(tmpdir(), 'adlc-codex-smoke-'));
    temporaryRoots.push(fixture);
    const configHome = join(isolatedHome, '.config');
    const cacheHome = join(isolatedHome, '.cache');
    const dataHome = join(isolatedHome, '.local/share');
    mkdirSync(configHome, { recursive: true });
    mkdirSync(cacheHome, { recursive: true });
    mkdirSync(dataHome, { recursive: true });
    const env = {
      CODEX_HOME: codexHome,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
      PATH: `${join(repo, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
      TERM: process.env.TERM ?? 'dumb',
      NO_COLOR: '1',
      CI: '1',
    };
    if (process.env.ADLC_CODEX_SMOKE_FAIL_AFTER_TEMP === '1') fail('injected failure after temporary setup');

    const marketplaceAdd = runCodexJson(repo, env, ['plugin', 'marketplace', 'add', repo, '--json']);
    if (marketplaceAdd.marketplaceName !== 'adlc') fail('isolated marketplace add did not register adlc');
    const pluginAdd = runCodexJson(repo, env, ['plugin', 'add', 'adlc-codex@adlc', '--json']);
    if (pluginAdd.pluginId !== 'adlc-codex@adlc') fail('isolated plugin add returned the wrong id');
    installedPluginRoot = pluginAdd.installedPath;
    if (!installedPluginRoot || !isInside(codexHome, installedPluginRoot)) fail(`isolated Codex install path escaped CODEX_HOME: ${installedPluginRoot}`);
    const list = runCodexJson(repo, env, ['plugin', 'list', '--json', '--available']);
    if (!list.installed?.find((plugin) => plugin.pluginId === 'adlc-codex@adlc')?.enabled) fail('isolated plugin list does not show adlc-codex enabled');
    const mcpList = runCodexJson(repo, env, ['mcp', 'list', '--json']);
    const registeredMcp = mcpList.find((server) => server.name === 'adlc');
    if (!registeredMcp?.enabled || registeredMcp.transport?.command !== 'adlc' || JSON.stringify(registeredMcp.transport?.args) !== JSON.stringify(['mcp-server'])) {
      fail('Codex did not register the installed adlc MCP declaration');
    }
    for (const path of ['package.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'mcp/server.mjs', 'agents/adlc-reviewer.toml', 'skills/adlc-init/SKILL.md']) {
      if (!existsSync(join(installedPluginRoot, path))) fail(`installed plugin payload is missing ${path}`);
    }

    mkdirSync(join(fixture, '.adlc'), { recursive: true });
    writeFileSync(join(fixture, 'smoke-spec.md'), '## Acceptance Criteria\n- MCP execution succeeds; verify: `node --test`\n');
    writeFileSync(join(fixture, '.adlc/tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'Smoke', rails: ['test/**'], scope: ['src/**'], edges: [] }] }));
    writeFileSync(join(fixture, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
    const { ADLC_P4_ENFORCEMENT: _enforcement, ADLC_TICKET: _ticket, ...hookEnv } = process.env;
    const blocked = spawnSync(process.execPath, [join(installedPluginRoot, 'hooks/adlc-rails-guard.mjs')], {
      cwd: fixture,
      env: hookEnv,
      input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { path: 'test/smoke.test.mjs' } }),
      encoding: 'utf8',
    });
    if (blocked.status !== 2 || !blocked.stderr.includes('blocked rail edit')) fail(`installed rail hook did not auto-block: status=${blocked.status} stderr=${blocked.stderr}`);
    const advisory = spawnSync(process.execPath, [join(installedPluginRoot, 'hooks/adlc-lifecycle.mjs'), 'flail'], {
      cwd: fixture,
      env: { ...hookEnv, PLUGIN_DATA: join(isolatedHome, 'plugin-data') },
      input: '{malformed',
      encoding: 'utf8',
    });
    if (advisory.status !== 0 || !advisory.stdout.includes('ADLC advisory hook could not complete')) {
      fail(`installed advisory hook was not failure-isolated: status=${advisory.status} stdout=${advisory.stdout} stderr=${advisory.stderr}`);
    }
    const { statusResponse, toolResponse } = await exerciseInstalledMcp({ fixture, env });
    if (statusResponse.error || !JSON.stringify(statusResponse.result).includes('adlc_gate')) {
      fail(`Codex did not initialize the installed ADLC MCP tools: ${JSON.stringify(statusResponse)}`);
    }
    const toolText = toolResponse.result?.content?.find((item) => item.type === 'text')?.text;
    let toolResult;
    try { toolResult = toolText ? JSON.parse(toolText) : undefined; }
    catch (error) { fail(`installed MCP tool returned invalid result JSON: ${error.message}: ${toolText}`); }
    if (toolResponse.error || toolResponse.result?.isError || toolResult?.ok !== true) {
      fail(`installed MCP tool call failed through Codex: ${JSON.stringify(toolResponse)}`);
    }
    const mcpToolCall = true;
    assertRealHomeUnchanged(realHomeBefore);

    console.log(JSON.stringify({
      ok: true,
      marketplace: contract.marketplacePath,
      pluginRoot: contract.pluginRoot,
      installedPluginRoot,
      isolatedHomeVerified: true,
      realHomeUnchanged: true,
      liveInstall: true,
      skills: Object.keys(contract.sentinels).length,
      agents: 3,
      hooks: Object.keys(contract.hooks).length,
      mcpServers: 1,
      mcpRegistered: true,
      mcpToolCall,
    }, null, 2));
  } finally {
    for (const path of temporaryRoots.reverse()) rmSync(path, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`codex-install-smoke: ${error.message}`);
  process.exitCode = error instanceof SmokeFailure ? 2 : 1;
}
