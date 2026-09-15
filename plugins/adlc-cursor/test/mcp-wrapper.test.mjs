// mcp-wrapper.test.mjs — T65 AC7: host-env + Roots proxy (unit/subprocess).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeRootsListResult,
  fileUriToPath,
  pathsFromRootsListResult,
  rootUriToPath,
} from "../lib/mcp-file-uri.mjs";
import { resolveHostEnvRoot } from "../lib/mcp-hostenv.mjs";
import {
  mcpRootFromWorkspace,
  resolveAdlcMcpSpawn,
} from "../lib/mcp-roots-proxy.mjs";
import { resolveConsumerWorkspace } from "../lib/workspace-resolve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const WRAPPER = join(HERE, "..", "bin", "adlc-mcp-wrapper.mjs");
const BUNDLED_WRAPPER = join(HERE, "..", "bin", "adlc-mcp-wrapper.bundle.mjs");
const MCP_JSON = join(HERE, "..", "mcp.json");
const REAL_CLI = join(REPO_ROOT, "packages", "cli", "bin", "adlc.mjs");

// Cursor documents substitution in command/args/env/cwd. This helper validates
// the post-substitution launch contract; it does not prove an installed Cursor
// build performs the substitution.
function substituteCursorPluginRoot(server, pluginRoot) {
  const substitute = (value) =>
    typeof value === "string"
      ? value.replaceAll("${CURSOR_PLUGIN_ROOT}", pluginRoot)
      : value;
  return {
    ...server,
    command: substitute(server.command),
    args: server.args?.map(substitute),
    cwd: substitute(server.cwd),
  };
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
const cleanup = (p) => rmSync(p, { recursive: true, force: true });

// Every wrapper launch gets its own state dir; remove them all once the file
// finishes so repeated runs do not accumulate empty dirs under tmpdir().
const stateDirs = new Set();
after(() => {
  for (const dir of stateDirs) cleanup(dir);
});

function stateDir() {
  const dir = tmp("adlc-mcp-state-");
  stateDirs.add(dir);
  return dir;
}

function adlcRepo(pointer = { id: "T1" }) {
  const root = tmp("adlc-mcp-");
  mkdirSync(join(root, ".adlc"), { recursive: true });
  writeFileSync(
    join(root, ".adlc", "tickets.json"),
    JSON.stringify({
      tickets: [{ id: "T1", title: "t", rails: [], scope: [], edges: [] }],
    }),
  );
  if (pointer)
    writeFileSync(
      join(root, ".adlc", "current-ticket.json"),
      JSON.stringify(pointer),
    );
  return root;
}

function commitFixture(root) {
  const git = (args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ADLC test"]);
  git(["add", "--all"]);
  git(["commit", "-qm", "fixture"]);
}

function writeFakeCli(root) {
  const fakeCli = join(root, "fake-adlc.mjs");
  writeFileSync(
    fakeCli,
    `import { createInterface } from "node:readline";
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
`,
  );
  return fakeCli;
}

function spawnWrapper(env, { wrapper = WRAPPER, cwd = join(HERE, "..") } = {}) {
  return spawn(process.execPath, [wrapper], {
    cwd,
    env: {
      ...process.env,
      ADLC_CURSOR_STATE_DIR: stateDir(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function attachCollector(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });
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
      throw new Error(
        `timeout waiting for MCP output.\nstdout=${stdout}\nstderr=${stderr}`,
      );
    },
  };
}

test("fileUriToPath decodes unix Roots URIs", () => {
  const root = adlcRepo();
  try {
    const decoded = fileUriToPath(pathToFileURL(root).href);
    assert.equal(decoded, root);
    assert.equal(fileUriToPath("https://example.com"), null);
  } finally {
    cleanup(root);
  }
});

test("rootUriToPath accepts bare absolute paths but rejects schemes and relatives", () => {
  const root = adlcRepo();
  try {
    assert.equal(rootUriToPath(root), root);
    assert.equal(rootUriToPath("https://example.com/repo"), null);
    assert.equal(rootUriToPath("vscode-remote://ssh-remote+host/repo"), null);
    assert.equal(rootUriToPath("relative/repo"), null);
    assert.equal(
      rootUriToPath("C:/Users/alice/repo").replaceAll("\\", "/"),
      "C:/Users/alice/repo",
    );
    assert.equal(
      rootUriToPath("C:\\Users\\alice\\repo").replaceAll("\\", "/"),
      "C:/Users/alice/repo",
    );
    assert.equal(
      rootUriToPath("/c:/Users/alice/repo").replaceAll("\\", "/").toLowerCase(),
      "c:/users/alice/repo",
    );
    assert.deepEqual(
      pathsFromRootsListResult({
        roots: [
          { uri: root },
          { uri: "https://example.com/repo" },
          { uri: "relative/repo" },
        ],
      }),
      [root],
    );
  } finally {
    cleanup(root);
  }
});

test("Roots decoder requires Root objects with supported absolute uris", () => {
  assert.deepEqual(pathsFromRootsListResult({ roots: ["/tmp/a"] }), []);
  const root = adlcRepo();
  try {
    const uri = pathToFileURL(root).href;
    assert.deepEqual(decodeRootsListResult({ roots: [{ uri }] }), {
      ok: true,
      paths: [root],
    });
    assert.deepEqual(
      decodeRootsListResult({
        roots: [{ uri: root }, { uri: "relative/repo" }],
      }),
      {
        ok: false,
        message: "Root at index 1 has an unsupported or relative uri",
      },
    );
    assert.deepEqual(
      decodeRootsListResult({
        roots: [{ uri: root }, { uri: "https://example.com/repo" }],
      }),
      {
        ok: false,
        message: "Root at index 1 has an unsupported or relative uri",
      },
    );
    assert.deepEqual(decodeRootsListResult({ roots: [{ uri: root }, {}] }), {
      ok: false,
      message: "Root at index 1 must have a uri",
    });
  } finally {
    cleanup(root);
  }
});

test("host-env: success when ADLC_CURSOR_MCP_ROOT points at ADLC repo", () => {
  const root = adlcRepo();
  try {
    const r = resolveHostEnvRoot({ ADLC_CURSOR_MCP_ROOT: root });
    assert.equal(r.ok, true);
    assert.equal(r.root, root);
  } finally {
    cleanup(root);
  }
});

test("host-env: absent env fails closed even if cwd is ADLC-bearing", () => {
  const root = adlcRepo();
  const prev = process.cwd();
  try {
    process.chdir(root);
    const r = resolveHostEnvRoot({});
    assert.equal(r.ok, false);
    assert.equal(r.code, "HOST_ENV_ABSENT");
  } finally {
    process.chdir(prev);
    cleanup(root);
  }
});

test("mcpRootFromWorkspace refuses ambiguity / unresolved", () => {
  assert.equal(
    mcpRootFromWorkspace({ outcome: "ambiguous", message: "x" }).ok,
    false,
  );
  assert.equal(mcpRootFromWorkspace({ outcome: "unresolved" }).ok, false);
  assert.equal(
    mcpRootFromWorkspace({ outcome: "active", root: "/tmp/a" }).ok,
    true,
  );
});

test("mcp.json semantically anchors the bundled Roots proxy to the plugin root", () => {
  const cfg = JSON.parse(readFileSync(MCP_JSON, "utf8"));
  const adlc = cfg.mcpServers?.adlc;
  assert.ok(adlc, "mcpServers.adlc required");
  assert.equal(adlc.command, "node");
  const bundleArg = adlc.args?.find((arg) =>
    /adlc-mcp-wrapper\.bundle\.mjs$/.test(arg),
  );
  assert.ok(
    bundleArg?.includes("${CURSOR_PLUGIN_ROOT}"),
    "bundle path must be plugin-root anchored",
  );
  assert.ok(
    adlc.cwd?.includes("${CURSOR_PLUGIN_ROOT}"),
    "cwd must be plugin-root anchored",
  );
  assert.doesNotMatch(
    JSON.stringify(adlc),
    /"command"\s*:\s*"adlc"|"mcp-server"/,
  );
});

test("bundled production wrapper has no host-environment fallback unlock", () => {
  const bundle = readFileSync(BUNDLED_WRAPPER, "utf8");
  assert.doesNotMatch(bundle, /ADLC_CURSOR_MCP_ALLOW_HOSTENV/);
});

test("resolveAdlcMcpSpawn prefers ADLC_CLI_BIN", () => {
  const r = resolveAdlcMcpSpawn({ ADLC_CLI_BIN: "/tmp/fake-adlc.mjs" });
  assert.equal(r.command, process.execPath);
  assert.deepEqual(r.args, ["/tmp/fake-adlc.mjs", "mcp-server"]);
});

test("resolveAdlcMcpSpawn runs the Windows CLI JavaScript through Node", () => {
  const entry = join(
    dirname(process.execPath),
    "node_modules",
    "@adlc",
    "cli",
    "bin",
    "adlc.mjs",
  );
  const resolved = resolveAdlcMcpSpawn({}, "win32", {
    isFile: (path) => path === entry,
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [entry, "mcp-server"]);
});

test("production wrapper refuses host-environment fallback without valid Roots", async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const child = spawnWrapper({
    ADLC_CLI_BIN: fakeCli,
    ADLC_CURSOR_MCP_ALLOW_HOSTENV: "1",
    ADLC_CURSOR_MCP_ROOT: root,
    CURSOR_PROJECT_DIR: root,
  });
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor((s) => s.includes('"id":1') && s.includes("adlc-cursor"));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor((s) => s.includes('"id":2') && s.includes("error"));
    const stdout = out.text();
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      lines.some(
        (l) => l.id === 1 && l.result?.serverInfo?.name === "adlc-cursor",
      ),
    );
    assert.match(
      lines.find((l) => l.id === 2)?.error?.message ?? "",
      /not bound/,
    );
    assert.equal(
      lines.some((l) => l.id === 2 && l.result?.tools),
      false,
      `host-controlled environment must not bind the production wrapper; got: ${stdout}`,
    );
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("Roots proxy: roots/list with one active root binds and lists tools", async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const child = spawnWrapper({ ADLC_CLI_BIN: fakeCli });
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );

    await out.waitFor((s) => s.includes("roots/list"));
    let stdout = out.text();
    const pending = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const rootsReq = pending.find((l) => l.method === "roots/list");
    assert.ok(
      rootsReq,
      `proxy must request roots/list; got ${stdout}\nerr=${out.err()}`,
    );

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rootsReq.id,
        result: { roots: [{ uri: pathToFileURL(root).href }] },
      }) + "\n",
    );

    await out.wait(50);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor(
      (s) => s.includes('"id":3') && s.includes("adlc_prosecute"),
    );
    stdout = out.text();
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      lines.some(
        (l) =>
          l.id === 3 &&
          l.result?.tools?.some((t) => t.name === "adlc_prosecute"),
      ),
    );
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("Roots proxy: Cursor bare-path root binds and lists both tools", async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const child = spawnWrapper(
    { ADLC_CLI_BIN: fakeCli },
    { wrapper: BUNDLED_WRAPPER },
  );
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "cursor-live-shape-test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor((stdout) => stdout.includes("roots/list"));
    const rootsReq = out
      .text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.method === "roots/list");
    assert.ok(rootsReq);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rootsReq.id,
        result: { roots: [{ uri: root, name: "cursor-live-root" }] },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor(
      (stdout) =>
        stdout.includes('"id":5') && stdout.includes("adlc_prosecute"),
    );
    const reply = out
      .text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.id === 5);
    assert.deepEqual(
      reply.result.tools.map((tool) => tool.name),
      ["adlc_gate", "adlc_prosecute"],
    );
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("bundled Roots proxy forwards real adlc_gate and adlc_prosecute calls in the resolved consumer root", async () => {
  const root = adlcRepo();
  const evidenceDir = join(root, ".omo", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  cpSync(
    join(REPO_ROOT, ".omo", "evidence"),
    evidenceDir,
    { recursive: true },
  );
  copyFileSync(
    join(REPO_ROOT, "docs", "examples", "p5-passes.json"),
    join(root, "passes.json"),
  );
  commitFixture(root);

  const child = spawnWrapper(
    { ADLC_CLI_BIN: REAL_CLI },
    { wrapper: BUNDLED_WRAPPER },
  );
  const out = attachCollector(child);
  const replies = () => out.text()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "real-cli-roundtrip-test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor((stdout) => stdout.includes("roots/list"));
    const rootsRequest = replies().find((message) => message.method === "roots/list");
    assert.ok(rootsRequest, `missing Roots request:\n${out.text()}`);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rootsRequest.id,
        result: { roots: [{ uri: root }] },
      }) + "\n",
    );

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor((stdout) =>
      stdout.includes('"id":2') && stdout.includes("adlc_prosecute"),
    );
    assert.deepEqual(
      replies()
        .find((message) => message.id === 2)
        .result.tools.map((tool) => tool.name),
      ["adlc_gate", "adlc_prosecute"],
    );

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "adlc_gate",
          arguments: { gate: "gate-manifest", args: ["show", "--json"] },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "adlc_prosecute",
          arguments: {
            input: "passes.json",
            ticket: "T1",
            revision: "docs-example-revision",
          },
        },
      }) + "\n",
    );
    await out.waitFor((stdout) =>
      stdout.includes('"id":3') && stdout.includes('"id":4'),
    );

    for (const id of [3, 4]) {
      const reply = replies().find((message) => message.id === id);
      assert.equal(reply.result.isError, false, JSON.stringify(reply));
      assert.equal(
        JSON.parse(reply.result.content[0].text).ok,
        true,
        JSON.stringify(reply),
      );
    }
  } finally {
    child.kill();
    cleanup(root);
  }
});

