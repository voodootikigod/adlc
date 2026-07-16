import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MCP_CONFIG = join(ROOT, 'plugins/adlc-codex/.mcp.json');

function isolatedEnv(codexHome, home) {
  return {
    PATH: `${join(ROOT, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
    TERM: process.env.TERM ?? 'dumb',
    NO_COLOR: '1',
    CI: '1',
    CODEX_HOME: codexHome,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
  };
}

function runCodex(args, { cwd, env, input, timeout = 30_000 } = {}) {
  return spawnSync('codex', args, { cwd, env, input, timeout, encoding: 'utf8' });
}

function queryMcpStatus({ cwd, env, timeout = 30_000 }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    let statusResponse;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex app-server timed out: ${stderr}`));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: 'mcpServerStatus/list', id: 2, params: { detail: 'full' } })}\n`);
        }
        if (message.id === 2) {
          statusResponse = message;
          child.stdin.end();
        }
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Codex app-server exited ${code}: ${stderr}`));
      else if (!statusResponse) reject(new Error(`missing mcpServerStatus/list response: ${stdout}`));
      else resolvePromise(statusResponse);
    });
    child.stdin.write(`${JSON.stringify({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'adlc_smoke', title: 'ADLC smoke', version: '1.0.0' } },
    })}\n`);
  });
}

test('plugin MCP transport uses the stable ADLC CLI entrypoint without unresolved placeholders', () => {
  const config = JSON.parse(readFileSync(MCP_CONFIG, 'utf8'));
  assert.deepEqual(config.adlc, { command: 'adlc', args: ['mcp-server'] });
  assert.doesNotMatch(JSON.stringify(config), /\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/);
});

test('Codex initializes the installed ADLC MCP server and discovers its tools', {
  skip: process.env.ADLC_CODEX_LIVE_INSTALL !== '1',
}, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'adlc-codex-mcp-home-'));
  const home = mkdtempSync(join(tmpdir(), 'adlc-codex-mcp-user-'));
  const fixture = mkdtempSync(join(tmpdir(), 'adlc-codex-mcp-workspace-'));
  const env = isolatedEnv(codexHome, home);
  try {
    for (const path of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]) mkdirSync(path, { recursive: true });
    let result = runCodex(['plugin', 'marketplace', 'add', ROOT, '--json'], { cwd: ROOT, env });
    assert.equal(result.status, 0, result.stderr);
    result = runCodex(['plugin', 'add', 'adlc-codex@adlc', '--json'], { cwd: ROOT, env });
    assert.equal(result.status, 0, result.stderr);

    const status = await queryMcpStatus({ cwd: fixture, env });
    assert.equal(status.error, undefined, JSON.stringify(status.error));
    assert.match(JSON.stringify(status.result), /adlc_gate/);
    assert.doesNotMatch(JSON.stringify(status.result), /initialize response|PLUGIN_ROOT/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
