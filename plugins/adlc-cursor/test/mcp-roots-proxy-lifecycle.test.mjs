// mcp-roots-proxy-lifecycle.test.mjs — T65: initialize ordering, queue draining,
// rebind isolation, Roots-only resolution, and child teardown.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runRootsProxy } from "../lib/mcp-roots-proxy.mjs";
import { retireChildProcess } from "../lib/mcp-proxy-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, "..", "bin", "adlc-mcp-wrapper.mjs");

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

async function waitForProcessExit(pid, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} remained alive after ${timeoutMs}ms`);
}

// Every subprocess launch gets its own state dir; remove them all once the
// file finishes so repeated runs do not accumulate empty dirs under tmpdir().
const stateDirs = new Set();
after(() => {
  for (const dir of stateDirs) cleanup(dir);
});

function stateDir() {
  const dir = tmp("adlc-mcp-state-");
  stateDirs.add(dir);
  return dir;
}

function adlcRepo() {
  const root = tmp("adlc-mcp-lifecycle-");
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

function writeFakeCli(
  root,
  {
    ignoreSigterm = false,
    initialize = "success",
    pidFile = null,
    sigtermFile = null,
  } = {},
) {
  const fakeCli = join(root, "fake-adlc-lifecycle.mjs");
  const pidTmp = pidFile ? `${pidFile}.writing` : null;
  writeFileSync(
    fakeCli,
    `import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
${pidFile ? `writeFileSync(${JSON.stringify(pidTmp)}, String(process.pid));\nrenameSync(${JSON.stringify(pidTmp)}, ${JSON.stringify(pidFile)});` : ""}
${ignoreSigterm ? `process.on("SIGTERM", () => { ${sigtermFile ? `writeFileSync(${JSON.stringify(sigtermFile)}, "received");` : ""} });` : ""}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
${
  initialize === "success"
    ? `
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } },
    }) + "\\n");
`
    : initialize === "error"
      ? `
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id,
      error: { code: -32603, message: "injected child initialize failure" },
    }) + "\\n");
`
      : ""
}
  }
  if (m.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id,
      result: { tools: [{ name: "adlc_gate" }, { name: "adlc_prosecute" }] },
    }) + "\\n");
  }
});
`,
  );
  return fakeCli;
}

function launch(env) {
  return spawn(process.execPath, [WRAPPER], {
    cwd: join(HERE, ".."),
    env: {
      ...process.env,
      ADLC_CURSOR_STATE_DIR: stateDir(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const parsed = () =>
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    messages: parsed,
    reply: (id) => parsed().find((m) => m.id === id),
    wait: (ms = 50) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(predicate, timeoutMs = 2000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate(stdout, stderr)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(
        `timeout waiting for proxy output\nstdout=${stdout}\nstderr=${stderr}`,
      );
    },
  };
}

// The fake CLI publishes its pid by atomic rename, so the file is either absent
// or complete. Parse defensively anyway: Number("") is 0, and process.kill(0, 0)
// probes this process GROUP instead of reporting ESRCH — which would turn a
// child that outlived the wrapper into a passing assertion.
function readChildPid(pidFile) {
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(
    Number.isInteger(pid) && pid > 0,
    `child pid file must hold a real pid, got ${JSON.stringify(pid)}`,
  );
  return pid;
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendInitialize(child, { initialized = false } = {}) {
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "lifecycle-test" },
    },
  });
  if (initialized) {
    send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }
}

function latestRootsRequest(out) {
  return out
    .messages()
    .filter((m) => m.method === "roots/list")
    .at(-1);
}

function launchInProcess({ spawnImpl, ...opts }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    stdout += chunk;
  });
  const messages = () =>
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    input,
    messages,
    running: runRootsProxy({ input, output, spawnImpl, ...opts }),
    send: (message) => input.write(`${JSON.stringify(message)}\n`),
    async waitFor(predicate, timeoutMs = 500) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timeout waiting for proxy output: ${stdout}`);
    },
  };
}

function fakeChild({ ignoreSigterm = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (signal === "SIGTERM" && ignoreSigterm) return true;
    child.exitCode = 0;
    child.signalCode = signal;
    child.emit("exit", 0, signal);
    return true;
  };
  return child;
}

test("SIGKILL retirement waits for the child exit event before resolving", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const timers = new Set();
  let settled = false;
  const retired = retireChildProcess(child, null, timers, 1).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    settled,
    false,
    "SIGKILL delivery does not prove the child has exited",
  );

  child.exitCode = 0;
  child.emit("exit", 0, "SIGKILL");
  await retired;
  assert.equal(timers.size, 0);
});

