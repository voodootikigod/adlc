#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// <define:__ADLC_MCP_BUILD_METADATA__>
var init_define_ADLC_MCP_BUILD_METADATA = __esm({
  "<define:__ADLC_MCP_BUILD_METADATA__>"() {
  }
});

// packages/core/lib/cli-providers.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
function normalizeCliAnthropicUsage(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  return {
    inputTokens: Number(u.input_tokens ?? u.inputTokens ?? 0),
    outputTokens: Number(u.output_tokens ?? u.outputTokens ?? 0),
    cachedTokens: Number((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cachedTokens ?? 0))
  };
}
function sanitizeProviderEnv(envSource = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(envSource ?? {})) {
    if (k === "ADLC_MANIFEST_KEY" || k === "ADLC_MANIFEST_PRIVATE_KEY" || k.startsWith("ADLC_ADMIN_")) continue;
    env[k] = v;
  }
  if (!env.HOME && process.env.HOME) env.HOME = process.env.HOME;
  if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
  return env;
}
function runCliCommand(bin, args, input, opts = {}) {
  const envSource = opts.env ?? process.env;
  const isTest = envSource.NODE_ENV === "test" || process.env.NODE_ENV === "test";
  const spawnFn = isTest && typeof envSource.__adlcCliSpawn === "function" ? envSource.__adlcCliSpawn : spawn;
  const env = sanitizeProviderEnv(envSource);
  const timeoutMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 12e4;
  const isolatedCwd = mkdtempSync(join(tmpdir(), "adlc-cli-cwd-"));
  const cleanupCwd = () => {
    try {
      rmSync(isolatedCwd, { recursive: true, force: true });
    } catch {
    }
  };
  return new Promise((resolve8, reject) => {
    let child;
    try {
      child = spawnFn(bin, args, {
        shell: false,
        cwd: isolatedCwd,
        stdio: ["pipe", "pipe", "pipe"],
        env
      });
    } catch (err) {
      cleanupCwd();
      return reject(err);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      cleanupCwd();
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (d) => {
      stdout += outDecoder.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += errDecoder.write(d);
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCwd();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCwd();
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (code !== 0) {
        return reject(new Error(`Process exited with code ${code ?? signal}: ${stderr || stdout}`));
      }
      resolve8(stdout);
    });
  });
}
async function claudeCliSend(apiKey, model, system, prompt, opts = {}) {
  const bin = apiKey === "1" || apiKey === "true" ? "claude" : apiKey;
  const args = ["--print", "--output-format", "json", "--tools", "", "--model", model];
  const input = system ? `${system}

---

${prompt}` : prompt;
  const stdout = await runCliCommand(bin, args, input, opts);
  try {
    const data = JSON.parse(stdout);
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.result === "string") {
      return {
        text: data.result,
        usage: normalizeCliAnthropicUsage(data.usage)
      };
    }
  } catch {
  }
  return { text: stdout, usage: null };
}
async function codexCliSend(apiKey, model, system, prompt, opts = {}) {
  const bin = apiKey === "1" || apiKey === "true" ? "codex" : apiKey;
  const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "-"];
  const input = system ? `${system}

---

${prompt}` : prompt;
  const stdout = await runCliCommand(bin, args, input, opts);
  return { text: stdout, usage: null };
}
var CLAUDE_CLI_MODELS, CODEX_CLI_MODELS;
var init_cli_providers = __esm({
  "packages/core/lib/cli-providers.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    CLAUDE_CLI_MODELS = Object.freeze({
      cheap: "claude-haiku-4-5",
      mid: "claude-sonnet-4-6",
      frontier: "claude-opus-4-7"
    });
    CODEX_CLI_MODELS = Object.freeze({
      cheap: "gpt-5-mini",
      mid: "gpt-5.1",
      frontier: "gpt-5.1"
    });
  }
});

// packages/core/lib/model-family.mjs
var init_model_family = __esm({
  "packages/core/lib/model-family.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/llm.mjs
import { spawn as spawn2 } from "node:child_process";
import { StringDecoder as StringDecoder2 } from "node:string_decoder";
function isAgyTimeout(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}
function parseAgyTimeoutMs(spec = "300s") {
  const m = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!m) return DEFAULT_HTTP_TIMEOUT_MS;
  const val = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return Math.max(1, Math.round(val));
  if (unit === "m") return Math.max(1, Math.round(val * 6e4));
  return Math.max(1, Math.round(val * 1e3));
}
function resolveHttpTimeoutMs(timeoutMs, env = process.env) {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  const fromEnv = Number(env?.ADLC_HTTP_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_HTTP_TIMEOUT_MS;
}
function agySend({ apiKey, model, system, prompt, timeoutMs }, env = process.env) {
  const bin = apiKey === "1" || apiKey === "true" ? "agy" : apiKey;
  const timeoutSpec = env.ADLC_AGY_TIMEOUT ?? "300s";
  const args = ["--print", "--print-timeout", timeoutSpec, "--model", model];
  if (env.ADLC_AGY_SANDBOX === "1") args.push("--sandbox");
  const input = system ? `${system}

---

${prompt}` : prompt;
  const hostTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : parseAgyTimeoutMs(timeoutSpec) + 5e3;
  return new Promise((resolve8, reject) => {
    const p = spawn2(bin, args, { stdio: "pipe", env: sanitizeProviderEnv(env) });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill("SIGKILL");
      } catch {
      }
      reject(new Error("agy: timed out waiting for response"));
    }, hostTimeoutMs);
    timer.unref?.();
    const outDecoder = new StringDecoder2("utf8");
    const errDecoder = new StringDecoder2("utf8");
    p.stdout.on("data", (d) => out += outDecoder.write(d));
    p.stderr.on("data", (d) => err += errDecoder.write(d));
    p.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`agy spawn failed: ${e.message}`));
    });
    let stdinError = null;
    p.stdin.on("error", (e) => {
      stdinError = e;
    });
    p.stdin.end(input);
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out += outDecoder.end();
      err += errDecoder.end();
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
      if (stdinError) return reject(new Error(`agy did not read the full prompt: ${stdinError.message}`));
      if (isAgyTimeout(out)) {
        return reject(new Error("agy: timed out waiting for response"));
      }
      resolve8({ text: out.replace(/\s+$/, ""), usage: null });
    });
  });
}
function usageFromAnthropic(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    // Anthropic splits cache reads and cache writes; both count as "cached"
    // for our purposes (cheaper-than-fresh-input), tracked separately isn't
    // needed at this granularity.
    cachedTokens: (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0)
  };
}
function usageFromOpenAI(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0
  };
}
function usageFromGemini(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    inputTokens: raw.promptTokenCount ?? 0,
    outputTokens: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0),
    cachedTokens: raw.cachedContentTokenCount ?? 0
  };
}
var DEFAULT_HTTP_TIMEOUT_MS, PROVIDERS, CLI_PROVIDERS, ALL_PROVIDERS, PROVIDER_NAMES, CLI_PROVIDER_NAMES;
var init_llm = __esm({
  "packages/core/lib/llm.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_cli_providers();
    init_model_family();
    DEFAULT_HTTP_TIMEOUT_MS = 3e5;
    PROVIDERS = [
      {
        name: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        models: {
          cheap: "claude-haiku-4-5",
          mid: "claude-sonnet-4-6",
          frontier: "claude-opus-4-8"
        },
        async send({ apiKey, model, system, prompt, maxTokens, cacheable, timeoutMs }, env = process.env) {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: AbortSignal.timeout(resolveHttpTimeoutMs(timeoutMs, env)),
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              ...system ? { system: cacheable ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system } : {},
              messages: [{
                role: "user",
                content: cacheable ? [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] : prompt
              }]
            })
          });
          if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = (data.content ?? []).map((b) => b.text ?? "").join("");
          return { text, usage: usageFromAnthropic(data.usage) };
        }
      },
      {
        name: "openai",
        envKey: "OPENAI_API_KEY",
        models: {
          cheap: "gpt-5-mini",
          mid: "gpt-5.1",
          frontier: "gpt-5.1"
        },
        async send({ apiKey, model, system, prompt, maxTokens, timeoutMs }, env = process.env) {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            signal: AbortSignal.timeout(resolveHttpTimeoutMs(timeoutMs, env)),
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model,
              max_completion_tokens: maxTokens,
              messages: [
                ...system ? [{ role: "system", content: system }] : [],
                { role: "user", content: prompt }
              ]
            })
          });
          if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content ?? "";
          return { text, usage: usageFromOpenAI(data.usage) };
        }
      },
      {
        name: "gemini",
        envKey: "GEMINI_API_KEY",
        models: {
          cheap: "gemini-2.5-flash",
          mid: "gemini-2.5-pro",
          frontier: "gemini-2.5-pro"
        },
        async send({ apiKey, model, system, prompt, maxTokens, timeoutMs }, env = process.env) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
          const res = await fetch(url, {
            method: "POST",
            signal: AbortSignal.timeout(resolveHttpTimeoutMs(timeoutMs, env)),
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
              ...system ? { systemInstruction: { parts: [{ text: system }] } } : {},
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens }
            })
          });
          if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
          return { text, usage: usageFromGemini(data.usageMetadata) };
        }
      },
      {
        // Antigravity CLI subprocess provider. Last in the list so API-key
        // providers win during auto-detection; force with ADLC_PROVIDER=agy.
        name: "agy",
        envKey: "ADLC_AGY",
        isCli: true,
        models: {
          cheap: "Gemini 3.5 Flash (Medium)",
          mid: "Claude Sonnet 4.6 (Thinking)",
          frontier: "Claude Opus 4.6 (Thinking)"
        },
        send: agySend
      }
    ];
    CLI_PROVIDERS = [
      {
        name: "claude-cli",
        envKey: "ADLC_CLAUDE_CLI",
        isCli: true,
        models: CLAUDE_CLI_MODELS,
        send: ({ apiKey, model, system, prompt, timeoutMs }, env = process.env) => claudeCliSend(apiKey, model, system, prompt, { timeoutMs, env })
      },
      {
        name: "codex-cli",
        envKey: "ADLC_CODEX_CLI",
        isCli: true,
        models: CODEX_CLI_MODELS,
        send: ({ apiKey, model, system, prompt, timeoutMs }, env = process.env) => codexCliSend(apiKey, model, system, prompt, { timeoutMs, env })
      }
    ];
    ALL_PROVIDERS = [...PROVIDERS, ...CLI_PROVIDERS];
    PROVIDER_NAMES = PROVIDERS.map((p) => p.name);
    CLI_PROVIDER_NAMES = Object.freeze(ALL_PROVIDERS.filter((p) => p.isCli).map((p) => p.name));
  }
});

// packages/core/lib/git.mjs
var GIT_MAX_BUFFER;
var init_git = __esm({
  "packages/core/lib/git.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    GIT_MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// packages/core/lib/cli.mjs
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
var init_cli = __esm({
  "packages/core/lib/cli.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/tickets/lib/errors.mjs
var TicketStoreError, invalid, conflict, policy, operational;
var init_errors = __esm({
  "packages/tickets/lib/errors.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    TicketStoreError = class extends Error {
      constructor(kind, code, message, details) {
        super(message);
        this.name = "TicketStoreError";
        this.kind = kind;
        this.code = code;
        if (details !== void 0) this.details = details;
      }
    };
    invalid = (code, message, details) => new TicketStoreError("invalid", code, message, details);
    conflict = (code, message, details) => new TicketStoreError("conflict", code, message, details);
    policy = (code, message, details) => new TicketStoreError("policy", code, message, details);
    operational = (code, message, details) => new TicketStoreError("operational", code, message, details);
  }
});

// packages/tickets/lib/pointer.mjs
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from "node:fs";
import { dirname, join as join2 } from "node:path";
function readPointerFileBounded(path) {
  let parentLst;
  try {
    parentLst = lstatSync(dirname(path));
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!parentLst.isDirectory()) return null;
  let lst;
  try {
    lst = lstatSync(path);
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!lst.isFile() || lst.size > MAX_POINTER_BYTES) return null;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) return null;
    if (lst.dev !== 0 && lst.ino !== 0 && (stat.dev !== lst.dev || stat.ino !== lst.ino)) return null;
    const length = stat.size;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function conflictMessage(envId, fileId) {
  return `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE} ("${fileId}"): they name different tickets. The active ticket is per-worktree state \u2014 ADLC supports exactly one active ticket per worktree, and parallel work on a second ticket needs its own worktree (git worktree add <path> -b <branch>), not a second pointer in this one. Failing closed: which ticket governs this build cannot be determined.`;
}
function readActiveTicketPointer(root = ".") {
  const path = join2(root, CURRENT_TICKET_FILE);
  const raw = readPointerFileBounded(path);
  if (raw === ABSENT) return ok({ present: false });
  if (raw === null) {
    return fail("operational", "INVALID_CURRENT_TICKET", `cannot read ${CURRENT_TICKET_FILE} as a bounded regular file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid2("INVALID_CURRENT_TICKET", `cannot parse ${CURRENT_TICKET_FILE}: ${error.message}`);
  }
  if (typeof parsed === "string") {
    const id2 = parsed.trim();
    if (!id2) return invalid2("INVALID_CURRENT_TICKET", `${CURRENT_TICKET_FILE} is an empty string pointer`);
    return ok({ present: true, id: id2, ticketHash: null, legacyString: true });
  }
  if (!isPlainObject2(parsed)) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} must be an object like {"id":"T1","ticketHash":"<64 hex>"} (got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}). To deactivate, delete the file.`
    );
  }
  let usedKey = null;
  for (const key of [CANONICAL_ID_KEY, ...DEPRECATED_ID_KEYS]) {
    if (Object.hasOwn(parsed, key)) {
      usedKey = key;
      break;
    }
  }
  if (usedKey === null) {
    const found = Object.keys(parsed);
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} declares no ticket id: expected "${CANONICAL_ID_KEY}" (or deprecated ${DEPRECATED_ID_KEYS.map((k) => `"${k}"`).join("/")}), found ${found.length ? found.map((k) => `"${k}"`).join(", ") : "no keys"}. Failing closed rather than treating an unrecognized pointer as "no active ticket". To deactivate, delete the file.`
    );
  }
  const id = trimmed(parsed[usedKey]);
  if (!id) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE} has a "${usedKey}" that is not a non-empty string`
    );
  }
  const value = { present: true, id, ticketHash: trimmed(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY) value.deprecatedAlias = usedKey;
  return ok(value);
}
function resolveActiveTicketId({ root = ".", env = process.env } = {}) {
  const pointer = readActiveTicketPointer(root);
  if (!pointer.ok) return pointer;
  const envId = trimmed(env.ADLC_TICKET) || null;
  const file = pointer.value;
  const fileId = file.present ? file.id : null;
  if (envId && fileId && envId !== fileId) return conflict2("ACTIVE_TICKET_CONFLICT", conflictMessage(envId, fileId));
  const id = envId ?? fileId;
  if (!id) return ok(null);
  return ok({
    id,
    pointerPresent: file.present,
    ticketHash: file.present ? file.ticketHash : null,
    legacyString: file.present ? Boolean(file.legacyString) : false,
    ...file.deprecatedAlias ? { deprecatedAlias: file.deprecatedAlias } : {}
  });
}
var CURRENT_TICKET_FILE, MAX_POINTER_BYTES, ABSENT, CANONICAL_ID_KEY, DEPRECATED_ID_KEYS, ok, fail, invalid2, conflict2, isPlainObject2, trimmed;
var init_pointer = __esm({
  "packages/tickets/lib/pointer.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    CURRENT_TICKET_FILE = ".adlc/current-ticket.json";
    MAX_POINTER_BYTES = 64 * 1024;
    ABSENT = /* @__PURE__ */ Symbol("pointer-absent");
    CANONICAL_ID_KEY = "id";
    DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);
    ok = (value) => ({ ok: true, value });
    fail = (kind, code, message) => ({ ok: false, kind, code, message });
    invalid2 = (code, message) => fail("invalid", code, message);
    conflict2 = (code, message) => fail("conflict", code, message);
    isPlainObject2 = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    trimmed = (value) => typeof value === "string" ? value.trim() : "";
  }
});

// packages/tickets/lib/constants.mjs
var ACTIVE_MANIFEST, ARCHIVE_MANIFEST, ACTIVE_DIRECTORY, ARCHIVE_DIRECTORY, LEGACY_FILE, LEGACY_ARCHIVE_FILE, LOCK_DIRECTORY, TRANSACTION_DIRECTORY, TICKET_HASH_DOMAIN, STORE_HASH_DOMAIN;
var init_constants = __esm({
  "packages/tickets/lib/constants.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_pointer();
    ACTIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-directory", version: 1 });
    ARCHIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-archive", version: 1 });
    ACTIVE_DIRECTORY = ".adlc/tickets";
    ARCHIVE_DIRECTORY = ".adlc/ticket-archive";
    LEGACY_FILE = ".adlc/tickets.json";
    LEGACY_ARCHIVE_FILE = ".adlc/tickets.archive.json";
    LOCK_DIRECTORY = ".adlc/tickets.lock";
    TRANSACTION_DIRECTORY = ".adlc/ticket-transactions";
    TICKET_HASH_DOMAIN = "adlc:ticket:v1\0";
    STORE_HASH_DOMAIN = "adlc:active-store:v1\0";
  }
});

// packages/tickets/lib/canonical.mjs
import { createHash } from "node:crypto";
function compareTicketIds(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return Buffer.compare(a, b);
}
function normalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("NON_JSON_VALUE", `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== "object") throw invalid("NON_JSON_VALUE", `${path} contains ${typeof value}`);
  const output = {};
  for (const key of Object.keys(value).sort(compareTicketIds)) {
    const item = value[key];
    if (item === void 0 || typeof item === "function" || typeof item === "symbol") {
      throw invalid("NON_JSON_VALUE", `${path}.${key} is not JSON`);
    }
    output[key] = normalize(item, `${path}.${key}`);
  }
  return output;
}
function storeHashFromPairs(pairs) {
  const sorted = [...pairs].sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(sorted));
}
function storeHash(tickets) {
  return storeHashFromPairs(tickets.map((ticket) => [ticket.id, ticketHash(ticket)]));
}
var canonicalJson, prettyCanonicalJson, sha256, ticketHash;
var init_canonical = __esm({
  "packages/tickets/lib/canonical.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_errors();
    init_constants();
    canonicalJson = (value) => JSON.stringify(normalize(value));
    prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}
`;
    sha256 = (value) => createHash("sha256").update(value).digest("hex");
    ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));
  }
});

