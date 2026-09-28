// mcp-roots-proxy-client-input.test.mjs — the Roots proxy survives non-object
// client lines, and an empty Roots list refuses binding without spawning the
// MCP server child.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { tmp } from "@adlc/core/test-kit";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, "..", "bin", "adlc-mcp-wrapper.mjs");
const BUNDLE = join(HERE, "..", "bin", "adlc-mcp-wrapper.bundle.mjs");

function adlcRepo(t) {
  const root = tmp(t, "cursor-mcp-client-input-");
  mkdirSync(join(root, ".adlc"), { recursive: true });
  writeFileSync(
    join(root, ".adlc", "tickets.json"),
    JSON.stringify({
      tickets: [{ id: "T1", title: "t", rails: [], scope: [], edges: [] }],
    }),
  );
  writeFileSync(
    join(root, ".adlc", "current-ticket.json"),
    JSON.stringify({ id: "T1" }),
  );
  return root;
}

// A fake `adlc mcp-server` that records it was spawned and answers the
// handshake and tools/list.
function writeFakeCli(root) {
  const marker = join(root, "fake-cli-spawned");
  const fakeCli = join(root, "fake-adlc-client-input.mjs");
  writeFileSync(
    fakeCli,
    `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(marker)}, "spawned");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }) + "\\n");
  }
  if (m.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id,
      result: { tools: [{ name: "adlc_gate" }] } }) + "\\n");
  }
});
`,
  );
  return { fakeCli, marker };
}

function launch(t, entry, { cwd, env }) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      ADLC_CURSOR_STATE_DIR: tmp(t, "cursor-mcp-client-input-state-"),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exit = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  t.after(() => {
    if (exit === null) child.kill("SIGKILL");
  });
  const messages = () =>
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    exited: () => exit,
    stderr: () => stderr,
    messages,
    reply: (id) => messages().find((m) => m.id === id),
    rootsRequest: () => messages().filter((m) => m.method === "roots/list").at(-1),
    raw: (line) => child.stdin.write(`${line}\n`),
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    async waitFor(predicate, timeoutMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (exit !== null) {
          throw new Error(
            `proxy exited ${JSON.stringify(exit)}\nstdout=${stdout}\nstderr=${stderr}`,
          );
        }
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`timeout\nstdout=${stdout}\nstderr=${stderr}`);
    },
    kill: () => child.kill(),
  };
}

function initialize(proxy) {
  proxy.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "client-input-test" },
    },
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

const NON_OBJECT_LINES = ["null", "42", '"text"', "[]", "true"];

for (const entry of [
  { name: "source wrapper", path: WRAPPER },
  { name: "committed bundle", path: BUNDLE },
]) {
  test(`${entry.name}: non-object lines before initialize are ignored`, async (t) => {
    const root = adlcRepo(t);
    const { fakeCli } = writeFakeCli(root);
    const proxy = launch(t, entry.path, {
      cwd: join(HERE, ".."),
      env: { ADLC_CLI_BIN: fakeCli },
    });
    for (const line of NON_OBJECT_LINES) proxy.raw(line);
    initialize(proxy);
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() => proxy.rootsRequest());
    proxy.send({
      jsonrpc: "2.0",
      id: proxy.rootsRequest().id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => proxy.reply(10));
    assert.ok(proxy.reply(1).result, "initialize must be answered");
    assert.deepEqual(proxy.reply(10).result.tools, [{ name: "adlc_gate" }]);
    proxy.kill();
  });

  test(`${entry.name}: non-object lines while roots/list is pending keep the proxy serving`, async (t) => {
    const root = adlcRepo(t);
    const { fakeCli } = writeFakeCli(root);
    const proxy = launch(t, entry.path, {
      cwd: join(HERE, ".."),
      env: { ADLC_CLI_BIN: fakeCli },
    });
    initialize(proxy);
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() => proxy.rootsRequest());
    for (const line of NON_OBJECT_LINES) proxy.raw(line);
    proxy.send({
      jsonrpc: "2.0",
      id: proxy.rootsRequest().id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => proxy.reply(10));
    assert.deepEqual(proxy.reply(10).result.tools, [{ name: "adlc_gate" }]);
    proxy.kill();
  });

  test(`${entry.name}: an empty Roots list refuses binding and never spawns the server`, async (t) => {
    const root = adlcRepo(t);
    const { fakeCli, marker } = writeFakeCli(root);
    // Every ambient source of a workspace points at an ADLC-bearing repo, so a
    // fallback from the empty list to cwd or the environment would bind it.
    const proxy = launch(t, entry.path, {
      cwd: root,
      env: { ADLC_CLI_BIN: fakeCli, CURSOR_PROJECT_DIR: root },
    });
    initialize(proxy);
    proxy.send({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
    await proxy.waitFor(() => proxy.rootsRequest());
    proxy.send({
      jsonrpc: "2.0",
      id: proxy.rootsRequest().id,
      result: { roots: [] },
    });
    await proxy.waitFor(() => proxy.reply(20));
    const reply = proxy.reply(20);
    assert.equal(reply.result, undefined, "no tools may be served");
    assert.match(reply.error.message, /^UNRESOLVED:/);
    assert.match(proxy.stderr(), /UNRESOLVED/);
    assert.equal(existsSync(marker), false, "the MCP server must not be spawned");
    proxy.kill();
  });
}