test("SIGKILL retirement is bounded when the child never reports exit", async () => {
  // A child stuck in uninterruptible I/O accepts SIGKILL but emits no exit
  // until the kernel lets it go. Rebind and shutdown must not wait forever:
  // a killed process never runs user code again, so continuing is safe.
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const timers = new Set();
  const retired = retireChildProcess(child, null, timers, 1, 10);

  await Promise.race([
    retired,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("retirement never resolved")), 500),
    ),
  ]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(timers.size, 0, "both retirement timers must be released");
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

function responsiveFakeChild(received) {
  const child = fakeChild();
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.trim().split("\n")) {
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      received.push(message);
      if (message.method === "initialize") {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })}\n`,
        );
      }
      if (message.method === "tools/list") {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n`,
        );
      }
    }
  });
  return child;
}

test("custom-stream runs do not attach global signal listeners", async () => {
  const before = [
    process.listenerCount("SIGTERM"),
    process.listenerCount("SIGINT"),
  ];
  const input = new PassThrough();
  const running = runRootsProxy({ input, output: new PassThrough() });
  assert.deepEqual(
    [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")],
    before,
  );
  input.end();
  await running;
  assert.deepEqual(
    [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")],
    before,
  );
});

test("initialize ordering: roots/list waits for initialized, early tools queue", async () => {
  const root = adlcRepo();
  const child = launch({ ADLC_CLI_BIN: writeFakeCli(root) });
  const out = collect(child);
  try {
    sendInitialize(child);
    send(child, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await out.waitFor((s) => s.includes('"id":1'));
    assert.ok(out.reply(1).result, "initialize must be answered");
    assert.equal(
      latestRootsRequest(out),
      undefined,
      "roots/list must not precede initialized",
    );
    assert.equal(
      out.reply(10),
      undefined,
      "early tools/list must queue, not fail",
    );

    send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: root }] },
    });
    await out.waitFor((s) => s.includes('"id":10') && s.includes("adlc_gate"));
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("pre-initialized wait expires queued Roots-capable client calls", async () => {
  const proxy = launchInProcess({
    preInitializedTimeoutMs: 20,
    spawnImpl: () => fakeChild(),
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });

    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    const timedOut = proxy.messages().find((message) => message.id === 10);
    assert.match(
      timedOut.error.message,
      /did not send notifications\/initialized within 20ms/,
    );
    assert.equal(
      proxy.messages().some((message) => message.method === "roots/list"),
      false,
      "MCP forbids roots/list before notifications/initialized",
    );

    proxy.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 11),
    );
    assert.match(
      proxy.messages().find((message) => message.id === 11).error.message,
      /did not send notifications\/initialized within 20ms/,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
  }
});

test("pre-initialized wait expires queued Roots-incapable client calls", async () => {
  const proxy = launchInProcess({
    preInitializedTimeoutMs: 20,
    spawnImpl: () => fakeChild(),
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });

    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    const timedOut = proxy.messages().find((message) => message.id === 10);
    assert.match(
      timedOut.error.message,
      /did not send notifications\/initialized within 20ms/,
    );

    proxy.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 11),
    );
    assert.match(
      proxy.messages().find((message) => message.id === 11).error.message,
      /did not send notifications\/initialized within 20ms/,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
  }
});

