import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'cursor-install-smoke.mjs');
const SOURCE_PLUGIN = join(ROOT, 'plugins', 'adlc-cursor');

function runSmoke(root) {
  return spawnSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function makeFixture(change) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-install-smoke-'));
  fixtureDirs.add(root);
  mkdirSync(join(root, 'plugins'), { recursive: true });
  cpSync(SOURCE_PLUGIN, join(root, 'plugins', 'adlc-cursor'), {
    recursive: true,
    filter(source) {
      const parts = source.split('/');
      return !parts.includes('node_modules') && !parts.includes('test');
    },
  });

  for (const path of ['package.json', '.cursor-plugin', '.adlc', 'docs', 'apps']) {
    symlinkSync(join(ROOT, path), join(root, path));
  }
  mkdirSync(join(root, 'scripts'));
  symlinkSync(
    join(ROOT, 'scripts', 'cursor-deny-proof'),
    join(root, 'scripts', 'cursor-deny-proof'),
  );
  symlinkSync(
    join(ROOT, 'scripts', 'cursor-deny-proof.mjs'),
    join(root, 'scripts', 'cursor-deny-proof.mjs'),
  );

  change(join(root, 'plugins', 'adlc-cursor'));
  return root;
}

function updateJson(path, change) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('cursor-install-smoke passes against the real repository', () => {
  const result = runSmoke(ROOT);
  assert.equal(result.status, 0, outputOf(result));
  assert.match(result.stdout, /cursor-install-smoke: PASS/);
});

test('cursor-install-smoke rejects each invalid T65 MCP launcher contract', () => {
  const cases = [
    {
      name: 'an argument outside CURSOR_PLUGIN_ROOT',
      change(plugin) {
        updateJson(join(plugin, 'mcp.json'), (mcp) => {
          mcp.mcpServers.adlc.args = ['bin/adlc-mcp-wrapper.bundle.mjs'];
        });
      },
      expected: /must launch the bundled Roots proxy from \$\{CURSOR_PLUGIN_ROOT\}/,
    },
    {
      name: 'a working directory outside CURSOR_PLUGIN_ROOT',
      change(plugin) {
        updateJson(join(plugin, 'mcp.json'), (mcp) => {
          mcp.mcpServers.adlc.cwd = '.';
        });
      },
      expected: /must launch the bundled Roots proxy from \$\{CURSOR_PLUGIN_ROOT\}/,
    },
    {
      name: 'a raw mcp-server reference',
      change(plugin) {
        updateJson(join(plugin, 'mcp.json'), (mcp) => {
          mcp.mcpServers.adlc.note = 'mcp-server';
        });
      },
      expected: /must not wire raw adlc mcp-server \(use the wrapper\)/,
    },
    {
      name: 'a missing bundled launcher',
      change(plugin) {
        rmSync(join(plugin, 'bin', 'adlc-mcp-wrapper.bundle.mjs'));
      },
      expected: /bin\/adlc-mcp-wrapper\.bundle\.mjs missing/,
    },
    {
      name: 'a plugin manifest that does not discover mcp.json',
      change(plugin) {
        updateJson(join(plugin, '.cursor-plugin', 'plugin.json'), (manifest) => {
          manifest.mcpServers = './other-mcp.json';
        });
      },
      expected: /\.cursor-plugin\/plugin\.json mcpServers must be \.\/mcp\.json/,
    },
    {
      name: 'a preToolUse hook with failClosed disabled',
      change(plugin) {
        updateJson(join(plugin, 'hooks', 'hooks.json'), (hj) => {
          hj.hooks.preToolUse[0].failClosed = false;
        });
      },
      expected: /hooks\/hooks\.json: preToolUse failClosed must be true/,
    },
    {
      name: 'an unbundled preToolUse hook command',
      change(plugin) {
        updateJson(join(plugin, 'hooks.json'), (hj) => {
          hj.hooks.preToolUse[0].command = 'node ./node_modules/@adlc/cursor/hooks/adlc-pretool.mjs';
        });
      },
      expected: /hooks\.json: preToolUse does not wire the adlc-pretool\.bundle\.mjs dispatcher/,
    },
    {
      name: 'a missing bundled hook file',
      change(plugin) {
        rmSync(join(plugin, 'hooks', 'adlc-preflight.bundle.mjs'));
      },
      expected: /hooks\/adlc-preflight\.bundle\.mjs missing/,
    },
  ];

  for (const scenario of cases) {
    const root = makeFixture(scenario.change);
    try {
      const result = runSmoke(root);
      assert.equal(result.status, 2, `${scenario.name}\n${outputOf(result)}`);
      assert.match(outputOf(result), scenario.expected, scenario.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('bundled preToolUse fails closed on malformed payload under enforcement and recovers with ADLC_P4_ENFORCEMENT=0', () => {
  const bundle = join(SOURCE_PLUGIN, 'hooks', 'adlc-pretool.bundle.mjs');
  const enforcing = spawnSync(process.execPath, [bundle], {
    input: '{not valid json',
    env: { PATH: process.env.PATH ?? '', ADLC_P4_ENFORCEMENT: '1' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(enforcing.status, 0, enforcing.stderr);
  assert.equal(JSON.parse(enforcing.stdout).permission, 'deny');

  const recovery = spawnSync(process.execPath, [bundle], {
    input: '{not valid json',
    env: { PATH: process.env.PATH ?? '', ADLC_P4_ENFORCEMENT: '0' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).permission, 'allow');
});