test("documented plugin-root substitution launches bundle from configured cwd without node_modules", async () => {
  const root = adlcRepo();
  const fakeCli = writeFakeCli(root);
  const stage = tmp("adlc-mcp-plugin-");
  mkdirSync(join(stage, "bin"), { recursive: true });
  copyFileSync(
    BUNDLED_WRAPPER,
    join(stage, "bin", "adlc-mcp-wrapper.bundle.mjs"),
  );
  const cfg = JSON.parse(readFileSync(MCP_JSON, "utf8"));
  const server = substituteCursorPluginRoot(cfg.mcpServers.adlc, stage);

  assert.ok(server.args.every((arg) => !arg.includes("${CURSOR_PLUGIN_ROOT}")));
  assert.ok(!server.cwd.includes("${CURSOR_PLUGIN_ROOT}"));
  const child = spawnWrapper(
    { ADLC_CLI_BIN: fakeCli },
    {
      wrapper: server.args.find((arg) =>
        /adlc-mcp-wrapper\.bundle\.mjs$/.test(arg),
      ),
      cwd: server.cwd,
    },
  );
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "post-substitution-contract-test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor((stdout) => stdout.includes("roots/list"));
    const rootsReq = out
      .text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.method === "roots/list");
    assert.ok(rootsReq);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rootsReq.id,
        result: { roots: [{ uri: pathToFileURL(root).href }] },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor(
      (stdout) => stdout.includes('"id":4') && stdout.includes("adlc_gate"),
    );
    assert.doesNotMatch(out.err(), /ERR_MODULE_NOT_FOUND|@adlc\/tickets/);
  } finally {
    child.kill();
    cleanup(root);
    cleanup(stage);
  }
});

