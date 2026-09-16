#!/usr/bin/env node
// adlc-mcp-wrapper.mjs — Cursor marketplace MCP entry (T65).
// Lifecycle Roots proxy → spawn `adlc mcp-server` with resolved consumer cwd.
// Missing `adlc` on PATH surfaces as Cursor's normal MCP start failure;
// install with: npm i -g @adlc/cli

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRootsProxy } from "../lib/mcp-roots-proxy.mjs";

async function main() {
  // Production: Roots only. Test-only host-env fallback is injected directly
  // through runRootsProxy and must never be controlled by the host environment.
  await runRootsProxy({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    allowHostEnvFallback: false,
  });
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (
  process.argv[1] &&
  canonicalPath(fileURLToPath(import.meta.url)) ===
    canonicalPath(process.argv[1])
) {
  main().catch((err) => {
    process.stderr.write(`adlc-mcp-wrapper: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