// packages/core/lib/secret-shapes.mjs
function tokenEntropy(s) {
  const freq = /* @__PURE__ */ new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
function isRandomSecretToken(token) {
  if (token.length < 32) return false;
  if (/^[0-9a-f]{1,40}$/i.test(token)) return false;
  if (/^[0-9a-f]{41,}$/i.test(token)) return true;
  if (!/[a-z]/.test(token) || !/[A-Z0-9]/.test(token)) return false;
  return tokenEntropy(token) >= 4;
}
function looksLikeRandomSecret(text) {
  return String(text).split(TOKEN_SEPARATORS).some(isRandomSecretToken);
}
var INLINE_ASSIGNMENT, SECRET_PATTERNS, TOKEN_SEPARATORS;
var init_secret_shapes = __esm({
  "packages/core/lib/secret-shapes.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    INLINE_ASSIGNMENT = /\b((?:api[-_]?key|secret|passwd|password|token|access[-_]?key)\b\s*[:=]\s*)\S{8,}/i;
    SECRET_PATTERNS = [
      [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
      [/\bASIA[0-9A-Z]{16}\b/, "an AWS temporary access key id"],
      [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "a GitHub token"],
      [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "a GitHub fine-grained token"],
      [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "a GitLab token"],
      [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "an OpenAI API key"],
      [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
      [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
      [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, "a bearer token"],
      [INLINE_ASSIGNMENT, "an inline credential assignment"],
      [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/, "a JWT"]
    ];
    TOKEN_SEPARATORS = /[\s"'`(){}\[\],:]+/;
  }
});

// packages/core/lib/proc.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
function pidAlive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function procStartTimeOf(pid, { platform = process.platform, readFile = readFileSync, execFile = execFileSync } = {}) {
  if (typeof pid !== "number") return null;
  try {
    if (platform === "linux") {
      const stat = readFile("/proc/" + pid + "/stat", "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      const fields = after.split(" ");
      return fields[19] || null;
    }
    const out = execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}
var init_proc = __esm({
  "packages/core/lib/proc.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/ledger.mjs
import { closeSync as closeSync2, existsSync, fsyncSync, mkdirSync, openSync as openSync2, readFileSync as readFileSync2, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
function ledgerPath(name, dir = ADLC_DIR) {
  return join3(dir, `${name}.jsonl`);
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isStaleLockOwner(current, { isPidAlive, procStartTime = procStartTimeOf, staleMs, now }) {
  if (!isPlainObject(current)) return false;
  if (current.hostname === hostname() && typeof current.pid === "number") {
    if (!isPidAlive(current.pid)) return true;
    if (current.pidStartTime != null) {
      const liveStart = procStartTime(current.pid);
      if (liveStart != null && String(liveStart) !== String(current.pidStartTime)) {
        return true;
      }
    }
    return false;
  }
  return typeof current.startedAt === "string" && now() - Date.parse(current.startedAt) > staleMs;
}
function withLedgerLock(target, fn, { retries = LOCK_MAX_RETRIES, delayMs = LOCK_RETRY_DELAY_MS, staleMs = LOCK_STALE_MS, isPidAlive = pidAlive, procStartTime = procStartTimeOf, now = Date.now } = {}) {
  const lockPath2 = `${target}.lock`;
  mkdirSync(dirname2(target), { recursive: true });
  const owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    pidStartTime: procStartTime(process.pid),
    hostname: hostname(),
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  for (let i = 0; i <= retries; i++) {
    let fd;
    try {
      fd = openSync2(lockPath2, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const current = JSON.parse(readFileSync2(lockPath2, "utf8"));
        if (isStaleLockOwner(current, { isPidAlive, procStartTime, staleMs, now })) unlinkSync(lockPath2);
      } catch {
      }
      if (i < retries) sleepSync(delayMs);
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(owner)}
`);
      fsyncSync(fd);
    } finally {
      closeSync2(fd);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync2(lockPath2, "utf8"));
        if (current.token === owner.token) unlinkSync(lockPath2);
      } catch {
      }
    }
  }
  throw new Error(
    `could not acquire ledger lock: ${lockPath2} (held > ${retries * delayMs}ms) \u2014 a previous writer may have been killed; remove ${lockPath2} if no ADLC process is running`
  );
}
function parseLedger(content) {
  const entries = [];
  const skipped = [];
  const rawLines = [];
  for (const [i, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    rawLines.push(line);
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      skipped.push({ line: i + 1, error: String(err.message ?? err) });
    }
  }
  return { entries, skipped, rawLines, lastRawLine: rawLines.at(-1) ?? null };
}
function countEntryNewlines(value) {
  if (typeof value === "string") return (value.match(/[\r\n]/g) || []).length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countEntryNewlines(v), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n, v) => n + countEntryNewlines(v), 0);
  return 0;
}
function assertPublishableFinding(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("findings ledger: entry must be a finding object (a non-null, non-array object) \u2014 a bare null/scalar/array crashes the distillation pipeline (ADR 0014)");
  }
  if (typeof entry.desc !== "string" || entry.desc.trim().length === 0) {
    throw new Error("findings ledger: entry must carry a non-empty string `desc` (the clustering key) \u2014 an entry without it starves lesson-foundry (ADR 0014)");
  }
  const serialized = JSON.stringify(entry);
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`findings ledger: refusing to record \u2014 the entry appears to contain ${what}. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)`);
    }
  }
  if (looksLikeRandomSecret(serialized)) {
    throw new Error("findings ledger: refusing to record \u2014 the entry contains a long, high-entropy token that looks like a key or secret. This ledger is committed to git; describe the failure class instead of quoting the value (ADR 0014)");
  }
  const desc = typeof entry?.desc === "string" ? entry.desc : "";
  if (/[\r\n]/.test(desc)) {
    throw new Error("findings ledger: desc must be a single line of curated prose \u2014 raw multi-line tool output is not recordable (ADR 0014)");
  }
  if (desc.length > MAX_FINDING_DESC) {
    throw new Error(`findings ledger: desc is ${desc.length} chars; curated descriptions are capped at ${MAX_FINDING_DESC} to keep dumps out of the committed ledger (ADR 0014)`);
  }
  if (serialized.length > MAX_FINDING_ENTRY) {
    throw new Error(`findings ledger: entry is ${serialized.length} bytes serialized; curated findings are capped at ${MAX_FINDING_ENTRY} to keep raw dumps out of the committed, append-only ledger (ADR 0014)`);
  }
  const newlines = countEntryNewlines(entry);
  if (newlines > MAX_FINDING_LINES) {
    throw new Error(`findings ledger: entry spans ${newlines} lines across its fields; a curated finding is near-single-line, so this looks like a raw multi-line dump (transcript, diff hunk, stack trace, log paste) \u2014 describe the failure class instead (ADR 0014)`);
  }
}
function appendEntries(name, entriesOrFactory, dir = ADLC_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = ledgerPath(name, dir);
  return withLedgerLock(p, () => {
    const additions = typeof entriesOrFactory === "function" ? entriesOrFactory(parseLedger(existsSync(p) ? readFileSync2(p, "utf8") : "")) : entriesOrFactory;
    if (!Array.isArray(additions)) throw new TypeError("ledger append batch must be an array");
    if (additions.length === 0) return [];
    if (name === FINDINGS_LEDGER) for (const entry of additions) assertPublishableFinding(entry);
    const descriptor = openSync2(p, "a");
    try {
      writeFileSync(descriptor, additions.map((entry) => `${JSON.stringify(entry)}
`).join(""));
      fsyncSync(descriptor);
    } finally {
      closeSync2(descriptor);
    }
    if (process.platform !== "win32") {
      const directory = openSync2(dirname2(p), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync2(directory);
      }
    }
    return additions;
  });
}
function sha2562(content) {
  return sha256(content);
}
function hashFiles(paths, readFile = (p) => readFileSync2(p)) {
  const out = {};
  for (const p of paths) {
    try {
      out[p] = sha2562(readFile(p));
    } catch {
      out[p] = null;
    }
  }
  return out;
}
var ADLC_DIR, LOCK_RETRY_DELAY_MS, LOCK_MAX_RETRIES, LOCK_STALE_MS, FINDINGS_LEDGER, MAX_FINDING_DESC, MAX_FINDING_ENTRY, MAX_FINDING_LINES;
var init_ledger = __esm({
  "packages/core/lib/ledger.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    init_secret_shapes();
    init_proc();
    init_cli();
    ADLC_DIR = ".adlc";
    LOCK_RETRY_DELAY_MS = 5;
    LOCK_MAX_RETRIES = 400;
    LOCK_STALE_MS = 6e4;
    FINDINGS_LEDGER = "findings";
    MAX_FINDING_DESC = 600;
    MAX_FINDING_ENTRY = 4e3;
    MAX_FINDING_LINES = 10;
  }
});

// packages/tickets/lib/ids.mjs
var init_ids = __esm({
  "packages/tickets/lib/ids.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/tickets/lib/filename.mjs
function ticketSlug(id) {
  const slug = id.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "ticket";
}
var ticketFilename;
var init_filename = __esm({
  "packages/tickets/lib/filename.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    ticketFilename = (id) => `${ticketSlug(id)}--${sha256(Buffer.from(id, "utf8"))}.json`;
  }
});

// packages/tickets/lib/schema.mjs
function validateTicket(ticket, { archive = false } = {}) {
  const errors = [];
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return ["ticket is not an object"];
  if (typeof ticket.id !== "string" || ticket.id.length === 0) errors.push("missing string id");
  if (typeof ticket.title !== "string" || ticket.title.length === 0) errors.push(`${ticket.id ?? "?"}: missing string title`);
  for (const field of ["scope", "rails"]) {
    if (ticket[field] !== void 0 && (!Array.isArray(ticket[field]) || ticket[field].some((item) => typeof item !== "string"))) {
      errors.push(`${ticket.id ?? "?"}: ${field} must be an array of strings`);
    }
  }
  if (ticket.edges !== void 0) {
    if (!Array.isArray(ticket.edges)) errors.push(`${ticket.id ?? "?"}: edges must be an array`);
    else for (const edge of ticket.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge) || typeof edge.to !== "string" || edge.to.length === 0) {
        errors.push(`${ticket.id ?? "?"}: edge missing string "to"`);
      }
    }
  }
  if (ticket.duration !== void 0 && (typeof ticket.duration !== "number" || !Number.isFinite(ticket.duration) || ticket.duration <= 0)) {
    errors.push(`${ticket.id ?? "?"}: duration must be a positive number`);
  }
  if (!archive && Object.hasOwn(ticket, "_adlcArchive")) errors.push(`${ticket.id ?? "?"}: _adlcArchive is reserved for archived tickets`);
  if (archive && ticket._adlcArchive !== void 0) {
    const metadata = ticket._adlcArchive;
    if (!metadata || typeof metadata !== "object" || metadata.version !== 1 || typeof metadata.ticketHash !== "string") {
      errors.push(`${ticket.id ?? "?"}: invalid _adlcArchive metadata`);
    }
  }
  return errors;
}
function validateTickets(tickets, { archive = false, validateGraph = !archive } = {}) {
  if (!Array.isArray(tickets)) throw invalid("INVALID_ENVELOPE", "tickets must be an array");
  const errors = [];
  const byId = /* @__PURE__ */ new Map();
  for (const ticket of tickets) {
    errors.push(...validateTicket(ticket, { archive }));
    if (typeof ticket?.id === "string") {
      if (byId.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
      byId.set(ticket.id, ticket);
    }
  }
  if (validateGraph) {
    for (const ticket of tickets) {
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) {
        if (typeof edge?.to === "string" && !byId.has(edge.to)) errors.push(`${ticket.id}: edge to unknown ticket ${edge.to}`);
      }
    }
    const color = /* @__PURE__ */ new Map();
    const visit = (id, stack) => {
      if (color.get(id) === 1) {
        errors.push(`cycle in ticket DAG: ${[...stack, id].join(" -> ")}`);
        return;
      }
      if (color.get(id) === 2) return;
      color.set(id, 1);
      const ticket = byId.get(id);
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) if (byId.has(edge.to)) visit(edge.to, [...stack, id]);
      color.set(id, 2);
    };
    for (const id of [...byId.keys()].sort(compareTicketIds)) visit(id, []);
  }
  if (errors.length) {
    const count = errors.length;
    errors.push("see `adlc ticket schema` and `adlc ticket doctor`");
    throw invalid("INVALID_TICKET_STORE", `ticket store validation failed (${count} error(s)): ${errors.join("; ")}`, errors);
  }
  return tickets;
}
var init_schema = __esm({
  "packages/tickets/lib/schema.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_errors();
    init_canonical();
  }
});

// packages/tickets/lib/help.mjs
function wrap(text, width, indent) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines;
}
function fieldTable() {
  const width = Math.max(...TICKET_FIELDS.map((field) => field.name.length));
  const body = FIELD_INDENT.repeat(3);
  const lines = [];
  for (const field of TICKET_FIELDS) {
    lines.push(`${FIELD_INDENT}${field.name.padEnd(width)}  ${field.type}${field.required ? " (required)" : ""}`);
    lines.push(...wrap(field.summary, 92 - body.length, body));
  }
  return lines;
}
var SYNC_CATEGORIES, TICKET_FIELDS, FIELD_INDENT, INPUT_DOCUMENT;
var init_help = __esm({
  "packages/tickets/lib/help.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    SYNC_CATEGORIES = Object.freeze([
      "feature",
      "bug",
      "bugfix",
      "refactor",
      "docs",
      "chore",
      "test",
      "spec",
      "contract",
      "architecture"
    ]);
    TICKET_FIELDS = [
      {
        name: "id",
        type: "string",
        required: false,
        summary: "Ticket id. Omit it on create and the store mints a ULID (T-01K...); supply one only to keep an existing T<n> id.",
        schema: { type: "string", minLength: 1 }
      },
      {
        name: "title",
        type: "string",
        required: true,
        summary: "One imperative line naming the work.",
        schema: { type: "string", minLength: 1 }
      },
      {
        name: "body",
        type: "string",
        required: false,
        summary: "The self-contained ticket text: what to build, the acceptance criteria, and the concrete command that verifies each one. A fresh agent sees only this \u2014 never the conversation that produced it. coldstart audits it for gaps.",
        schema: {}
        // unpoliced by validateTicket — see the `schema` note below
      },
      {
        name: "category",
        type: "string",
        required: false,
        // The store accepts any string, so the schema must too — but ticket-sync's
        // rich validator pins an enum, and a category outside it round-trips to a
        // remote provider and then fails closed on the next sync. Name the set here
        // so the choice is made once, at authoring time.
        summary: "Routing hint, not a free-form label. model-router sends contract, spec, and architecture to a frontier model and routes the rest from empirical priors. Keep to the set ticket-sync accepts or a synced ticket cannot converge: feature, bug, bugfix, refactor, docs, chore, test, spec, contract, architecture.",
        schema: {}
        // unpoliced by validateTicket — see the `schema` note below
      },
      {
        name: "duration",
        type: "number > 0",
        required: false,
        summary: "Positive number (number > 0) giving the relative build-time estimate used to order the ticket DAG. Defaults to 1.",
        schema: { type: "number", exclusiveMinimum: 0 }
      },
      {
        name: "budget",
        type: "number > 0",
        required: false,
        // NOT constrained in the schema: the store does not police budget, and
        // model-router ignores a non-positive or non-numeric one rather than
        // rejecting it. Pinning it here would narrow v1 under an unchanged $id and
        // make the published schema reject stores that load fine.
        summary: "Optional token ceiling. model-router and flail-detector honour a positive number and ignore anything else; the store does not validate it. Omit it to take the tier default.",
        schema: {}
      },
      {
        name: "scope",
        type: "string[]",
        required: false,
        summary: "Path globs this ticket may touch, e.g. src/auth/**.",
        schema: { type: "array", items: { type: "string" } }
      },
      {
        name: "rails",
        type: "string[]",
        required: false,
        summary: "Path globs frozen for the duration of the build; rails-guard denies edits to them. Each rail must match at least one file in the repository when it is added, or the write is refused (RAIL_MATCHES_NOTHING). Narrowing rails, widening scope, or changing `completed` on an existing ticket requires `--authorize` (see `adlc ticket update --help`); `ADLC_RAILS_BYPASS` governs only the `rails-guard` hook/CLI check on direct store-path edits, not `adlc ticket` writes.",
        schema: { type: "array", items: { type: "string" } }
      },
      {
        name: "completed",
        type: "boolean",
        required: false,
        // Written by planComplete, not by an author — but it lives on a stored
        // ticket, so an update rebuilt from this table without it silently retires
        // the flag and downstream tooling schedules the work again.
        summary: "Lifecycle state, set by `adlc ticket complete` rather than authored by hand. It is part of the stored document, so an update that omits it REMOVES it \u2014 build updates from `show <id> --json`, not from scratch.",
        schema: {}
      },
      {
        name: "edges",
        type: 'array of "to" objects',
        required: false,
        summary: 'Array of edge objects (each with a non-empty string "to" id) giving ordering constraints, prerequisite to dependent: this ticket completes before `to` (an edge with "to": "TX" on THIS ticket means this ticket must complete before TX \u2014 so making this ticket depend on an existing one is an edge added to that existing ticket, never a reversed edge here). An edge may also carry "contract": a path to the interface it guarantees TX can consume, which is what lets the two be built in parallel; ticket-sync recognizes it and nothing else on an edge.',
        schema: {
          type: "array",
          items: {
            type: "object",
            required: ["to"],
            properties: {
              to: { type: "string", minLength: 1, description: "Id of the dependent ticket (this ticket completes before `to`, which must not start before this one completes)." },
              // Unconstrained for the same reason as body/category: validateTicket
              // checks only that an edge carries a string `to`.
              contract: { description: "Path to the interface this edge guarantees the dependent ticket can consume." }
            },
            additionalProperties: true
          }
        }
      }
    ];
    FIELD_INDENT = "  ";
    INPUT_DOCUMENT = [
      "Input document (--input <path> or - for stdin; see `adlc ticket schema`):",
      "",
      ...fieldTable(),
      "",
      "Unknown fields are preserved as-is; the store never strips them."
    ];
  }
});

// packages/tickets/lib/edit.mjs
var init_edit = __esm({
  "packages/tickets/lib/edit.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_errors();
  }
});

// packages/tickets/lib/snapshot.mjs
function deepClone(value) {
  const serialized = JSON.stringify(value, function reject(key, item) {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError(`deepClone cannot round-trip the non-finite number ${item}`);
    }
    if (Array.isArray(this) && (item === void 0 || typeof item === "function" || typeof item === "symbol")) {
      throw new TypeError(`deepClone cannot round-trip ${String(item)} at array index ${key}`);
    }
    if (Array.isArray(item)) {
      const extra = Reflect.ownKeys(item).filter((key2) => Object.getOwnPropertyDescriptor(item, key2)?.enumerable).filter((key2) => typeof key2 === "symbol" || !(/^(0|[1-9][0-9]*)$/.test(key2) && Number(key2) < 4294967295));
      if (extra.length) {
        throw new TypeError(`deepClone cannot round-trip non-index array key(s): ${extra.map(String).join(", ")}`);
      }
    }
    return item;
  });
  return JSON.parse(serialized);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
var TicketSnapshot;
var init_snapshot = __esm({
  "packages/tickets/lib/snapshot.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    TicketSnapshot = class {
      #byId;
      constructor({ backend, formatVersion, tickets }) {
        this.backend = backend;
        this.formatVersion = formatVersion;
        this.tickets = deepFreeze(deepClone(tickets).sort((left, right) => compareTicketIds(left.id, right.id)));
        this.hash = storeHash(this.tickets);
        this.ticketHashes = deepFreeze(Object.fromEntries(this.tickets.map((ticket) => [ticket.id, ticketHash(ticket)])));
        this.#byId = new Map(this.tickets.map((ticket) => [ticket.id, ticket]));
        Object.freeze(this);
      }
      get(id) {
        return this.#byId.get(id);
      }
      mutableTickets() {
        return deepClone(this.tickets);
      }
    };
  }
});

// packages/tickets/lib/stores/directory.mjs
import { existsSync as existsSync2, lstatSync as lstatSync2, readFileSync as readFileSync3, readdirSync } from "node:fs";
import { dirname as dirname3, join as join4, resolve } from "node:path";
function assertRealDirectory(path) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") throw operational("STORE_NOT_FOUND", `ticket store not found: ${path}`);
    throw operational("STORE_READ_FAILED", `cannot inspect ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${path} must be a real directory`);
  const parent = dirname3(path);
  if (parent !== path) {
    const parentStat = lstatSync2(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${parent} must be a real directory`);
  }
}
var DirectoryTicketStore;
var init_directory = __esm({
  "packages/tickets/lib/stores/directory.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_errors();
    init_canonical();
    init_filename();
    init_schema();
    init_snapshot();
    DirectoryTicketStore = class {
      constructor(path = ACTIVE_DIRECTORY, { archive = false } = {}) {
        this.path = path;
        this.archive = archive;
      }
      exists() {
        return existsSync2(this.path);
      }
      load() {
        assertRealDirectory(this.path);
        const expectedManifest = this.archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST;
        const entries = readdirSync(this.path, { withFileTypes: true });
        const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
        if (names.size !== entries.length) throw invalid("CASE_COLLISION", `${this.path} contains case-insensitive name collisions`);
        const manifestEntry = entries.find((entry) => entry.name === ".store.json");
        if (!manifestEntry || !manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw invalid("INVALID_MANIFEST", `${this.path}/.store.json must be a regular file`);
        let manifest;
        try {
          manifest = JSON.parse(readFileSync3(join4(this.path, ".store.json"), "utf8"));
        } catch (error) {
          throw invalid("INVALID_MANIFEST", `invalid store manifest: ${error.message}`);
        }
        if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
          const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? "upgrade @adlc/tickets to read this store" : "expected format version 1";
          throw invalid("UNSUPPORTED_STORE_FORMAT", `unsupported ticket store manifest (${hint})`, manifest);
        }
        const tickets = [];
        for (const entry of entries) {
          if (entry.name === ".store.json") continue;
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
            throw invalid("UNRECOGNIZED_STORE_ENTRY", `unrecognized or unsafe ticket store entry: ${entry.name}`);
          }
          const fullPath = join4(this.path, entry.name);
          const stat = lstatSync2(fullPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("UNSAFE_SHARD", `${entry.name} must be a regular file`);
          let ticket;
          try {
            ticket = JSON.parse(readFileSync3(fullPath, "utf8"));
          } catch (error) {
            throw invalid("INVALID_JSON", `invalid JSON in ${entry.name}: ${error.message}`);
          }
          if (!ticket || typeof ticket !== "object" || Array.isArray(ticket) || typeof ticket.id !== "string") {
            throw invalid("INVALID_SHARD", `${entry.name} must contain one ticket object`);
          }
          const expected = ticketFilename(ticket.id);
          if (entry.name !== expected) throw invalid("FILENAME_MISMATCH", `${entry.name} does not match ticket id ${ticket.id}; expected ${expected}`);
          tickets.push(ticket);
        }
        validateTickets(tickets, { archive: this.archive, validateGraph: !this.archive });
        return new TicketSnapshot({ backend: "directory", formatVersion: 1, tickets });
      }
      loadOne(id) {
        if (typeof id !== "string" || id.length === 0) return null;
        assertRealDirectory(this.path);
        const expectedManifest = this.archive ? ARCHIVE_MANIFEST : ACTIVE_MANIFEST;
        const manifestPath = join4(this.path, ".store.json");
        let manifestStat;
        try {
          manifestStat = lstatSync2(manifestPath);
        } catch {
          throw invalid("INVALID_MANIFEST", `${this.path}/.store.json must be a regular file`);
        }
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
          throw invalid("INVALID_MANIFEST", `${this.path}/.store.json must be a regular file`);
        }
        let manifest;
        try {
          manifest = JSON.parse(readFileSync3(manifestPath, "utf8"));
        } catch (error) {
          throw invalid("INVALID_MANIFEST", `invalid store manifest: ${error.message}`);
        }
        if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
          const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? "upgrade @adlc/tickets to read this store" : "expected format version 1";
          throw invalid("UNSUPPORTED_STORE_FORMAT", `unsupported ticket store manifest (${hint})`, manifest);
        }
        const name = ticketFilename(id);
        const fullPath = join4(this.path, name);
        let stat;
        try {
          stat = lstatSync2(fullPath);
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw operational("STORE_READ_FAILED", `cannot inspect ${fullPath}: ${error.message}`);
        }
        if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("UNSAFE_SHARD", `${name} must be a regular file`);
        let ticket;
        try {
          ticket = JSON.parse(readFileSync3(fullPath, "utf8"));
        } catch (error) {
          throw invalid("INVALID_JSON", `invalid JSON in ${name}: ${error.message}`);
        }
        if (!ticket || typeof ticket !== "object" || Array.isArray(ticket) || ticket.id !== id) {
          throw invalid("FILENAME_MISMATCH", `${name} does not match ticket id ${id}`);
        }
        validateTickets([ticket], { archive: this.archive, validateGraph: false });
        return new TicketSnapshot({ backend: "directory", formatVersion: 1, tickets: [ticket] }).get(id);
      }
      resolvedPath() {
        return resolve(this.path);
      }
    };
  }
});

// packages/tickets/lib/lock.mjs
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync4, renameSync, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname4, join as join5 } from "node:path";
function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
function defaultProcStartTimeOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") return null;
  try {
    const stat = readFileSync4(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}
function isStaleTicketLock(owner, { staleMs, now, isPidAlive, procStartTime, host }) {
  if (!owner || staleMs === void 0) return false;
  const startedAtMs = Date.parse(owner.startedAt);
  if (!Number.isFinite(startedAtMs) || now() - startedAtMs <= staleMs) return false;
  if (owner.hostname === host) {
    if (!isPidAlive(owner.pid)) return true;
    if (owner.pidStartTime != null) {
      const liveStart = procStartTime(owner.pid);
      if (liveStart != null && String(liveStart) !== String(owner.pidStartTime)) return true;
    }
    return false;
  }
  return true;
}
function acquireTicketLock(root = ".", {
  retries = 50,
  delayMs = 20,
  command = process.argv.join(" "),
  transactionId = null,
  staleMs,
  now = Date.now,
  isPidAlive = defaultPidAlive,
  procStartTime = defaultProcStartTimeOf,
  host = hostname2(),
  writeOwner = writeFileSync2,
  removeLock = rmSync2,
  makeLockDirectory = mkdirSync2
} = {}) {
  const path = join5(root, LOCK_DIRECTORY);
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: "", startedAt: "", command, transactionId })) {
    throw invalid(
      "INVALID_LOCK_OPTIONS",
      "acquireTicketLock requires a string command and a string-or-null transactionId; a lock written from other values could not be released by its own owner."
    );
  }
  mkdirSync2(dirname4(path), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let created = false;
    try {
      const pidStartTime = procStartTime(process.pid);
      const metadata = {
        version: 1,
        pid: process.pid,
        ...pidStartTime != null ? { pidStartTime } : {},
        hostname: host,
        startedAt: new Date(now()).toISOString(),
        command,
        transactionId
      };
      const serialized = `${JSON.stringify(metadata, null, 2)}
`;
      makeLockDirectory(path);
      created = true;
      writeOwner(join5(path, "owner.json"), serialized, { flag: "wx" });
      return { path, metadata };
    } catch (error) {
      if (created) {
        try {
          removeLock(path, { recursive: true, force: true });
        } catch (cleanupError) {
          throw operational(
            "LOCK_STRANDED",
            `could not acquire the ticket lock (${error.message}), and could not remove the partial lock at ${path} (${cleanupError.message}). Remove that directory to unblock later ticket writers.`
          );
        }
      }
      if (error.code !== "EEXIST") throw operational("LOCK_FAILED", `cannot acquire ticket lock: ${error.message}`);
      if (staleMs !== void 0) {
        const currentOwner = readLockMetadata(join5(path, "owner.json"));
        if (isStaleTicketLock(currentOwner, { staleMs, now, isPidAlive, procStartTime, host })) {
          const staleDir = `${path}.stale-${process.pid}-${randomUUID2()}`;
          try {
            renameSync(path, staleDir);
            const movedOwner = readLockMetadata(join5(staleDir, "owner.json"));
            const sameOwner = currentOwner === null ? movedOwner === null : movedOwner !== null && movedOwner.pid === currentOwner.pid && movedOwner.startedAt === currentOwner.startedAt && movedOwner.hostname === currentOwner.hostname;
            if (!sameOwner) {
              try {
                renameSync(staleDir, path);
              } catch {
              }
            } else {
              removeLock(staleDir, { recursive: true, force: true });
            }
          } catch {
          }
          continue;
        }
      }
      if (attempt < retries) sleep(delayMs);
    }
  }
  throw conflict("LOCK_TIMEOUT", `could not acquire ${LOCK_DIRECTORY}; another ticket writer is running`, readTicketLock(root));
}
function isLockMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== 1) return false;
  if (!Number.isInteger(value.pid)) return false;
  if (typeof value.hostname !== "string" || typeof value.startedAt !== "string") return false;
  if (typeof value.command !== "string") return false;
  if (value.transactionId !== null && typeof value.transactionId !== "string") return false;
  return true;
}
function readLockMetadata(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return null;
  }
  return isLockMetadata(parsed) ? parsed : null;
}
function readTicketLock(root = ".") {
  return readLockMetadata(join5(root, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync2 } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync3(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join5(lock.path, "owner.json"));
  if (!owner) return { released: false, reason: "unverifiable", code: "LOCK_STRANDED", path: lock.path };
  if (owner.pid !== lock.metadata?.pid || owner.startedAt !== lock.metadata?.startedAt) {
    return { released: false, reason: "not-ours", path: lock.path };
  }
  try {
    removeLock(lock.path, { recursive: true, force: true });
  } catch (cause) {
    return { released: false, reason: "remove-failed", code: "LOCK_STRANDED", path: lock.path, cause };
  }
  return { released: true };
}
var sleep;
var init_lock = __esm({
  "packages/tickets/lib/lock.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_errors();
    sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
});

// packages/tickets/lib/durability.mjs
import {
  closeSync as closeSync3,
  constants,
  copyFileSync,
  existsSync as existsSync4,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync3,
  openSync as openSync3,
  renameSync as renameSync2,
  rmSync as rmSync3,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname5, resolve as resolve2 } from "node:path";
function fsyncFile(path) {
  const descriptor = openSync3(path, "r+");
  try {
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
}
function fsyncDirectory(path) {
  if (process.platform === "win32") return false;
  const descriptor = openSync3(path, "r");
  try {
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
  return true;
}
function durableMkdir(path) {
  const missing = [];
  let cursor = resolve2(path);
  while (!existsSync4(cursor)) {
    missing.push(cursor);
    const parent = dirname5(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync3(path, { recursive: true });
  if (missing.length === 0) {
    fsyncDirectory(resolve2(path));
    return;
  }
  for (const directory of missing.reverse()) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname5(directory));
  }
}
function durableWrite(path, content) {
  let st = null;
  try {
    st = lstatSync3(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (st && st.isSymbolicLink()) {
    throw new Error("refusing to write through symlink: " + path);
  }
  const openFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = openSync3(path, openFlags, 438);
  } catch (err) {
    if (err?.code === "ELOOP") throw new Error("refusing to write through symlink: " + path);
    throw err;
  }
  try {
    writeFileSync3(descriptor, content);
    fsyncSync2(descriptor);
  } finally {
    closeSync3(descriptor);
  }
  fsyncDirectory(dirname5(resolve2(path)));
}
function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname5(resolve2(target)));
}
function durableRename(source, target) {
  const sourceParent = dirname5(resolve2(source));
  const targetParent = dirname5(resolve2(target));
  renameSync2(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}
function durableRemove(path, options) {
  const parent = dirname5(resolve2(path));
  rmSync3(path, options);
  fsyncDirectory(parent);
}
var init_durability = __esm({
  "packages/tickets/lib/durability.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/tickets/lib/manifest-crypto.mjs
import {
  lstatSync as lstatSync4,
  fstatSync as fstatSync2,
  openSync as openSync4,
  readSync as readSync2,
  closeSync as closeSync4,
  constants as fsConstants2
} from "node:fs";
import {
  createHash as createHash2,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { join as join6 } from "node:path";
function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, segment: _segment, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = {
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts
  };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}
function isEd25519PrivateKey(key) {
  return typeof key === "string" && key.startsWith(ED25519_PRIV_PREFIX);
}
function parsePrivateKey(privateKey) {
  if (!isEd25519PrivateKey(privateKey)) {
    throw new TypeError(`Ed25519 private key must start with "${ED25519_PRIV_PREFIX}"`);
  }
  const b64 = privateKey.slice(ED25519_PRIV_PREFIX.length);
  if (b64.length === 0 || !BASE64_RE.test(b64)) {
    throw new Error("invalid Ed25519 private key encoding");
  }
  const der = Buffer.from(b64, "base64");
  const keyObj = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  if (keyObj.type !== "private" || keyObj.asymmetricKeyType !== "ed25519") {
    throw new Error("private key is not an Ed25519 key");
  }
  return keyObj;
}
function parsePublicKey(publicKey) {
  if (typeof publicKey !== "string" || !publicKey.includes("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("public key must be a canonical SPKI PEM string");
  }
  const keyObj = createPublicKey({ key: publicKey, format: "pem", type: "spki" });
  if (keyObj.type !== "public" || keyObj.asymmetricKeyType !== "ed25519") {
    throw new Error("public key is not an Ed25519 SPKI key");
  }
  return keyObj;
}
function derivePublicKeyPem(privateKey) {
  const privObj = parsePrivateKey(privateKey);
  const pubObj = createPublicKey(privObj);
  return pubObj.export({ type: "spki", format: "pem" });
}
function signEntryEd25519(privateKey, entry) {
  const privObj = parsePrivateKey(privateKey);
  const payload = Buffer.from(canonicalEntryBytes(entry), "utf8");
  return cryptoSign(null, payload, privObj).toString("hex");
}
function verifyEntryEd25519(publicKeyOrPrivateKey, entry) {
  if (typeof entry?.sig !== "string" || !ED25519_SIG_HEX_RE.test(entry.sig)) return false;
  if (typeof publicKeyOrPrivateKey !== "string" || publicKeyOrPrivateKey.length === 0) return false;
  try {
    const pubObj = isEd25519PrivateKey(publicKeyOrPrivateKey) ? createPublicKey(parsePrivateKey(publicKeyOrPrivateKey)) : parsePublicKey(publicKeyOrPrivateKey);
    const payload = Buffer.from(canonicalEntryBytes(entry), "utf8");
    const sigBuf = Buffer.from(entry.sig, "hex");
    return cryptoVerify(null, payload, pubObj, sigBuf);
  } catch {
    return false;
  }
}
function readAdminPublicKey(dir = ".adlc") {
  const filePath = join6(dir, ADMIN_PUB_FILENAME);
  let st;
  try {
    st = lstatSync4(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "absent", publicKey: null };
    return { status: "error", reason: `cannot stat ${ADMIN_PUB_FILENAME}: ${err.message}` };
  }
  if (st.isSymbolicLink()) {
    return { status: "error", reason: `${ADMIN_PUB_FILENAME} is a symlink` };
  }
  if (!st.isFile()) {
    return { status: "error", reason: `${ADMIN_PUB_FILENAME} is not a regular file` };
  }
  if (st.size > MAX_ADMIN_PUB_BYTES) {
    return { status: "error", reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
  }
  let fd;
  try {
    fd = openSync4(filePath, fsConstants2.O_RDONLY | fsConstants2.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "absent", publicKey: null };
    if (err?.code === "ELOOP") return { status: "error", reason: `${ADMIN_PUB_FILENAME} is a symlink` };
    return { status: "error", reason: `cannot open ${ADMIN_PUB_FILENAME}: ${err.message}` };
  }
  try {
    const fst = fstatSync2(fd);
    if (!fst.isFile()) {
      return { status: "error", reason: `${ADMIN_PUB_FILENAME} is not a regular file` };
    }
    if (fst.size > MAX_ADMIN_PUB_BYTES) {
      return { status: "error", reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
    }
    const buf = Buffer.alloc(MAX_ADMIN_PUB_BYTES + 1);
    let total = 0;
    while (total <= MAX_ADMIN_PUB_BYTES) {
      const n = readSync2(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_ADMIN_PUB_BYTES) {
      return { status: "error", reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
    }
    const raw = buf.subarray(0, total).toString("utf8");
    let pubObj;
    try {
      pubObj = parsePublicKey(raw);
    } catch {
      return { status: "error", reason: `${ADMIN_PUB_FILENAME} is not a valid Ed25519 SPKI public key` };
    }
    return { status: "ok", publicKey: pubObj.export({ type: "spki", format: "pem" }) };
  } catch (err) {
    return { status: "error", reason: `cannot read ${ADMIN_PUB_FILENAME}: ${err.message}` };
  } finally {
    closeSync4(fd);
  }
}
var ADMIN_PUB_FILENAME, ED25519_PRIV_PREFIX, SIG_ALG_ED25519, MAX_ADMIN_PUB_BYTES, BASE64_RE, ED25519_SIG_HEX_RE;
var init_manifest_crypto = __esm({
  "packages/tickets/lib/manifest-crypto.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    ADMIN_PUB_FILENAME = "admin.pub";
    ED25519_PRIV_PREFIX = "ed25519-priv:";
    SIG_ALG_ED25519 = "ed25519";
    MAX_ADMIN_PUB_BYTES = 4096;
    BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
    ED25519_SIG_HEX_RE = /^[0-9a-f]{128}$/;
  }
});

// packages/tickets/lib/manifest-primitives.mjs
import {
  existsSync as existsSync5,
  lstatSync as lstatSync5,
  readdirSync as readdirSync2,
  readFileSync as readFileSync5,
  writeFileSync as writeFileSync4,
  openSync as openSync5,
  readSync as readSync3,
  closeSync as closeSync5,
  unlinkSync as unlinkSync3,
  mkdirSync as mkdirSync4,
  constants as fsConstants3
} from "node:fs";
import { execFileSync as execFileSync2 } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname6, isAbsolute, join as join7, relative, resolve as resolve3, sep } from "node:path";
function segmentDirPath(dir = ".adlc") {
  return join7(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir = ".adlc", name) {
  return join7(segmentDirPath(dir), name);
}
function markerPath(dir = ".adlc") {
  return join7(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir = ".adlc") {
  return join7(segmentDirPath(dir), LINEAGE_NAME);
}
function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync5(path, "utf8").trim());
  } catch {
  }
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.startedAt === "string";
}
function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync5(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync5(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync5(path, fsConstants3.O_RDONLY | fsConstants3.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync3(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync5(fd);
  }
}
function hasActivationMarker(dir = ".adlc") {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir = ".adlc") {
  const rootPath = join7(dir, "manifest.jsonl");
  if (!existsSync5(rootPath)) return false;
  let content;
  try {
    content = readFileSync5(rootPath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  try {
    const last = JSON.parse(lines.at(-1));
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function isSegmentedRepo(dir = ".adlc") {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}
function discoverSegments(dir = ".adlc") {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync5(segDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) {
    return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is a symlink" }] };
  }
  if (!dirStat.isDirectory()) {
    return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is not a directory" }] };
  }
  const valid = [];
  const invalid4 = [];
  const seenLower = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync2(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: ".", reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    const full = join7(segDir, name);
    let st;
    try {
      st = lstatSync5(full);
    } catch (err) {
      invalid4.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid4.push({ name, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      invalid4.push({ name, reason: "nested directory" });
      continue;
    }
    if (!st.isFile()) {
      invalid4.push({ name, reason: "not a regular file" });
      continue;
    }
    if (name.endsWith(LOCK_SUFFIX)) {
      if (looksLikeGenuineLedgerLock(full, st.size)) continue;
      invalid4.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid4.push({ name, reason: "bad filename grammar" });
      continue;
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      invalid4.push({ name, reason: `case-colliding with ${seenLower.get(lower)}` });
      continue;
    }
    seenLower.set(lower, name);
    valid.push(name);
  }
  return { valid, invalid: invalid4 };
}
function encodeUlidPart(value, width) {
  let remaining = BigInt(value);
  let output = "";
  for (let i = 0; i < width; i += 1) {
    output = ULID_ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}
function generateSegmentUlid(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281474976710655) throw new RangeError("ULID timestamp out of range");
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError("ULID entropy must be 10 bytes");
  const random = BigInt(`0x${entropy.toString("hex")}`);
  return `${encodeUlidPart(BigInt(now), 10)}${encodeUlidPart(random, 16)}`;
}
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - ".jsonl".length - 26, segmentName.length - ".jsonl".length);
}
function deriveSlug(branchName) {
  const lowered = String(branchName ?? "").toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = substituted.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, "");
  return truncated || "segment";
}
function currentBranch(cwd = process.cwd()) {
  try {
    const out = execFileSync2("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out === "" || out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}
function readLineageToken(dir = ".adlc") {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== "object") return null;
  if (typeof token.segment !== "string" || typeof token.ulid !== "string" || typeof token.branch !== "string") return null;
  return token;
}
function writeLineageToken(dir = ".adlc", token) {
  mkdirSync4(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync3(p);
  const fd = openSync5(p, fsConstants3.O_WRONLY | fsConstants3.O_CREAT | fsConstants3.O_TRUNC | fsConstants3.O_NOFOLLOW);
  try {
    writeFileSync4(fd, JSON.stringify(token));
  } finally {
    closeSync5(fd);
  }
}
function normalizeManifestDirAndCwd(dir = ".adlc", opts = {}) {
  const effectiveDir = dir ?? ".adlc";
  if (opts?.cwd === void 0 || opts?.cwd === null) {
    const resolvedDir2 = resolve3(effectiveDir);
    const defaultCwd = effectiveDir === ".adlc" ? process.cwd() : dirname6(resolvedDir2);
    return { dir: resolvedDir2, cwd: defaultCwd };
  }
  const resolvedCwd = resolve3(opts.cwd);
  const resolvedDir = isAbsolute(effectiveDir) ? resolve3(effectiveDir) : effectiveDir !== ".adlc" && resolve3(dirname6(effectiveDir)) === resolvedCwd ? resolve3(effectiveDir) : resolve3(resolvedCwd, effectiveDir);
  return { dir: resolvedDir, cwd: resolvedCwd };
}
function peekOpenSegment(dir = ".adlc", opts = {}) {
  ({ dir, cwd: opts } = normalizeManifestDirAndCwd(dir, opts));
  const cwd = opts;
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    const { valid } = discoverSegments(dir);
    if (valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}
function firstEntryOf(dir = ".adlc", segmentName) {
  let fd;
  try {
    fd = openSync5(segmentPath(dir, segmentName), fsConstants3.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync3(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync5(fd);
  }
}
function recoverOpenSegment(dir = ".adlc", opts = {}) {
  let cwd;
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, opts));
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  const branch = currentBranch(cwd);
  if (branch === null) return null;
  const discovered = discoverSegments(dir);
  if (discovered.invalid.length > 0) {
    throw new Error(
      `manifest.d/ contains ${discovered.invalid.length} non-conforming filesystem object(s) (${discovered.invalid.map((i) => i.name).sort().join(", ")}) \u2014 one could be a disguised or tampered segment belonging to this branch, so recovery refuses rather than guess`
    );
  }
  const candidates = [];
  for (const name of discovered.valid) {
    const first = firstEntryOf(dir, name);
    if (first === OVERSIZED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry exceeds the ${MAX_FIRST_LINE_BYTES}-byte bounded-read cap \u2014 its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first === MALFORMED_FIRST_ENTRY) {
      throw new Error(
        `segment ${name}'s first entry could not be read or parsed \u2014 its branch cannot be determined, so it cannot be safely excluded as a candidate either; refusing to guess`
      );
    }
    if (first?.branch === branch) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous: ${candidates.length} committed segments declare branch "${branch}" as their own (${candidates.sort().join(", ")}) and no local .lineage token disambiguates them \u2014 refusing to guess; run \`adlc gate-manifest adopt\` to see the candidates and choose which lineage this checkout continues`
    );
  }
  return { name: candidates[0], isNew: false };
}
function assertSegmentPathCommittable(dir = ".adlc", name, opts = {}) {
  let probeCwd;
  ({ dir, cwd: probeCwd } = normalizeManifestDirAndCwd(dir, opts));
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  delete env.ADLC_MANIFEST_PRIVATE_KEY;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  const run = (args) => {
    try {
      execFileSync2("git", args, { cwd: probeCwd, env, stdio: "ignore" });
      return 0;
    } catch (err) {
      if (err.code === "ENOENT") return "no-git";
      return err.status ?? "error";
    }
  };
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return;
  const rel = relative(probeCwd, segmentPath(dir, name)).split(sep).join("/");
  const status = run(["check-ignore", "-q", "--", rel]);
  if (status === 0) {
    throw new Error(
      `refusing to mint segment ${name}: .gitignore would ignore its file, so evidence recorded there would exist only in this checkout \u2014 never in CI or any other clone; fix the ignore rules (gate-manifest enable names the required negation lines) and retry`
    );
  }
  if (status !== 1) {
    throw new Error(`git check-ignore failed while probing segment ${name} \u2014 cannot verify the segment is committable, refusing to record evidence blindly`);
  }
}
function entrySigValid(key, entry, { publicKey = null } = {}) {
  if (typeof entry?.sig !== "string" || entry.sig.length === 0) return false;
  if (entry.sigAlg === SIG_ALG_ED25519) {
    let verifierKey = publicKey;
    if (verifierKey === null && isEd25519PrivateKey(key)) {
      try {
        verifierKey = derivePublicKeyPem(key);
      } catch {
        return false;
      }
    }
    if (typeof verifierKey !== "string" || verifierKey.length === 0) return false;
    return verifyEntryEd25519(verifierKey, entry);
  }
  if (entry.sigAlg !== void 0) return false;
  if (key === null || typeof key !== "string" || key.length === 0 || isEd25519PrivateKey(key)) {
    return false;
  }
  const expected = createHmac("sha256", key).update(canonicalEntryBytes(entry)).digest("hex");
  const a = Buffer.from(entry.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function readRawLines(filePath) {
  if (!existsSync5(filePath)) return [];
  const content = readFileSync5(filePath, "utf8");
  return content.split("\n").map((line, i) => ({ line, lineNo: i + 1 })).filter(({ line }) => line.trim() !== "");
}
function resolveAnchor(anchor, chainsBySeq, rootExists) {
  if (anchor === null) {
    if (rootExists) return { ok: false, reason: "anchor: null is not permitted once a root exists" };
    return { ok: true };
  }
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    return { ok: false, reason: "anchor must be an object or null" };
  }
  const { segment, seq, lineHash } = anchor;
  if (typeof segment !== "string" || segment === "") {
    return { ok: false, reason: "anchor.segment must be a non-empty string" };
  }
  if (!Number.isInteger(seq) || seq < 1) {
    return { ok: false, reason: "anchor.seq must be a positive integer" };
  }
  if (typeof lineHash !== "string" || lineHash === "") {
    return { ok: false, reason: "anchor.lineHash must be a non-empty string" };
  }
  const target = chainsBySeq.get(segment);
  if (!target) return { ok: false, reason: `dangling anchor: no such segment '${segment}' in the forest` };
  const rawLine = target.get(seq);
  if (rawLine === void 0) return { ok: false, reason: `dangling anchor: segment '${segment}' has no entry with seq ${seq}` };
  if (sha256(rawLine) !== lineHash) return { ok: false, reason: `anchor lineHash mismatch for '${segment}' seq ${seq}` };
  return { ok: true };
}
function detectAnchorCycle(anchorBySegment) {
  const state = /* @__PURE__ */ new Map();
  for (const start of anchorBySegment.keys()) {
    if (state.get(start) === "done") continue;
    const path = [];
    let current = start;
    while (current !== void 0) {
      if (state.get(current) === "visiting") return { ok: false, segment: current };
      if (state.get(current) === "done") break;
      if (!anchorBySegment.has(current)) break;
      state.set(current, "visiting");
      path.push(current);
      const anchor = anchorBySegment.get(current);
      current = anchor === null ? void 0 : anchor.segment;
    }
    for (const seg of path) state.set(seg, "done");
  }
  return { ok: true };
}
function orderSegmentNames(segmentNames, anchorBySegment) {
  const depthCache = /* @__PURE__ */ new Map();
  function depthOf(name, seen = /* @__PURE__ */ new Set()) {
    if (depthCache.has(name)) return depthCache.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const anchor = anchorBySegment.get(name);
    const target = anchor?.segment;
    const depth = target && target !== "root" && anchorBySegment.has(target) ? depthOf(target, seen) + 1 : 0;
    depthCache.set(name, depth);
    return depth;
  }
  return [...segmentNames].sort((a, b) => {
    const depthDiff = depthOf(a) - depthOf(b);
    if (depthDiff !== 0) return depthDiff;
    const aa = anchorBySegment.get(a);
    const bb = anchorBySegment.get(b);
    const aSeg = aa?.segment ?? "";
    const bSeg = bb?.segment ?? "";
    if (aSeg !== bSeg) return aSeg < bSeg ? -1 : 1;
    const aSeq = aa?.seq ?? 0;
    const bSeq = bb?.seq ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aUlid = ulidOf(a);
    const bUlid = ulidOf(b);
    if (aUlid !== bUlid) return aUlid < bUlid ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function validateForestMarker(dir = ".adlc") {
  const path = markerPath(dir);
  let st;
  try {
    st = lstatSync5(path);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, present: false, auth: null };
    return { ok: false, reason: `cannot stat .store.json: ${err.message}` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  const parsed = readBoundedJsonNoFollow(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid or oversized .store.json marker" };
  }
  if (parsed.format !== MARKER_FORMAT || parsed.version !== MARKER_VERSION) {
    return { ok: false, reason: "invalid .store.json format or version" };
  }
  if (parsed.auth !== void 0 && parsed.auth !== "keyed" && parsed.auth !== "keyless") {
    return { ok: false, reason: "invalid .store.json auth mode" };
  }
  return { ok: true, present: true, auth: parsed.auth ?? null };
}
function hasManifestCutoverTail(rootRaw) {
  if (!Array.isArray(rootRaw) || rootRaw.length === 0) return false;
  try {
    const last = JSON.parse(rootRaw.at(-1).line);
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function checkForestSignedEra({
  declaredAuth = null,
  rootEmpty = false,
  rootCutover = false,
  segmentNames,
  anchorBySegment,
  rootSawSigned,
  rootFirstUnsigned = null,
  segmentResults
}) {
  if (declaredAuth === "keyed" && !rootSawSigned && rootFirstUnsigned) {
    return { ok: false, segment: "root", firstUnsigned: rootFirstUnsigned };
  }
  const ordered = orderSegmentNames(segmentNames, anchorBySegment);
  const anySegmentSigned = ordered.some((name) => Boolean(segmentResults.get(name)?.sawSignedEntry));
  const keyedForest = declaredAuth === "keyed" || declaredAuth === null && Boolean(rootCutover) && Boolean(rootSawSigned) || declaredAuth !== "keyless" && Boolean(rootEmpty) && anySegmentSigned;
  const signedSegments = /* @__PURE__ */ new Set();
  for (const name of ordered) {
    const res = segmentResults.get(name);
    const anchor = anchorBySegment.get(name);
    const parentSeg = anchor && anchor.segment !== "root" ? anchor.segment : null;
    const parentInSignedEra = keyedForest || parentSeg !== null && signedSegments.has(parentSeg);
    if (parentInSignedEra && res?.firstUnsigned) {
      return { ok: false, segment: name, firstUnsigned: res.firstUnsigned };
    }
    if (parentInSignedEra || res?.sawSignedEntry) {
      signedSegments.add(name);
    }
  }
  return { ok: true };
}
function checkForestEd25519Era({
  segmentNames,
  anchorBySegment,
  rootSawEd25519,
  segmentResults
}) {
  const ordered = orderSegmentNames(segmentNames, anchorBySegment);
  const ed25519Segments = /* @__PURE__ */ new Set();
  for (const name of ordered) {
    const res = segmentResults.get(name);
    const anchor = anchorBySegment.get(name);
    const parentSeg = anchor && anchor.segment !== "root" ? anchor.segment : null;
    const parentInEd25519Era = anchor?.segment === "root" && Boolean(rootSawEd25519) || parentSeg !== null && ed25519Segments.has(parentSeg);
    if (parentInEd25519Era && res?.firstNonEd25519) {
      return { ok: false, segment: name, firstNonEd25519: res.firstNonEd25519 };
    }
    if (parentInEd25519Era || res?.sawEd25519Entry) {
      ed25519Segments.add(name);
    }
  }
  return { ok: true };
}
function isUnsignedKeyedRoot(declaredAuth, key, requireSignatures, rootResult) {
  return key !== null && !isEd25519PrivateKey(key) && !requireSignatures && declaredAuth === "keyed" && rootResult.valid && rootResult.count > 0 && !rootResult.sawSignedEntry && rootResult.firstUnsigned !== null;
}
function verifyChain(nonEmpty, {
  key = null,
  publicKey = null,
  requireSignatures = false,
  anchorOnFirst = false,
  allowPreEd25519Only = false
} = {}) {
  if (nonEmpty.length === 0) {
    if (anchorOnFirst) {
      return {
        valid: false,
        message: "empty segment file has no first entry to carry the required anchor",
        count: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason: "empty segment file" },
        lastRawLine: null,
        firstAnchor: void 0,
        sawSignedEntry: false,
        firstUnsigned: null,
        sawEd25519Entry: false,
        firstNonEd25519: null
      };
    }
    return {
      valid: true,
      message: "empty manifest",
      count: 0,
      signed: false,
      break: null,
      lastRawLine: null,
      firstAnchor: void 0,
      sawSignedEntry: false,
      firstUnsigned: null,
      sawEd25519Entry: false,
      firstNonEd25519: null
    };
  }
  const hasHmacKey = key !== null && !isEd25519PrivateKey(key);
  const hasEd25519Verifier = publicKey !== null || isEd25519PrivateKey(key);
  const hasAnyVerifier = hasHmacKey || hasEd25519Verifier;
  let prevRawLine = null;
  let prevSeq = null;
  let firstAnchor;
  let seenSignedEntry = false;
  let seenEd25519Entry = false;
  let firstUnsigned = null;
  let firstNonEd25519 = null;
  for (const { line, lineNo } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail3(lineNo - 1, { seq: null, lineNo, reason: "malformed JSON" }, `chain broken at line ${lineNo}: malformed JSON`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail3(lineNo - 1, { seq: null, lineNo, reason: "entry must be an object" }, `chain broken at line ${lineNo}: entry must be an object`);
    }
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return fail3(lineNo - 1, { seq: entry.seq ?? null, lineNo, reason: "invalid seq" }, `chain broken at line ${lineNo}: seq must be a positive integer`);
    }
    const isFirst = prevRawLine === null;
    if (isFirst) {
      if (entry.prev !== null) {
        return fail3(0, { seq: entry.seq, lineNo, reason: "first entry prev must be null" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry prev must be null`);
      }
    } else {
      const expected = sha256(prevRawLine);
      if (entry.prev !== expected) {
        return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "prev hash mismatch" }, `chain broken at seq ${entry.seq} (line ${lineNo}): prev hash mismatch`);
      }
    }
    if (isFirst) {
      if (entry.seq !== 1) {
        return fail3(0, { seq: entry.seq, lineNo, reason: "first entry seq must be 1" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry seq must be 1`);
      }
    } else if (entry.seq !== prevSeq + 1) {
      return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "seq not contiguous" }, `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be contiguous (+1 from previous)`);
    }
    const hasAnchor = Object.hasOwn(entry, "anchor");
    if (isFirst) {
      firstAnchor = hasAnchor ? entry.anchor : void 0;
      if (anchorOnFirst && !hasAnchor) {
        return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "segment first entry missing required anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): segment first entry missing required anchor field`);
      }
      if (!anchorOnFirst && hasAnchor) {
        return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "root entry must not carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): root entry must not carry an anchor field`);
      }
    } else if (hasAnchor) {
      return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "only a segment's first entry may carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): only a segment's first entry may carry an anchor field`);
    }
    if (hasAnyVerifier) {
      const hasSig = entry.sig !== void 0 && entry.sig !== null;
      if (entry.sigAlg === SIG_ALG_ED25519) {
        if (!hasSig) {
          return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
        if (!entrySigValid(key, entry, { publicKey })) {
          return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
        }
        seenSignedEntry = true;
        seenEd25519Entry = true;
      } else if (entry.sigAlg !== void 0) {
        return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsupported signature algorithm`);
      } else {
        if (seenEd25519Entry) {
          return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "downgrade after ed25519 entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): non-ed25519 entry after ed25519 era`);
        }
        if (firstNonEd25519 === null) firstNonEd25519 = { seq: entry.seq, lineNo };
        if (!hasSig) {
          if (firstUnsigned === null) firstUnsigned = { seq: entry.seq, lineNo };
          if (hasHmacKey) {
            const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
            if (!toleratedLegacyPrefix) {
              return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
            }
          }
        } else if (hasHmacKey) {
          if (!entrySigValid(key, entry, { publicKey })) {
            return fail3(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
          }
          seenSignedEntry = true;
        }
      }
    }
    prevRawLine = line;
    prevSeq = entry.seq;
  }
  if (requireSignatures && !hasHmacKey && hasEd25519Verifier && !allowPreEd25519Only && !seenEd25519Entry) {
    const target = firstNonEd25519 ?? { seq: null, lineNo: null };
    return fail3(
      nonEmpty.length,
      { seq: target.seq, lineNo: target.lineNo, reason: "no valid ed25519 signatures" },
      "chain broken: no valid ed25519 signatures found"
    );
  }
  const signed = requireSignatures && (hasHmacKey || hasEd25519Verifier && seenEd25519Entry);
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${nonEmpty.length} entries)` : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
    lastRawLine: prevRawLine,
    firstAnchor,
    sawSignedEntry: seenSignedEntry,
    firstUnsigned,
    sawEd25519Entry: seenEd25519Entry,
    firstNonEd25519
  };
  function fail3(count, breakInfo, message) {
    return {
      valid: false,
      message,
      count,
      signed: false,
      break: breakInfo,
      lastRawLine: null,
      firstAnchor: void 0,
      sawSignedEntry: false,
      firstUnsigned: null,
      sawEd25519Entry: false,
      firstNonEd25519: null
    };
  }
}
function seqMap(nonEmpty) {
  const m = /* @__PURE__ */ new Map();
  for (const { line } of nonEmpty) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && Number.isInteger(entry.seq)) m.set(entry.seq, line);
  }
  return m;
}
function verifyManifestForest(dir = ".adlc", { requireSignatures = true, requireEntries = false, key = null, publicKey = void 0 } = {}) {
  let effectivePublicKey = publicKey;
  if (effectivePublicKey === void 0) {
    const adminPub = readAdminPublicKey(dir);
    if (adminPub.status === "error") {
      return {
        valid: false,
        message: `${ADMIN_PUB_FILENAME}: ${adminPub.reason}`,
        count: 0,
        segments: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason: adminPub.reason, segment: ADMIN_PUB_FILENAME }
      };
    }
    effectivePublicKey = adminPub.publicKey;
  }
  const hasHmacKey = key !== null && !isEd25519PrivateKey(key);
  const hasEd25519Verifier = effectivePublicKey !== null || isEd25519PrivateKey(key);
  const rootRaw = readRawLines(join7(dir, "manifest.jsonl"));
  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments(dir);
  if (invalidSegments.length > 0) {
    const first = invalidSegments[0];
    return {
      valid: false,
      message: `manifest.d/${first.name}: ${first.reason}`,
      count: 0,
      segments: segmentNames.length,
      signed: false,
      break: { seq: null, lineNo: null, reason: first.reason, segment: first.name }
    };
  }
  const markerCheck = validateForestMarker(dir);
  if (!markerCheck.ok) {
    return {
      valid: false,
      message: `manifest.d/.store.json: ${markerCheck.reason}`,
      count: 0,
      segments: segmentNames.length,
      signed: false,
      break: { seq: null, lineNo: null, reason: markerCheck.reason, segment: ".store.json" }
    };
  }
  if (segmentNames.length === 0) {
    if (requireEntries && rootRaw.length === 0) {
      const reason = "empty manifest (--require-entries requires at least one entry)";
      return {
        valid: false,
        message: reason,
        count: 0,
        segments: 0,
        signed: false,
        break: { seq: null, lineNo: null, reason, segment: "root" }
      };
    }
    const result = verifyChain(rootRaw, { key, publicKey: effectivePublicKey, requireSignatures, anchorOnFirst: false });
    if (isUnsignedKeyedRoot(markerCheck.auth, key, requireSignatures, result)) {
      const u = result.firstUnsigned;
      return { valid: false, message: `chain broken at seq ${u.seq} (line ${u.lineNo}): unsigned entry`, count: result.count, segments: 0, signed: false, break: { seq: u.seq, lineNo: u.lineNo, reason: "unsigned entry", segment: "root" } };
    }
    return { valid: result.valid, message: result.message, count: result.count, segments: 0, signed: result.signed, break: result.break ? { ...result.break, segment: "root" } : null };
  }
  const rootResult = verifyChain(rootRaw, {
    key,
    publicKey: effectivePublicKey,
    requireSignatures,
    anchorOnFirst: false,
    allowPreEd25519Only: true
  });
  if (!rootResult.valid) {
    return { valid: false, message: rootResult.message, count: rootResult.count, segments: segmentNames.length, signed: false, break: { ...rootResult.break, segment: "root" } };
  }
  const chainsBySeq = /* @__PURE__ */ new Map();
  chainsBySeq.set("root", seqMap(rootRaw));
  const anchorBySegment = /* @__PURE__ */ new Map();
  const segmentResults = /* @__PURE__ */ new Map();
  let totalCount = rootResult.count;
  let allSigned = rootResult.count === 0 ? true : rootResult.signed;
  let forestSawEd25519 = rootResult.sawEd25519Entry;
  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const result = verifyChain(raw, {
      key,
      publicKey: effectivePublicKey,
      requireSignatures,
      anchorOnFirst: true,
      allowPreEd25519Only: true
    });
    if (!result.valid) {
      return { valid: false, message: `manifest.d/${name}: ${result.message}`, count: totalCount + result.count, segments: segmentNames.length, signed: false, break: { ...result.break, segment: name } };
    }
    chainsBySeq.set(name, seqMap(raw));
    anchorBySegment.set(name, result.firstAnchor === void 0 ? null : result.firstAnchor);
    segmentResults.set(name, result);
    totalCount += result.count;
    allSigned = allSigned && (result.count === 0 ? true : result.signed);
    if (result.sawEd25519Entry) forestSawEd25519 = true;
  }
  for (const name of segmentNames) {
    const anchor = anchorBySegment.get(name);
    const resolved = resolveAnchor(anchor, chainsBySeq, rootResult.count > 0);
    if (!resolved.ok) {
      return { valid: false, message: `manifest.d/${name}: ${resolved.reason}`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: resolved.reason, segment: name } };
    }
  }
  const cycleCheck = detectAnchorCycle(anchorBySegment);
  if (!cycleCheck.ok) {
    return { valid: false, message: `manifest.d/${cycleCheck.segment}: anchor cycle detected`, count: totalCount, segments: segmentNames.length, signed: false, break: { seq: null, lineNo: null, reason: "anchor cycle", segment: cycleCheck.segment } };
  }
  if (hasEd25519Verifier) {
    const edEra = checkForestEd25519Era({
      segmentNames,
      anchorBySegment,
      rootSawEd25519: rootResult.sawEd25519Entry,
      segmentResults
    });
    if (!edEra.ok) {
      const u = edEra.firstNonEd25519;
      const msg = `chain broken at seq ${u.seq} (line ${u.lineNo}): non-ed25519 entry after ed25519 era`;
      return {
        valid: false,
        message: `manifest.d/${edEra.segment}: ${msg}`,
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: u.seq, lineNo: u.lineNo, reason: "downgrade after ed25519 entry", segment: edEra.segment }
      };
    }
    if (requireSignatures && !hasHmacKey && totalCount > 0 && !forestSawEd25519) {
      return {
        valid: false,
        message: "manifest forest has no valid ed25519 signatures",
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: null, lineNo: null, reason: "no valid ed25519 signatures", segment: "root" }
      };
    }
  }
  if (hasHmacKey && !requireSignatures) {
    const eraCheck = checkForestSignedEra({
      declaredAuth: markerCheck.auth,
      rootEmpty: rootRaw.length === 0,
      rootCutover: hasManifestCutoverTail(rootRaw),
      segmentNames,
      anchorBySegment,
      rootSawSigned: rootResult.sawSignedEntry,
      rootFirstUnsigned: rootResult.firstUnsigned,
      segmentResults
    });
    if (!eraCheck.ok) {
      const u = eraCheck.firstUnsigned;
      const msg = `chain broken at seq ${u.seq} (line ${u.lineNo}): unsigned entry`;
      const prefix = eraCheck.segment === "root" ? "" : `manifest.d/${eraCheck.segment}: `;
      return {
        valid: false,
        message: `${prefix}${msg}`,
        count: totalCount,
        segments: segmentNames.length,
        signed: false,
        break: { seq: u.seq, lineNo: u.lineNo, reason: "unsigned entry", segment: eraCheck.segment }
      };
    }
  }
  const signed = hasHmacKey ? allSigned : hasEd25519Verifier && requireSignatures && forestSawEd25519;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${totalCount} entries, ${segmentNames.length} segments)` : `manifest ok (${totalCount} entries, ${segmentNames.length} segments)`,
    count: totalCount,
    segments: segmentNames.length,
    signed,
    break: null
  };
}
function isChainIntact(lines, key, publicKey = null) {
  return verifyChain(
    lines.map((line, i) => ({ line, lineNo: i + 1 })),
    { key, publicKey, requireSignatures: false, anchorOnFirst: true }
  ).valid;
}
function resolveOpenSegment(dir = ".adlc", opts = {}) {
  const key = opts?.key ?? null;
  let cwd;
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, opts));
  let effectivePublicKey = opts?.publicKey;
  if (effectivePublicKey === void 0) {
    const adminPub = readAdminPublicKey(dir);
    if (adminPub.status === "error") {
      throw new Error(`${ADMIN_PUB_FILENAME}: ${adminPub.reason}`);
    }
    effectivePublicKey = adminPub.publicKey;
  }
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === "keyed" && key === null) {
    throw new Error(
      "this forest was activated in keyed mode, but no signing key was provided for this write \u2014 an unsigned entry here would permanently strand every keyed clone of this branch; configure the manifest key"
    );
  }
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  if (key !== null) {
    const recovered = recoverOpenSegment(dir, { cwd });
    if (recovered) {
      let lines = [];
      const segFile = segmentPath(dir, recovered.name);
      if (existsSync5(segFile)) {
        lines = readFileSync5(segFile, "utf8").split("\n").filter((l) => l.trim() !== "");
      }
      let first = null;
      try {
        first = JSON.parse(lines[0]);
      } catch {
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first, { publicKey: effectivePublicKey });
      if (!isChainIntact(lines, key, effectivePublicKey) || !firstAuthenticated) {
        throw new Error(
          `segment ${recovered.name} declares this branch but cannot be authenticated with the configured key (broken chain, or its branch-bearing first entry lacks a verified v2 signature) \u2014 refusing to extend it, and refusing to mint a duplicate past it (that would silently fork this branch's lineage)`
        );
      }
      return recovered;
    }
  } else {
    let candidateExists = false;
    try {
      candidateExists = recoverOpenSegment(dir, { cwd }) !== null;
    } catch {
      candidateExists = true;
    }
    if (candidateExists) {
      throw new Error(
        "a committed segment already declares this branch, and with no signing key this writer can neither authenticate and extend it nor safely mint alongside it (a fresh token would shadow the committed evidence from every later read) \u2014 configure the manifest key, or restore the local .lineage token"
      );
    }
  }
  const branch = currentBranch(cwd);
  const rootPath = join7(dir, "manifest.jsonl");
  let rootLast = null;
  if (existsSync5(rootPath)) {
    const rootLines = readFileSync5(rootPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    rootLast = rootLines.at(-1) ?? null;
  }
  let anchor = null;
  if (rootLast !== null) {
    let lastEntry = null;
    try {
      lastEntry = JSON.parse(rootLast);
    } catch {
    }
    if (lastEntry) anchor = { segment: "root", seq: lastEntry.seq, lineHash: sha256(rootLast) };
  }
  const ulid = generateSegmentUlid();
  const slug = deriveSlug(branch ?? "");
  const name = `${slug}-${ulid}.jsonl`;
  assertSegmentPathCommittable(dir, name, { cwd });
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...branch !== null ? { branch } : {} };
}
var SEGMENT_DIRNAME, SEGMENT_NAME_RE, RESERVED_NAMES, MARKER_NAME, LINEAGE_NAME, MARKER_FORMAT, MARKER_VERSION, LOCK_SUFFIX, MAX_LOCAL_JSON_BYTES, MAX_LOCK_OWNER_BYTES, MAX_FIRST_LINE_BYTES, ULID_ALPHABET, OVERSIZED_FIRST_ENTRY, MALFORMED_FIRST_ENTRY;
var init_manifest_primitives = __esm({
  "packages/tickets/lib/manifest-primitives.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    init_manifest_crypto();
    SEGMENT_DIRNAME = "manifest.d";
    SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
    RESERVED_NAMES = /* @__PURE__ */ new Set([".store.json", ".lineage"]);
    MARKER_NAME = ".store.json";
    LINEAGE_NAME = ".lineage";
    MARKER_FORMAT = "adlc-manifest-segments";
    MARKER_VERSION = 1;
    LOCK_SUFFIX = ".lock";
    MAX_LOCAL_JSON_BYTES = 4096;
    MAX_LOCK_OWNER_BYTES = 512;
    MAX_FIRST_LINE_BYTES = 65536;
    ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    OVERSIZED_FIRST_ENTRY = /* @__PURE__ */ Symbol("oversized-first-entry");
    MALFORMED_FIRST_ENTRY = /* @__PURE__ */ Symbol("malformed-first-entry");
  }
});

// packages/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
function readRawLines2(filePath) {
  if (!existsSync6(filePath)) return [];
  return readFileSync6(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
}
function parseLines(lines) {
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
function forestChainsIntact(dir, { key = null, publicKey = void 0 } = {}) {
  return verifyManifestForest(dir, { key, publicKey, requireSignatures: false }).valid;
}
function readForestEntries(dir) {
  const root = parseLines(readRawLines2(join8(dir, "manifest.jsonl")));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines2(segmentPath(dir, name))));
  return [...root, ...segments];
}
var init_manifest_segments = __esm({
  "packages/tickets/lib/manifest-segments.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_manifest_primitives();
  }
});

// packages/tickets/lib/key-contract.mjs
function validateKeyParam(key) {
  if (key === null) return null;
  if (typeof key === "string" && key.length > 0) return key;
  throw new TypeError(
    `manifest key parameter must be a non-empty string (a key) or null (explicitly no key); got ${key === "" ? "'' (empty string)" : typeof key}. Resolve the environment in the bin (getKey()) and thread the value down \u2014 library code never reads process.env.`
  );
}
var init_key_contract = __esm({
  "packages/tickets/lib/key-contract.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_manifest_crypto();
  }
});

// packages/tickets/lib/evidence.mjs
import { closeSync as closeSync6, existsSync as existsSync7, fsyncSync as fsyncSync3, mkdirSync as mkdirSync5, openSync as openSync6, readFileSync as readFileSync7, unlinkSync as unlinkSync4, writeFileSync as writeFileSync5 } from "node:fs";
import { createHmac as createHmac2, randomUUID as randomUUID3 } from "node:crypto";
import { hostname as hostname3 } from "node:os";
import { dirname as dirname7, join as join9 } from "node:path";
function withManifestLock(path, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath2 = `${path}.lock`;
  mkdirSync5(dirname7(path), { recursive: true });
  const owner = { version: 1, token: randomUUID3(), pid: process.pid, hostname: hostname3(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync6(lockPath2, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt < retries) sleep2(delayMs);
      continue;
    }
    try {
      writeFileSync5(descriptor, `${JSON.stringify(owner)}
`);
      fsyncSync3(descriptor);
    } finally {
      closeSync6(descriptor);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync7(lockPath2, "utf8"));
        if (current.token === owner.token) unlinkSync4(lockPath2);
      } catch {
      }
    }
  }
  throw conflict("MANIFEST_LOCK_TIMEOUT", `could not acquire manifest lock: ${lockPath2}`);
}
function lastLine(content) {
  return content.split("\n").reverse().find((line) => line.trim()) ?? null;
}
function sign(key, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac2("sha256", key).update(JSON.stringify(canonical)).digest("hex");
}
function signV2(key, entry) {
  const { sig: _sig, segment: _segment, ...signed } = entry;
  return createHmac2("sha256", key).update(canonicalJson(signed)).digest("hex");
}
function auditFieldsMatch(entry, data, acceptLegacyMatch) {
  if (acceptLegacyMatch && AUDIT_FIELDS.every((field) => entry.data?.[field] === void 0)) return true;
  for (const field of AUDIT_FIELDS) {
    if (canonicalJson(entry.data?.[field] ?? null) !== canonicalJson(data[field] ?? null)) return false;
  }
  return true;
}
function findMatchingEvidence(entries, { gate, data, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, transactionId, key = null, acceptLegacyMatch = false }) {
  for (const entry of entries) {
    if (entry?.data?.transactionId === transactionId && entry?.data?.action === action) {
      if (key !== null && !entrySigValid(key, entry)) continue;
      const matches = entry.gate === gate && (entry.ticket ?? null) === ticketId && entry.data.operation === operation && (entry.data.ticketHash ?? null) === ticketHash2 && entry.data.storeHash === storeHash2 && (entry.data.archiveHash ?? null) === archiveHash && entry.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry, data, acceptLegacyMatch);
      if (!matches) throw conflict("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
      return entry;
    }
  }
  return null;
}
function assertEd25519KeyMatchesAdminPub(dir, key) {
  if (!isEd25519PrivateKey(key)) return;
  const derivedPub = derivePublicKeyPem(key);
  const adminPub = readAdminPublicKey(dir);
  if (adminPub.status === "error") {
    throw conflict("INVALID_MANIFEST", `${ADMIN_PUB_FILENAME}: ${adminPub.reason}`);
  }
  if (adminPub.status === "ok" && adminPub.publicKey !== derivedPub) {
    throw conflict("KEY_MISMATCH", `Ed25519 private key does not match ${ADMIN_PUB_FILENAME}`);
  }
}
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch = false }) {
  assertEd25519KeyMatchesAdminPub(dir, key);
  return withManifestLock(lineagePath(dir), () => {
    if (!forestChainsIntact(dir, { key })) {
      throw conflict("INVALID_MANIFEST", "manifest forest is invalid: a segment or root chain is broken, or an entry is unsigned/forged \u2014 refusing to append or trust the idempotency scan");
    }
    const existing = findMatchingEvidence(readForestEntries(dir), { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch });
    if (existing) return existing;
    const resolved = resolveOpenSegment(dir, { cwd: dirname7(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync5(dirname7(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync7(targetPath) ? readFileSync7(targetPath, "utf8") : "";
      const rawLines = content.split("\n").filter((line) => line.trim() !== "");
      if (resolved.isNew && rawLines.length > 0) {
        throw conflict("INVALID_MANIFEST", `segment ${resolved.name} was expected to be new but already has content`);
      }
      if (!resolved.isNew && rawLines.length === 0) {
        throw conflict("INVALID_MANIFEST", `segment ${resolved.name} was expected to already be open with content but is empty or missing`);
      }
      let previous = null;
      for (const line of rawLines) {
        try {
          previous = JSON.parse(line);
        } catch {
          throw conflict("INVALID_MANIFEST", `segment ${resolved.name} contains malformed JSON`);
        }
      }
      const prevRawLine = rawLines.at(-1) ?? null;
      const entry = {
        seq: typeof previous?.seq === "number" ? previous.seq + 1 : 1,
        // `branch` (T-MANIFEST-FOREST, fourth round): the EXACT git branch
        // that minted this segment, alongside `anchor` — the non-lossy
        // identity recoverOpenSegment matches on. Mirrors
        // @adlc/gate-manifest/lib/segment-writer.mjs's identical addition.
        ...resolved.isNew ? { anchor: resolved.anchor, ...resolved.branch !== void 0 ? { branch: resolved.branch } : {} } : {},
        gate,
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        ...ticketId ? { ticket: ticketId } : {},
        data,
        files: {},
        prev: prevRawLine === null ? null : sha256(prevRawLine)
      };
      if (key) {
        entry.sigVersion = 2;
        if (isEd25519PrivateKey(key)) {
          entry.sigAlg = SIG_ALG_ED25519;
          entry.sig = signEntryEd25519(key, entry);
        } else {
          entry.sig = signV2(key, entry);
        }
      }
      const descriptor = openSync6(targetPath, "a");
      try {
        writeFileSync5(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync3(descriptor);
      } finally {
        closeSync6(descriptor);
      }
      fsyncDirectory(dirname7(targetPath));
      return entry;
    });
  });
}
function recordTicketEvidence(root, {
  key,
  transactionId,
  operation,
  action = "apply",
  ticketId = null,
  ticketHash: ticketHash2 = null,
  storeHash: storeHash2,
  archiveHash = null,
  revision = process.env.ADLC_REVISION ?? null,
  gate = `ticket-${operation}`,
  bypass = false,
  storeHashBefore = null,
  ticketIds = null,
  acceptLegacyMatch = false
} = {}) {
  const signingKey = validateKeyParam(key);
  const dir = join9(root, ".adlc");
  const data = {
    operation,
    action,
    transactionId,
    revision,
    ticketHash: ticketHash2,
    storeHash: storeHash2,
    ...archiveHash ? { archiveHash } : {},
    bindingScope: ticketId ? "ticket" : "store",
    ...bypass ? {
      op: operation,
      ticketId,
      // A write that moves SEVERAL tickets at once (a prune sweep) names them all:
      // store hashes prove that something changed, not what this entry authorized.
      ...ticketIds ? { ticketIds } : {},
      storeHashBefore,
      storeHashAfter: storeHash2,
      bypass: true
    } : {}
  };
  if (isSegmentedRepo(dir)) {
    return recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key: signingKey, acceptLegacyMatch });
  }
  assertEd25519KeyMatchesAdminPub(dir, signingKey);
  const path = join9(root, ".adlc/manifest.jsonl");
  return withManifestLock(path, () => {
    const content = existsSync7(path) ? readFileSync7(path, "utf8") : "";
    const lines = content.split("\n").filter((line) => line.trim());
    if (isSegmentedRepo(dir)) {
      throw conflict("MANIFEST_FROZEN", "manifest chain is frozen; this repo uses .adlc/manifest.d/ \u2014 upgrade adlc if you are seeing this locally");
    }
    for (const line of lines) {
      try {
        const entry2 = JSON.parse(line);
        if (entry2.data?.transactionId === transactionId && entry2.data?.action === action) {
          if (signingKey !== null && !entrySigValid(signingKey, entry2)) continue;
          const matches = entry2.gate === gate && (entry2.ticket ?? null) === ticketId && entry2.data.operation === operation && (entry2.data.ticketHash ?? null) === ticketHash2 && entry2.data.storeHash === storeHash2 && (entry2.data.archiveHash ?? null) === archiveHash && entry2.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry2, data, acceptLegacyMatch);
          if (!matches) throw conflict("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
          return entry2;
        }
      } catch (error) {
        if (error?.code === "EVIDENCE_IDEMPOTENCY_CONFLICT") throw error;
        throw conflict("INVALID_MANIFEST", "cannot append ticket evidence to a malformed manifest");
      }
    }
    if (lines.length === 0) {
      let hasExistingSegments;
      try {
        hasExistingSegments = readForestEntries(dir).length > 0;
      } catch {
        hasExistingSegments = false;
      }
      if (hasExistingSegments) {
        throw conflict("MANIFEST_FROZEN", "refusing to create the root manifest: manifest.d/ already holds segment(s) anchored to nothing (anchor: null), legal only in a rootless forest \u2014 this usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted");
      }
    }
    const previous = lastLine(content);
    const prior = previous ? JSON.parse(previous) : null;
    const entry = {
      seq: typeof prior?.seq === "number" ? prior.seq + 1 : 1,
      gate,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...ticketId ? { ticket: ticketId } : {},
      data,
      files: {},
      prev: previous ? sha256(previous) : null
    };
    if (signingKey) {
      if (isEd25519PrivateKey(signingKey)) {
        entry.sigVersion = 2;
        entry.sigAlg = SIG_ALG_ED25519;
        entry.sig = signEntryEd25519(signingKey, entry);
      } else {
        entry.sig = sign(signingKey, entry);
      }
    }
    const descriptor = openSync6(path, "a");
    try {
      writeFileSync5(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync3(descriptor);
    } finally {
      closeSync6(descriptor);
    }
    fsyncDirectory(dirname7(path));
    return entry;
  });
}
var sleep2, AUDIT_FIELDS;
var init_evidence = __esm({
  "packages/tickets/lib/evidence.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_errors();
    init_canonical();
    init_durability();
    init_manifest_segments();
    init_manifest_primitives();
    init_key_contract();
    sleep2 = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    AUDIT_FIELDS = ["bypass", "op", "ticketId", "storeHashBefore", "storeHashAfter", "ticketIds"];
  }
});

// packages/tickets/lib/trust-root.mjs
import { existsSync as existsSync8, lstatSync as lstatSync6, readFileSync as readFileSync8, readdirSync as readdirSync3 } from "node:fs";
import { join as join10 } from "node:path";
function assertNotSymlink(path) {
  let stat;
  try {
    stat = lstatSync6(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw operational("TRUST_ROOT_PATH_UNREADABLE", `cannot determine whether ${path} holds trust-root evidence: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw invalid("UNSAFE_STORE_PATH", `${path} must be a real path, not a symlink \u2014 trust-root evidence read through a link is not this repo's own`);
  }
}
function storeDeclaresRails(tickets) {
  if (!Array.isArray(tickets)) return true;
  return tickets.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const rails = item.rails;
    if (rails === void 0) return false;
    if (!Array.isArray(rails)) return true;
    return rails.length > 0;
  });
}
function archiveDeclaresRails(root) {
  const directory = join10(root, ARCHIVE_DIRECTORY);
  const legacy = join10(root, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync8(directory)) {
    let entries;
    try {
      entries = readdirSync3(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    let sawMarker = false;
    for (const entry of entries) {
      if (entry.name === STORE_MARKER) {
        try {
          const marker = JSON.parse(readFileSync8(join10(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join10(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync8(join10(directory, entry.name), "utf8"));
      } catch {
        return true;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.id !== "string") return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync8(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync8(legacy, "utf8"));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function manifestRecordsBypass(root) {
  const rootManifest = join10(root, ".adlc", "manifest.jsonl");
  const segments = join10(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync8(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join10(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join10(segments, entry.name));
      }
    } catch {
      return true;
    }
  }
  for (const file of files) {
    if (!existsSync8(file)) continue;
    let text;
    try {
      text = readFileSync8(file, "utf8");
    } catch {
      return true;
    }
    if (!text.includes('"bypass"') && !text.includes("rails-bypass")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"bypass"') && !line.includes("rails-bypass")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.data?.bypass === true || entry?.gate === "rails-bypass") return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}
function repoDeclaresRails(root, tickets) {
  assertNotSymlink(join10(root, ".adlc"));
  return storeDeclaresRails(tickets) || archiveDeclaresRails(root) || manifestRecordsBypass(root);
}
function assertWriteIsSignable({ key, allowUnsigned = false } = {}) {
  const resolved = validateKeyParam(key);
  if (resolved !== null || allowUnsigned) return;
  throw policy(
    "MANIFEST_KEY_REQUIRED",
    "this ticket store is a frozen trust root (a ticket declares rails), so mutating it is an audited override \u2014 and ADLC_MANIFEST_KEY is not set, so the audit entry would be written UNSIGNED, proving nothing about who made the change. Refusing before the write: nothing has changed.\n  Set ADLC_MANIFEST_KEY and re-run. It is commonly kept in the MAIN checkout's gitignored .env.local, which is ABSENT from a git worktree \u2014 from a worktree, export it explicitly.\n  To record an UNSIGNED audit entry on purpose, pass --allow-unsigned."
  );
}
function assertSignableTrustRootWrite(tickets, { key, allowUnsigned = false, root = "." } = {}) {
  if (!repoDeclaresRails(root, tickets)) return false;
  assertWriteIsSignable({ key, allowUnsigned });
  return true;
}
var STORE_MARKER;
var init_trust_root = __esm({
  "packages/tickets/lib/trust-root.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_errors();
    init_key_contract();
    STORE_MARKER = ".store.json";
  }
});

// packages/tickets/lib/transaction.mjs
import { existsSync as existsSync9, readFileSync as readFileSync9 } from "node:fs";
import { basename, dirname as dirname8, isAbsolute as isAbsolute2, join as join11, relative as relative2, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
function journalPath(root, path) {
  const absolute = resolve4(path);
  const rel = relative2(resolve4(root), absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute2(rel) ? rel : absolute;
}
function evidenceBinding(before, tickets, ticketId, beforeTicketId = null) {
  const priorId = beforeTicketId ?? ticketId;
  const desired = ticketId ? tickets.find((ticket) => ticket.id === ticketId) : null;
  const logicalTicketHash = desired ? ticketHash(desired) : null;
  return {
    beforeTicketId: priorId,
    beforeTicketHash: priorId ? before.ticketHashes[priorId] ?? (priorId === ticketId ? logicalTicketHash : null) : null,
    afterTicketHash: ticketId ? logicalTicketHash ?? before.ticketHashes[priorId] ?? null : null
  };
}
function transactionChangesAnything(before, tickets, auxiliaryOperations) {
  return storeHash(tickets) !== before.hash || auxiliaryOperations.length > 0;
}
function bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) {
  if (!assertSignableTrustRootWrite(before.tickets, { key, allowUnsigned, root })) return null;
  return { gate: evidenceRequired ? `ticket-${operation}` : "ticket-mutation", storeHashBefore: before.hash };
}
function applyLegacyTransaction(store, tickets, { expectedSnapshotHash, operation = "update", evidenceRequired = false, ticketId = null, beforeTicketId = null, root = ".", faultInjector = null, lock: existingLock = null, key = null, allowUnsigned = false } = {}) {
  key = validateKeyParam(key);
  validateTickets(tickets);
  const transactionId = randomUUID4();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join11(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) : null;
    const target = resolve4(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join11(transactionRoot, "stage", basename(store.path));
    const backup = join11(transactionRoot, "backup", basename(store.path));
    durableMkdir(dirname8(stage));
    durableMkdir(dirname8(backup));
    durableWrite(stage, prettyCanonicalJson({ tickets }));
    durableCopy(target, backup);
    const afterHash = storeHash(tickets);
    const binding = evidenceBinding(before, tickets, ticketId, beforeTicketId);
    const journal = {
      version: 1,
      id: transactionId,
      operation,
      state: "prepared",
      beforeHash: before.hash,
      afterHash,
      evidenceRequired,
      bypassAudit: bypassAudit !== null,
      ticketId,
      ...binding,
      storePath: recordedTarget,
      operations: [{
        role: "legacy-store",
        action: "write",
        filename: recordedTarget,
        target: recordedTarget,
        stage: relative2(root, stage),
        backup: relative2(root, backup),
        beforeHash: fileHash(backup),
        afterHash: fileHash(stage)
      }]
    };
    durableWrite(join11(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    faultInjector?.("journal-prepared", { transactionId, operations: 1 });
    const temporary = `${target}.txn-${transactionId}`;
    durableCopy(stage, temporary);
    durableRename(temporary, target);
    faultInjector?.("operation-applied:1", { transactionId, operation: journal.operations[0] });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid("TRANSACTION_VERIFY_FAILED", `transaction produced ${after.hash}, expected ${afterHash}`);
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root, {
      key,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}
    });
    journal.state = "complete";
    durableWrite(join11(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync9(join11(transactionRoot, "journal.json")) && existsSync9(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}
var fileHash;
var init_transaction = __esm({
  "packages/tickets/lib/transaction.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_schema();
    init_evidence();
    init_durability();
    init_key_contract();
    init_trust_root();
    fileHash = (path) => sha256(readFileSync9(path));
  }
});

// packages/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync10, lstatSync as lstatSync7, readFileSync as readFileSync10 } from "node:fs";
import { basename as basename2, dirname as dirname9 } from "node:path";
function repositoryRootFor(path, explicit) {
  if (explicit !== null && explicit !== void 0) return explicit;
  const parent = dirname9(path);
  if (basename2(path) === basename2(LEGACY_FILE) && basename2(parent) === dirname9(LEGACY_FILE)) {
    return dirname9(parent);
  }
  throw invalid(
    "AMBIGUOUS_STORE_ROOT",
    `cannot infer which repository governs ${path}: it is not the canonical <root>/${LEGACY_FILE} layout, so the trust-root evidence (archive, manifest, recorded overrides) would be read from the wrong directory and a frozen store could be written keylessly. Pass an explicit { root }.`
  );
}
var LegacyTicketStore;
var init_legacy = __esm({
  "packages/tickets/lib/stores/legacy.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_transaction();
    init_constants();
    init_errors();
    init_schema();
    init_snapshot();
    LegacyTicketStore = class {
      constructor(path = LEGACY_FILE) {
        this.path = path;
      }
      exists() {
        return existsSync10(this.path);
      }
      /**
       * `root` is where the trust-root evidence is read from — the archive, the manifest,
       * and the recorded overrides that decide whether this store is frozen. It is
       * INFERRED only for the canonical `<root>/.adlc/tickets.json` layout, which keeps
       * the 1.x one-argument call working; anywhere else it must be passed, because
       * guessing wrong is not a cosmetic error (see repositoryRootFor).
       */
      write(tickets, { key = null, allowUnsigned = false, root = null } = {}) {
        return applyLegacyTransaction(this, tickets, {
          root: repositoryRootFor(this.path, root),
          operation: "update",
          key,
          allowUnsigned
        });
      }
      load() {
        if (!this.exists()) throw operational("STORE_NOT_FOUND", `tickets file not found: ${this.path}`);
        const stat = lstatSync7(this.path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw invalid("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
        const parentStat = lstatSync7(dirname9(this.path));
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${dirname9(this.path)} must be a real directory`);
        let parsed;
        try {
          parsed = JSON.parse(readFileSync10(this.path, "utf8"));
        } catch (error) {
          throw invalid("INVALID_JSON", `invalid JSON in ${this.path}: ${error.message}`);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.tickets)) {
          throw invalid("INVALID_ENVELOPE", `${this.path} must contain { "tickets": [...] }`);
        }
        validateTickets(parsed.tickets);
        return new TicketSnapshot({ backend: "legacy", formatVersion: 0, tickets: parsed.tickets });
      }
    };
  }
});

// packages/tickets/lib/store.mjs
import { existsSync as existsSync11, lstatSync as lstatSync8, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join12, resolve as resolve5 } from "node:path";
function pendingTransactions(root = ".") {
  const path = join12(root, TRANSACTION_DIRECTORY);
  if (!existsSync11(path)) return [];
  const stat = lstatSync8(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("RECOVERY_REQUIRED", `${path} is not a safe transaction directory`);
  return readdirSync4(path).filter((entry) => !entry.startsWith(".")).sort();
}
function resolveStoreOverride({ root = ".", ticketStore, legacyTickets, env = process.env } = {}) {
  const modern = ticketStore ?? env.ADLC_TICKET_STORE;
  const legacy = legacyTickets ?? env.ADLC_TICKETS;
  if (modern && legacy && resolve5(rooted(root, modern)) !== resolve5(rooted(root, legacy))) {
    throw conflict("CONFLICTING_STORE_OVERRIDE", "ADLC_TICKET_STORE/--ticket-store conflicts with ADLC_TICKETS/--tickets");
  }
  return modern ?? legacy ?? null;
}
function detectTicketStore(options = {}) {
  const { root = ".", allowRecovery = false } = options;
  if (!allowRecovery) {
    const pending = pendingTransactions(root);
    if (pending.length) throw conflict("RECOVERY_REQUIRED", `unfinished ticket transaction(s): ${pending.join(", ")}`);
  }
  const override = resolveStoreOverride(options);
  if (override) {
    const path = rooted(root, override);
    if (path.endsWith(".json")) return new LegacyTicketStore(path);
    return new DirectoryTicketStore(path);
  }
  const legacy = new LegacyTicketStore(join12(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join12(root, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict("AMBIGUOUS_STORE", "both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration");
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational("STORE_NOT_FOUND", `no ticket store found under ${resolve5(root)}`);
}
var rooted;
var init_store = __esm({
  "packages/tickets/lib/store.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_errors();
    init_directory();
    init_legacy();
    rooted = (root, path) => isAbsolute3(path) ? path : join12(root, path);
  }
});

// packages/tickets/lib/generated-glob-match.mjs
var SLASH;
var init_generated_glob_match = __esm({
  "packages/tickets/lib/generated-glob-match.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    SLASH = "/".charCodeAt(0);
  }
});

// packages/tickets/lib/manifest-rails.mjs
var MANIFEST_BASENAMES;
var init_manifest_rails = __esm({
  "packages/tickets/lib/manifest-rails.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_generated_glob_match();
    MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);
  }
});

// packages/tickets/lib/rail-existence.mjs
var GIT_MAX_BUFFER2;
var init_rail_existence = __esm({
  "packages/tickets/lib/rail-existence.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_generated_glob_match();
    GIT_MAX_BUFFER2 = 256 * 1024 * 1024;
  }
});

// packages/tickets/lib/service.mjs
var init_service = __esm({
  "packages/tickets/lib/service.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    init_constants();
    init_errors();
    init_filename();
    init_ids();
    init_snapshot();
    init_directory();
    init_legacy();
    init_transaction();
    init_schema();
    init_manifest_rails();
    init_rail_existence();
  }
});

// packages/tickets/lib/archive.mjs
var init_archive = __esm({
  "packages/tickets/lib/archive.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_directory();
    init_transaction();
    init_durability();
    init_key_contract();
    init_trust_root();
  }
});

// packages/tickets/lib/migrate.mjs
var init_migrate = __esm({
  "packages/tickets/lib/migrate.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_lock();
    init_directory();
    init_legacy();
    init_evidence();
    init_schema();
    init_durability();
    init_key_contract();
    init_trust_root();
  }
});

// packages/tickets/lib/doctor.mjs
var init_doctor = __esm({
  "packages/tickets/lib/doctor.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_lock();
    init_pointer();
    init_store();
    init_directory();
    init_manifest_segments();
    init_key_contract();
  }
});

// packages/tickets/lib/provenance.mjs
var init_provenance = __esm({
  "packages/tickets/lib/provenance.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_pointer();
    init_errors();
  }
});

// packages/tickets/lib/pointer-write.mjs
var init_pointer_write = __esm({
  "packages/tickets/lib/pointer-write.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_pointer();
  }
});

// packages/tickets/lib/rail-index.mjs
var MAX_INDEX_BYTES;
var init_rail_index = __esm({
  "packages/tickets/lib/rail-index.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_canonical();
    init_durability();
    init_pointer();
    init_store();
    init_directory();
    MAX_INDEX_BYTES = 1024 * 1024;
  }
});

// packages/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";
var init_prompt = __esm({
  "packages/tickets/lib/prompt.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_store();
    init_legacy();
    init_migrate();
  }
});

// packages/tickets/lib/stores/git-tree.mjs
var MAX_BUFFER;
var init_git_tree = __esm({
  "packages/tickets/lib/stores/git-tree.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_canonical();
    init_errors();
    init_filename();
    init_schema();
    init_snapshot();
    MAX_BUFFER = 64 * 1024 * 1024;
  }
});

// packages/tickets/index.mjs
var init_tickets = __esm({
  "packages/tickets/index.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_constants();
    init_errors();
    init_canonical();
    init_ids();
    init_filename();
    init_schema();
    init_help();
    init_edit();
    init_snapshot();
    init_store();
    init_lock();
    init_durability();
    init_transaction();
    init_service();
    init_manifest_rails();
    init_trust_root();
    init_archive();
    init_migrate();
    init_doctor();
    init_provenance();
    init_pointer();
    init_pointer_write();
    init_rail_index();
    init_prompt();
    init_evidence();
    init_manifest_segments();
    init_legacy();
    init_directory();
    init_git_tree();
    init_key_contract();
  }
});

// packages/core/lib/glob.mjs
function globMatch2(pattern, path) {
  const tokens = pattern.split(/(\*\*\/|\*\*|\*)/).filter((part) => part !== "");
  let reach = new Uint8Array(path.length + 1);
  const end = reach.length - 1;
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(reach.length);
    if (token === "**") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
      }
    } else if (token === "**/") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) {
          next[i] = 1;
          open = true;
        }
        if (open && i < end && path.charCodeAt(i) === SLASH2) next[i + 1] = 1;
      }
    } else if (token === "*") {
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
        if (i < end && path.charCodeAt(i) === SLASH2) open = false;
      }
    } else {
      for (let i = 0; i + token.length <= end; i++) {
        if (reach[i] && path.startsWith(token, i)) next[i + token.length] = 1;
      }
    }
    reach = next;
  }
  return reach[end] === 1;
}
var SLASH2;
var init_glob = __esm({
  "packages/core/lib/glob.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    SLASH2 = "/".charCodeAt(0);
  }
});

// packages/core/lib/tickets.mjs
import { existsSync as existsSync12, lstatSync as lstatSync9 } from "node:fs";
import { dirname as dirname10, isAbsolute as isAbsolute4, join as join13 } from "node:path";
function ticketStoreExists(root = ".", override = null) {
  if (override) return existsSync12(isAbsolute4(override) ? override : join13(root, override));
  return existsSync12(join13(root, ".adlc/tickets.json")) || existsSync12(join13(root, ".adlc/tickets/.store.json"));
}
function loadTickets(path = TICKETS_PATH) {
  try {
    const directoryPath = join13(dirname10(path), "tickets");
    const store = existsSync12(path) ? lstatSync9(path).isDirectory() ? new DirectoryTicketStore(path) : new LegacyTicketStore(path) : existsSync12(directoryPath) ? new DirectoryTicketStore(directoryPath) : null;
    if (!store) return { tickets: [], snapshot: null, errors: [`tickets file not found: ${path}`] };
    const snapshot = store.load();
    return { tickets: snapshot.mutableTickets(), snapshot, errors: [] };
  } catch (err) {
    return { tickets: [], snapshot: null, errors: Array.isArray(err.details) ? [...err.details] : [err.message] };
  }
}
var TICKETS_PATH, TICKET_TRUST_ROOT_RAILS;
var init_tickets2 = __esm({
  "packages/core/lib/tickets.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_tickets();
    init_glob();
    TICKETS_PATH = ".adlc/tickets.json";
    TICKET_TRUST_ROOT_RAILS = Object.freeze([
      ".adlc/tickets.json",
      ".adlc/tickets/.store.json",
      ".adlc/tickets/**",
      ".adlc/current-ticket.json"
    ]);
  }
});

// packages/core/lib/revision.mjs
var GIT_MAX_BUFFER3, NULL_OBJECT;
var init_revision = __esm({
  "packages/core/lib/revision.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_git();
    GIT_MAX_BUFFER3 = 64 * 1024 * 1024;
    NULL_OBJECT = "0".repeat(40);
  }
});

// packages/core/lib/generated-glob-match.mjs
var SLASH3;
var init_generated_glob_match2 = __esm({
  "packages/core/lib/generated-glob-match.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    SLASH3 = "/".charCodeAt(0);
  }
});

// packages/core/lib/risk-tier.mjs
var RISK_TIER_PATTERNS;
var init_risk_tier = __esm({
  "packages/core/lib/risk-tier.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_generated_glob_match2();
    RISK_TIER_PATTERNS = Object.freeze({
      "auth-trust-boundary": Object.freeze([
        "**/auth/**",
        "**/authn/**",
        "**/authz/**",
        "**/oauth/**",
        "**/sso/**",
        "**/session/**",
        "**/login/**",
        "**/permissions/**",
        "**/rbac/**",
        "**/acl/**"
      ]),
      "security-control-deny-path": Object.freeze([
        "**/*guard*",
        "**/*validator*",
        "**/*validators*",
        "**/sandbox/**",
        "**/sandboxes/**",
        "**/middleware/**",
        "**/*deny-path*",
        "**/*policy*",
        "**/policies/**"
      ]),
      secrets: Object.freeze([
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.key",
        "**/*.p12",
        "**/*.pfx",
        "**/secrets/**",
        "**/secret/**",
        "**/*credentials*",
        "**/vault/**"
      ]),
      "data-loss-destructive": Object.freeze([
        "**/*delete*",
        "**/*destroy*",
        "**/*purge*",
        "**/*truncate*",
        "**/*wipe*",
        "**/*irreversible*"
      ]),
      "schema-migration": Object.freeze([
        "**/migrations/**",
        "**/migrate/**",
        "**/*.sql",
        "**/schema.*",
        "**/*.prisma"
      ]),
      "ci-cd-supply-chain": Object.freeze([
        ".github/workflows/**",
        "**/Dockerfile",
        "**/Dockerfile.*",
        "**/docker-compose*.yml",
        "**/package.json",
        "**/package-lock.json",
        "**/pnpm-lock.yaml",
        "**/yarn.lock",
        "**/requirements*.txt",
        "**/Gemfile*",
        "**/go.sum",
        "**/go.mod",
        "**/Cargo.lock",
        ".circleci/**",
        ".gitlab-ci.yml"
      ])
    });
  }
});

// packages/core/lib/scaffold-hygiene.mjs
var init_scaffold_hygiene = __esm({
  "packages/core/lib/scaffold-hygiene.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_tickets();
  }
});

// packages/core/lib/prosecutor.mjs
var LENSES, VERIFIER, ALL_AGENTS;
var init_prosecutor = __esm({
  "packages/core/lib/prosecutor.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_ledger();
    LENSES = [
      { key: "correctness", agent: "prosecutor-correctness", focus: "logic errors, broken invariants, wrong results" },
      { key: "security", agent: "prosecutor-security", focus: "auth/trust boundaries, injection, secrets, unsafe data flow" },
      { key: "contract", agent: "prosecutor-contract", focus: "API/schema/type conformance against the declared contract" },
      { key: "diff", agent: "prosecutor-diff", focus: "spec-vs-implementation divergence; unstated behavior changes" },
      { key: "tests", agent: "prosecutor-tests", focus: "hollow/mock-only tests; are the new tests load-bearing?" }
    ];
    VERIFIER = { key: "verifier", agent: "prosecutor-verifier", focus: "reproduce/refute a finding" };
    ALL_AGENTS = [...LENSES.map((l) => l.agent), VERIFIER.agent];
  }
});

// packages/core/lib/markdown.mjs
var init_markdown = __esm({
  "packages/core/lib/markdown.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/shell.mjs
var init_shell = __esm({
  "packages/core/lib/shell.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/railpath.mjs
import { lstatSync as lstatSync10, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute as isAbsolute5, join as join14, parse, relative as relative3 } from "node:path";
function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
function segmentsOf(p) {
  return p.replace(/^[A-Za-z]:[\\/]?/, "").split(/[\\/]+/).filter(Boolean);
}
function lstatOrNull(p) {
  try {
    return lstatSync10(p);
  } catch {
    return null;
  }
}
function readlinkOrNull(p) {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}
function walk(start, segments) {
  const queue = [...segments];
  let cur = start;
  let exists = true;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === ".") continue;
    if (seg === "..") {
      cur = join14(cur, "..");
      continue;
    }
    const next = join14(cur, seg);
    const st = exists ? lstatOrNull(next) : null;
    if (st?.isSymbolicLink()) {
      const target = ++hops > MAX_SYMLINK_HOPS ? null : readlinkOrNull(next);
      if (target === null) return null;
      if (isAbsolute5(target)) cur = parse(target).root;
      queue.unshift(...segmentsOf(target));
      continue;
    }
    if (!st) exists = false;
    cur = next;
  }
  return cur;
}
function resolveRailPath(filePath, root) {
  const realRoot = realpathOr(root);
  const start = isAbsolute5(filePath) ? parse(filePath).root : realRoot;
  const final = walk(start, segmentsOf(filePath)) ?? (isAbsolute5(filePath) ? filePath : join14(realRoot, filePath));
  return relative3(realRoot, final).split("\\").join("/");
}
var MAX_SYMLINK_HOPS;
var init_railpath = __esm({
  "packages/core/lib/railpath.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    MAX_SYMLINK_HOPS = 40;
  }
});

// packages/core/lib/structural-mutate.mjs
function dropObjectArgKey(line) {
  if (typeof line !== "string") return null;
  if (line.includes("\n") || line.includes("\r")) return null;
  const masked = maskStringLiterals(line);
  if (masked.includes("...")) return null;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth < 0) return null;
    } else if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth < 0) return null;
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") {
      bracketDepth--;
      if (bracketDepth < 0) return null;
    }
  }
  if (parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) return null;
  if (/\b(?:const|let|var)\s*\{/.test(masked)) return null;
  if (/}\s*=/.test(masked)) return null;
  if (/\b(?:import|export|function)\b/.test(masked)) return null;
  if (/=>/.test(masked)) return null;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "{") continue;
    const openBrace = i;
    let depth = 1;
    let closeBrace = -1;
    for (let j = openBrace + 1; j < masked.length; j++) {
      if (masked[j] === "{") depth++;
      else if (masked[j] === "}") {
        depth--;
        if (depth === 0) {
          closeBrace = j;
          break;
        }
      }
    }
    if (closeBrace === -1) continue;
    let pDepth = 0, bDepth = 0, brDepth = 0;
    let enclosingParen = -1;
    for (let k = openBrace - 1; k >= 0; k--) {
      const c = masked[k];
      if (c === ")") pDepth++;
      else if (c === "(") {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) {
          enclosingParen = k;
          break;
        }
        pDepth--;
      } else if (c === "}") bDepth++;
      else if (c === "{") {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) break;
        bDepth--;
      } else if (c === "]") brDepth++;
      else if (c === "[") {
        if (pDepth === 0 && bDepth === 0 && brDepth === 0) break;
        brDepth--;
      }
    }
    if (enclosingParen === -1) continue;
    const beforeParen = masked.slice(0, enclosingParen).trimEnd();
    if (!beforeParen) continue;
    const calleeMatch = beforeParen.match(/([a-zA-Z_$][\w$]*)$/);
    if (!calleeMatch && !beforeParen.endsWith(")") && !beforeParen.endsWith("]")) {
      continue;
    }
    if (calleeMatch) {
      const word = calleeMatch[1];
      if (NON_CALL_KEYWORDS.has(word)) continue;
    }
    if (beforeParen.endsWith(")")) {
      let d = 0;
      let matchingP = -1;
      for (let k = beforeParen.length - 1; k >= 0; k--) {
        if (beforeParen[k] === ")") d++;
        else if (beforeParen[k] === "(") {
          d--;
          if (d === 0) {
            matchingP = k;
            break;
          }
        }
      }
      if (matchingP > 0) {
        const priorWord = beforeParen.slice(0, matchingP).trimEnd().match(/([a-zA-Z_$][\w$]*)$/);
        if (priorWord && NON_CALL_KEYWORDS.has(priorWord[1])) continue;
      }
    }
    const props = [];
    let segStart = openBrace + 1;
    let curParen = 0, curBrace = 0, curBracket = 0;
    for (let j = openBrace + 1; j <= closeBrace; j++) {
      if (j === closeBrace || curParen === 0 && curBrace === 0 && curBracket === 0 && masked[j] === ",") {
        const segText = line.slice(segStart, j);
        const trimmed4 = segText.trim();
        if (trimmed4.length > 0) {
          const leadMatch = segText.match(/^\s*/)[0].length;
          const trailMatch = segText.match(/\s*$/)[0].length;
          const pStart = segStart + leadMatch;
          const pEnd = j - trailMatch;
          let colonIdx = -1;
          let subP = 0, subB = 0, subBr = 0;
          for (let m = pStart; m < pEnd; m++) {
            const ch = masked[m];
            if (ch === "(") subP++;
            else if (ch === ")") subP--;
            else if (ch === "{") subB++;
            else if (ch === "}") subB--;
            else if (ch === "[") subBr++;
            else if (ch === "]") subBr--;
            else if (ch === ":" && subP === 0 && subB === 0 && subBr === 0) {
              colonIdx = m;
              break;
            }
          }
          const rawKey = (colonIdx !== -1 ? line.slice(pStart, colonIdx) : line.slice(pStart, pEnd)).trim();
          const key = rawKey.replace(/^['"`](.*)['"`]$/, "$1").trim();
          props.push({ start: pStart, end: pEnd, key });
        }
        segStart = j + 1;
      } else {
        const ch = masked[j];
        if (ch === "(") curParen++;
        else if (ch === ")") curParen--;
        else if (ch === "{") curBrace++;
        else if (ch === "}") curBrace--;
        else if (ch === "[") curBracket++;
        else if (ch === "]") curBracket--;
      }
    }
    if (props.length < 2) continue;
    const nonExemptIndices = [];
    for (let pIdx = 0; pIdx < props.length; pIdx++) {
      const k = props[pIdx].key;
      const isExempt = EXEMPT_KEYS.has(k) || isTuningIdentifier(k);
      if (!isExempt) {
        nonExemptIndices.push(pIdx);
      }
    }
    if (nonExemptIndices.length < 1) continue;
    const dropIdx = nonExemptIndices[nonExemptIndices.length - 1];
    return line.slice(0, openBrace + 1) + " " + props.filter((_, idx) => idx !== dropIdx).map((p) => line.slice(p.start, p.end).trim()).join(", ") + " " + line.slice(closeBrace);
  }
  return null;
}
var EXEMPT_KEYS, NON_CALL_KEYWORDS, STRUCTURAL_FALLBACK_OPERATORS;
var init_structural_mutate = __esm({
  "packages/core/lib/structural-mutate.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_mutate();
    EXEMPT_KEYS = /* @__PURE__ */ new Set(["encoding", "recursive", "force"]);
    NON_CALL_KEYWORDS = /* @__PURE__ */ new Set([
      "if",
      "while",
      "for",
      "switch",
      "catch",
      "with",
      "function",
      "return",
      "throw",
      "typeof",
      "void",
      "delete",
      "yield",
      "default",
      "case",
      "new"
    ]);
    STRUCTURAL_FALLBACK_OPERATORS = Object.freeze([
      Object.freeze({
        name: "object-arg-key-drop",
        apply: dropObjectArgKey
      })
    ]);
  }
});

// packages/core/lib/mutate.mjs
function identifierSegments(name) {
  return String(name).replace(/[_$\d]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
}
function isTuningIdentifier(name) {
  const segs = identifierSegments(name);
  if (segs.length === 0) return false;
  const tail = segs[segs.length - 1];
  if (DISCRETE_TAIL.has(tail)) return false;
  if (MAGNITUDE_UNIT_TAIL.has(tail)) return true;
  for (let i = 0; i < segs.length; i++) {
    let joined = "";
    for (let j = i; j < segs.length; j++) {
      joined += segs[j];
      if (TUNING_PHRASES.has(joined)) return true;
    }
  }
  return false;
}
function maskStringLiterals(line) {
  let out = "";
  let quote = null;
  let escaped = false;
  let exprDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (exprDepth > 0) {
      if (ch === "{") exprDepth++;
      else if (ch === "}") exprDepth--;
      out += ch;
      continue;
    }
    if (quote) {
      if (escaped) {
        out += " ";
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += " ";
        escaped = true;
        continue;
      }
      if (quote === "`" && ch === "$" && line[i + 1] === "{") {
        out += "${";
        i++;
        exprDepth = 1;
        continue;
      }
      if (ch === quote) {
        out += ch;
        quote = null;
        continue;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}
var DISCRETE_TAIL, MAGNITUDE_UNIT_TAIL, TUNING_PHRASES, ARRAY_LITERAL_ELEMENT, ARRAY_LITERAL_RE;
var init_mutate = __esm({
  "packages/core/lib/mutate.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_structural_mutate();
    DISCRETE_TAIL = /* @__PURE__ */ new Set([
      "retries",
      "retry",
      "tries",
      "attempts",
      "attempt",
      "count",
      "counts",
      "limit",
      "limits",
      "size",
      "sizes",
      "length",
      "len",
      "index",
      "idx",
      "offset",
      "code",
      "codes",
      "id",
      "ids",
      "version",
      "port",
      "level",
      "priority",
      "depth",
      "concurrency",
      "workers",
      "slots",
      "page",
      "pages",
      "num",
      "number",
      "numbers",
      "items",
      "rows",
      "lines",
      "chars",
      "columns"
    ]);
    MAGNITUDE_UNIT_TAIL = /* @__PURE__ */ new Set([
      "ms",
      "msec",
      "msecs",
      "milli",
      "millis",
      "millisecond",
      "milliseconds",
      "us",
      "usec",
      "usecs",
      "micro",
      "micros",
      "microsecond",
      "microseconds",
      "ns",
      "nsec",
      "nsecs",
      "nano",
      "nanos",
      "nanosecond",
      "nanoseconds",
      "byte",
      "bytes",
      "kb",
      "mb",
      "gb",
      "tb",
      "kib",
      "mib",
      "gib",
      "tib",
      "kbytes",
      "mbytes",
      "gbytes"
    ]);
    TUNING_PHRASES = /* @__PURE__ */ new Set([
      "timeout",
      "delay",
      "interval",
      "backoff",
      "ttl",
      "maxage",
      "keepalive",
      "maxbuffer",
      "highwatermark",
      "maxbytes"
    ]);
    ARRAY_LITERAL_ELEMENT = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[\w$.]+)`;
    ARRAY_LITERAL_RE = new RegExp(
      `\\[\\s*(${ARRAY_LITERAL_ELEMENT}(?:\\s*,\\s*${ARRAY_LITERAL_ELEMENT})+)\\s*\\]`
    );
  }
});

// packages/core/lib/text.mjs
var init_text = __esm({
  "packages/core/lib/text.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/primitives.mjs
var SECRET_REDACT_RULES, VALID_ATTESTATION_MODES;
var init_primitives = __esm({
  "packages/core/lib/primitives.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_cli();
    init_proc();
    init_secret_shapes();
    init_durability();
    SECRET_REDACT_RULES = SECRET_PATTERNS.map(([pattern]) => [
      new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
      pattern === INLINE_ASSIGNMENT ? "$1[REDACTED]" : "[REDACTED]"
    ]);
    VALID_ATTESTATION_MODES = Object.freeze(["self-context", "headless-cli", "api"]);
  }
});

// packages/core/lib/sandbox-runner.mjs
var SENSITIVE_HOME_DIRS, SENSITIVE_HOME_FILES, USER_EPHEMERAL_ROOTS;
var init_sandbox_runner = __esm({
  "packages/core/lib/sandbox-runner.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_primitives();
    SENSITIVE_HOME_DIRS = Object.freeze([
      ".ssh",
      ".aws",
      ".gnupg",
      ".config/gh",
      ".config/gcloud",
      ".config/adlc",
      ".config/opencode",
      ".config/github-copilot",
      ".config/pi",
      ".local/share/cursor-agent",
      ".azure",
      ".kube",
      ".docker",
      ".claude",
      ".codex",
      ".gemini",
      ".cursor",
      ".copilot",
      ".pi"
    ]);
    SENSITIVE_HOME_FILES = Object.freeze([
      ".netrc",
      ".npmrc",
      ".git-credentials",
      ".claude.json",
      ".claude.json.backup"
    ]);
    USER_EPHEMERAL_ROOTS = Object.freeze([
      "/home",
      "/Users",
      "/root",
      "/tmp",
      "/var/tmp",
      "/srv",
      "/opt",
      "/var",
      "/run",
      "/mnt"
    ]);
  }
});

// packages/core/lib/syntax.mjs
import { fileURLToPath } from "node:url";
var TYPESCRIPT_WORKER;
var init_syntax = __esm({
  "packages/core/lib/syntax.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_sandbox_runner();
    TYPESCRIPT_WORKER = fileURLToPath(new URL("./syntax-check-typescript.mjs", import.meta.url));
  }
});

// packages/core/lib/inflight.mjs
var init_inflight = __esm({
  "packages/core/lib/inflight.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/cluster.mjs
var BASE_STOPWORDS;
var init_cluster = __esm({
  "packages/core/lib/cluster.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    BASE_STOPWORDS = Object.freeze(/* @__PURE__ */ new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "shall",
      "can",
      "not",
      "no",
      "nor",
      "so",
      "yet",
      "both",
      "either",
      "neither",
      "each",
      "every",
      "all",
      "any",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "than",
      "too",
      "very",
      "just",
      "that",
      "this",
      "it",
      "its",
      "as",
      "if",
      "then",
      "there",
      "when",
      "where",
      "which",
      "who",
      "how",
      "what",
      "use",
      "used",
      "using",
      "via",
      "also",
      "only",
      "into",
      "up",
      "out",
      "about",
      "after",
      "before"
    ]));
  }
});

// packages/core/lib/trusted-binary.mjs
var init_trusted_binary = __esm({
  "packages/core/lib/trusted-binary.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/core/lib/diff-mask.mjs
var MASKED_SECRET, NAME, ASSIGNMENT_RULES, SHAPE_RULES, MASK_RULES;
var init_diff_mask = __esm({
  "packages/core/lib/diff-mask.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_secret_shapes();
    MASKED_SECRET = "[redacted]";
    NAME = String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,48}?(?:secret|token|passw(?:or)?d|pwd|credentials?|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key)[A-Za-z0-9_.-]{0,48}["']?\s*(?::=|=>|[:=])\s*`;
    ASSIGNMENT_RULES = [
      // `name = "value with anything"` — the quoted value, escapes included, up to
      // its closing quote or the end of the line (a multi-line string, a trailing
      // line-continuation backslash, or a hunk header git cut short).
      [new RegExp(`(${NAME})(["'\`])((?:\\\\[^]|\\\\$|(?!\\2)[^\\\\]){8,}?)(\\2|$)`, "gi"), (_m, prefix, quote, _value, close) => `${prefix}${quote}${MASKED_SECRET}${close}`],
      // `name = value` — an unquoted value up to whitespace or a quote.
      [new RegExp(`(${NAME})(?!["'\`])[^\\s"'\`]{8,}`, "gi"), (_m, prefix) => `${prefix}${MASKED_SECRET}`],
      // `scheme://user:password@host` — the password in URL userinfo.
      [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(?=@)/gi, (_m, prefix) => `${prefix}${MASKED_SECRET}`],
      // `Authorization: Basic <base64 user:pass>`.
      [/(\bBasic\s+)[A-Za-z0-9+/]{8,}={0,2}/g, (_m, prefix) => `${prefix}${MASKED_SECRET}`]
    ];
    SHAPE_RULES = SECRET_PATTERNS.filter(([pattern]) => pattern !== INLINE_ASSIGNMENT).map(([pattern]) => [new RegExp(pattern.source, `${pattern.flags}g`), () => MASKED_SECRET]);
    MASK_RULES = [...ASSIGNMENT_RULES, ...SHAPE_RULES];
  }
});

// packages/core/lib/workspace-root.mjs
import { existsSync as existsSync13, lstatSync as lstatSync11, readFileSync as readFileSync11, readlinkSync as readlinkSync2, realpathSync as realpathSync2, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename as basename3, dirname as dirname11, isAbsolute as isAbsolute6, join as join15, relative as relative4, resolve as resolve6 } from "node:path";
function readSmallRegularFile(filePath) {
  try {
    const st = lstatSync11(filePath);
    if (!st.isFile() || st.size > GITDIR_POINTER_MAX_BYTES) return null;
    return readFileSync11(filePath, "utf8");
  } catch {
    return null;
  }
}
function canonicalizePath(targetPath) {
  const abs = resolve6(targetPath);
  let cur = abs;
  const pending = [];
  const seen = /* @__PURE__ */ new Set();
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const realBase = realpathSync2(cur);
      return pending.length === 0 ? realBase : join15(realBase, ...pending);
    } catch {
      if (seen.has(cur)) return abs;
      seen.add(cur);
      try {
        if (lstatSync11(cur).isSymbolicLink()) {
          cur = resolve6(dirname11(cur), readlinkSync2(cur));
          continue;
        }
      } catch {
      }
      const parent = dirname11(cur);
      if (parent === cur) return pending.length === 0 ? cur : join15(cur, ...pending);
      pending.unshift(basename3(cur));
      cur = parent;
    }
  }
  return abs;
}
function isPathInside(childPath, parentPath) {
  if (typeof childPath !== "string" || !childPath.trim()) return false;
  if (typeof parentPath !== "string" || !parentPath.trim()) return false;
  const rel = relative4(canonicalizePath(parentPath), canonicalizePath(childPath));
  return rel === "" || !rel.startsWith("..") && !isAbsolute6(rel);
}
function inspectGitCheckout(dir) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const gitEntry = join15(dir, ".git");
  let stats;
  try {
    stats = lstatSync11(gitEntry);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    if (!existsSync13(join15(gitEntry, "HEAD"))) return null;
    const realGitDir = canonicalizePath(gitEntry);
    return { kind: "repo", gitDir: realGitDir, commonGitDir: realGitDir };
  }
  if (!stats.isFile() || stats.size > GITDIR_POINTER_MAX_BYTES) return null;
  let content;
  try {
    content = readFileSync11(gitEntry, "utf8");
  } catch {
    return null;
  }
  const trimmed4 = content.trimStart();
  if (!trimmed4.startsWith("gitdir:")) return null;
  const firstLine = trimmed4.split(/\r?\n/, 1)[0];
  const rawPtr = firstLine.slice("gitdir:".length).trim();
  if (!rawPtr) return null;
  const resolvedGitDir = resolve6(dir, rawPtr);
  try {
    const realGitDir = realpathSync2(resolvedGitDir);
    const realDir = realpathSync2(dir);
    const backRaw = readSmallRegularFile(join15(realGitDir, "gitdir"));
    const commonRaw = readSmallRegularFile(join15(realGitDir, "commondir"));
    if (backRaw && commonRaw) {
      const backTrimmed = backRaw.trim();
      const commonTrimmed = commonRaw.trim();
      if (backTrimmed && commonTrimmed) {
        const realBackDir = realpathSync2(dirname11(resolve6(realGitDir, backTrimmed)));
        const realCommon = realpathSync2(resolve6(realGitDir, commonTrimmed));
        const realWorktrees = realpathSync2(join15(realCommon, "worktrees"));
        const relWt = relative4(realWorktrees, realGitDir);
        const underWorktrees = relWt !== "" && !relWt.startsWith("..") && !isAbsolute6(relWt);
        if (realBackDir === realDir && underWorktrees && existsSync13(join15(realCommon, "HEAD"))) {
          return { kind: "worktree", gitDir: realGitDir, commonGitDir: realCommon };
        }
      }
      if (existsSync13(join15(realGitDir, "HEAD")) || existsSync13(join15(realGitDir, "commondir"))) {
        return { kind: "gitfile", gitDir: realGitDir, commonGitDir: null };
      }
    }
    if (existsSync13(join15(realGitDir, "HEAD")) || existsSync13(join15(realGitDir, "commondir"))) {
      return { kind: "gitfile", gitDir: realGitDir, commonGitDir: null };
    }
  } catch {
    return null;
  }
  return null;
}
function hasTicketStoreAt(dir, storeOverride = null) {
  if (typeof dir !== "string" || !dir.trim()) return false;
  if (typeof storeOverride === "string" && storeOverride.trim() && !isAbsolute6(storeOverride)) {
    return existsSync13(join15(dir, storeOverride.trim()));
  }
  return existsSync13(join15(dir, ".adlc", "tickets", ".store.json")) || existsSync13(join15(dir, ".adlc", "tickets.json"));
}
function hasExternalAbsoluteStore(storeOverride) {
  return typeof storeOverride === "string" && storeOverride.trim().length > 0 && isAbsolute6(storeOverride.trim()) && existsSync13(storeOverride.trim());
}
function findInnermostCheckoutRoot(startPath, options = {}) {
  if (typeof startPath !== "string" || !startPath.trim()) return null;
  const {
    storeOverride = null,
    homeDir = homedir(),
    pluginDir = null,
    rememberedRoots = null,
    allowFileStart = false,
    requireStore = true,
    preserveSpelling = false
  } = options;
  let startLexical = resolve6(startPath);
  if (allowFileStart) {
    let isDir = false;
    try {
      isDir = statSync(startLexical).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      let isSym = false;
      try {
        isSym = lstatSync11(startLexical).isSymbolicLink();
      } catch {
        isSym = false;
      }
      startLexical = isSym ? dirname11(canonicalizePath(startLexical)) : dirname11(startLexical);
    }
  }
  if (pluginDir && isPathInside(startLexical, pluginDir)) return null;
  const startCanonical = canonicalizePath(startLexical);
  const realHome = typeof homeDir === "string" && homeDir.trim() ? canonicalizePath(homeDir) : null;
  const trimmedOverride = typeof storeOverride === "string" && storeOverride.trim() ? storeOverride.trim() : null;
  const isExternalOverride = trimmedOverride !== null && isAbsolute6(trimmedOverride);
  const perDirOverride = trimmedOverride !== null && !isExternalOverride ? trimmedOverride : null;
  const chain = [];
  let rawCur = startLexical;
  for (let depth = 0; depth < 256; depth += 1) {
    const canonicalCur = canonicalizePath(rawCur);
    const atHome = realHome !== null && canonicalCur === realHome;
    const rawInfo = inspectGitCheckout(canonicalCur);
    const examine = !atHome || canonicalCur === startCanonical || rawInfo !== null;
    const info = examine ? rawInfo : null;
    chain.push({
      rawDir: rawCur,
      dir: canonicalCur,
      atHome,
      remembered: rememberedRoots ? rememberedRoots.has(canonicalCur) : false,
      store: examine && !isExternalOverride ? hasTicketStoreAt(canonicalCur, perDirOverride) : false,
      info,
      checkout: info?.kind === "repo" || info?.kind === "worktree"
    });
    const parent = dirname11(rawCur);
    if (parent === rawCur || atHome && !rememberedRoots) break;
    rawCur = parent;
  }
  const nestedWorktreeIdx = chain.findIndex(
    (entry, idx) => entry.info?.kind === "worktree" && entry.info.commonGitDir !== null && chain.slice(idx + 1).some((anc) => anc.info?.commonGitDir === entry.info?.commonGitDir)
  );
  const effectiveChain = nestedWorktreeIdx >= 0 ? chain.slice(0, nestedWorktreeIdx + 1) : chain;
  const externalStoreActive = hasExternalAbsoluteStore(storeOverride);
  const adlcRepoAbove = effectiveChain.map(() => false);
  for (let i = effectiveChain.length - 2; i >= 0; i -= 1) {
    const above = effectiveChain[i + 1];
    const aboveHasStore = above.store || above.remembered || externalStoreActive;
    adlcRepoAbove[i] = adlcRepoAbove[i + 1] || !above.atHome && above.checkout && (requireStore ? aboveHasStore : true);
  }
  let outermost = null;
  let checkoutRoot = null;
  let insideCheckout = true;
  for (let i = 0; i < effectiveChain.length; i += 1) {
    const link = effectiveChain[i];
    const picked = preserveSpelling ? link.rawDir : link.dir;
    if (link.remembered || insideCheckout && link.store) {
      outermost = picked;
    }
    if (insideCheckout && link.checkout) {
      checkoutRoot = picked;
      if (!adlcRepoAbove[i]) insideCheckout = false;
    }
  }
  if (outermost !== null) return outermost;
  if (hasExternalAbsoluteStore(storeOverride)) {
    return checkoutRoot ?? (preserveSpelling ? startLexical : startCanonical);
  }
  if (!requireStore) {
    return checkoutRoot;
  }
  return null;
}
function preferInnermostCheckout(outerRoot, dynamicCandidates = [], options = {}) {
  const hasOuter = typeof outerRoot === "string" && outerRoot.trim().length > 0;
  if (!hasOuter) {
    for (const cand of dynamicCandidates) {
      if (typeof cand !== "string" || !cand.trim()) continue;
      const resolved = findInnermostCheckoutRoot(cand, options);
      if (resolved) return resolved;
    }
    return null;
  }
  const trimmedOuter = outerRoot.trim();
  const outerInfo = inspectGitCheckout(canonicalizePath(trimmedOuter));
  for (const cand of dynamicCandidates) {
    if (typeof cand !== "string" || !cand.trim()) continue;
    if (!isPathInside(cand, trimmedOuter)) continue;
    const inner = findInnermostCheckoutRoot(cand, options);
    if (!inner) continue;
    if (!isPathInside(inner, trimmedOuter)) continue;
    if (canonicalizePath(inner) === canonicalizePath(trimmedOuter)) continue;
    const innerInfo = inspectGitCheckout(inner);
    if (innerInfo?.kind === "worktree" && innerInfo.commonGitDir !== null && (outerInfo === null || outerInfo.commonGitDir === innerInfo.commonGitDir)) {
      return inner;
    }
  }
  return options.preserveSpelling ? trimmedOuter : canonicalizePath(trimmedOuter);
}
var GITDIR_POINTER_MAX_BYTES, SHELL_WORKDIR_KEYS, WORKDIR_CONTAINERS;
var init_workspace_root = __esm({
  "packages/core/lib/workspace-root.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    GITDIR_POINTER_MAX_BYTES = 4096;
    SHELL_WORKDIR_KEYS = Object.freeze([
      "Cwd",
      "cwd",
      "dir_path",
      "dirPath",
      "working_directory",
      "workingDirectory",
      "working_dir",
      "workingDir",
      "workdir",
      "workDir"
    ]);
    WORKDIR_CONTAINERS = Object.freeze([
      "options",
      "params",
      "parameters",
      "payload",
      "input",
      "tool_input",
      "toolInput",
      "args",
      "arguments"
    ]);
  }
});

// packages/core/index.mjs
var init_core = __esm({
  "packages/core/index.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_llm();
    init_model_family();
    init_git();
    init_cli();
    init_ledger();
    init_tickets2();
    init_revision();
    init_risk_tier();
    init_scaffold_hygiene();
    init_prosecutor();
    init_markdown();
    init_shell();
    init_railpath();
    init_mutate();
    init_text();
    init_syntax();
    init_primitives();
    init_inflight();
    init_cluster();
    init_proc();
    init_trusted_binary();
    init_diff_mask();
    init_workspace_root();
    init_tickets2();
    init_cli();
    init_cli_providers();
    init_structural_mutate();
    init_primitives();
    init_inflight();
    init_sandbox_runner();
    init_cluster();
    init_proc();
    init_trusted_binary();
  }
});

// packages/build-gate/lib/risk.mjs
var risk_exports = {};
__export(risk_exports, {
  HIGH_RISK_CATEGORIES: () => HIGH_RISK_CATEGORIES,
  MANIFEST_PATH: () => MANIFEST_PATH,
  MANIFEST_PATHS: () => MANIFEST_PATHS,
  TRUST_ROOT_PATHS: () => TRUST_ROOT_PATHS,
  computeRiskTier: () => computeRiskTier,
  deriveRiskSignals: () => deriveRiskSignals
});
function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch2(g, p) || globMatch2(p, g)));
}
function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const signals = [];
  if (t.risk === "high") signals.push("declared-risk-high");
  if (t.external === true) signals.push("external-system-effect");
  if (t.mutatesIdentity === true) signals.push("mutates-identity");
  if (t.scope !== void 0 && !Array.isArray(t.scope)) signals.push("malformed-scope");
  if (t.rails !== void 0 && !Array.isArray(t.rails)) signals.push("malformed-rails");
  const combinedGlobs = [
    ...Array.isArray(t.scope) ? t.scope : [],
    ...Array.isArray(t.rails) ? t.rails : []
  ];
  if (touchesAny(combinedGlobs, MANIFEST_PATHS)) signals.push("mutates-manifest");
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) signals.push("touches-trust-root");
  if (HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);
  return signals;
}
function computeRiskTier(ticket) {
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? "high" : "normal", signals };
}
var TRUST_ROOT_PATHS, MANIFEST_PATH, MANIFEST_PATHS, HIGH_RISK_CATEGORIES;
var init_risk = __esm({
  "packages/build-gate/lib/risk.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_tickets2();
    TRUST_ROOT_PATHS = [".adlc/tickets.json", ".adlc/tickets/**", ".adlc/current-ticket.json"];
    MANIFEST_PATH = ".adlc/manifest.jsonl";
    MANIFEST_PATHS = [MANIFEST_PATH, ".adlc/manifest.d/**"];
    HIGH_RISK_CATEGORIES = /* @__PURE__ */ new Set(["contract", "architecture"]);
  }
});

// packages/build-gate/lib/decide.mjs
var decide_exports = {};
__export(decide_exports, {
  decideBuildGate: () => decideBuildGate
});
function decideBuildGate({ riskTier, degraded, bypass, recordBypass } = {}) {
  if (riskTier !== "high") {
    return { decision: "allow", reason: `ticket risk tier is '${riskTier ?? "normal"}' \u2014 gate only guards high-risk tickets` };
  }
  if (!degraded) {
    return { decision: "allow", reason: "high-risk ticket, but the context-fitness signal is not degraded (below threshold)" };
  }
  if (bypass) {
    const recorded = typeof recordBypass === "function" && recordBypass() === true;
    if (recorded) {
      return { decision: "allow", reason: "high-risk build in a degraded session, but an audited override was recorded", overridden: true };
    }
    return {
      decision: "deny",
      reason: "override requested but could not be durably recorded to the gate-manifest \u2014 an unaudited bypass is refused"
    };
  }
  return {
    decision: "deny",
    reason: "high-risk ticket build denied: the context-fitness signal is past threshold in this session. Resume in a fresh session (or an isolated subagent) rather than continuing here."
  };
}
var init_decide = __esm({
  "packages/build-gate/lib/decide.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/context-handoff/lib/thresholds.mjs
var WARN_PCT, HANDOFF_PCT, HARD_PCT, WARN_DEPTH, HANDOFF_DEPTH, HARD_DEPTH, WARN_BYTES, HANDOFF_BYTES, HARD_BYTES, MAX_ACTIVE_CONTEXT_BYTES, BYPASS_GRANT_TTL_MS;
var init_thresholds = __esm({
  "packages/context-handoff/lib/thresholds.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    WARN_PCT = 50;
    HANDOFF_PCT = 60;
    HARD_PCT = 80;
    WARN_DEPTH = 20;
    HANDOFF_DEPTH = 30;
    HARD_DEPTH = 40;
    WARN_BYTES = 4 * 1024 * 1024;
    HANDOFF_BYTES = 6 * 1024 * 1024;
    HARD_BYTES = 8 * 1024 * 1024;
    MAX_ACTIVE_CONTEXT_BYTES = 8 * 1024 * 1024;
    BYPASS_GRANT_TTL_MS = 10 * 60 * 1e3;
  }
});

// packages/context-handoff/lib/bands.mjs
function classifyBandSignal(value) {
  if (value === void 0 || value === null) return "absent";
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  return "number";
}
function evaluateBands(observed = {}) {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    return { warn: true, handoff: true, hard: true };
  }
  const past = (value, warnAt, handoffAt, hardAt, inDomain) => {
    const kind = classifyBandSignal(value);
    if (kind === "absent") {
      return { warn: false, handoff: false, hard: false };
    }
    if (kind === "invalid" || !inDomain(value)) {
      return { warn: true, handoff: true, hard: true };
    }
    return {
      warn: value >= warnAt,
      handoff: value >= handoffAt,
      hard: value >= hardAt
    };
  };
  const pct = past(observed.pct, WARN_PCT, HANDOFF_PCT, HARD_PCT, (v) => v >= 0 && v <= 100);
  const depth = past(observed.depth, WARN_DEPTH, HANDOFF_DEPTH, HARD_DEPTH, (v) => v >= 0);
  const bytes = past(observed.bytes, WARN_BYTES, HANDOFF_BYTES, HARD_BYTES, (v) => v >= 0);
  return {
    warn: pct.warn || depth.warn || bytes.warn,
    handoff: pct.handoff || depth.handoff || bytes.handoff,
    hard: pct.hard || depth.hard || bytes.hard
  };
}
function isHardDegraded(observed = {}) {
  return evaluateBands(observed).hard === true;
}
var init_bands = __esm({
  "packages/context-handoff/lib/bands.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_thresholds();
  }
});

// packages/context-handoff/lib/deny-marker.mjs
var init_deny_marker = __esm({
  "packages/context-handoff/lib/deny-marker.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/context-handoff/lib/mutation-gate.mjs
var init_mutation_gate = __esm({
  "packages/context-handoff/lib/mutation-gate.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
  }
});

// packages/context-handoff/lib/deny-lifecycle.mjs
var init_deny_lifecycle = __esm({
  "packages/context-handoff/lib/deny-lifecycle.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_mutation_gate();
    init_deny_marker();
  }
});

// packages/context-handoff/lib/paths.mjs
var init_paths = __esm({
  "packages/context-handoff/lib/paths.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
  }
});

// packages/context-handoff/lib/atomic-json.mjs
var init_atomic_json = __esm({
  "packages/context-handoff/lib/atomic-json.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/context-handoff/lib/final.mjs
var init_final = __esm({
  "packages/context-handoff/lib/final.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_deny_marker();
    init_paths();
    init_atomic_json();
  }
});

// packages/context-handoff/lib/lock.mjs
var init_lock2 = __esm({
  "packages/context-handoff/lib/lock.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_paths();
    init_atomic_json();
  }
});

// packages/context-handoff/lib/resume-auth.mjs
var init_resume_auth = __esm({
  "packages/context-handoff/lib/resume-auth.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_paths();
    init_atomic_json();
  }
});

// packages/context-handoff/lib/bypass-grant.mjs
var init_bypass_grant = __esm({
  "packages/context-handoff/lib/bypass-grant.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_paths();
    init_atomic_json();
    init_thresholds();
  }
});

// packages/context-handoff/lib/deny-persist.mjs
var init_deny_persist = __esm({
  "packages/context-handoff/lib/deny-persist.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
    init_atomic_json();
  }
});

// packages/context-handoff/lib/text-cap.mjs
var init_text_cap = __esm({
  "packages/context-handoff/lib/text-cap.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/context-handoff/lib/capture.mjs
var MAX_CAPTURE_BYTES;
var init_capture = __esm({
  "packages/context-handoff/lib/capture.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_paths();
    init_atomic_json();
    init_text_cap();
    MAX_CAPTURE_BYTES = 64 * 1024;
  }
});

// packages/context-handoff/lib/adapter.mjs
var init_adapter = __esm({
  "packages/context-handoff/lib/adapter.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
    init_bands();
    init_mutation_gate();
    init_resume_auth();
    init_bypass_grant();
    init_thresholds();
    init_capture();
    init_final();
    init_core();
  }
});

// packages/context-handoff/lib/secret-scrub.mjs
var HOOK_SECRET_ENV_VARS;
var init_secret_scrub = __esm({
  "packages/context-handoff/lib/secret-scrub.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    HOOK_SECRET_ENV_VARS = Object.freeze([
      "ADLC_MANIFEST_KEY",
      "ADLC_ADMIN_KEY"
    ]);
  }
});

// packages/context-handoff/lib/recovery-exception.mjs
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { dirname as dirname16, join as join21 } from "node:path";
var RECOVERY_CLI_PATH;
var init_recovery_exception = __esm({
  "packages/context-handoff/lib/recovery-exception.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    RECOVERY_CLI_PATH = join21(dirname16(dirname16(fileURLToPath3(import.meta.url))), "bin", "handoff.mjs");
  }
});

// packages/context-handoff/lib/redact.mjs
var init_redact = __esm({
  "packages/context-handoff/lib/redact.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
  }
});

// packages/context-handoff/lib/brief.mjs
var init_brief = __esm({
  "packages/context-handoff/lib/brief.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_redact();
  }
});

// packages/context-handoff/lib/transcript-extract.mjs
var MAX_NARRATIVE_BYTES;
var init_transcript_extract = __esm({
  "packages/context-handoff/lib/transcript-extract.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_text_cap();
    MAX_NARRATIVE_BYTES = 32 * 1024;
  }
});

