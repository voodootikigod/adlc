import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { resolveAdlcMcpSpawn } from '../lib/mcp-spawn.mjs';

const WIN_EXEC_PATH = '/fixture/Program Files/nodejs/node.exe';

function resolveWindows(env, entry) {
  return resolveAdlcMcpSpawn(env, 'win32', {
    execPath: WIN_EXEC_PATH,
    isFile: (path) => path === entry,
  });
}

test('Windows resolves the JavaScript bin from npm_config_prefix', () => {
  const prefix = '/fixture/npm-global';
  const entry = join(prefix, 'node_modules', '@adlc', 'cli', 'bin', 'adlc.mjs');
  const resolved = resolveWindows({ npm_config_prefix: prefix }, entry);

  assert.equal(resolved.command, WIN_EXEC_PATH);
  assert.deepEqual(resolved.args, [entry, 'mcp-server']);
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.probed, [entry]);
});

test('Windows resolves global CLI layouts used by Volta and pnpm', () => {
  const voltaHome = '/fixture/volta';
  const voltaEntry = join(voltaHome, 'tools', 'image', 'packages', '@adlc', 'cli', 'node_modules', '@adlc', 'cli', 'bin', 'adlc.mjs');
  const volta = resolveWindows({ VOLTA_HOME: voltaHome }, voltaEntry);
  assert.deepEqual(volta.args, [voltaEntry, 'mcp-server']);
  assert.ok(volta.probed.includes(voltaEntry), 'the Volta dependency-tree entry must be probed');

  const pnpmHome = '/fixture/pnpm';
  const pnpmEntry = join(pnpmHome, 'global', '10', 'node_modules', '@adlc', 'cli', 'bin', 'adlc.mjs');
  const pnpm = resolveWindows({ PNPM_HOME: pnpmHome }, pnpmEntry);
  assert.deepEqual(pnpm.args, [pnpmEntry, 'mcp-server']);
});

test('Windows resolution never starts a shell or a command shim', () => {
  const resolved = resolveAdlcMcpSpawn(
    { APPDATA: '/fixture/AppData/Roaming' },
    'win32',
    { execPath: WIN_EXEC_PATH, isFile: () => false },
  );

  assert.equal(resolved.command, null);
  assert.deepEqual(resolved.args, []);
  assert.match(resolved.diagnostic, /ADLC MCP CLI was not found/);
  assert.match(resolved.diagnostic, /AppData/);
  assert.ok(resolved.probed.every((path) => path.endsWith('adlc.mjs')));
  assert.ok(resolved.probed.every((path) => !/\.cmd$/i.test(path)));
});

test('Windows probes the standard npm root and custom prefix with diagnostics', () => {
  const appData = '/fixture/AppData/Roaming';
  const standardEntry = join(appData, 'npm', 'node_modules', '@adlc', 'cli', 'bin', 'adlc.mjs');
  const standard = resolveWindows({ APPDATA: appData }, standardEntry);
  assert.deepEqual(standard.args, [standardEntry, 'mcp-server']);

  const prefix = '/fixture/custom-npm';
  const customEntry = join(prefix, 'node_modules', '@adlc', 'cli', 'bin', 'adlc.mjs');
  const unresolved = resolveWindows({ npm_config_prefix: prefix }, null);
  assert.ok(unresolved.probed.includes(customEntry));
  assert.match(unresolved.diagnostic, new RegExp(customEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