test("roots/list JSON-RPC error drains every queued tool request", async () => {
  const root = adlcRepo();
  const child = launch({ ADLC_CLI_BIN: writeFakeCli(root) });
  const out = collect(child);
  try {
    sendInitialize(child);
    send(child, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    send(child, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "adlc_gate" },
    });
    send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      error: { code: -32603, message: "Cursor Roots failed" },
    });
    await out.waitFor((s) => s.includes('"id":11') && s.includes('"id":12'));
    for (const id of [11, 12]) {
      assert.equal(out.reply(id).error.code, -32603);
      assert.match(out.reply(id).error.message, /roots\/list failed/);
    }
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("a synchronous child-spawn failure fails queued client calls", async () => {
  const root = adlcRepo();
  const proxy = launchInProcess({
    spawnImpl: () => {
      throw new Error("injected spawn failure");
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    const reply = proxy.messages().find((message) => message.id === 10);
    assert.match(
      reply.error.message,
      /failed to spawn: injected spawn failure/,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("child exit waits for buffered stdout before failing in-flight calls", async () => {
  const root = adlcRepo();
  let child;
  const received = [];
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line);
          received.push(message);
          if (message.method === "initialize") {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { capabilities: {} },
              }) + "\n",
            );
          }
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      received.some((message) => message.method === "initialize"),
    );

    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      received.some((message) => message.method === "tools/list"),
    );
    proxy.send({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      received.filter((message) => message.method === "tools/list").length === 2,
    );
    const forwardedRequest = received.find(
      (message) => message.method === "tools/list",
    );
    child.stdin.end();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    proxy.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 11),
    );
    assert.match(
      proxy.messages().find((message) => message.id === 11).error.message,
      /not bound to a consumer root/,
    );
    child.stdin.emit("error", new Error("late fixture stdin error"));
    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwardedRequest.id,
        result: { tools: [{ name: "adlc_gate" }] },
      }) + "\n",
    );
    child.stdout.end();
    child.emit("close", 0, null);

    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10) &&
      proxy.messages().some((message) => message.id === 12),
    );
    assert.deepEqual(
      proxy.messages().filter((message) => message.id === 10),
      [
        {
          jsonrpc: "2.0",
          id: 10,
          result: { tools: [{ name: "adlc_gate" }] },
        },
      ],
    );
    assert.match(
      proxy.messages().find((message) => message.id === 12).error.message,
      /child failed.*late fixture stdin error/,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("child stdin errors fail in-flight calls without leaving the child bound", async () => {
  const root = adlcRepo();
  let child;
  const received = [];
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (!line) {
            continue;
          }
          const message = JSON.parse(line);
          received.push(message);
          if (message.method === "initialize") {
            child.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { capabilities: {} },
              }) + "\n",
            );
          }
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      received.some((message) => message.method === "initialize"),
    );

    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      received.some((message) => message.method === "tools/list"),
    );
    child.stdin.emit("error", new Error("fixture stdin closed"));

    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    assert.match(
      proxy.messages().find((message) => message.id === 10).error.message,
      /child stdin failed: fixture stdin closed/,
    );

    proxy.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 11),
    );
    assert.match(
      proxy.messages().find((message) => message.id === 11).error.message,
      /not bound to a consumer root/,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("child handshake queues colliding client ids until private initialization completes", async () => {
  const root = adlcRepo();
  let child;
  const received = [];
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (line) received.push(JSON.parse(line));
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => received.length === 1);
    const privateId = received[0].id;
    const clientIds = ["__adlc_child_user_request", privateId];

    for (const id of clientIds) {
      proxy.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    }
    assert.equal(
      received.length,
      1,
      "client calls must queue until the child handshake replies",
    );

    child.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: privateId,
        result: { capabilities: {} },
      }) + "\n",
    );
    await proxy.waitFor(
      () =>
        received.filter((message) => message.method === "tools/list").length ===
        2,
    );
    assert.deepEqual(
      received
        .filter((message) => message.method === "tools/list")
        .map((message) => message.id),
      ["__adlc_proxy_to_child_1", "__adlc_proxy_to_child_2"],
    );

    for (const id of received
      .filter((message) => message.method === "tools/list")
      .map((message) => message.id)) {
      child.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: [{ name: "adlc_gate" }] },
        }) + "\n",
      );
    }
    await proxy.waitFor(() =>
      clientIds.every((id) =>
        proxy.messages().some((message) => message.id === id),
      ),
    );
    for (const id of clientIds) {
      assert.deepEqual(
        proxy.messages().filter((message) => message.id === id),
        [
          {
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "adlc_gate" }] },
          },
        ],
      );
    }
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("test-only host-env fallback requires direct proxy injection", async () => {
  const root = adlcRepo();
  const received = [];
  const proxy = launchInProcess({
    allowHostEnvFallback: true,
    env: { ADLC_CLI_BIN: "/test/fake-adlc.mjs", ADLC_CURSOR_MCP_ROOT: root },
    spawnImpl: () => {
      const child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (!line) {
            continue;
          }
          const message = JSON.parse(line);
          received.push(message);
          if (message.method === "initialize") {
            child.stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })}\n`,
            );
          }
          if (message.method === "tools/list") {
            child.stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })}\n`,
            );
          }
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      received.some((message) => message.method === "tools/list"),
    );
    assert.deepEqual(
      proxy.messages().filter((message) => message.id === 10),
      [{ jsonrpc: "2.0", id: 10, result: { tools: [] } }],
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("child handshake timeout fails queued calls and never forwards a late reply", async () => {
  const root = adlcRepo();
  let child;
  const received = [];
  const proxy = launchInProcess({
    childHandshakeTimeoutMs: 20,
    childRetirementTimeoutMs: 20,
    env: { ADLC_CLI_BIN: "/test/fake-adlc.mjs" },
    spawnImpl: () => {
      child = fakeChild({ ignoreSigterm: true });
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (line) {
            received.push(JSON.parse(line));
          }
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => received.length === 1);
    const privateId = received[0].id;

    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    assert.deepEqual(
      proxy.messages().filter((message) => message.id === 10),
      [
        {
          jsonrpc: "2.0",
          id: 10,
          error: {
            code: -32001,
            message: "ADLC MCP child initialization timed out after 20ms",
          },
        },
      ],
    );
    assert.equal(
      received.length,
      1,
      "queued request must not reach silent child",
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: privateId, result: { capabilities: {} } })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      received.some(
        (message) => message.method === "notifications/initialized",
      ),
      false,
      "late handshake must not bind the retired child",
    );
    assert.deepEqual(
      proxy.messages().filter((message) => message.id === 10),
      [
        {
          jsonrpc: "2.0",
          id: 10,
          error: {
            code: -32001,
            message: "ADLC MCP child initialization timed out after 20ms",
          },
        },
      ],
      "late child traffic must not produce a second client response",
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("roots/list response timeout fails queued calls without leaving them queued", async () => {
  const proxy = launchInProcess({
    rootsResponseTimeoutMs: 20,
    spawnImpl: () => fakeChild(),
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 11),
    );
    const timedOut = proxy.messages().find((message) => message.id === 11);
    assert.match(timedOut.error.message, /roots\/list timed out after 20ms/);

    proxy.send({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 12),
    );
    const rejected = proxy.messages().find((message) => message.id === 12);
    assert.match(rejected.error.message, /not bound/);
  } finally {
    proxy.input.end();
    await proxy.running;
  }
});

test("a Roots-incapable client ignores list_changed without leaving calls binding", async () => {
  let spawnCount = 0;
  const proxy = launchInProcess({
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    proxy.send({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 13),
    );
    const reply = proxy.messages().find((message) => message.id === 13);
    assert.match(reply.error.message, /not bound/);
    assert.equal(spawnCount, 0);
  } finally {
    proxy.input.end();
    await proxy.running;
  }
});

test("list_changed fails queued and in-flight requests, ignoring stale Roots replies", async () => {
  const root = adlcRepo();
  const child = launch({ ADLC_CLI_BIN: writeFakeCli(root) });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    await out.waitFor((s) => s.includes("roots/list"));
    const firstRoots = latestRootsRequest(out);
    send(child, { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
    send(child, {
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await out.waitFor((s) => s.includes('"id":20'));
    const secondRoots = latestRootsRequest(out);
    assert.notEqual(
      secondRoots.id,
      firstRoots.id,
      "rebind must use a fresh request id",
    );
    assert.match(out.reply(20).error.message, /roots changed/);

    // A late answer to the retired request must not bind.
    send(child, {
      jsonrpc: "2.0",
      id: firstRoots.id,
      result: { roots: [{ uri: root }] },
    });
    send(child, { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} });
    await out.wait(75);
    assert.equal(out.reply(22), undefined, "stale Roots reply must not bind");

    send(child, {
      jsonrpc: "2.0",
      id: secondRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await out.waitFor((s) => s.includes('"id":22') && s.includes("adlc_gate"));

    send(child, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "adlc_gate" },
    });
    send(child, {
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await out.waitFor((s) => s.includes('"id":21'));
    assert.match(out.reply(21).error.message, /roots changed/);
    assert.equal(
      out.messages().filter((m) => m.id === 22).length,
      1,
      "a completed child request must leave in-flight tracking",
    );
    assert.notEqual(latestRootsRequest(out).id, secondRoots.id);
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("a malformed Root beside a valid Root refuses binding", async () => {
  const ambient = adlcRepo();
  const child = launch({
    ADLC_CLI_BIN: writeFakeCli(ambient),
    CURSOR_PROJECT_DIR: ambient,
  });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    send(child, { jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: ambient }, { uri: "relative/path" }] },
    });
    await out.waitFor((s) => s.includes('"id":30'));
    assert.match(out.reply(30).error.message, /INVALID_ROOTS/);
  } finally {
    child.kill();
    cleanup(ambient);
  }
});

test("rapid Roots rebind notifications never overlap child processes", async () => {
  const root = adlcRepo();
  const spawnStates = [];
  const liveChildren = new Set();
  let spawnCount = 0;
  const proxy = launchInProcess({
    childRetirementTimeoutMs: 20,
    spawnImpl: () => {
      const child = fakeChild({ ignoreSigterm: spawnCount === 0 });
      spawnStates.push(liveChildren.size);
      spawnCount += 1;
      liveChildren.add(child);
      child.once("exit", () => liveChildren.delete(child));
      return child;
    },
  });
  const rootsRequests = () =>
    proxy.messages().filter((message) => message.method === "roots/list");
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 1);
    proxy.send({
      jsonrpc: "2.0",
      id: rootsRequests()[0].id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => spawnCount === 1);

    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 2);
    proxy.send({
      jsonrpc: "2.0",
      id: rootsRequests()[1].id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() => spawnCount === 2);

    assert.equal(
      spawnStates[1],
      0,
      "successor must spawn only after the first child exits",
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("a real Root is not made ambiguous by an ambient CURSOR_PROJECT_DIR", async () => {
  const rootA = adlcRepo();
  const rootB = adlcRepo();
  const child = launch({
    ADLC_CLI_BIN: writeFakeCli(rootA),
    CURSOR_PROJECT_DIR: rootB,
  });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    send(child, { jsonrpc: "2.0", id: 31, method: "tools/list", params: {} });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: rootA }] },
    });
    await out.waitFor(
      (s) => s.includes('"id":31') && s.includes("adlc_prosecute"),
    );
  } finally {
    child.kill();
    cleanup(rootA);
    cleanup(rootB);
  }
});

test("a client id with the child handshake prefix receives its tool reply", async () => {
  const root = adlcRepo();
  const child = launch({ ADLC_CLI_BIN: writeFakeCli(root) });
  const out = collect(child);
  const requestId = "__adlc_child_user_request";
  try {
    sendInitialize(child, { initialized: true });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: root }] },
    });
    send(child, {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/list",
      params: {},
    });
    await out.waitFor(
      (s) => s.includes(`"id":"${requestId}"`) && s.includes("adlc_gate"),
    );
    assert.ok(
      out.reply(requestId)?.result?.tools,
      "the client response must not be mistaken for a child handshake",
    );
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("a child request id beginning with the Roots prefix receives its response once", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const requestId = "__adlc_roots_list_child_ping";
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = responsiveFakeChild(childMessages);
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy
        .messages()
        .some(
          (message) => message.id !== requestId && message.method === "ping",
        ),
    );
    const forwardedRequest = proxy
      .messages()
      .find((message) => message.method === "ping");
    proxy.send({
      jsonrpc: "2.0",
      id: forwardedRequest.id,
      result: { pong: true },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.id === requestId && message.result?.pong,
      ),
    );

    assert.equal(
      childMessages.filter(
        (message) => message.id === requestId && message.result?.pong,
      ).length,
      1,
    );
    assert.equal(
      proxy.messages().filter((message) => message.id === forwardedRequest.id)
        .length,
      1,
      "the client response is forwarded to the child, never swallowed or answered",
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("a child request reusing a completed Roots id is remapped and restored", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = responsiveFakeChild(childMessages);
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    const completedRoots = latestRootsRequest({ messages: proxy.messages });
    proxy.send({
      jsonrpc: "2.0",
      id: completedRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: completedRoots.id, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy
        .messages()
        .some(
          (message) =>
            message.method === "ping" && message.id !== completedRoots.id,
        ),
    );
    const resultRequest = proxy
      .messages()
      .find((message) => message.method === "ping");
    assert.notEqual(resultRequest.id, completedRoots.id);
    proxy.send({
      jsonrpc: "2.0",
      id: resultRequest.id,
      result: { pong: true },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) =>
          message.id === completedRoots.id && message.result?.pong === true,
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: completedRoots.id, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(
      () =>
        proxy.messages().filter((message) => message.method === "ping")
          .length === 2,
    );
    const errorRequest = proxy
      .messages()
      .filter((message) => message.method === "ping")
      .at(-1);
    assert.notEqual(errorRequest.id, completedRoots.id);
    assert.notEqual(errorRequest.id, resultRequest.id);
    proxy.send({
      jsonrpc: "2.0",
      id: errorRequest.id,
      error: { code: -32603, message: "injected error" },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) =>
          message.id === completedRoots.id &&
          message.error?.message === "injected error",
      ),
    );
    assert.equal(
      childMessages.filter(
        (message) => message.id === completedRoots.id && message.result?.pong,
      ).length,
      1,
    );
    assert.equal(
      childMessages.filter(
        (message) =>
          message.id === completedRoots.id &&
          message.error?.message === "injected error",
      ).length,
      1,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("rebind clears remapped child requests before binding a successor", async () => {
  const root = adlcRepo();
  const children = [];
  const receivedByChild = [];
  const proxy = launchInProcess({
    spawnImpl: () => {
      const received = [];
      receivedByChild.push(received);
      const child = responsiveFakeChild(received);
      children.push(child);
      return child;
    },
  });
  const rootsRequests = () =>
    proxy.messages().filter((message) => message.method === "roots/list");
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 1);
    const firstRoots = rootsRequests()[0];
    proxy.send({
      jsonrpc: "2.0",
      id: firstRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[0]?.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    children[0].stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: firstRoots.id, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy
        .messages()
        .some(
          (message) =>
            message.method === "ping" && message.id !== firstRoots.id,
        ),
    );
    const retiredRequest = proxy
      .messages()
      .find((message) => message.method === "ping");

    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 2);
    proxy.send({
      jsonrpc: "2.0",
      id: retiredRequest.id,
      result: { pong: true },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      receivedByChild[0].some(
        (message) => message.id === firstRoots.id && message.result?.pong,
      ),
      false,
      "a response for a retired mapping must not reach its retired child",
    );

    const secondRoots = rootsRequests()[1];
    proxy.send({
      jsonrpc: "2.0",
      id: secondRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[1]?.some(
        (message) => message.method === "notifications/initialized",
      ),
    );
    const successorMessageCount = receivedByChild[1].length;
    proxy.send({
      jsonrpc: "2.0",
      id: firstRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      receivedByChild[1].length,
      successorMessageCount,
      "a stale Roots response must not bind or reach the successor",
    );

    children[1].stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: firstRoots.id, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(
      () =>
        proxy.messages().filter((message) => message.method === "ping")
          .length === 2,
    );
    const successorRequest = proxy
      .messages()
      .filter((message) => message.method === "ping")
      .at(-1);
    assert.notEqual(successorRequest.id, firstRoots.id);
    assert.notEqual(successorRequest.id, retiredRequest.id);
    proxy.send({
      jsonrpc: "2.0",
      id: successorRequest.id,
      result: { pong: "successor" },
    });
    await proxy.waitFor(() =>
      receivedByChild[1].some(
        (message) =>
          message.id === firstRoots.id && message.result?.pong === "successor",
      ),
    );
    assert.equal(
      receivedByChild[1].filter(
        (message) =>
          message.id === firstRoots.id && message.result?.pong === "successor",
      ).length,
      1,
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("rebind drops retired child responses and stale Roots replies without disturbing the successor", async () => {
  const root = adlcRepo();
  const children = [];
  const receivedByChild = [];
  const requestId = "__adlc_roots_list_child_ping";
  const proxy = launchInProcess({
    spawnImpl: () => {
      const received = [];
      receivedByChild.push(received);
      const child = responsiveFakeChild(received);
      children.push(child);
      return child;
    },
  });
  const rootsRequests = () =>
    proxy.messages().filter((message) => message.method === "roots/list");
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 1);
    const firstRoots = rootsRequests()[0];
    proxy.send({
      jsonrpc: "2.0",
      id: firstRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[0]?.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    children[0].stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "ping", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy
        .messages()
        .some(
          (message) => message.id !== requestId && message.method === "ping",
        ),
    );
    const forwardedRequest = proxy
      .messages()
      .find((message) => message.method === "ping");
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 2);
    const secondRoots = rootsRequests()[1];

    proxy.send({
      jsonrpc: "2.0",
      id: forwardedRequest.id,
      result: { pong: true },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      proxy.messages().filter((message) => message.id === forwardedRequest.id)
        .length,
      1,
      "a response to a retired child request must not receive a synthetic error",
    );

    proxy.send({
      jsonrpc: "2.0",
      id: secondRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[1]?.some(
        (message) => message.method === "notifications/initialized",
      ),
    );
    const successorMessageCount = receivedByChild[1].length;
    proxy.send({
      jsonrpc: "2.0",
      id: firstRoots.id,
      result: { roots: [{ uri: root }] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2, "a stale Roots reply must not rebind");
    assert.equal(
      receivedByChild[1].length,
      successorMessageCount,
      "a stale Roots reply must not reach the successor",
    );

    proxy.send({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 99 && message.result),
    );
    assert.deepEqual(
      proxy.messages().filter((message) => message.id === 99),
      [{ jsonrpc: "2.0", id: 99, result: { tools: [] } }],
    );
    assert.equal(
      receivedByChild[1].some(
        (message) => message.id === requestId && message.result?.pong,
      ),
      false,
      "the successor must not receive the retired child's response",
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("a live silent child times out queued calls without overlap or orphaning", async () => {
  const root = adlcRepo();
  let childExit;
  // Take the pid from the spawned process, not from a file the child writes:
  // the proxy retires it 50ms + 20ms after spawn, and under CI load node
  // startup can outlast that, so a pid file may never appear.
  let childPid;
  let spawnCount = 0;
  const proxy = launchInProcess({
    childHandshakeTimeoutMs: 50,
    childRetirementTimeoutMs: 20,
    env: {
      ...process.env,
      ADLC_CLI_BIN: writeFakeCli(root, {
        initialize: "silent",
        ignoreSigterm: true,
      }),
    },
    spawnImpl: (...args) => {
      spawnCount += 1;
      const child = spawn(...args);
      childPid = child.pid;
      childExit = once(child, "exit");
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.id === 10),
    );
    assert.equal(Number.isInteger(childPid), true, "the child must have spawned");
    const timedOut = proxy.messages().find((message) => message.id === 10);
    assert.equal(timedOut.error.code, -32001);
    assert.match(timedOut.error.message, /initialization timed out after 50ms/);
    await childExit;
    assert.equal(
      spawnCount,
      1,
      "a timed-out child must not overlap a successor",
    );
    await waitForProcessExit(childPid);
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("child initialize error uses bounded retirement before wrapper shutdown", async () => {
  const root = adlcRepo();
  const pidFile = join(root, "error-child.pid");
  const sigtermFile = join(root, "error-child-sigterm");
  const child = launch({
    ADLC_CLI_BIN: writeFakeCli(root, {
      initialize: "error",
      ignoreSigterm: true,
      pidFile,
      sigtermFile,
    }),
  });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    send(child, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    await out.waitFor((stdout) => stdout.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: root }] },
    });
    await out.waitFor(
      (stdout, stderr) =>
        stdout.includes('"id":10') &&
        stderr.includes("injected child initialize failure") &&
        existsSync(pidFile),
    );
    const childPid = readChildPid(pidFile);
    assert.equal(out.reply(10).error.code, -32603);
    assert.match(out.reply(10).error.message, /initialization failed/);

    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("wrapper did not exit")), 2000),
      ),
    ]);
    assert.equal(
      existsSync(sigtermFile),
      true,
      "retirement must signal the child",
    );
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    cleanup(root);
  }
});

test("SIGTERM retires a SIGTERM-ignoring child through the SIGKILL fallback", async () => {
  const root = adlcRepo();
  const pidFile = join(root, "child.pid");
  const child = launch({
    ADLC_CLI_BIN: writeFakeCli(root, { ignoreSigterm: true, pidFile }),
  });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: root }] },
    });
    await out.waitFor(() => existsSync(pidFile));
    const serverPid = readChildPid(pidFile);

    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("wrapper did not exit")), 2000),
      ),
    ]);
    assert.throws(
      () => process.kill(serverPid, 0),
      { code: "ESRCH" },
      "the child mcp-server must not outlive the wrapper",
    );
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    cleanup(root);
  }
});