// packages/context-handoff/lib/rollback.mjs
var init_rollback = __esm({
  "packages/context-handoff/lib/rollback.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
  }
});

// packages/context-handoff/lib/checkpoint.mjs
var init_checkpoint = __esm({
  "packages/context-handoff/lib/checkpoint.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
    init_deny_persist();
    init_final();
    init_paths();
    init_atomic_json();
    init_rollback();
  }
});

// packages/context-handoff/lib/consume.mjs
var init_consume = __esm({
  "packages/context-handoff/lib/consume.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_lifecycle();
    init_deny_persist();
    init_resume_auth();
    init_paths();
    init_rollback();
  }
});

// packages/context-handoff/lib/supervise.mjs
var CHILD_SESSION_ENV_MARKERS, CHILD_SECRET_ENV_VARS, SUPERVISE_EXIT_CODES;
var init_supervise = __esm({
  "packages/context-handoff/lib/supervise.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_deny_marker();
    init_brief();
    init_thresholds();
    CHILD_SESSION_ENV_MARKERS = Object.freeze([
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT"
    ]);
    CHILD_SECRET_ENV_VARS = Object.freeze(["ADLC_MANIFEST_KEY", "ADLC_ADMIN_KEY"]);
    SUPERVISE_EXIT_CODES = Object.freeze({
      ok: 0,
      operational: 1,
      degraded: 2,
      harnessFailed: 3,
      harnessUnstartable: 4
    });
  }
});

