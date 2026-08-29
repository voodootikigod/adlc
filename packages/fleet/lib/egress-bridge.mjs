#!/usr/bin/env node
// In-sandbox loopback bridge for model-plane egress (spec §6.4 "EGRESS", AC 152).
//
//   node egress-bridge.mjs --socket <unix socket> --port <n> -- <cmd> [args...]
//
// Runs INSIDE `bwrap --unshare-net`, spawned by fleet from the pinned `node`.
// It listens on `127.0.0.1:<port>` — the address the worker's `HTTPS_PROXY`
// names — and forwards every connection, byte for byte, to the host-side proxy's
// unix socket, which is bind-mounted into the sandbox. That socket is the ONLY
// route out of the network namespace; the proxy on the other end decides what
// the bytes may reach. The bridge decides nothing.
//
// This file is deliberately self-contained (no sibling imports): it is the one
// file that must be visible inside the sandbox, so it must not drag a dependency
// tree in with it.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { pathToFileURL } from 'node:url';

const LOOPBACK = '127.0.0.1';
const FORWARDED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);
const EXIT_OPERATIONAL_ERROR = 1;

// A flag never swallows the next flag as its value: `--socket --port 8118` is a
// missing socket, not a socket named "--port".
function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(raw) {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * `--socket <path> --port <n> -- <cmd> [args...]` → `{ socketPath, port, command }`.
 * Throws on a missing flag, a flag without a value, an unknown flag, a missing
 * `--`, or an empty command: the bridge must never guess what to run.
 */
export function parseBridgeArgv(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  let socketPath;
  let port;
  let command;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { command = argv.slice(i + 1); break; }
    if (arg === '--socket') { socketPath = takeValue(argv, i, arg); i += 1; continue; }
    if (arg === '--port') { port = parsePort(takeValue(argv, i, arg)); i += 1; continue; }
    throw new Error(`unknown bridge argument: ${JSON.stringify(arg)}`);
  }
  if (command === undefined) throw new Error('missing "--" separating bridge flags from the command');
  if (command.length === 0) throw new Error('missing command after "--"');
  if (!socketPath) throw new Error('missing --socket <unix socket path>');
  if (port === undefined) throw new Error('missing --port <n>');
  return Object.freeze({ socketPath, port, command: Object.freeze([...command]) });
}

/** Wire one loopback connection to a fresh unix-socket connection; any error drops both ends. */
function forward(conn, socketPath, connect) {
  const upstream = connect(socketPath);
  const drop = () => { conn.destroy(); upstream.destroy(); };
  conn.on('error', drop);
  upstream.on('error', drop);
  conn.on('close', () => upstream.destroy());
  upstream.on('close', () => conn.destroy());
  // Piping before `upstream` connects is safe: net.Socket queues writes until then.
  conn.pipe(upstream);
  upstream.pipe(conn);
}

/** Resolves to `{ close }` once the loopback listener is up; rejects if the port cannot be bound. */
export function startBridgeServer({ socketPath, port, connect = net.connect }) {
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    forward(conn, socketPath, connect);
  });
  const close = () => new Promise((resolve) => {
    for (const conn of conns) conn.destroy();
    server.close(() => resolve());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => process.stderr.write(`egress-bridge: ${err.message}\n`));
      resolve({ close });
    });
  });
}

/** A child's exit → the code the bridge should exit with (128+signal when it was signalled). */
export function childExitCode(code, signal) {
  if (code !== null && code !== undefined) return code;
  const num = osConstants.signals[signal];
  return 128 + (Number.isInteger(num) ? num : 0);
}

/**
 * Start the listener, THEN the command (the worker must never start with a dead
 * proxy address in its env), forward SIGTERM/SIGINT, and resolve with the exit
 * code the bridge should propagate once the child is gone.
 */
export async function runBridge({ socketPath, port, command, spawnFn = spawn, connect = net.connect, proc = process }) {
  // The relays are installed BEFORE the server and the spawn: a stop signal that lands during
  // the start-up window is held and delivered to the child the moment it exists, never lost
  // (and never lets the bridge die of the signal with the child about to be spawned).
  let child = null; let pending = null;
  const relay = (signal) => () => { if (!child) { pending = signal; return; } if (child.exitCode === null) child.kill(signal); };
  const relays = FORWARDED_SIGNALS.map((signal) => [signal, relay(signal)]);
  for (const [signal, handler] of relays) proc.on(signal, handler);
  const server = await startBridgeServer({ socketPath, port, connect });
  const [cmd, ...args] = command;
  child = spawnFn(cmd, args, { stdio: 'inherit', env: proc.env });
  if (pending) child.kill(pending);
  const detach = () => { for (const [signal, handler] of relays) proc.removeListener(signal, handler); };
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(childExitCode(code, signal)));
    });
  } finally {
    detach();
    await server.close();
  }
}

// The file:// URL of the script Node was started with, symlinks resolved, or null
// when there is no resolvable entry — the same guard `bin/fleet.mjs` uses so that
// importing this module (a test importing parseBridgeArgv) starts nothing.
function entryUrl() {
  if (!process.argv[1]) return null;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
}

async function main() {
  try {
    const exitCode = await runBridge(parseBridgeArgv(process.argv.slice(2)));
    process.exit(exitCode);
  } catch (err) {
    process.stderr.write(`egress-bridge: ${err?.message ?? err}\n`);
    process.exit(EXIT_OPERATIONAL_ERROR);
  }
}

if (entryUrl() === import.meta.url) main();
