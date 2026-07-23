#!/usr/bin/env node
// adlc-mcp-wrapper.mjs — Cursor marketplace MCP entry (T65).
// Lifecycle Roots proxy → spawn `adlc mcp-server` with resolved consumer cwd.
// Missing `adlc` on PATH surfaces as Cursor's normal MCP start failure;
// install with: npm i -g @adlc/cli

import { fileURLToPath } from 'node:url';
import { runRootsProxy } from '../lib/mcp-roots-proxy.mjs';

async function main() {
  // Production: Roots only (no host-env unlock). Tests import runRootsProxy with allowHostEnvFallback.
  await runRootsProxy({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    allowHostEnvFallback: process.env.ADLC_CURSOR_MCP_ALLOW_HOSTENV === '1',
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`adlc-mcp-wrapper: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