// packages/context-handoff/lib/index.mjs
var init_lib = __esm({
  "packages/context-handoff/lib/index.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_thresholds();
    init_bands();
    init_mutation_gate();
    init_deny_lifecycle();
    init_deny_marker();
    init_paths();
    init_final();
    init_lock2();
    init_resume_auth();
    init_bypass_grant();
    init_deny_persist();
    init_adapter();
    init_secret_scrub();
    init_recovery_exception();
    init_text_cap();
    init_capture();
    init_brief();
    init_transcript_extract();
    init_checkpoint();
    init_consume();
    init_redact();
    init_rollback();
    init_supervise();
  }
});

// packages/build-gate/lib/depth-signal.mjs
var depth_signal_exports = {};
__export(depth_signal_exports, {
  DEFAULT_BYTES_THRESHOLD: () => DEFAULT_BYTES_THRESHOLD,
  DEFAULT_DEPTH_THRESHOLD: () => DEFAULT_DEPTH_THRESHOLD,
  PROSE_TOOL_LINE: () => PROSE_TOOL_LINE,
  classifyTranscriptSignal: () => classifyTranscriptSignal,
  computeDepthSignal: () => computeDepthSignal,
  countToolCalls: () => countToolCalls,
  isDegraded: () => isDegraded
});
function countToolCalls(text) {
  if (!text) return 0;
  const toolCallRecords = text.match(/"type"\s*:\s*"(?:tool_use|function_call|custom_tool_call|web_search_call|tool_search_call|image_generation_call)"/g) ?? [];
  const proseToolLines = text.match(PROSE_TOOL_LINE) ?? [];
  return toolCallRecords.length + proseToolLines.length;
}
function computeDepthSignal({ text, bytes } = {}) {
  const toolCallCount = countToolCalls(text ?? "");
  const resolvedBytes = typeof bytes === "number" ? bytes : Buffer.byteLength(text ?? "", "utf8");
  return { bytes: resolvedBytes, toolCallCount, depth: toolCallCount };
}
function classifyTranscriptSignal(sig) {
  const depth = sig?.depth;
  return typeof depth === "number" && depth > 0 ? "measured" : "degenerate";
}
function isDegraded({
  depth,
  sessionBytes,
  bytes,
  pct,
  depthThreshold = DEFAULT_DEPTH_THRESHOLD,
  bytesThreshold = DEFAULT_BYTES_THRESHOLD
} = {}) {
  const resolvedBytes = typeof sessionBytes === "number" ? sessionBytes : bytes;
  const usingDefaults = depthThreshold === DEFAULT_DEPTH_THRESHOLD && bytesThreshold === DEFAULT_BYTES_THRESHOLD;
  if (usingDefaults) {
    return isHardDegraded({ depth, bytes: resolvedBytes, pct });
  }
  const depthDegraded = typeof depth === "number" && depth >= depthThreshold;
  const bytesDegraded = typeof resolvedBytes === "number" && resolvedBytes >= bytesThreshold;
  return depthDegraded || bytesDegraded;
}
var DEFAULT_DEPTH_THRESHOLD, DEFAULT_BYTES_THRESHOLD, PROSE_TOOL_LINE;
var init_depth_signal = __esm({
  "packages/build-gate/lib/depth-signal.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_lib();
    DEFAULT_DEPTH_THRESHOLD = HARD_DEPTH;
    DEFAULT_BYTES_THRESHOLD = HARD_BYTES;
    PROSE_TOOL_LINE = /^[ \t]*(?:\[?(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?[ \t]+)?(?:Writing|Editing|Created)[ \t]+\S+/gim;
  }
});

// packages/build-gate/lib/active-ticket.mjs
var active_ticket_exports = {};
__export(active_ticket_exports, {
  resolveActiveTicketId: () => resolveActiveTicketId3
});
function resolveActiveTicketId3({ dir = ".", env = process.env } = {}) {
  const result = resolveActiveTicketId({ root: dir, env });
  if (!result.ok) return { id: null, conflict: true, code: result.code, message: result.message };
  if (result.value === null) return { id: null, conflict: false };
  return { id: result.value.id, conflict: false };
}
var init_active_ticket = __esm({
  "packages/build-gate/lib/active-ticket.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_tickets();
  }
});

