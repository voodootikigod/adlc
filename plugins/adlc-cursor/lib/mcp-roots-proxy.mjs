// mcp-roots-proxy.mjs — lifecycle-aware MCP Roots proxy (T65).
// Speaks JSON-RPC stdio with the Cursor client, requests roots/list after
// initialize, resolves the consumer workspace via T64 algorithm, then spawns
// `adlc mcp-server` with that cwd and forwards traffic.
//
// Never falls back to process.cwd() / plugin cache. Clients without roots
// capability fail closed. Multi-active roots fail closed (ambiguity).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsFromRootsListResult } from './mcp-file-uri.mjs';
import { resolveHostEnvRoot } from './mcp-hostenv.mjs';
import { resolveConsumerWorkspace } from './workspace-resolve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;

const ROOTS_REQ_ID = '__adlc_roots_list__';

function send(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function failClosed(output, id, message, code = -32000) {
  if (id !== undefined) {
    send(output, { jsonrpc: '2.0', id, error: { code, message } });
  }
}

/**
 * Resolve spawn target for the frozen CLI mcp-server.
 */
export function resolveAdlcMcpSpawn(env = process.env) {
  if (env.ADLC_CLI_BIN) {
    return { command: process.execPath, args: [env.ADLC_CLI_BIN, 'mcp-server'] };
  }
  return { command: 'adlc', args: ['mcp-server'] };
}

/**
 * Pick a concrete cwd from workspace resolution for MCP (fail closed on ambiguity).
 */
export function mcpRootFromWorkspace(workspace) {
  if (!workspace) return { ok: false, code: 'UNRESOLVED', message: 'no workspace resolution' };
  if (workspace.outcome === 'active' || workspace.outcome === 'inactive') {
    if (!workspace.root) return { ok: false, code: 'UNRESOLVED', message: 'resolved outcome without root' };
    return { ok: true, root: workspace.root, outcome: workspace.outcome, ticketId: workspace.ticketId ?? null };
  }
  return {
    ok: false,
    code: workspace.outcome?.toUpperCase?.() || 'UNRESOLVED',
    message: workspace.message || `MCP refuses to launch (${workspace.outcome})`,
  };
}

/**
 * Run the lifecycle proxy on the given streams.
 * @param {{ allowHostEnvFallback?: boolean }} [opts]
 *   allowHostEnvFallback — ONLY for unit tests of host-env path; production entry leaves this false.
 */
export async function runRootsProxy({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  spawnImpl = spawn,
  allowHostEnvFallback = false,
} = {}) {
  let child = null;
  let childRl = null;
  let boundRoot = null;
  let generation = 0;
  let pendingClient = [];
  let initialized = false;
  let binding = false;

  const killChild = () => {
    if (childRl) {
      try { childRl.close(); } catch { /* ignore */ }
      childRl = null;
    }
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    child = null;
  };

  const bindChild = (root) => {
    killChild();
    generation += 1;
    const myGen = generation;
    const target = resolveAdlcMcpSpawn(env);
    child = spawnImpl(target.command, target.args, {
      cwd: root,
      env: { ...env, ADLC_CURSOR_MCP_BOUND_ROOT: root },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    boundRoot = root;
    childRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    childRl.on('line', (line) => {
      if (myGen !== generation) return;
      if (!line.trim()) return;
      // Drop private child handshake replies; forward the rest.
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.id === 'string' && parsed.id.startsWith('__adlc_child_')) return;
      } catch { /* forward raw */ }
      output.write(`${line}\n`);
    });
    child.on('exit', () => {
      if (myGen === generation) {
        child = null;
        childRl = null;
      }
    });

    // Prime child with initialize so tools/call works; discard its initialize result
    // by using a private id the client never sees.
    send(child.stdin, {
      jsonrpc: '2.0',
      id: `__adlc_child_init_${myGen}`,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adlc-cursor-proxy', version: VERSION } },
    });
    send(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  };

  const flushPending = () => {
    if (!child?.stdin) return;
    const q = pendingClient;
    pendingClient = [];
    for (const msg of q) send(child.stdin, msg);
  };

  const resolveAndBindFromPaths = (paths) => {
    const workspace = resolveConsumerWorkspace({ workspace_roots: paths }, env);
    const picked = mcpRootFromWorkspace(workspace);
    if (!picked.ok) {
      return picked;
    }
    bindChild(picked.root);
    flushPending();
    return picked;
  };

  const tryHostEnvBind = () => {
    if (!allowHostEnvFallback) return null;
    const host = resolveHostEnvRoot(env);
    if (!host.ok) return host;
    bindChild(host.root);
    flushPending();
    return { ok: true, root: host.root, via: 'host-env' };
  };

  const requestRoots = () => {
    send(output, {
      jsonrpc: '2.0',
      id: ROOTS_REQ_ID,
      method: 'roots/list',
      params: {},
    });
  };

  return new Promise((resolvePromise) => {
    const lines = createInterface({ input, crlfDelay: Infinity });

    lines.on('line', async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      // Client response to our roots/list
      if (msg.id === ROOTS_REQ_ID && (msg.result !== undefined || msg.error !== undefined)) {
        binding = false;
        if (msg.error) {
          failClosed(output, undefined, `roots/list failed: ${msg.error.message || 'error'}`);
          process.stderr.write(`adlc-mcp-wrapper: roots/list error — ${msg.error.message}\n`);
          return;
        }
        const paths = pathsFromRootsListResult(msg.result);
        const picked = resolveAndBindFromPaths(paths);
        if (!picked.ok) {
          process.stderr.write(`adlc-mcp-wrapper: ${picked.code}: ${picked.message}\n`);
          // Fail closed any queued tool traffic — do not leave callers hanging.
          const stalled = pendingClient;
          pendingClient = [];
          for (const q of stalled) {
            if (q.id !== undefined) failClosed(output, q.id, `${picked.code}: ${picked.message}`);
          }
        }
        return;
      }

      if (msg.method === 'initialize') {
        const caps = msg.params?.capabilities ?? {};
        const hasRoots = Boolean(caps.roots);
        send(output, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'adlc-cursor', version: VERSION },
          },
        });
        initialized = true;

        if (!hasRoots) {
          // Fail closed for production path — optional host-env only when explicitly allowed.
          const host = tryHostEnvBind();
          if (!host || !host.ok) {
            process.stderr.write(
              'adlc-mcp-wrapper: client lacks roots capability; refusing to guess cwd. ' +
              'Install @adlc/cli and use a Roots-capable Cursor build, or set ADLC_CURSOR_MCP_ROOT for local tests only.\n',
            );
          }
          return;
        }
        binding = true;
        requestRoots();
        return;
      }

      if (msg.method === 'notifications/initialized') {
        return;
      }

      if (msg.method === 'notifications/roots/list_changed') {
        // Rebind: stop accepting new tool calls into old child; re-request roots.
        pendingClient = [];
        killChild();
        boundRoot = null;
        binding = true;
        requestRoots();
        return;
      }

      // Forward or queue
      if (child?.stdin && boundRoot && !binding) {
        send(child.stdin, msg);
        return;
      }

      // Not bound yet — queue while roots bind is in flight; else fail closed.
      if (msg.method === 'tools/call' || msg.method === 'tools/list') {
        if (!initialized) {
          failClosed(output, msg.id, 'ADLC MCP proxy not initialized');
          return;
        }
        if (binding) {
          pendingClient.push(msg);
          return;
        }
        if (!boundRoot) {
          const host = tryHostEnvBind();
          if (host?.ok) {
            // bound via host-env; flush includes this call if we queue first
            pendingClient.push(msg);
            flushPending();
            return;
          }
          failClosed(
            output,
            msg.id,
            host?.message || 'ADLC MCP proxy not bound to a consumer root (Roots unresolved or refused)',
          );
          return;
        }
      }

      if (msg.method?.startsWith('notifications/')) return;

      if (msg.id !== undefined) {
        failClosed(output, msg.id, `ADLC MCP proxy not bound to a consumer root yet (${msg.method})`);
      }
    });

    lines.on('close', () => {
      killChild();
      resolvePromise();
    });
  });
}