test("SIGTERM during serialized rebind waits for a SIGTERM-ignoring child to die", async () => {
  const root = adlcRepo();
  const pidFile = join(root, "child.pid");
  const retirementStarted = join(root, "child-sigterm");
  const child = launch({
    ADLC_CLI_BIN: writeFakeCli(root, {
      ignoreSigterm: true,
      pidFile,
      sigtermFile: retirementStarted,
    }),
  });
  const out = collect(child);
  try {
    sendInitialize(child, { initialized: true });
    await out.waitFor((s) => s.includes("roots/list"));
    send(child, {
      jsonrpc: "2.0",
      id: latestRootsRequest(out).id,
      result: { roots: [{ uri: root }] },
    });
    await out.waitFor(() => existsSync(pidFile));
    const serverPid = readChildPid(pidFile);

    send(child, {
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await out.waitFor(() => existsSync(retirementStarted));
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("wrapper did not exit")), 2000),
      ),
    ]);
    assert.throws(
      () => process.kill(serverPid, 0),
      { code: "ESRCH" },
      "the retiring child mcp-server must not outlive the wrapper",
    );
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    cleanup(root);
  }
});

test("bidirectional requests with the same id are translated independently", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = responsiveFakeChild(childMessages);
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    proxy.send({
      jsonrpc: "2.0",
      id: "same",
      method: "tools/call",
      params: {},
    });
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "same", method: "client/ping", params: {} })}\n`,
    );
    await proxy.waitFor(
      () =>
        childMessages.some((message) => message.method === "tools/call") &&
        proxy.messages().some((message) => message.method === "client/ping"),
    );

    const clientRequest = childMessages.find(
      (message) => message.method === "tools/call",
    );
    const childRequest = proxy
      .messages()
      .find((message) => message.method === "client/ping");
    assert.notEqual(clientRequest.id, "same");
    assert.notEqual(childRequest.id, "same");
    assert.notEqual(clientRequest.id, childRequest.id);

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: clientRequest.id, error: { code: -32603, message: "child error" } })}\n`,
    );
    proxy.send({
      jsonrpc: "2.0",
      id: childRequest.id,
      result: { pong: true },
    });
    await proxy.waitFor(
      () =>
        proxy
          .messages()
          .some(
            (message) =>
              message.id === "same" && message.error?.message === "child error",
          ) &&
        childMessages.some(
          (message) => message.id === "same" && message.result?.pong,
        ),
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("distinct child requests cannot cross-talk when a proxy-looking id collides", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = responsiveFakeChild(childMessages);
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "__adlc_child_request_1_1", method: "alpha", params: {} })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "__adlc_proxy_to_client_1", method: "beta", params: {} })}\n`,
    );
    await proxy.waitFor(
      () =>
        proxy.messages().filter((message) => message.method === "alpha")
          .length === 1 &&
        proxy.messages().filter((message) => message.method === "beta")
          .length === 1,
    );

    const alpha = proxy
      .messages()
      .find((message) => message.method === "alpha");
    const beta = proxy.messages().find((message) => message.method === "beta");
    assert.notEqual(alpha.id, beta.id);
    proxy.send({ jsonrpc: "2.0", id: alpha.id, result: { reply: "alpha" } });
    proxy.send({ jsonrpc: "2.0", id: beta.id, result: { reply: "beta" } });
    await proxy.waitFor(
      () =>
        childMessages.some(
          (message) =>
            message.id === "__adlc_child_request_1_1" &&
            message.result?.reply === "alpha",
        ) &&
        childMessages.some(
          (message) =>
            message.id === "__adlc_proxy_to_client_1" &&
            message.result?.reply === "beta",
        ),
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("a future Roots-looking child id cannot consume a rebind response", async () => {
  const root = adlcRepo();
  const children = [];
  const receivedByChild = [];
  const proxy = launchInProcess({
    spawnImpl: () => {
      const received = [];
      receivedByChild.push(received);
      const child = responsiveFakeChild(received);
      children.push(child);
      return child;
    },
  });
  const rootsRequests = () =>
    proxy.messages().filter((message) => message.method === "roots/list");
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 1);
    proxy.send({
      jsonrpc: "2.0",
      id: rootsRequests()[0].id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[0].some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    const futureRootsId = "__adlc_roots_list_2_2";
    children[0].stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: futureRootsId, method: "child/ping", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.method === "child/ping"),
    );
    const remappedRequest = proxy
      .messages()
      .find((message) => message.method === "child/ping");
    assert.notEqual(remappedRequest.id, futureRootsId);

    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
      params: {},
    });
    await proxy.waitFor(() => rootsRequests().length === 2);
    assert.equal(rootsRequests()[1].id, futureRootsId);
    proxy.send({
      jsonrpc: "2.0",
      id: remappedRequest.id,
      result: { delayed: true },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      children.length,
      1,
      "a response to a retired mapping must not bind a successor",
    );

    proxy.send({
      jsonrpc: "2.0",
      id: futureRootsId,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      receivedByChild[1]?.some(
        (message) => message.method === "notifications/initialized",
      ),
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("duplicate responses after a completed mapping are dropped", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = responsiveFakeChild(childMessages);
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "first", method: "child/first", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.method === "child/first"),
    );
    const first = proxy
      .messages()
      .find((message) => message.method === "child/first");
    proxy.send({ jsonrpc: "2.0", id: first.id, result: { reply: "first" } });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) =>
          message.id === "first" && message.result?.reply === "first",
      ),
    );

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "second", method: "child/second", params: {} })}\n`,
    );
    await proxy.waitFor(() =>
      proxy.messages().some((message) => message.method === "child/second"),
    );
    const second = proxy
      .messages()
      .find((message) => message.method === "child/second");
    proxy.send({ jsonrpc: "2.0", id: first.id, result: { stale: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      childMessages.some(
        (message) => message.id === "second" && message.result?.stale,
      ),
      false,
    );

    proxy.send({ jsonrpc: "2.0", id: second.id, result: { reply: "second" } });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) =>
          message.id === "second" && message.result?.reply === "second",
      ),
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});