// packages/gate-manifest/lib/sign.mjs
import { createHmac as createHmac3 } from "node:crypto";
function signEntry(key, entry) {
  if (isEd25519PrivateKey(key)) {
    return signEntryEd25519(key, entry);
  }
  return createHmac3("sha256", key).update(canonicalEntryBytes(entry)).digest("hex");
}
function assertEd25519KeyMatchesAdminPub2(dir, key) {
  if (!isEd25519PrivateKey(key)) return;
  const derivedPub = derivePublicKeyPem(key);
  const adminPub = readAdminPublicKey(dir);
  if (adminPub.status === "error") {
    throw new Error(`${ADMIN_PUB_FILENAME}: ${adminPub.reason}`);
  }
  if (adminPub.status === "ok" && adminPub.publicKey !== derivedPub) {
    throw new Error(`Ed25519 private key does not match ${ADMIN_PUB_FILENAME}`);
  }
}
var init_sign = __esm({
  "packages/gate-manifest/lib/sign.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_manifest_primitives();
    init_key_contract();
  }
});

// packages/gate-manifest/lib/verify.mjs
function verify(dir = ADLC_DIR, { requireSignatures = true, requireEntries = false, key: keyParam, publicKey } = {}) {
  const key = validateKeyParam(keyParam);
  return verifyManifestForest(dir, { requireSignatures, requireEntries, key, publicKey });
}
var init_verify = __esm({
  "packages/gate-manifest/lib/verify.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_manifest_primitives();
    init_key_contract();
  }
});

