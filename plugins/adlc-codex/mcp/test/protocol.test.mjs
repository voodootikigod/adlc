import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(dirname(SERVER), '..', 'package.json'), 'utf8')).version;

function transact({ cwd, cli, requests, env = {} }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd,
      env: { ...process.env, ...env, ADLC_CLI_BIN: cli },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`server exited ${code}: ${stderr}`));
      else resolvePromise(stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

test('real stdio server initializes, lists tools, executes safe argv, and rejects unsafe invocations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-mcp-'));
  const cli = join(root, 'fake-adlc.mjs');
  const outside = mkdtempSync(join(tmpdir(), 'adlc-codex-mcp-outside-'));
  writeFileSync(cli, 'if (process.argv.includes("--slow")) setTimeout(() => console.log("late"), 1500); else console.log(JSON.stringify(process.argv.slice(2)))\n');
  writeFileSync(join(outside, 'evidence.json'), '{}\n');
  symlinkSync(join(outside, 'evidence.json'), join(root, 'linked-evidence.json'));
  symlinkSync(join(outside, 'missing.json'), join(root, 'dangling-evidence.json'));
  try {
    const responses = await transact({
      cwd: root,
      cli,
      // Leave enough headroom for a Node child to start on a busy CI worker while
      // still proving that the server terminates a genuinely stalled command.
      env: { ADLC_MCP_TIMEOUT_MS: '500' },
      requests: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['ticket.md', '--json'] } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['--review-cmd', 'touch owned'] } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'adlc_prosecute', arguments: { input: '../escape.json', ticket: 'T1' } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'gate-manifest', args: ['record', 'fake'] } } },
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['../../secret.md'] } } },
        { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'adlc_prosecute', arguments: { input: 'linked-evidence.json', ticket: 'T1' } } },
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['--slow'] } } },
        { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['--file=linked-evidence.json'] } } },
        { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'preflight', args: [] } } },
        { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'premortem', args: ['ticket.md'] } } },
        { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'adlc_gate', arguments: { gate: 'spec-lint', args: ['--file=dangling-evidence.json'] } } },
      ],
    });
    assert.equal(responses[0].result.protocolVersion, '2025-06-18');
    assert.equal(responses[0].result.serverInfo.version, PACKAGE_VERSION);
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['adlc_gate', 'adlc_prosecute']);
    const execution = JSON.parse(responses[2].result.content[0].text);
    assert.equal(execution.ok, true);
    assert.deepEqual(JSON.parse(execution.stdout), ['spec-lint', 'ticket.md', '--json']);
    assert.match(responses[3].error.message, /mutating flag/);
    assert.match(responses[4].error.message, /escapes the repository/);
    assert.match(responses[5].error.message, /only permits gate-manifest show or verify/);
    assert.match(responses[6].error.message, /escapes the repository/);
    assert.match(responses[7].error.message, /escapes the repository/);
    const timeout = JSON.parse(responses[8].result.content[0].text);
    assert.equal(responses[8].result.isError, true);
    assert.equal(timeout.ok, false);
    assert.match(responses[9].error.message, /escapes the repository/);
    assert.match(responses[10].error.message, /not allowlisted/);
    assert.match(responses[11].error.message, /requires --prompt-only/);
    assert.match(responses[12].error.message, /unresolved symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
