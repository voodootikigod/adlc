// mcp-wrapper.test.mjs — T65 AC7: host-env + Roots proxy (unit/subprocess).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileUriToPath, pathsFromRootsListResult } from '../lib/mcp-file-uri.mjs';
import { resolveHostEnvRoot } from '../lib/mcp-hostenv.mjs';
import { mcpRootFromWorkspace, resolveAdlcMcpSpawn } from '../lib/mcp-roots-proxy.mjs';
import { resolveConsumerWorkspace } from '../lib/workspace-resolve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, '..', 'bin', 'adlc-mcp-wrapper.mjs');
const MCP_JSON = join(HERE, '..', 'mcp.json');

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
const cleanup = (p) => rmSync(p, { recursive: true, force: true });

function adlcRepo(pointer = { id: 'T1' }) {
  const root = tmp('adlc-mcp-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({
    tickets: [{ id: 'T1', title: 't', rails: [], scope: [], edges: [] }],
  }));
  if (pointer) writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify(pointer));
  return root;
}

function writeFakeCli(root) {
  const fakeCli = join(root, 'fake-adlc.mjs');
  writeFileSync(fakeCli, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } },
    }) + "\\n");
  }
  if (m.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id,
      result: { tools: [{ name: "adlc_gate" }, { name: "adlc_prosecute" }] },
    }) + "\\n");
  }
});
`);
  return fakeCli;
}

function spawnWrapper(env) {
  return spawn(process.execPath, [WRAPPER], {
    cwd: join(HERE, '..'),
    env: { ...process.env, ADLC_CURSOR_STATE_DIR: tmp('adlc-mcp-state-'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function attachCollector(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  return {
    text: () => stdout,
    err: () => stderr,
    wait: (ms = 200) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(predicate, { timeoutMs = 2000, stepMs = 25 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate(stdout, stderr)) return;
        await new Promise((r) => setTimeout(r, stepMs));
      }
      throw new Error(`timeout waiting for MCP output.\nstdout=${stdout}\nstderr=${stderr}`);
    },
  };
}

test('fileUriToPath decodes unix Roots URIs', () => {
  const root = adlcRepo();
  try {
    const decoded = fileUriToPath(pathToFileURL(root).href);
    assert.equal(decoded, root);
    assert.equal(fileUriToPath('https://example.com'), null);
  } finally { cleanup(root); }
});

test('pathsFromRootsListResult requires Root objects with uri (not bare strings)', () => {
  assert.deepEqual(pathsFromRootsListResult({ roots: ['/tmp/a'] }), []);
  const root = adlcRepo();
  try {
    const uri = pathToFileURL(root).href;
    const paths = pathsFromRootsListResult({ roots: [{ uri }] });
    assert.equal(paths.length, 1);
    assert.equal(paths[0], root);
  } finally { cleanup(root); }
});

test('host-env: success when ADLC_CURSOR_MCP_ROOT points at ADLC repo', () => {
  const root = adlcRepo();
  try {
    const r = resolveHostEnvRoot({ ADLC_CURSOR_MCP_ROOT: root });
    assert.equal(r.ok, true);
    assert.equal(r.root, root);
  } finally { cleanup(root); }
});

test('host-env: absent env fails closed even if cwd is ADLC-bearing', () => {
  const root = adlcRepo();
  const prev = process.cwd();
  try {
    process.chdir(root);
    const r = resolveHostEnvRoot({});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HOST_ENV_ABSENT');
  } finally {
    process.chdir(prev);
    cleanup(root);
  }
});

test('mcpRootFromWorkspace refuses ambiguity / unresolved', () => {
  assert.equal(mcpRootFromWorkspace({ outcome: 'ambiguous', message: 'x' }).ok, false);
  assert.equal(mcpRootFromWorkspace({ outcome: 'unresolved' }).ok, false);
  assert.equal(mcpRootFromWorkspace({ outcome: 'active', root: '/tmp/a' }).ok, true);
});

test('mcp.json wires the wrapper module, not raw adlc mcp-server', () => {
  const cfg = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
  const adlc = cfg.mcpServers?.adlc;
  assert.ok(adlc, 'mcpServers.adlc required');
  assert.equal(adlc.command, 'node');
  assert.ok(adlc.args?.some((a) => /adlc-mcp-wrapper\.mjs/.test(a)));
  assert.ok(!adlc.args?.includes('mcp-server'));
  assert.notEqual(adlc.command, 'adlc');
});

test('resolveAdlcMcpSpawn prefers ADLC_CLI_BIN', () => {
  const r = resolveAdlcMcpSpawn({ ADLC_CLI_BIN: '/tmp/fake-adlc.mjs' });
  assert.equal(r.command, process.execPath);
  assert.deepEqual(r.args, ['/tmp/fake-adlc.mjs', 'mcp-server']);
});

test('Roots proxy: host-env opt-in binds without roots capability', async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const child = spawnWrapper({
    ADLC_CLI_BIN: fakeCli,
    ADLC_CURSOR_MCP_ALLOW_HOSTENV: '1',
    ADLC_CURSOR_MCP_ROOT: root,
  });
  const out = attachCollector(child);
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
    }) + '\n');
    await out.waitFor((s) => s.includes('"id":1') && s.includes('adlc-cursor'));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    await out.waitFor((s) => s.includes('"id":2') && s.includes('adlc_gate'));
    const stdout = out.text();
    const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.id === 1 && l.result?.serverInfo?.name === 'adlc-cursor'));
    assert.ok(lines.some((l) => l.id === 2 && l.result?.tools?.some((t) => t.name === 'adlc_gate')),
      `expected tools/list via host-env bind; got: ${stdout}`);
  } finally {
    child.kill();
    cleanup(root);
  }
});

test('Roots proxy: roots/list with one active root binds and lists tools', async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const child = spawnWrapper({ ADLC_CLI_BIN: fakeCli });
  const out = attachCollector(child);
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'test' },
      },
    }) + '\n');

    await out.waitFor((s) => s.includes('roots/list'));
    let stdout = out.text();
    const pending = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rootsReq = pending.find((l) => l.method === 'roots/list');
    assert.ok(rootsReq, `proxy must request roots/list; got ${stdout}\nerr=${out.err()}`);

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: rootsReq.id,
      result: { roots: [{ uri: pathToFileURL(root).href }] },
    }) + '\n');

    await out.wait(50);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) + '\n');
    await out.waitFor((s) => s.includes('"id":3') && s.includes('adlc_prosecute'));
    stdout = out.text();
    const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.id === 3 && l.result?.tools?.some((t) => t.name === 'adlc_prosecute')));
  } finally {
    child.kill();
    cleanup(root);
  }
});

test('Roots proxy: multi-active roots refuse launch (fail closed)', async () => {
  const a = adlcRepo({ id: 'T1' });
  const b = adlcRepo({ id: 'T1' });
  const fakeCli = writeFakeCli(a);
  const child = spawnWrapper({ ADLC_CLI_BIN: fakeCli });
  const out = attachCollector(child);
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'test' },
      },
    }) + '\n');
    await out.waitFor((s) => s.includes('roots/list'));
    let stdout = out.text();
    const rootsReq = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .find((l) => l.method === 'roots/list');
    assert.ok(rootsReq);

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: rootsReq.id,
      result: {
        roots: [
          { uri: pathToFileURL(a).href },
          { uri: pathToFileURL(b).href },
        ],
      },
    }) + '\n');
    await out.wait(50);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) + '\n');
    await out.waitFor((s) => s.includes('"id":9') && s.includes('error'));
    stdout = out.text();
    const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const err = lines.find((l) => l.id === 9 && l.error);
    assert.ok(err, `multi-root must fail closed tools/list; got ${stdout}`);
    assert.match(err.error.message, /AMBIGUOUS|ambiguous|refuse/i);
  } finally {
    child.kill();
    cleanup(a);
    cleanup(b);
  }
});

test('resolveConsumerWorkspace still used for multi-root ambiguity (MCP refuses)', () => {
  const a = adlcRepo({ id: 'T1' });
  const b = adlcRepo({ id: 'T1' });
  try {
    const ws = resolveConsumerWorkspace({ workspace_roots: [a, b] }, {});
    assert.equal(ws.outcome, 'ambiguous');
    assert.equal(mcpRootFromWorkspace(ws).ok, false);
  } finally {
    cleanup(a); cleanup(b);
  }
});