// packages/gate-manifest/lib/lineage.mjs
var init_lineage = __esm({
  "packages/gate-manifest/lib/lineage.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_manifest_primitives();
  }
});

// packages/gate-manifest/lib/forest.mjs
function parseLenient(rawLines, segmentLabel) {
  const entries = [];
  const skipped = [];
  for (const { line, lineNo } of rawLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: String(err.message ?? err) });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skipped.push({ segment: segmentLabel, line: lineNo, error: "entry must be an object" });
      continue;
    }
    entries.push({ ...entry, segment: segmentLabel });
  }
  return { entries, skipped };
}
function readManifestForest(dir = ADLC_DIR) {
  const rootRaw = readRawLines(ledgerPath("manifest", dir));
  const root = parseLenient(rootRaw, "root");
  const { valid: segmentNames, invalid: invalidSegments } = discoverSegments(dir);
  const skipped = [...root.skipped, ...invalidSegments.map((i) => ({ segment: i.name, line: null, error: i.reason }))];
  const bySegment = /* @__PURE__ */ new Map();
  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const parsed = parseLenient(raw, name);
    skipped.push(...parsed.skipped);
    const anchor = parsed.entries.length > 0 && Object.hasOwn(parsed.entries[0], "anchor") ? parsed.entries[0].anchor : null;
    bySegment.set(name, { entries: parsed.entries, anchor });
  }
  const anchorMap = /* @__PURE__ */ new Map();
  for (const [name, info] of bySegment.entries()) anchorMap.set(name, info.anchor);
  const orderedNames = orderSegmentNames(segmentNames, anchorMap);
  const entries = [...root.entries];
  for (const name of orderedNames) entries.push(...bySegment.get(name).entries);
  return { entries, skipped };
}
var init_forest = __esm({
  "packages/gate-manifest/lib/forest.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_manifest_primitives();
  }
});

// packages/gate-manifest/lib/segment-writer.mjs
import { existsSync as existsSync17, readFileSync as readFileSync14, mkdirSync as mkdirSync8, openSync as openSync8, writeFileSync as writeFileSync8, fsyncSync as fsyncSync4, closeSync as closeSync8 } from "node:fs";
import { dirname as dirname17 } from "node:path";
function appendToSegment(payload, dir, { signatureVersion, cwd, key }) {
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, { cwd }));
  if (!isSegmentedRepo(dir)) {
    throw new Error(`refusing to append segment entry to non-segmented manifest directory: ${dir}`);
  }
  return withLedgerLock(lineagePath(dir), () => appendWithinLedgerLock(payload, dir, { signatureVersion, cwd, key }));
}
function appendWithinLedgerLock(payload, dir, { signatureVersion, cwd, key }) {
  assertEd25519KeyMatchesAdminPub2(dir, key);
  const integrity = verify(dir, { requireSignatures: false, key });
  if (!integrity.valid) {
    throw new Error(`manifest forest is invalid: ${integrity.message}`);
  }
  const resolved = resolveOpenSegment(dir, { cwd, key });
  const targetPath = segmentPath(dir, resolved.name);
  mkdirSync8(segmentDirPath(dir), { recursive: true });
  return withLedgerLock(targetPath, () => appendLockedEntry(payload, resolved, targetPath, signatureVersion, key));
}
function appendLockedEntry(payload, resolved, targetPath, signatureVersion, key) {
  const content = existsSync17(targetPath) ? readFileSync14(targetPath, "utf8") : "";
  const rawLines = content.split("\n").filter((line) => line.trim() !== "");
  if (resolved.isNew && rawLines.length > 0) {
    throw new Error(`segment ${resolved.name} was expected to be new but already has content \u2014 refusing to append`);
  }
  if (!resolved.isNew && rawLines.length === 0) {
    throw new Error(`segment ${resolved.name} was expected to already be open with content but is empty or missing \u2014 refusing to append without an anchor`);
  }
  const entries = rawLines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`segment ${resolved.name} contains malformed JSON at line ${i + 1}`);
    }
  });
  const previous = entries.at(-1) ?? null;
  if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
    throw new Error(`segment ${resolved.name} tail is not hash-chain compatible: missing positive seq`);
  }
  const prevRawLine = rawLines.at(-1) ?? null;
  const normalized = {
    ...payload,
    gate: payload.gate ?? payload.type ?? "evidence",
    ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    files: payload.files ?? {}
  };
  const chained = {
    seq: previous ? previous.seq + 1 : 1,
    ...normalized,
    // `anchor`/`branch` spread AFTER `...normalized`, not before (adversarial-
    // review finding, T-MANIFEST-FOREST fourth round): `RESERVED_CHAIN_FIELDS`
    // in record.mjs already rejects a payload that supplies either field
    // outright, but constructing these writer-owned structural fields LAST is
    // defense-in-depth — a payload can never overwrite them regardless of
    // what upstream validation does or doesn't catch. `branch` is the EXACT
    // git branch that minted this segment, recorded once on the first entry
    // alongside `anchor` — a non-lossy identity recoverOpenSegment matches on,
    // unlike the derived filename slug (see lineage.mjs's recoverOpenSegment
    // doc). Omitted (not `anchor`-style `null`) when resolveOpenSegment minted
    // this segment from a detached HEAD, which has no branch identity.
    ...resolved.isNew ? { anchor: resolved.anchor, ...resolved.branch !== void 0 ? { branch: resolved.branch } : {} } : {},
    prev: prevRawLine === null ? null : sha2562(prevRawLine)
  };
  const effectiveSignatureVersion = resolved.isNew ? 2 : signatureVersion;
  if (key) {
    if (isEd25519PrivateKey(key)) {
      chained.sigVersion = 2;
      chained.sigAlg = SIG_ALG_ED25519;
    } else if (effectiveSignatureVersion === 2) {
      chained.sigVersion = 2;
    }
    chained.sig = signEntry(key, chained);
  }
  const fd = openSync8(targetPath, "a");
  try {
    writeFileSync8(fd, `${JSON.stringify(chained)}
`);
    fsyncSync4(fd);
  } finally {
    closeSync8(fd);
  }
  if (process.platform !== "win32") {
    const dirFd = openSync8(dirname17(targetPath), "r");
    try {
      fsyncSync4(dirFd);
    } finally {
      closeSync8(dirFd);
    }
  }
  return chained;
}
var init_segment_writer = __esm({
  "packages/gate-manifest/lib/segment-writer.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_sign();
    init_verify();
    init_forest();
    init_lineage();
  }
});