test("bundled wrapper starts through a symlink path", async () => {
  const links = tmp("adlc-mcp-symlink-");
  const foreignCwd = tmp("adlc-mcp-symlink-cwd-");
  const linkedWrapper = join(links, "linked-wrapper.mjs");
  symlinkSync(BUNDLED_WRAPPER, linkedWrapper);
  const child = spawnWrapper({}, { wrapper: linkedWrapper, cwd: foreignCwd });
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "symlink-launch-test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor(
      (stdout) => stdout.includes('"id":1') && stdout.includes("roots/list"),
    );
    assert.doesNotMatch(out.err(), /ERR_MODULE_NOT_FOUND/);
  } finally {
    child.kill();
    cleanup(links);
    cleanup(foreignCwd);
  }
});

test("Roots proxy: multi-active roots refuse launch (fail closed)", async () => {
  const a = adlcRepo({ id: "T1" });
  const b = adlcRepo({ id: "T1" });
  const fakeCli = writeFakeCli(a);
  const child = spawnWrapper({ ADLC_CLI_BIN: fakeCli });
  const out = attachCollector(child);
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "test" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    await out.waitFor((s) => s.includes("roots/list"));
    let stdout = out.text();
    const rootsReq = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l) => l.method === "roots/list");
    assert.ok(rootsReq);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rootsReq.id,
        result: {
          roots: [
            { uri: pathToFileURL(a).href },
            { uri: pathToFileURL(b).href },
          ],
        },
      }) + "\n",
    );
    await out.wait(50);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/list",
        params: {},
      }) + "\n",
    );
    await out.waitFor((s) => s.includes('"id":9') && s.includes("error"));
    stdout = out.text();
    const lines = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const err = lines.find((l) => l.id === 9 && l.error);
    assert.ok(err, `multi-root must fail closed tools/list; got ${stdout}`);
    assert.match(err.error.message, /AMBIGUOUS|ambiguous|refuse/i);
  } finally {
    child.kill();
    cleanup(a);
    cleanup(b);
  }
});

test("resolveConsumerWorkspace still used for multi-root ambiguity (MCP refuses)", () => {
  const a = adlcRepo({ id: "T1" });
  const b = adlcRepo({ id: "T1" });
  try {
    const ws = resolveConsumerWorkspace({ workspace_roots: [a, b] }, {});
    assert.equal(ws.outcome, "ambiguous");
    assert.equal(mcpRootFromWorkspace(ws).ok, false);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});