test("a request using an active child-facing proxy id is translated as a request", async () => {
  const root = adlcRepo();
  const childMessages = [];
  let child;
  const proxy = launchInProcess({
    spawnImpl: () => {
      child = fakeChild();
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.trim().split("\n")) {
          if (!line) {
            continue;
          }
          const message = JSON.parse(line);
          childMessages.push(message);
          if (message.method === "initialize") {
            child.stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } })}\n`,
            );
          }
        }
      });
      return child;
    },
  });
  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: {} } },
    });
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await proxy.waitFor(() => latestRootsRequest({ messages: proxy.messages }));
    proxy.send({
      jsonrpc: "2.0",
      id: latestRootsRequest({ messages: proxy.messages }).id,
      result: { roots: [{ uri: root }] },
    });
    await proxy.waitFor(() =>
      childMessages.some(
        (message) => message.method === "notifications/initialized",
      ),
    );

    proxy.send({
      jsonrpc: "2.0",
      id: "original",
      method: "tools/list",
      params: {},
    });
    await proxy.waitFor(() =>
      childMessages.some((message) => message.method === "tools/list"),
    );
    const first = childMessages.find(
      (message) => message.method === "tools/list",
    );
    proxy.send({
      jsonrpc: "2.0",
      id: first.id,
      method: "tools/list",
      params: {},
    });
    await proxy.waitFor(
      () =>
        childMessages.filter((message) => message.method === "tools/list")
          .length === 2,
    );
    const second = childMessages
      .filter((message) => message.method === "tools/list")
      .at(-1);
    assert.notEqual(second.id, first.id);

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { tools: ["second"] } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { tools: ["first"] } })}\n`,
    );
    await proxy.waitFor(
      () =>
        proxy
          .messages()
          .some(
            (message) =>
              message.id === first.id &&
              message.result?.tools?.[0] === "second",
          ) &&
        proxy
          .messages()
          .some(
            (message) =>
              message.id === "original" &&
              message.result?.tools?.[0] === "first",
          ),
    );
  } finally {
    proxy.input.end();
    await proxy.running;
    cleanup(root);
  }
});