// packages/gate-manifest/lib/record.mjs
import { dirname as dirname18 } from "node:path";
function appendManifestEntry(payload, dir = ADLC_DIR, { signatureVersion = 2, cwd = dirname18(dir), key } = {}) {
  const signingKey = validateKeyParam(key);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("manifest payload must be an object");
  }
  for (const field of RESERVED_CHAIN_FIELDS) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(`manifest payload must not provide reserved chain field: ${field}`);
    }
  }
  if (isSegmentedRepo(dir)) {
    return appendToSegment(payload, dir, { signatureVersion, cwd, key: signingKey });
  }
  const [entry] = appendEntries("manifest", (state) => {
    if (isSegmentedRepo(dir)) {
      throw new Error("manifest chain is frozen; this repo uses .adlc/manifest.d/ \u2014 upgrade adlc if you are seeing this locally");
    }
    if (state.skipped.length > 0) {
      throw new Error(`manifest contains malformed JSON at line ${state.skipped[0].line}`);
    }
    if (state.rawLines.length > 0) {
      const integrity = verify(dir, { requireSignatures: false, key: signingKey });
      if (!integrity.valid) {
        throw new Error(`manifest chain is invalid: ${integrity.message}`);
      }
    } else {
      const { valid: existingSegments } = discoverSegments(dir);
      if (existingSegments.length > 0) {
        throw new Error(
          `refusing to create the root manifest: manifest.d/ already holds ${existingSegments.length} segment(s) anchored to nothing (anchor: null), legal only in a rootless forest \u2014 creating a root now would make every one of them invalid (spec \xA74.4). This usually means the activation marker (.adlc/manifest.d/.store.json) was lost or corrupted; restore it rather than appending to root.`
        );
      }
    }
    const previous = state.entries.at(-1);
    if (previous && (!Number.isInteger(previous.seq) || previous.seq < 1)) {
      throw new Error("manifest tail is not hash-chain compatible: missing positive seq");
    }
    const normalized = {
      ...payload,
      gate: payload.gate ?? payload.type ?? "evidence",
      ts: payload.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
      files: payload.files ?? {}
    };
    const chained = {
      seq: previous ? previous.seq + 1 : 1,
      ...normalized,
      prev: state.lastRawLine === null ? null : sha2562(state.lastRawLine)
    };
    if (signingKey) {
      assertEd25519KeyMatchesAdminPub2(dir, signingKey);
      if (isEd25519PrivateKey(signingKey)) {
        chained.sigVersion = 2;
        chained.sigAlg = SIG_ALG_ED25519;
      } else if (signatureVersion === 2) {
        chained.sigVersion = 2;
      }
      chained.sig = signEntry(signingKey, chained);
    }
    return [chained];
  }, dir);
  return entry;
}
function parseData(raw) {
  if (!raw) return void 0;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--data is not valid JSON: ${err.message}`);
  }
}
function parseFileList(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function record({ gate, ticket, rawData, rawFiles, dir = ADLC_DIR, key }) {
  const signingKey = validateKeyParam(key);
  const data = parseData(rawData);
  const filePaths = parseFileList(rawFiles);
  const payload = { gate, ts: (/* @__PURE__ */ new Date()).toISOString() };
  if (ticket !== void 0) payload.ticket = ticket;
  if (data !== void 0) payload.data = data;
  payload.files = filePaths.length > 0 ? hashFiles(filePaths) : {};
  return appendManifestEntry(payload, dir, { signatureVersion: 1, key: signingKey });
}
var RESERVED_CHAIN_FIELDS;
var init_record = __esm({
  "packages/gate-manifest/lib/record.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_core();
    init_sign();
    init_verify();
    init_lineage();
    init_segment_writer();
    init_forest();
    init_key_contract();
    RESERVED_CHAIN_FIELDS = ["seq", "prev", "sig", "sigVersion", "sigAlg", "segment", "anchor", "branch"];
  }
});

// packages/build-gate/lib/override.mjs
var override_exports = {};
__export(override_exports, {
  recordOverride: () => recordOverride
});
function recordOverride({ ticketId, signals, depth, sessionBytes, reason, dir = ADLC_DIR, key }) {
  try {
    if (typeof key !== "string" || key === "") {
      const { entries } = readManifestForest(dir);
      if (entries.some((e) => typeof e?.sig === "string" && e.sig !== "")) {
        return false;
      }
    }
    record({
      gate: "build-gate-bypass",
      ticket: ticketId ?? void 0,
      rawData: JSON.stringify({
        signals: signals ?? [],
        depth: depth ?? null,
        sessionBytes: sessionBytes ?? null,
        reason: reason ?? null
      }),
      dir,
      key
    });
    return true;
  } catch {
    return false;
  }
}
var init_override = __esm({
  "packages/build-gate/lib/override.mjs"() {
    init_define_ADLC_MCP_BUILD_METADATA();
    init_record();
    init_forest();
    init_core();
  }
});

// plugins/adlc-cursor/hooks/adlc-pretool.mjs
init_define_ADLC_MCP_BUILD_METADATA();
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { isAbsolute as isAbsolute10, join as join22 } from "node:path";

// plugins/adlc-cursor/hooks/adlc-rails-guard.mjs
init_define_ADLC_MCP_BUILD_METADATA();
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { isAbsolute as isAbsolute9, resolve as resolve7, relative as relative6, dirname as dirname15, basename as basename4, join as join20 } from "node:path";
import { realpathSync as realpathSync3, existsSync as existsSync16 } from "node:fs";

// plugins/adlc-cursor/rails-checker.mjs
init_define_ADLC_MCP_BUILD_METADATA();
init_core();
init_tickets();
import { isAbsolute as isAbsolute7, join as join17, relative as relative5 } from "node:path";

// plugins/adlc-cursor/generated-active-ticket.mjs
init_define_ADLC_MCP_BUILD_METADATA();
import { lstatSync as lstatSync12, openSync as openSync7, fstatSync as fstatSync3, readSync as readSync4, closeSync as closeSync7, constants as fsConstants4 } from "node:fs";
import { dirname as dirname12, join as join16 } from "node:path";
var CURRENT_TICKET_FILE2 = ".adlc/current-ticket.json";
var MAX_POINTER_BYTES2 = 64 * 1024;
var ABSENT2 = /* @__PURE__ */ Symbol("pointer-absent");
function readPointerFileBounded2(path) {
  let parentLst;
  try {
    parentLst = lstatSync12(dirname12(path));
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT2 : null;
  }
  if (!parentLst.isDirectory()) return null;
  let lst;
  try {
    lst = lstatSync12(path);
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT2 : null;
  }
  if (!lst.isFile() || lst.size > MAX_POINTER_BYTES2) return null;
  let fd;
  try {
    fd = openSync7(path, fsConstants4.O_RDONLY | fsConstants4.O_NONBLOCK | fsConstants4.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync3(fd);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES2) return null;
    if (lst.dev !== 0 && lst.ino !== 0 && (stat.dev !== lst.dev || stat.ino !== lst.ino)) return null;
    const length = stat.size;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync4(fd, buf, read, length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    try {
      closeSync7(fd);
    } catch {
    }
  }
}
var CANONICAL_ID_KEY2 = "id";
var DEPRECATED_ID_KEYS2 = Object.freeze(["ticket", "ticketId"]);
var ok2 = (value) => ({ ok: true, value });
var fail2 = (kind, code, message) => ({ ok: false, kind, code, message });
var invalid3 = (code, message) => fail2("invalid", code, message);
var conflict3 = (code, message) => fail2("conflict", code, message);
var isPlainObject3 = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var trimmed2 = (value) => typeof value === "string" ? value.trim() : "";
function conflictMessage2(envId, fileId) {
  return `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE2} ("${fileId}"): they name different tickets. The active ticket is per-worktree state \u2014 ADLC supports exactly one active ticket per worktree, and parallel work on a second ticket needs its own worktree (git worktree add <path> -b <branch>), not a second pointer in this one. Failing closed: which ticket governs this build cannot be determined.`;
}
function readActiveTicketPointer2(root = ".") {
  const path = join16(root, CURRENT_TICKET_FILE2);
  const raw = readPointerFileBounded2(path);
  if (raw === ABSENT2) return ok2({ present: false });
  if (raw === null) {
    return fail2("operational", "INVALID_CURRENT_TICKET", `cannot read ${CURRENT_TICKET_FILE2} as a bounded regular file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid3("INVALID_CURRENT_TICKET", `cannot parse ${CURRENT_TICKET_FILE2}: ${error.message}`);
  }
  if (typeof parsed === "string") {
    const id2 = parsed.trim();
    if (!id2) return invalid3("INVALID_CURRENT_TICKET", `${CURRENT_TICKET_FILE2} is an empty string pointer`);
    return ok2({ present: true, id: id2, ticketHash: null, legacyString: true });
  }
  if (!isPlainObject3(parsed)) {
    return invalid3(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} must be an object like {"id":"T1","ticketHash":"<64 hex>"} (got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}). To deactivate, delete the file.`
    );
  }
  let usedKey = null;
  for (const key of [CANONICAL_ID_KEY2, ...DEPRECATED_ID_KEYS2]) {
    if (Object.hasOwn(parsed, key)) {
      usedKey = key;
      break;
    }
  }
  if (usedKey === null) {
    const found = Object.keys(parsed);
    return invalid3(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} declares no ticket id: expected "${CANONICAL_ID_KEY2}" (or deprecated ${DEPRECATED_ID_KEYS2.map((k) => `"${k}"`).join("/")}), found ${found.length ? found.map((k) => `"${k}"`).join(", ") : "no keys"}. Failing closed rather than treating an unrecognized pointer as "no active ticket". To deactivate, delete the file.`
    );
  }
  const id = trimmed2(parsed[usedKey]);
  if (!id) {
    return invalid3(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} has a "${usedKey}" that is not a non-empty string`
    );
  }
  const value = { present: true, id, ticketHash: trimmed2(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY2) value.deprecatedAlias = usedKey;
  return ok2(value);
}
function resolveActiveTicketId2({ root = ".", env = process.env } = {}) {
  const pointer = readActiveTicketPointer2(root);
  if (!pointer.ok) return pointer;
  const envId = trimmed2(env.ADLC_TICKET) || null;
  const file = pointer.value;
  const fileId = file.present ? file.id : null;
  if (envId && fileId && envId !== fileId) return conflict3("ACTIVE_TICKET_CONFLICT", conflictMessage2(envId, fileId));
  const id = envId ?? fileId;
  if (!id) return ok2(null);
  return ok2({
    id,
    pointerPresent: file.present,
    ticketHash: file.present ? file.ticketHash : null,
    legacyString: file.present ? Boolean(file.legacyString) : false,
    ...file.deprecatedAlias ? { deprecatedAlias: file.deprecatedAlias } : {}
  });
}
function resolveActiveTicketAgainst2(snapshot, { root = ".", env = process.env, allowLegacyPointer = false } = {}) {
  const resolved = resolveActiveTicketId2({ root, env });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok2(null);
  const { id, pointerPresent, ticketHash: ticketHash2, legacyString, deprecatedAlias } = resolved.value;
  const ticket = snapshot.get(id);
  if (!ticket) {
    return invalid3("ACTIVE_TICKET_MISSING", `active ticket "${id}" is not in the ticket store`);
  }
  const expected = snapshot.ticketHashes[id];
  const warnings = [];
  if (deprecatedAlias) {
    warnings.push(
      `${CURRENT_TICKET_FILE2} uses the deprecated "${deprecatedAlias}" key; rewrite it as {"id":"${id}","ticketHash":"${expected}"} ("${deprecatedAlias}" is removed in 2.0).`
    );
  }
  if (pointerPresent) {
    if (!ticketHash2) {
      const detail = legacyString ? "a legacy bare-string pointer pins no ticketHash" : `${CURRENT_TICKET_FILE2} pins no ticketHash`;
      if (!allowLegacyPointer) {
        return invalid3(
          "ACTIVE_TICKET_HASH_MISSING",
          `${detail}; it must pin ticketHash so a ticket changing after selection is detectable. Expected {"id":"${id}","ticketHash":"${expected}"}.`
        );
      }
      warnings.push(`${detail}; a ticket changing after selection cannot be detected. Expected ticketHash "${expected}". Strict in 2.0.`);
    } else if (ticketHash2 !== expected) {
      return conflict3(
        "ACTIVE_TICKET_STALE",
        `active ticket "${id}" changed after selection (pointer pins ${ticketHash2}, store has ${expected}). Re-select the ticket to confirm you intend to build against the new contract.`
      );
    }
  }
  return ok2({
    id,
    ticket,
    ticketHash: expected,
    storeHash: snapshot.hash,
    warnings,
    ...deprecatedAlias ? { deprecatedAlias } : {}
  });
}

// plugins/adlc-cursor/constants.mjs
init_define_ADLC_MCP_BUILD_METADATA();
var SESSION_TTL_MS = 30 * 60 * 1e3;

// plugins/adlc-cursor/rails-checker.mjs
var TRUST_ROOT_RAILS = [...TICKET_TRUST_ROOT_RAILS];
var MUTATING_TOOL_HINTS = ["write", "edit", "replace", "patch", "create", "delete", "remove", "rename", "move", "apply", "insert", "append"];
var PURE_READS = /* @__PURE__ */ new Set([
  "read",
  "readfile",
  "readlints",
  "grep",
  "grepsearch",
  "glob",
  "globsearch",
  "codebasesearch",
  "semanticsearch",
  "filesearch",
  "globfilesearch",
  "list",
  "listdir",
  "ls",
  "cat",
  "view",
  "viewfile",
  "webfetch",
  "websearch",
  "fetch",
  "fetchrules",
  "fetchpullrequest",
  "search"
]);
function normalizeToolName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z]/g, "");
}
var SHELL_TOOL_NAMES = /* @__PURE__ */ new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "shell",
  "terminal",
  "cmd",
  "powershell",
  "pwsh",
  "console",
  "exec",
  "run",
  "runcommand",
  "runcmd",
  "runterminalcmd",
  "runterminalcommand",
  "runinterminal",
  "runinterminalcommand",
  "runshell",
  "runshellcommand",
  "shellexec",
  "shellcommand",
  "executecommand",
  "execcommand",
  "executecommandline",
  "execcommandline",
  "executeshell",
  "executeterminalcommand",
  "terminalcmd",
  "terminalcommand"
]);
function isShellTool(name) {
  return SHELL_TOOL_NAMES.has(normalizeToolName(name));
}
var NON_MUTATING_STRUCTURED_TOOL_NAMES = /* @__PURE__ */ new Set(["todowrite", "creatediagram"]);
function classifyTool(name) {
  const n = normalizeToolName(name);
  if (!n) return "other";
  if (NON_MUTATING_STRUCTURED_TOOL_NAMES.has(n)) return "readonly";
  if (MUTATING_TOOL_HINTS.some((h) => n.includes(h))) return "mutating";
  if (PURE_READS.has(n)) return "readonly";
  return "other";
}
function canonicalizePath2(filePath, root) {
  const abs = isAbsolute7(filePath) ? filePath : join17(root, filePath);
  return relative5(root, abs).split("\\").join("/");
}
function railPreconditions({ root = process.cwd(), env = process.env } = {}) {
  if (env.ADLC_P4_ENFORCEMENT === "0") {
    return { state: "inactive", reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT === "0")' };
  }
  let snapshot;
  try {
    snapshot = detectTicketStore({
      root,
      ticketStore: env.ADLC_TICKET_STORE,
      legacyTickets: env.ADLC_TICKETS,
      env
    }).load();
  } catch (err) {
    if (err?.code === "STORE_NOT_FOUND") {
      return { state: "inactive", reason: "repo not ADLC-initialized (no supported ticket store)" };
    }
    return {
      state: "deny",
      reason: `ticket store failed to load (${err?.code ?? "error"}: ${err?.message ?? err}) \u2014 failing closed`
    };
  }
  const against = resolveActiveTicketAgainst2(snapshot, { root, env, allowLegacyPointer: true });
  if (!against.ok) {
    return {
      state: "deny",
      reason: against.message ?? "conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)"
    };
  }
  if (!against.value) {
    return { state: "inactive", reason: "no active ticket resolved" };
  }
  const ticket = against.value.ticket;
  const declaredRails = ticket.rails ?? [];
  if (declaredRails.some((rail) => typeof rail !== "string" || rail.length === 0)) {
    return { state: "deny", reason: `active ticket ${against.value.id} has a malformed rail entry \u2014 failing closed` };
  }
  return { state: "active", rails: [...declaredRails, ...TRUST_ROOT_RAILS], activeId: against.value.id };
}
function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  if (classifyTool(tool) === "readonly") {
    return { decision: "allow", reason: `tool "${tool}" is read-only` };
  }
  const pre = railPreconditions({ root, env });
  if (pre.state === "inactive") return { decision: "allow", reason: pre.reason };
  if (pre.state === "deny") return { decision: "deny", reason: pre.reason };
  const candidates = /* @__PURE__ */ new Set([canonicalizePath2(filePath, root), resolveRailPath(filePath, root)]);
  for (const path of candidates) {
    const hit = pre.rails.find((rail) => rail === path || globMatch2(rail, path));
    if (hit) {
      return { decision: "deny", reason: `frozen rail "${hit}" (active ticket ${pre.activeId})` };
    }
  }
  return { decision: "allow", reason: "path is not a frozen rail" };
}

// plugins/adlc-cursor/lib/workspace-resolve.mjs
init_define_ADLC_MCP_BUILD_METADATA();
init_tickets();
init_core();
import { existsSync as existsSync15, mkdirSync as mkdirSync7, readFileSync as readFileSync13, renameSync as renameSync4, writeFileSync as writeFileSync7 } from "node:fs";
import { dirname as dirname14, isAbsolute as isAbsolute8, join as join19, normalize as normalize2, resolve as pathResolve } from "node:path";

// plugins/adlc-cursor/lib/session-state.mjs
init_define_ADLC_MCP_BUILD_METADATA();
import {
  existsSync as existsSync14,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync12,
  renameSync as renameSync3,
  unlinkSync as unlinkSync5,
  writeFileSync as writeFileSync6
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname13, join as join18 } from "node:path";

// plugins/adlc-cursor/lib/session-identity.mjs
init_define_ADLC_MCP_BUILD_METADATA();
import { createHash as createHash3 } from "node:crypto";
var SESSION_ENV_KEY = "ADLC_CURSOR_SESSION_ID";
var PAYLOAD_SESSION_KEYS = Object.freeze(["session_id", "sessionId", "conversation_id", "conversationId"]);
var REJECTED_AS_SESSION_KEYS = Object.freeze(["thread_id", "threadId", "generation_id", "generationId"]);
function resolveSessionIdentity(payload = {}, env = process.env) {
  const envId = trimmed3(env?.[SESSION_ENV_KEY]);
  const payloadIds = collectPayloadSessionIds(payload);
  if (payloadIds.conflict) {
    return {
      ok: false,
      sessionId: null,
      source: "conflict",
      conflict: true,
      message: payloadIds.message
    };
  }
  const payloadId = payloadIds.id;
  if (envId && payloadId && envId !== payloadId) {
    return {
      ok: false,
      sessionId: null,
      source: "conflict",
      conflict: true,
      message: `${SESSION_ENV_KEY} ("${envId}") conflicts with payload session id ("${payloadId}"). Named session state will not be read or mutated.`
    };
  }
  if (envId) return { ok: true, sessionId: envId, source: "env" };
  if (payloadId) return { ok: true, sessionId: payloadId, source: "payload" };
  return { ok: true, sessionId: null, source: "anonymous" };
}
function sessionSafeId(sessionId) {
  return createHash3("sha256").update(String(sessionId), "utf8").digest("hex");
}
function trimmed3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function collectPayloadSessionIds(payload) {
  if (!payload || typeof payload !== "object") return { id: null };
  const found = [];
  for (const key of PAYLOAD_SESSION_KEYS) {
    if (!Object.hasOwn(payload, key)) continue;
    const v = trimmed3(payload[key]);
    if (v) found.push({ key, v });
  }
  for (const key of REJECTED_AS_SESSION_KEYS) {
    if (Object.hasOwn(payload, key) && trimmed3(payload[key]) && found.length === 0) {
      return { id: null };
    }
  }
  if (found.length === 0) return { id: null };
  const first = found[0].v;
  for (const item of found) {
    if (item.v !== first) {
      return {
        id: null,
        conflict: true,
        message: `payload session aliases disagree (${found.map((f) => `${f.key}=${f.v}`).join(", ")})`
      };
    }
  }
  return { id: first };
}

// plugins/adlc-cursor/lib/session-state.mjs
function resolveStateDir(env = process.env) {
  const override = typeof env.ADLC_CURSOR_STATE_DIR === "string" && env.ADLC_CURSOR_STATE_DIR.trim() ? env.ADLC_CURSOR_STATE_DIR.trim() : null;
  return override || join18(homedir2(), ".cursor", "adlc");
}
function ensureDir(dir) {
  mkdirSync6(dir, { recursive: true });
}
function depthPath(stateDir, sessionId) {
  const name = sessionId ? `cursor-buildgate-depth-${sessionSafeId(sessionId)}.json` : "cursor-buildgate-depth-anonymous.json";
  const path = join18(stateDir, name);
  if (!path.startsWith(stateDir)) throw new Error("depth path escaped state dir");
  return path;
}
function markerPath2(stateDir, sessionId) {
  const name = sessionId ? `cursor-p5-marker-${sessionSafeId(sessionId)}.json` : "cursor-p5-marker-anonymous.json";
  const path = join18(stateDir, name);
  if (!path.startsWith(stateDir)) throw new Error("marker path escaped state dir");
  return path;
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync12(path, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(path, value) {
  ensureDir(dirname13(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync6(tmp, `${JSON.stringify(value)}
`);
  renameSync3(tmp, path);
}
var LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
function withStateLock(lockPath2, fn, {
  now = Date.now(),
  leaseMs = 5e3,
  retries = 40,
  backoffMs = 25,
  wait = Atomics.wait
} = {}) {
  ensureDir(dirname13(lockPath2));
  const owner = `${process.pid}.${now}.${Math.random().toString(16).slice(2)}`;
  for (let i = 0; i < retries; i++) {
    try {
      if (existsSync14(lockPath2)) {
        const cur = readJson(lockPath2);
        if (cur?.leaseUntil && cur.leaseUntil < now) {
          try {
            unlinkSync5(lockPath2);
          } catch {
          }
        }
      }
      writeFileSync6(lockPath2, `${JSON.stringify({ owner, leaseUntil: now + leaseMs })}
`, { flag: "wx" });
      try {
        return fn({ owner, revalidate() {
          const cur = readJson(lockPath2);
          if (!cur || cur.owner !== owner) throw new Error("STATE_LOCK_LOST");
        } });
      } finally {
        const cur = readJson(lockPath2);
        if (cur?.owner === owner) {
          try {
            unlinkSync5(lockPath2);
          } catch {
          }
        }
      }
    } catch (err) {
      if (err?.code === "EEXIST" || err?.message === "STATE_LOCK_LOST") {
        if (typeof wait === "function") {
          wait(LOCK_WAIT_BUF, 0, 0, backoffMs);
        } else {
          const end = Date.now() + backoffMs;
          while (Date.now() < end) {
          }
        }
        now = Date.now();
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not acquire state lock: ${lockPath2}`);
}
function bumpDepthCounter(rootIgnored, {
  now = Date.now(),
  conversationId = null,
  sessionId = conversationId,
  toolUseId = null,
  ttlMs = SESSION_TTL_MS,
  env = process.env
} = {}) {
  const stateDir = resolveStateDir(env);
  const path = depthPath(stateDir, sessionId);
  const lockPath2 = `${path}.lock`;
  return withStateLock(lockPath2, ({ revalidate }) => {
    let data = readJson(path);
    const fresh = data && typeof data.updatedAt === "number" && now - data.updatedAt >= 0 && now - data.updatedAt <= ttlMs;
    if (!fresh) data = { count: 0, seen: {}, updatedAt: now, sessionId: sessionId ?? null };
    const seen = data.seen && typeof data.seen === "object" ? { ...data.seen } : {};
    for (const [id2, ts] of Object.entries(seen)) {
      if (typeof ts !== "number" || now - ts > ttlMs) delete seen[id2];
    }
    const id = typeof toolUseId === "string" && toolUseId.trim() ? toolUseId.trim() : null;
    if (id && seen[id]) {
      revalidate();
      atomicWrite(path, { ...data, seen, updatedAt: now, sessionId: sessionId ?? null });
      return data.count ?? 0;
    }
    const next = (Number.isInteger(data.count) && data.count >= 0 ? data.count : 0) + 1;
    if (id) seen[id] = now;
    const record2 = { count: next, seen, updatedAt: now, sessionId: sessionId ?? null };
    revalidate();
    atomicWrite(path, record2);
    return next;
  }, { now });
}
function readP5Marker(sessionId, { env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const cur = readJson(markerPath2(resolveStateDir(env), sessionId));
  if (!cur) return null;
  if (typeof cur.ts !== "number" || now - cur.ts > ttlMs) return null;
  if ((cur.sessionId ?? null) !== (sessionId ?? null)) return null;
  return cur;
}

// plugins/adlc-cursor/lib/workspace-resolve.mjs
function normalizeRootPath(raw) {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  const win = p.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (win) p = `${win[1]}:\\${win[2].replace(/\//g, "\\")}`;
  p = normalize2(p);
  try {
    if (existsSync15(p)) return pathResolve(p);
  } catch {
  }
  return isAbsolute8(p) ? p : null;
}

// plugins/adlc-cursor/hooks/adlc-rails-guard.mjs
init_core();
function realOr(p) {
  try {
    return realpathSync3(p);
  } catch {
    return p;
  }
}
function realpathDeepest(absPath) {
  if (existsSync16(absPath)) return realOr(absPath);
  const tail = [];
  let cur = absPath;
  while (!existsSync16(cur)) {
    const parent = dirname15(cur);
    if (parent === cur) break;
    tail.unshift(basename4(cur));
    cur = parent;
  }
  return tail.length ? resolve7(realOr(cur), ...tail) : realOr(cur);
}
var TOOL_NAME_KEYS = ["tool_name", "toolName", "tool", "name"];
var INPUT_BAG_KEYS = ["tool_input", "toolInput", "input", "args", "arguments", "params", "parameters"];
var PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath", "target_file", "targetFile", "target", "target_path", "targetPath"];
var ROOT_KEYS = ["workspace_roots", "workspaceRoots", "workspace_root", "workspaceRoot", "project_root", "projectRoot", "cwd", "root"];
function firstString(obj, keys) {
  if (!obj || typeof obj !== "object") return void 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0];
  }
  return void 0;
}
function extractToolName(payload) {
  return firstString(payload, TOOL_NAME_KEYS) ?? "";
}
var BATCH_KEYS = ["edits", "files", "changes", "operations", "fileEdits", "file_edits"];
var PATCH_TEXT_KEYS = ["command", "cmd", "patch", "input", "content", "text", "diff"];
var PATCH_PREFIXES = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
function collectPatchPaths(text, out) {
  for (const line of String(text).split(/\r?\n/)) {
    for (const pre of PATCH_PREFIXES) {
      if (line.startsWith(pre)) {
        const p = line.slice(pre.length).trim();
        if (p) out.add(p);
      }
    }
  }
}
function extractFilePaths(payload) {
  const out = /* @__PURE__ */ new Set();
  const addEveryPathKey = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of PATH_KEYS) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) out.add(v);
      else if (Array.isArray(v)) {
        for (const e of v) if (typeof e === "string" && e.trim()) out.add(e);
      }
    }
  };
  const addScalars = (obj) => {
    if (!obj || typeof obj !== "object") return;
    addEveryPathKey(obj);
    for (const bk of BATCH_KEYS) {
      const arr = obj[bk];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (typeof el === "string" && el.trim()) out.add(el);
        else if (el && typeof el === "object") addEveryPathKey(el);
      }
    }
    for (const tk of PATCH_TEXT_KEYS) {
      const v = obj[tk];
      if (typeof v === "string" && v.includes("*** ")) collectPatchPaths(v, out);
    }
  };
  if (payload && typeof payload === "object") {
    addScalars(payload);
    for (const bagKey of INPUT_BAG_KEYS) addScalars(payload[bagKey]);
  }
  return [...out];
}
function candidateRoots(payload) {
  const raw = [];
  if (payload && typeof payload === "object") {
    for (const k of ROOT_KEYS) {
      const v = payload[k];
      if (typeof v === "string") raw.push(v);
      else if (Array.isArray(v)) {
        for (const e of v) if (typeof e === "string") raw.push(e);
      }
    }
  }
  return raw.map(absoluteRoot).filter((r) => r != null);
}
function absoluteRoot(raw) {
  if (typeof raw !== "string") return null;
  const trimmed4 = raw.trim();
  if (!isAbsolute9(trimmed4)) return null;
  return normalizeRootPath(trimmed4);
}
var EXPLICIT_WORKSPACE_KEYS = ["workspace_roots", "workspaceRoots", "workspace_root", "workspaceRoot", "project_root", "projectRoot", "root"];
function hasExplicitWorkspaceDeclaration(payload) {
  return Boolean(firstString(payload, EXPLICIT_WORKSPACE_KEYS));
}
function hasLocalDefaultTicketStore(dir) {
  return existsSync16(join20(dir, ".adlc", "tickets", ".store.json")) || existsSync16(join20(dir, ".adlc", "tickets.json"));
}
function storeOverrideForNestedProbe(rawOverride, outerDir) {
  if (!rawOverride || typeof rawOverride !== "string" || !rawOverride.trim()) return null;
  const trimmed4 = rawOverride.trim();
  if (!isAbsolute9(trimmed4)) {
    const resolvedRel = resolve7(outerDir, trimmed4);
    return contains(outerDir, resolvedRel) && existsSync16(resolvedRel) ? trimmed4 : null;
  }
  return contains(outerDir, trimmed4) ? null : trimmed4;
}
function sanitizeDiscoveryStoreOverride(rawOverride, startDir, baseCwd = startDir) {
  if (typeof rawOverride !== "string" || !rawOverride.trim()) return null;
  const trimmed4 = rawOverride.trim();
  const resolvedStart = resolve7(startDir);
  const boundary = findInnermostCheckoutRoot(resolvedStart, {
    storeOverride: null,
    requireStore: false,
    allowFileStart: true,
    preserveSpelling: true
  });
  const anchor = boundary ?? resolvedStart;
  const anchorInfo = inspectGitCheckout(realpathDeepest(resolve7(anchor)));
  const anchorParent = dirname15(resolve7(anchor));
  const enclosing = anchorParent !== resolve7(anchor) ? findInnermostCheckoutRoot(anchorParent, {
    storeOverride: null,
    requireStore: true,
    preserveSpelling: true
  }) : null;
  if (isAbsolute9(trimmed4)) {
    if (enclosing && contains(enclosing, trimmed4) && !contains(anchor, trimmed4)) {
      return null;
    }
    if ((anchorInfo?.kind === "worktree" || enclosing) && hasLocalDefaultTicketStore(anchor) && !contains(anchor, trimmed4)) {
      return null;
    }
    return trimmed4;
  }
  const lexRel = relative6("/anchor", resolve7("/anchor", trimmed4));
  const escapesLexically = lexRel === ".." || lexRel.startsWith("../") || lexRel.startsWith("..\\") || isAbsolute9(lexRel);
  if (escapesLexically) {
    if (boundary && baseCwd) {
      const resolvedBase = resolve7(baseCwd);
      if (contains(boundary, resolvedBase)) {
        const fromBase = resolve7(resolvedBase, trimmed4);
        if (contains(boundary, fromBase) && existsSync16(fromBase)) {
          return fromBase;
        }
      }
    }
    return null;
  }
  if (boundary) {
    return contains(boundary, resolve7(boundary, trimmed4)) ? trimmed4 : null;
  }
  const atStart = resolve7(resolvedStart, trimmed4);
  if (existsSync16(atStart) && !contains(resolvedStart, atStart)) return null;
  return trimmed4;
}
function envForCheckoutRoot(checkoutRoot, outerAnchor, env) {
  if (!checkoutRoot || !env) return env;
  const sameAsOuter = !outerAnchor || realpathDeepest(resolve7(checkoutRoot)) === realpathDeepest(resolve7(outerAnchor));
  const checkoutInfo = inspectGitCheckout(realpathDeepest(resolve7(checkoutRoot)));
  const parentDir = dirname15(resolve7(checkoutRoot));
  const enclosingCheckout = parentDir !== resolve7(checkoutRoot) ? findInnermostCheckoutRoot(parentDir, {
    storeOverride: null,
    requireStore: true,
    preserveSpelling: true
  }) : null;
  const isNestedWorktree = checkoutInfo?.kind === "worktree" || enclosingCheckout !== null;
  const localStorePresent = hasLocalDefaultTicketStore(checkoutRoot);
  const next = { ...env };
  if (sameAsOuter && !isNestedWorktree) {
    for (const key of ["ADLC_TICKET_STORE", "ADLC_TICKETS"]) {
      const val = next[key];
      if (typeof val !== "string" || !val.trim()) continue;
      const trimmed4 = val.trim();
      if (isAbsolute9(trimmed4)) continue;
      if (!contains(checkoutRoot, resolve7(checkoutRoot, trimmed4)) && localStorePresent) {
        delete next[key];
      }
    }
    return next;
  }
  if (!sameAsOuter && (!contains(outerAnchor, checkoutRoot) || existsSync16(join20(checkoutRoot, ".adlc", "current-ticket.json")))) {
    delete next.ADLC_TICKET;
  }
  for (const key of ["ADLC_TICKET_STORE", "ADLC_TICKETS"]) {
    const val = next[key];
    if (typeof val !== "string" || !val.trim()) continue;
    const trimmed4 = val.trim();
    const resolvedRel = resolve7(checkoutRoot, trimmed4);
    const keepRelative = !isAbsolute9(trimmed4) && contains(checkoutRoot, resolvedRel) && existsSync16(resolvedRel);
    const outsideOuter = (sameAsOuter || !contains(outerAnchor, trimmed4)) && (!enclosingCheckout || !contains(enclosingCheckout, trimmed4) || contains(checkoutRoot, trimmed4));
    const keepExternal = isAbsolute9(trimmed4) && outsideOuter && !localStorePresent;
    if (!keepRelative && !keepExternal) {
      delete next[key];
    }
  }
  return next;
}
function resolveOwningInternal(payload, filePath, fallback, env = process.env) {
  const roots = candidateRoots(payload);
  const rawStoreOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
  const cwdOnlyRoot = roots.length > 0 && !hasExplicitWorkspaceDeclaration(payload);
  const base = roots[0] ?? fallback ?? hostProjectRoot(env);
  const absFile = !filePath ? void 0 : isAbsolute9(filePath) ? resolve7(filePath) : base != null ? resolve7(base, filePath) : void 0;
  const climbIfCwdOnly = (chosen) => {
    if (!cwdOnlyRoot || !chosen) return chosen;
    const safeOverride = sanitizeDiscoveryStoreOverride(rawStoreOverride, chosen, chosen);
    return findInnermostCheckoutRoot(chosen, { storeOverride: safeOverride, preserveSpelling: true }) ?? chosen;
  };
  if (absFile) {
    const upgradeWorktree = (chosen) => {
      const climbed = climbIfCwdOnly(chosen);
      return preferInnermostCheckout(climbed, [absFile], {
        storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbed),
        allowFileStart: true,
        preserveSpelling: true
      }) ?? climbed;
    };
    const owning = roots.map((raw) => climbIfCwdOnly(raw)).filter((raw) => contains(raw, absFile)).map((raw) => ({ raw, real: realpathDeepest(resolve7(raw)) })).sort((a, b) => b.real.length - a.real.length)[0];
    if (owning) return { root: upgradeWorktree(owning.raw), absFile, outerRoot: owning.raw };
    const climbedBase = climbIfCwdOnly(base);
    if (fallback == null && climbedBase != null && !contains(climbedBase, absFile)) return { root: null, absFile, outerRoot: null };
    if (climbedBase != null) return { root: upgradeWorktree(climbedBase), absFile, outerRoot: climbedBase };
  }
  const climbedForBase = base != null ? climbIfCwdOnly(base) : null;
  const resolvedBase = climbedForBase != null ? preferInnermostCheckout(climbedForBase, [payload?.cwd], {
    storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbedForBase),
    preserveSpelling: true
  }) ?? climbedForBase : null;
  return { root: resolvedBase, absFile, outerRoot: climbedForBase };
}
function contains(root, absFile) {
  const rel = relative6(realpathDeepest(resolve7(root)), realpathDeepest(absFile));
  return rel === "" || !rel.startsWith("..") && !isAbsolute9(rel);
}
function hostProjectRoot(env = process.env) {
  return absoluteRoot(env?.CURSOR_PROJECT_DIR);
}
var UNRESOLVED_CAUSE = "the workspace root could not be resolved from the hook payload (workspace_roots/cwd/root) or CURSOR_PROJECT_DIR";
function unresolvedRootVerdict(tool, env = process.env) {
  if (env?.ADLC_P4_ENFORCEMENT !== "0") {
    return {
      permission: "deny",
      user_message: `ADLC rails-guard: blocked "${tool || "unknown"}" \u2014 ${UNRESOLVED_CAUSE}`,
      agent_message: `Rail enforcement is active but ${UNRESOLVED_CAUSE}, so the edit cannot be verified against the frozen rails and is denied. The host must supply workspace_roots or set CURSOR_PROJECT_DIR.`
    };
  }
  process.stderr.write(`adlc-rails-guard: ${UNRESOLVED_CAUSE}; rails not checked (enforcement inactive)
`);
  return { permission: "allow" };
}
function decide(payload, { root, env = process.env } = {}) {
  try {
    const tool = extractToolName(payload);
    const filePaths = extractFilePaths(payload);
    if (!filePaths.length) {
      const cls = classifyTool(tool);
      const opaque = cls === "mutating" || cls === "other" && !isShellTool(tool);
      if (!opaque) return { permission: "allow" };
      const declared = candidateRoots(payload);
      const rawStoreOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
      const cwdOnly = declared.length > 0 && !hasExplicitWorkspaceDeclaration(payload);
      const host = hostProjectRoot(env);
      const rawRoots = root != null ? [root] : declared.length ? declared : host != null ? [host] : [];
      if (!rawRoots.length) return unresolvedRootVerdict(tool, env);
      const rootPairs = rawRoots.map((r) => {
        const climbed = root == null && cwdOnly ? findInnermostCheckoutRoot(r, {
          storeOverride: sanitizeDiscoveryStoreOverride(rawStoreOverride, r, r),
          preserveSpelling: true
        }) ?? r : r;
        const chosen = preferInnermostCheckout(climbed, [payload?.cwd], {
          storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbed),
          preserveSpelling: true
        }) ?? climbed;
        return { root: chosen, outerRoot: climbed };
      });
      const states = rootPairs.map(
        ({ root: r, outerRoot }) => railPreconditions({ root: r, env: envForCheckoutRoot(r, outerRoot, env) })
      );
      const denied = states.find((s) => s.state === "deny");
      if (denied) {
        return {
          permission: "deny",
          user_message: `ADLC rails-guard: blocked "${tool || "unknown"}" \u2014 ${denied.reason}`,
          agent_message: `The rail trust state failed closed: ${denied.reason}. Fix the ticket/rail state rather than working around the guard.`
        };
      }
      if (states.some((s) => s.state === "active")) {
        return {
          permission: "deny",
          user_message: `ADLC rails-guard: blocked "${tool || "unknown"}" \u2014 a structured mutating tool with no verifiable target path while enforcement is active`,
          agent_message: `A structured mutating tool reached the rail guard during an active build but exposed no inspectable file path, so it cannot be verified against the frozen rails and is denied. Use a structured edit/write with an explicit path rather than an opaque patch payload. (Shell commands are allowed in-session and gated by the CI rail-freeze check instead.)`
        };
      }
      return { permission: "allow" };
    }
    if (classifyTool(tool) === "readonly") return { permission: "allow" };
    const owners = filePaths.map((filePath) => ({
      filePath,
      owned: root != null ? { root, absFile: void 0, outerRoot: root } : resolveOwningInternal(payload, filePath, void 0, env)
    }));
    if (owners.some(({ owned }) => owned.root == null)) return unresolvedRootVerdict(tool, env);
    for (const { filePath, owned } of owners) {
      const targetEnv = envForCheckoutRoot(owned.root, owned.outerRoot, env);
      const verdict = checkRail({ filePath: owned.absFile ?? filePath, tool, root: owned.root, env: targetEnv });
      if (verdict.decision === "deny") {
        return {
          permission: "deny",
          user_message: `ADLC rails-guard: blocked edit to ${verdict.reason}`,
          agent_message: `This path is a FROZEN ADLC rail: ${verdict.reason}. Do not edit it during the active build. If the rail must change, update the ticket spec and re-freeze \u2014 do not work around the guard.`
        };
      }
    }
    return { permission: "allow" };
  } catch (err) {
    const enforcing = env?.ADLC_P4_ENFORCEMENT !== "0";
    process.stderr.write(
      `adlc-rails-guard: internal error (failing ${enforcing ? "CLOSED" : "OPEN"}) \u2014 ${err?.message ?? err}
`
    );
    if (enforcing) {
      return {
        permission: "deny",
        user_message: `ADLC rails-guard: internal error while enforcing \u2014 failing closed (${err?.message ?? err})`,
        agent_message: "The rail guard hit an unexpected error while enforcement is active and failed closed. Fix the rail/ticket state (e.g. a malformed .adlc/tickets.json) rather than working around the guard."
      };
    }
    return { permission: "allow" };
  }
}
async function readStdin2() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  let payload = {};
  const raw = await readStdin2();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      const enforcing = process.env.ADLC_P4_ENFORCEMENT !== "0";
      process.stderr.write(`adlc-rails-guard: malformed payload JSON (failing ${enforcing ? "CLOSED" : "OPEN"}) \u2014 ${err.message}
`);
      process.stdout.write(JSON.stringify(enforcing ? {
        permission: "deny",
        user_message: "ADLC rails-guard: unparseable tool payload while enforcement is active \u2014 failing closed",
        agent_message: "The rail guard received a tool payload it could not parse during an active build, so the edit cannot be verified against the frozen rails and is denied. Retry with a well-formed structured edit."
      } : { permission: "allow" }));
      return;
    }
  }
  const verdict = decide(payload, { env: process.env });
  process.stdout.write(JSON.stringify(verdict));
}
if (process.argv[1] && fileURLToPath2(import.meta.url) === process.argv[1] && process.argv[1].endsWith("adlc-rails-guard.mjs")) {
  main();
}

// plugins/adlc-cursor/hooks/adlc-pretool.mjs
init_core();

// plugins/adlc-cursor/lib/p5-subagent-policy.mjs
init_define_ADLC_MCP_BUILD_METADATA();
var PROSECUTOR_AGENT_NAMES = /* @__PURE__ */ new Set([
  "prosecutor-correctness",
  "prosecutor-security",
  "prosecutor-contract",
  "prosecutor-diff",
  "prosecutor-tests",
  "prosecutor-verifier",
  "prosecutor"
  // optional orchestrator
]);
var P5_EXTRA_ALLOWED = /* @__PURE__ */ new Set(["generalPurpose", "explore"]);
function isTaskSpawnTool(toolName) {
  if (typeof toolName !== "string") return false;
  const n = toolName.trim().toLowerCase();
  return n === "task" || n === "task_tool" || n === "agent" || n === "spawn_agent";
}
function extractAgentName(payload) {
  const input = payload?.tool_input ?? payload?.toolInput ?? payload ?? {};
  const candidates = [
    input.subagent_type,
    input.subagentType,
    input.agent,
    input.agent_name,
    input.agentName,
    input.name,
    payload?.subagent_type,
    payload?.subagentType,
    payload?.agent_name,
    payload?.agentName
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}
function resolveMarkerSessionId(payload, env = process.env) {
  const id = resolveSessionIdentity(payload, env);
  if (id.conflict) return { ok: false, conflict: true, message: id.message };
  return { ok: true, sessionId: id.sessionId ?? null };
}
function decideP5SubagentPolicy(payload, {
  env = process.env,
  now = Date.now(),
  toolName = null
} = {}) {
  const session = resolveMarkerSessionId(payload, env);
  if (session.conflict) {
    return { permission: "allow", reason: "session identity conflict \u2014 P5 allowlist skipped", marker: null };
  }
  const marker = readP5Marker(session.sessionId, { env, now });
  if (!marker) {
    return { permission: "allow", reason: "no fresh session-matching P5 marker", marker: null };
  }
  const name = extractAgentName(payload);
  if (!name) {
    return {
      permission: "ask",
      reason: "P5 marker present but Task/subagent agent name missing \u2014 cannot verify allowlist",
      marker
    };
  }
  if (PROSECUTOR_AGENT_NAMES.has(name) || P5_EXTRA_ALLOWED.has(name)) {
    return { permission: "allow", reason: `P5 allowlist: ${name}`, marker };
  }
  const mode = env.ADLC_CURSOR_P5_UNRELATED === "deny" ? "deny" : "ask";
  return {
    permission: mode,
    reason: `P5 marker active \u2014 unrelated subagent/agent "${name}" not on prosecutor allowlist`,
    marker
  };
}
function isP5TaskPayload(payload, toolName) {
  const tn = toolName ?? payload?.tool_name ?? payload?.toolName ?? null;
  return isTaskSpawnTool(tn);
}

// plugins/adlc-cursor/hooks/adlc-pretool.mjs
function extractConversationId(payload, env = process.env) {
  const id = resolveSessionIdentity(payload, env);
  if (!id.ok || id.conflict) return null;
  return id.sessionId;
}
function bumpDepthCounter2(rootIgnored, opts = {}) {
  const {
    now = Date.now(),
    conversationId = null,
    sessionId = conversationId,
    toolUseId = null,
    env = process.env,
    ttlMs
  } = opts;
  return bumpDepthCounter(rootIgnored, {
    now,
    sessionId,
    toolUseId: toolUseId ?? opts.tool_use_id ?? null,
    env,
    ttlMs
  });
}
function buildGateDeny(reason) {
  return {
    permission: "deny",
    user_message: `ADLC build-gate: ${reason}`,
    agent_message: `ADLC build-gate (advisory, opt-in via ADLC_BUILD_GATE_ENFORCEMENT=1): ${reason} To override deliberately, set ADLC_BUILD_GATE_BYPASS=1 \u2014 the bypass is recorded to the gate-manifest; an unaudited bypass is refused.`
  };
}
var STATIC_BUILD_GATE_LOADERS = Object.freeze({
  "@adlc/build-gate/lib/risk.mjs": () => Promise.resolve().then(() => (init_risk(), risk_exports)),
  "@adlc/build-gate/lib/decide.mjs": () => Promise.resolve().then(() => (init_decide(), decide_exports)),
  "@adlc/build-gate/lib/depth-signal.mjs": () => Promise.resolve().then(() => (init_depth_signal(), depth_signal_exports)),
  "@adlc/build-gate/lib/active-ticket.mjs": () => Promise.resolve().then(() => (init_active_ticket(), active_ticket_exports)),
  "@adlc/build-gate/lib/override.mjs": () => Promise.resolve().then(() => (init_override(), override_exports))
});
function defaultImportModule(spec) {
  const loader = STATIC_BUILD_GATE_LOADERS[spec];
  if (!loader) return Promise.reject(new Error(`unsupported build-gate module: ${spec}`));
  return loader();
}
async function consultBuildGate(payload, {
  root,
  env = process.env,
  now = Date.now(),
  importModule = defaultImportModule
} = {}) {
  let risk, decideMod, depthSignal, activeTicket, override;
  try {
    risk = await importModule("@adlc/build-gate/lib/risk.mjs");
    decideMod = await importModule("@adlc/build-gate/lib/decide.mjs");
    depthSignal = await importModule("@adlc/build-gate/lib/depth-signal.mjs");
    activeTicket = await importModule("@adlc/build-gate/lib/active-ticket.mjs");
    override = await importModule("@adlc/build-gate/lib/override.mjs");
  } catch (err) {
    process.stderr.write(
      `adlc-pretool: @adlc/build-gate failed to load \u2014 buildgate skipped, rails verdict unaffected (${err?.message ?? err})
`
    );
    return null;
  }
  const cls = classifyTool(extractToolName(payload));
  const mutating = cls === "mutating" || cls === "other" && !isShellTool(extractToolName(payload));
  try {
    env = envForCheckoutRoot(root, root, env);
    const storeOverride = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
    const ticketsPath = storeOverride ? isAbsolute10(storeOverride) ? storeOverride : join22(root, storeOverride) : join22(root, ".adlc", "tickets.json");
    if (!ticketStoreExists(root, storeOverride)) return null;
    const active = activeTicket.resolveActiveTicketId({ dir: root, env });
    if (active.conflict) {
      if (!mutating) return null;
      return buildGateDeny(`${active.message ?? "conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)"} \u2014 failing closed.`);
    }
    if (!active.id) return null;
    const identity = resolveSessionIdentity(payload, env);
    let depth;
    let counterError;
    if (identity.conflict) {
      counterError = new Error(identity.message ?? "session identity conflict");
    } else {
      try {
        const toolUseId = typeof payload?.tool_use_id === "string" ? payload.tool_use_id : typeof payload?.toolUseId === "string" ? payload.toolUseId : null;
        depth = bumpDepthCounter2(root, {
          now,
          sessionId: identity.sessionId,
          toolUseId,
          env
        });
      } catch (err) {
        counterError = err;
      }
    }
    const envDepth = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH ?? "", 10);
    if (Number.isFinite(envDepth)) depth = envDepth;
    if (!mutating) return null;
    const loaded = loadTickets(ticketsPath);
    if (loaded.errors.length) return buildGateDeny(`cannot read ticket store (${loaded.errors[0]}) \u2014 active ticket ${active.id}'s risk cannot be verified, failing closed.`);
    const ticket = loaded.tickets.find((t) => t && typeof t === "object" && t.id === active.id);
    if (!ticket) {
      return buildGateDeny(`active ticket ${active.id} not found in .adlc/tickets.json \u2014 failing closed.`);
    }
    const { tier, signals } = risk.computeRiskTier(ticket);
    if (tier !== "high") return null;
    if (depth === void 0) {
      return buildGateDeny(
        `active ticket ${active.id} is high-risk but the session depth counter could not be read/persisted (${counterError?.message ?? counterError}) \u2014 the context-fitness signal cannot be verified, failing closed.`
      );
    }
    const degraded = depthSignal.isDegraded({ depth });
    const verdict = decideMod.decideBuildGate({
      riskTier: tier,
      degraded,
      bypass: env.ADLC_BUILD_GATE_BYPASS === "1",
      recordBypass: () => override.recordOverride({
        // The hook is the process entry point: env resolution happens HERE (the
        // dispatcher's import surface is pinned to @adlc/build-gate/lib/ by test).
        key: typeof env.ADLC_MANIFEST_KEY === "string" && env.ADLC_MANIFEST_KEY.length > 0 ? env.ADLC_MANIFEST_KEY : null,
        ticketId: active.id,
        signals,
        depth,
        sessionBytes: null,
        reason: "cursor preToolUse dispatcher bypass (ADLC_BUILD_GATE_BYPASS=1)",
        dir: join22(root, ".adlc")
      })
    });
    if (verdict.decision === "deny") return buildGateDeny(`${verdict.reason} (depth=${depth}).`);
    return null;
  } catch (err) {
    if (mutating) {
      return buildGateDeny(`internal error while enforcing (${err?.message ?? err}) \u2014 failing closed.`);
    }
    return null;
  }
}
function unresolvedBuildGate(payload, toolName, rails) {
  const cls = classifyTool(toolName);
  const mutating = cls === "mutating" || cls === "other" && !isShellTool(toolName);
  if (!mutating || isP5TaskPayload(payload, toolName)) return rails;
  return buildGateDeny(
    "the workspace root could not be resolved from the hook payload or CURSOR_PROJECT_DIR \u2014 failing closed."
  );
}
async function dispatch(payload, { root, env = process.env, now, importModule } = {}) {
  const rails = decide(payload, root != null ? { root, env } : { env });
  if (rails.permission !== "allow") return rails;
  const toolName = extractToolName(payload);
  if (isP5TaskPayload(payload, toolName)) {
    const p5 = decideP5SubagentPolicy(payload, { env, now: now ?? Date.now(), toolName });
    if (p5.permission !== "allow") {
      return {
        permission: p5.permission,
        user_message: p5.reason,
        agent_message: `${p5.reason} (authoritative preToolUse Task allowlist during P5). Nested Task lineage is degraded/permissive until proven \u2014 see ADR-0006.`
      };
    }
  }
  if (env.ADLC_BUILD_GATE_ENFORCEMENT !== "1") return rails;
  const owningEntries = root != null ? [{ root, outerRoot: root }] : owningEntriesForTargets(payload, env);
  if (owningEntries.some((entry) => entry.root == null)) {
    return unresolvedBuildGate(payload, toolName, rails);
  }
  for (const entry of owningEntries) {
    const targetEnv = envForCheckoutRoot(entry.root, entry.outerRoot, env);
    const gate = await consultBuildGate(payload, { root: entry.root, env: targetEnv, now, importModule });
    if (gate) return gate;
  }
  return rails;
}
function owningEntriesForTargets(payload, env) {
  const paths = extractFilePaths(payload);
  const targets = paths.length ? paths : [void 0];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of targets) {
    const { root, outerRoot } = resolveOwningInternal(payload, p, void 0, env);
    const key = root ?? "__null__";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root, outerRoot });
  }
  return out;
}
async function readStdin3() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main2() {
  let payload = {};
  const raw = await readStdin3();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      const enforcing = process.env.ADLC_P4_ENFORCEMENT !== "0";
      process.stderr.write(`adlc-pretool: malformed payload JSON (failing ${enforcing ? "CLOSED" : "OPEN"}) \u2014 ${err.message}
`);
      process.stdout.write(JSON.stringify(enforcing ? {
        permission: "deny",
        user_message: "ADLC rails-guard: unparseable tool payload while enforcement is active \u2014 failing closed",
        agent_message: "The rail guard received a tool payload it could not parse during an active build, so the edit cannot be verified against the frozen rails and is denied. Retry with a well-formed structured edit."
      } : { permission: "allow" }));
      return;
    }
  }
  const verdict = await dispatch(payload, { env: process.env });
  process.stdout.write(JSON.stringify(verdict));
}
if (process.argv[1] && fileURLToPath4(import.meta.url) === process.argv[1]) {
  main2();
}
export {
  bumpDepthCounter2 as bumpDepthCounter,
  consultBuildGate,
  dispatch,
  extractConversationId
};
