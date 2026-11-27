#!/usr/bin/env node

// packages/hook-engine/lib/cli-gemini.mjs
import { fileURLToPath as fileURLToPath4 } from "node:url";

// packages/hook-engine/lib/gemini-guard.mjs
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { existsSync as existsSync15, realpathSync as realpathSync6, lstatSync as lstatSync15 } from "node:fs";
import { dirname as dirname11, isAbsolute as isAbsolute11, join as join18, parse as parse2, relative as relative9, resolve as resolve10 } from "node:path";
import { homedir as homedir5 } from "node:os";

// packages/core/lib/llm.mjs
import { spawn as spawn2 } from "node:child_process";
import { StringDecoder as StringDecoder2 } from "node:string_decoder";

// packages/core/lib/cli-providers.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
var CLAUDE_CLI_MODELS = Object.freeze({
  cheap: "claude-haiku-4-5",
  mid: "claude-sonnet-4-6",
  frontier: "claude-opus-4-7"
});
var CODEX_CLI_MODELS = Object.freeze({
  cheap: "gpt-5-mini",
  mid: "gpt-5.1",
  frontier: "gpt-5.1"
});
function normalizeCliAnthropicUsage(u) {
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  return {
    inputTokens: Number(u.input_tokens ?? u.inputTokens ?? 0),
    outputTokens: Number(u.output_tokens ?? u.outputTokens ?? 0),
    cachedTokens: Number((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cachedTokens ?? 0))
  };
}
function runCliCommand(bin, args, input, opts = {}) {
  const envSource = opts.env ?? process.env;
  const isTest = envSource.NODE_ENV === "test" || process.env.NODE_ENV === "test";
  const spawnFn = isTest && typeof envSource.__adlcCliSpawn === "function" ? envSource.__adlcCliSpawn : spawn;
  const env = {};
  for (const [k, v] of Object.entries(envSource)) {
    if (k === "ADLC_MANIFEST_KEY" || k.startsWith("ADLC_ADMIN_")) continue;
    env[k] = v;
  }
  if (!env.HOME && process.env.HOME) env.HOME = process.env.HOME;
  if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
  const timeoutMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 12e4;
  const isolatedCwd = mkdtempSync(join(tmpdir(), "adlc-cli-cwd-"));
  const cleanupCwd = () => {
    try {
      rmSync(isolatedCwd, { recursive: true, force: true });
    } catch {
    }
  };
  return new Promise((resolve11, reject) => {
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
      resolve11(stdout);
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

// packages/core/lib/llm.mjs
function isAgyTimeout(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}
var DEFAULT_HTTP_TIMEOUT_MS = 3e5;
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
  return new Promise((resolve11, reject) => {
    const p = spawn2(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      resolve11({ text: out.replace(/\s+$/, ""), usage: null });
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
var PROVIDERS = [
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
var CLI_PROVIDERS = [
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
var ALL_PROVIDERS = [...PROVIDERS, ...CLI_PROVIDERS];
var PROVIDER_NAMES = PROVIDERS.map((p) => p.name);
var CLI_PROVIDER_NAMES = Object.freeze(ALL_PROVIDERS.filter((p) => p.isCli).map((p) => p.name));

// packages/core/lib/git.mjs
var GIT_MAX_BUFFER = 64 * 1024 * 1024;

// packages/tickets/lib/canonical.mjs
import { createHash } from "node:crypto";

// packages/tickets/lib/errors.mjs
var TicketStoreError = class extends Error {
  constructor(kind, code, message, details) {
    super(message);
    this.name = "TicketStoreError";
    this.kind = kind;
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
var invalid = (code, message, details) => new TicketStoreError("invalid", code, message, details);
var conflict = (code, message, details) => new TicketStoreError("conflict", code, message, details);
var policy = (code, message, details) => new TicketStoreError("policy", code, message, details);
var operational = (code, message, details) => new TicketStoreError("operational", code, message, details);

// packages/tickets/lib/pointer.mjs
import { lstatSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from "node:fs";
import { dirname, join as join2 } from "node:path";
var CURRENT_TICKET_FILE = ".adlc/current-ticket.json";
var MAX_POINTER_BYTES = 64 * 1024;
var ABSENT = /* @__PURE__ */ Symbol("pointer-absent");
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
var CANONICAL_ID_KEY = "id";
var DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);
var ok = (value) => ({ ok: true, value });
var fail = (kind, code, message) => ({ ok: false, kind, code, message });
var invalid2 = (code, message) => fail("invalid", code, message);
var conflict2 = (code, message) => fail("conflict", code, message);
var isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var trimmed = (value) => typeof value === "string" ? value.trim() : "";
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
  if (!isPlainObject(parsed)) {
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
function resolveActiveTicketAgainst(snapshot, { root = ".", env = process.env, allowLegacyPointer = false } = {}) {
  const resolved = resolveActiveTicketId({ root, env });
  if (!resolved.ok) return resolved;
  if (resolved.value === null) return ok(null);
  const { id, pointerPresent, ticketHash: ticketHash2, legacyString, deprecatedAlias } = resolved.value;
  const ticket = snapshot.get(id);
  if (!ticket) {
    return invalid2("ACTIVE_TICKET_MISSING", `active ticket "${id}" is not in the ticket store`);
  }
  const expected = snapshot.ticketHashes[id];
  const warnings = [];
  if (deprecatedAlias) {
    warnings.push(
      `${CURRENT_TICKET_FILE} uses the deprecated "${deprecatedAlias}" key; rewrite it as {"id":"${id}","ticketHash":"${expected}"} ("${deprecatedAlias}" is removed in 2.0).`
    );
  }
  if (pointerPresent) {
    if (!ticketHash2) {
      const detail = legacyString ? "a legacy bare-string pointer pins no ticketHash" : `${CURRENT_TICKET_FILE} pins no ticketHash`;
      if (!allowLegacyPointer) {
        return invalid2(
          "ACTIVE_TICKET_HASH_MISSING",
          `${detail}; it must pin ticketHash so a ticket changing after selection is detectable. Expected {"id":"${id}","ticketHash":"${expected}"}.`
        );
      }
      warnings.push(`${detail}; a ticket changing after selection cannot be detected. Expected ticketHash "${expected}". Strict in 2.0.`);
    } else if (ticketHash2 !== expected) {
      return conflict2(
        "ACTIVE_TICKET_STALE",
        `active ticket "${id}" changed after selection (pointer pins ${ticketHash2}, store has ${expected}). Re-select the ticket to confirm you intend to build against the new contract.`
      );
    }
  }
  return ok({
    id,
    ticket,
    ticketHash: expected,
    storeHash: snapshot.hash,
    warnings,
    ...deprecatedAlias ? { deprecatedAlias } : {}
  });
}

// packages/tickets/lib/constants.mjs
var ACTIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-directory", version: 1 });
var ARCHIVE_MANIFEST = Object.freeze({ format: "adlc-ticket-archive", version: 1 });
var ACTIVE_DIRECTORY = ".adlc/tickets";
var ARCHIVE_DIRECTORY = ".adlc/ticket-archive";
var LEGACY_FILE = ".adlc/tickets.json";
var LEGACY_ARCHIVE_FILE = ".adlc/tickets.archive.json";
var LOCK_DIRECTORY = ".adlc/tickets.lock";
var TRANSACTION_DIRECTORY = ".adlc/ticket-transactions";
var TICKET_HASH_DOMAIN = "adlc:ticket:v1\0";
var STORE_HASH_DOMAIN = "adlc:active-store:v1\0";

// packages/tickets/lib/canonical.mjs
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
var canonicalJson = (value) => JSON.stringify(normalize(value));
var prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}
`;
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
var ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));
function storeHashFromPairs(pairs) {
  const sorted = [...pairs].sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(sorted));
}
function storeHash(tickets) {
  return storeHashFromPairs(tickets.map((ticket) => [ticket.id, ticketHash(ticket)]));
}

// packages/core/lib/secret-shapes.mjs
var INLINE_ASSIGNMENT = /\b((?:api[-_]?key|secret|passwd|password|token|access[-_]?key)\b\s*[:=]\s*)\S{8,}/i;
var SECRET_PATTERNS = [
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

// packages/tickets/lib/filename.mjs
function ticketSlug(id) {
  const slug = id.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "ticket";
}
var ticketFilename = (id) => `${ticketSlug(id)}--${sha256(Buffer.from(id, "utf8"))}.json`;

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

// packages/tickets/lib/help.mjs
var SYNC_CATEGORIES = Object.freeze([
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
var TICKET_FIELDS = [
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
var FIELD_INDENT = "  ";
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
var INPUT_DOCUMENT = [
  "Input document (--input <path> or - for stdin; see `adlc ticket schema`):",
  "",
  ...fieldTable(),
  "",
  "Unknown fields are preserved as-is; the store never strips them."
];

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
var TicketSnapshot = class {
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

// packages/tickets/lib/store.mjs
import { existsSync as existsSync10, lstatSync as lstatSync8, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join11, resolve as resolve5 } from "node:path";

// packages/tickets/lib/stores/directory.mjs
import { existsSync, lstatSync as lstatSync2, readFileSync, readdirSync } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";
function assertRealDirectory(path) {
  let stat;
  try {
    stat = lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") throw operational("STORE_NOT_FOUND", `ticket store not found: ${path}`);
    throw operational("STORE_READ_FAILED", `cannot inspect ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${path} must be a real directory`);
  const parent = dirname2(path);
  if (parent !== path) {
    const parentStat = lstatSync2(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${parent} must be a real directory`);
  }
}
var DirectoryTicketStore = class {
  constructor(path = ACTIVE_DIRECTORY, { archive = false } = {}) {
    this.path = path;
    this.archive = archive;
  }
  exists() {
    return existsSync(this.path);
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
      manifest = JSON.parse(readFileSync(join3(this.path, ".store.json"), "utf8"));
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
      const fullPath = join3(this.path, entry.name);
      const stat = lstatSync2(fullPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("UNSAFE_SHARD", `${entry.name} must be a regular file`);
      let ticket;
      try {
        ticket = JSON.parse(readFileSync(fullPath, "utf8"));
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
    const manifestPath = join3(this.path, ".store.json");
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
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw invalid("INVALID_MANIFEST", `invalid store manifest: ${error.message}`);
    }
    if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
      const hint = Number.isInteger(manifest?.version) && manifest.version > 1 ? "upgrade @adlc/tickets to read this store" : "expected format version 1";
      throw invalid("UNSUPPORTED_STORE_FORMAT", `unsupported ticket store manifest (${hint})`, manifest);
    }
    const name = ticketFilename(id);
    const fullPath = join3(this.path, name);
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
      ticket = JSON.parse(readFileSync(fullPath, "utf8"));
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

// packages/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync9, lstatSync as lstatSync7, readFileSync as readFileSync8 } from "node:fs";
import { basename as basename2, dirname as dirname8 } from "node:path";

// packages/tickets/lib/transaction.mjs
import { existsSync as existsSync8, readFileSync as readFileSync7 } from "node:fs";
import { basename, dirname as dirname7, isAbsolute as isAbsolute2, join as join10, relative as relative2, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";

// packages/tickets/lib/lock.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";
var sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
    const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}
function isStaleTicketLock(owner, { staleMs, now, isPidAlive: isPidAlive2, procStartTime, host }) {
  if (!owner || staleMs === void 0) return false;
  const startedAtMs = Date.parse(owner.startedAt);
  if (!Number.isFinite(startedAtMs) || now() - startedAtMs <= staleMs) return false;
  if (owner.hostname === host) {
    if (!isPidAlive2(owner.pid)) return true;
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
  isPidAlive: isPidAlive2 = defaultPidAlive,
  procStartTime = defaultProcStartTimeOf,
  host = hostname(),
  writeOwner = writeFileSync,
  removeLock = rmSync2,
  makeLockDirectory = mkdirSync
} = {}) {
  const path = join4(root, LOCK_DIRECTORY);
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: "", startedAt: "", command, transactionId })) {
    throw invalid(
      "INVALID_LOCK_OPTIONS",
      "acquireTicketLock requires a string command and a string-or-null transactionId; a lock written from other values could not be released by its own owner."
    );
  }
  mkdirSync(dirname3(path), { recursive: true });
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
      writeOwner(join4(path, "owner.json"), serialized, { flag: "wx" });
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
        const currentOwner = readLockMetadata(join4(path, "owner.json"));
        if (isStaleTicketLock(currentOwner, { staleMs, now, isPidAlive: isPidAlive2, procStartTime, host })) {
          const staleDir = `${path}.stale-${process.pid}-${randomUUID()}`;
          try {
            renameSync(path, staleDir);
            const movedOwner = readLockMetadata(join4(staleDir, "owner.json"));
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
    parsed = JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
  return isLockMetadata(parsed) ? parsed : null;
}
function readTicketLock(root = ".") {
  return readLockMetadata(join4(root, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync2 } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync2(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join4(lock.path, "owner.json"));
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

// packages/tickets/lib/evidence.mjs
import { closeSync as closeSync5, existsSync as existsSync6, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync5, readFileSync as readFileSync5, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { createHmac as createHmac2, randomUUID as randomUUID2 } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname6, join as join8 } from "node:path";

// packages/tickets/lib/durability.mjs
import {
  closeSync as closeSync2,
  constants,
  copyFileSync,
  existsSync as existsSync3,
  fsyncSync,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  renameSync as renameSync2,
  rmSync as rmSync3,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname4, resolve as resolve2 } from "node:path";
function fsyncFile(path) {
  const descriptor = openSync2(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync2(descriptor);
  }
}
function fsyncDirectory(path) {
  if (process.platform === "win32") return false;
  const descriptor = openSync2(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync2(descriptor);
  }
  return true;
}
function durableMkdir(path) {
  const missing = [];
  let cursor = resolve2(path);
  while (!existsSync3(cursor)) {
    missing.push(cursor);
    const parent = dirname4(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync2(path, { recursive: true });
  if (missing.length === 0) {
    fsyncDirectory(resolve2(path));
    return;
  }
  for (const directory of missing.reverse()) {
    fsyncDirectory(directory);
    fsyncDirectory(dirname4(directory));
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
    descriptor = openSync2(path, openFlags, 438);
  } catch (err) {
    if (err?.code === "ELOOP") throw new Error("refusing to write through symlink: " + path);
    throw err;
  }
  try {
    writeFileSync2(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync2(descriptor);
  }
  fsyncDirectory(dirname4(resolve2(path)));
}
function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname4(resolve2(target)));
}
function durableRename(source, target) {
  const sourceParent = dirname4(resolve2(source));
  const targetParent = dirname4(resolve2(target));
  renameSync2(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}
function durableRemove(path, options) {
  const parent = dirname4(resolve2(path));
  rmSync3(path, options);
  fsyncDirectory(parent);
}

// packages/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "node:fs";
import { join as join7 } from "node:path";

// packages/tickets/lib/manifest-primitives.mjs
import {
  existsSync as existsSync4,
  lstatSync as lstatSync5,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync3,
  openSync as openSync4,
  readSync as readSync3,
  closeSync as closeSync4,
  unlinkSync as unlinkSync2,
  mkdirSync as mkdirSync3,
  constants as fsConstants3
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname5, isAbsolute, join as join6, relative, resolve as resolve3, sep } from "node:path";

// packages/tickets/lib/manifest-crypto.mjs
import {
  lstatSync as lstatSync4,
  fstatSync as fstatSync2,
  openSync as openSync3,
  readSync as readSync2,
  closeSync as closeSync3,
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
import { join as join5 } from "node:path";
var ADMIN_PUB_FILENAME = "admin.pub";
var ED25519_PRIV_PREFIX = "ed25519-priv:";
var SIG_ALG_ED25519 = "ed25519";
var MAX_ADMIN_PUB_BYTES = 4096;
var BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
var ED25519_SIG_HEX_RE = /^[0-9a-f]{128}$/;
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
  const filePath = join5(dir, ADMIN_PUB_FILENAME);
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
    fd = openSync3(filePath, fsConstants2.O_RDONLY | fsConstants2.O_NOFOLLOW);
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
    closeSync3(fd);
  }
}

// packages/tickets/lib/manifest-primitives.mjs
var SEGMENT_DIRNAME = "manifest.d";
var SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
var RESERVED_NAMES = /* @__PURE__ */ new Set([".store.json", ".lineage"]);
var MARKER_NAME = ".store.json";
var LINEAGE_NAME = ".lineage";
var MARKER_FORMAT = "adlc-manifest-segments";
var MARKER_VERSION = 1;
var LOCK_SUFFIX = ".lock";
var MAX_LOCAL_JSON_BYTES = 4096;
var MAX_LOCK_OWNER_BYTES = 512;
var MAX_FIRST_LINE_BYTES = 65536;
var ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var OVERSIZED_FIRST_ENTRY = /* @__PURE__ */ Symbol("oversized-first-entry");
var MALFORMED_FIRST_ENTRY = /* @__PURE__ */ Symbol("malformed-first-entry");
function segmentDirPath(dir = ".adlc") {
  return join6(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir = ".adlc", name) {
  return join6(segmentDirPath(dir), name);
}
function markerPath(dir = ".adlc") {
  return join6(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir = ".adlc") {
  return join6(segmentDirPath(dir), LINEAGE_NAME);
}
function looksLikeGenuineLedgerLock(path, size) {
  if (size === 0) return true;
  if (size >= MAX_LOCK_OWNER_BYTES) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync3(path, "utf8").trim());
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
    fd = openSync4(path, fsConstants3.O_RDONLY | fsConstants3.O_NOFOLLOW);
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
    closeSync4(fd);
  }
}
function hasActivationMarker(dir = ".adlc") {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir = ".adlc") {
  const rootPath = join6(dir, "manifest.jsonl");
  if (!existsSync4(rootPath)) return false;
  let content;
  try {
    content = readFileSync3(rootPath, "utf8");
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
  const invalid3 = [];
  const seenLower = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync2(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: ".", reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    const full = join6(segDir, name);
    let st;
    try {
      st = lstatSync5(full);
    } catch (err) {
      invalid3.push({ name, reason: `cannot stat: ${err.message}` });
      continue;
    }
    if (st.isSymbolicLink()) {
      invalid3.push({ name, reason: "symlink" });
      continue;
    }
    if (st.isDirectory()) {
      invalid3.push({ name, reason: "nested directory" });
      continue;
    }
    if (!st.isFile()) {
      invalid3.push({ name, reason: "not a regular file" });
      continue;
    }
    if (name.endsWith(LOCK_SUFFIX)) {
      if (looksLikeGenuineLedgerLock(full, st.size)) continue;
      invalid3.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid3.push({ name, reason: "bad filename grammar" });
      continue;
    }
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) {
      invalid3.push({ name, reason: `case-colliding with ${seenLower.get(lower)}` });
      continue;
    }
    seenLower.set(lower, name);
    valid.push(name);
  }
  return { valid, invalid: invalid3 };
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
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
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
  mkdirSync3(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync2(p);
  const fd = openSync4(p, fsConstants3.O_WRONLY | fsConstants3.O_CREAT | fsConstants3.O_TRUNC | fsConstants3.O_NOFOLLOW);
  try {
    writeFileSync3(fd, JSON.stringify(token));
  } finally {
    closeSync4(fd);
  }
}
function normalizeManifestDirAndCwd(dir = ".adlc", opts = {}) {
  const effectiveDir = dir ?? ".adlc";
  if (opts?.cwd === void 0 || opts?.cwd === null) {
    const resolvedDir2 = resolve3(effectiveDir);
    const defaultCwd = effectiveDir === ".adlc" ? process.cwd() : dirname5(resolvedDir2);
    return { dir: resolvedDir2, cwd: defaultCwd };
  }
  const resolvedCwd = resolve3(opts.cwd);
  const resolvedDir = isAbsolute(effectiveDir) ? resolve3(effectiveDir) : effectiveDir !== ".adlc" && resolve3(dirname5(effectiveDir)) === resolvedCwd ? resolve3(effectiveDir) : resolve3(resolvedCwd, effectiveDir);
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
    fd = openSync4(segmentPath(dir, segmentName), fsConstants3.O_RDONLY);
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
    closeSync4(fd);
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
      execFileSync("git", args, { cwd: probeCwd, env, stdio: "ignore" });
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
  if (!existsSync4(filePath)) return [];
  const content = readFileSync3(filePath, "utf8");
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
      return fail2(lineNo - 1, { seq: null, lineNo, reason: "malformed JSON" }, `chain broken at line ${lineNo}: malformed JSON`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail2(lineNo - 1, { seq: null, lineNo, reason: "entry must be an object" }, `chain broken at line ${lineNo}: entry must be an object`);
    }
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      return fail2(lineNo - 1, { seq: entry.seq ?? null, lineNo, reason: "invalid seq" }, `chain broken at line ${lineNo}: seq must be a positive integer`);
    }
    const isFirst = prevRawLine === null;
    if (isFirst) {
      if (entry.prev !== null) {
        return fail2(0, { seq: entry.seq, lineNo, reason: "first entry prev must be null" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry prev must be null`);
      }
    } else {
      const expected = sha256(prevRawLine);
      if (entry.prev !== expected) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "prev hash mismatch" }, `chain broken at seq ${entry.seq} (line ${lineNo}): prev hash mismatch`);
      }
    }
    if (isFirst) {
      if (entry.seq !== 1) {
        return fail2(0, { seq: entry.seq, lineNo, reason: "first entry seq must be 1" }, `chain broken at seq ${entry.seq} (line ${lineNo}): first entry seq must be 1`);
      }
    } else if (entry.seq !== prevSeq + 1) {
      return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "seq not contiguous" }, `chain broken at seq ${entry.seq} (line ${lineNo}): seq must be contiguous (+1 from previous)`);
    }
    const hasAnchor = Object.hasOwn(entry, "anchor");
    if (isFirst) {
      firstAnchor = hasAnchor ? entry.anchor : void 0;
      if (anchorOnFirst && !hasAnchor) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "segment first entry missing required anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): segment first entry missing required anchor field`);
      }
      if (!anchorOnFirst && hasAnchor) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "root entry must not carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): root entry must not carry an anchor field`);
      }
    } else if (hasAnchor) {
      return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "only a segment's first entry may carry an anchor field" }, `chain broken at seq ${entry.seq} (line ${lineNo}): only a segment's first entry may carry an anchor field`);
    }
    if (hasAnyVerifier) {
      const hasSig = entry.sig !== void 0 && entry.sig !== null;
      if (entry.sigAlg === SIG_ALG_ED25519) {
        if (!hasSig) {
          return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
        if (!entrySigValid(key, entry, { publicKey })) {
          return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
        }
        seenSignedEntry = true;
        seenEd25519Entry = true;
      } else if (entry.sigAlg !== void 0) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsupported signature algorithm`);
      } else {
        if (seenEd25519Entry) {
          return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "downgrade after ed25519 entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): non-ed25519 entry after ed25519 era`);
        }
        if (firstNonEd25519 === null) firstNonEd25519 = { seq: entry.seq, lineNo };
        if (!hasSig) {
          if (firstUnsigned === null) firstUnsigned = { seq: entry.seq, lineNo };
          if (hasHmacKey) {
            const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
            if (!toleratedLegacyPrefix) {
              return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
            }
          }
        } else if (hasHmacKey) {
          if (!entrySigValid(key, entry, { publicKey })) {
            return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
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
    return fail2(
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
  function fail2(count, breakInfo, message) {
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
  const rootRaw = readRawLines(join6(dir, "manifest.jsonl"));
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
      if (existsSync4(segFile)) {
        lines = readFileSync3(segFile, "utf8").split("\n").filter((l) => l.trim() !== "");
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
  const rootPath = join6(dir, "manifest.jsonl");
  let rootLast = null;
  if (existsSync4(rootPath)) {
    const rootLines = readFileSync3(rootPath, "utf8").split("\n").filter((l) => l.trim() !== "");
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

// packages/tickets/lib/manifest-segments.mjs
function readRawLines2(filePath) {
  if (!existsSync5(filePath)) return [];
  return readFileSync4(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
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
  const root = parseLines(readRawLines2(join7(dir, "manifest.jsonl")));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines2(segmentPath(dir, name))));
  return [...root, ...segments];
}

// packages/tickets/lib/key-contract.mjs
function validateKeyParam(key) {
  if (key === null) return null;
  if (typeof key === "string" && key.length > 0) return key;
  throw new TypeError(
    `manifest key parameter must be a non-empty string (a key) or null (explicitly no key); got ${key === "" ? "'' (empty string)" : typeof key}. Resolve the environment in the bin (getKey()) and thread the value down \u2014 library code never reads process.env.`
  );
}

// packages/tickets/lib/evidence.mjs
var sleep2 = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
function withManifestLock(path, fn, { retries = 400, delayMs = 5 } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync4(dirname6(path), { recursive: true });
  const owner = { version: 1, token: randomUUID2(), pid: process.pid, hostname: hostname2(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync5(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt < retries) sleep2(delayMs);
      continue;
    }
    try {
      writeFileSync4(descriptor, `${JSON.stringify(owner)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync5(descriptor);
    }
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(readFileSync5(lockPath, "utf8"));
        if (current.token === owner.token) unlinkSync3(lockPath);
      } catch {
      }
    }
  }
  throw conflict("MANIFEST_LOCK_TIMEOUT", `could not acquire manifest lock: ${lockPath}`);
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
var AUDIT_FIELDS = ["bypass", "op", "ticketId", "storeHashBefore", "storeHashAfter", "ticketIds"];
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
    const resolved = resolveOpenSegment(dir, { cwd: dirname6(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync4(dirname6(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync6(targetPath) ? readFileSync5(targetPath, "utf8") : "";
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
      const descriptor = openSync5(targetPath, "a");
      try {
        writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync2(descriptor);
      } finally {
        closeSync5(descriptor);
      }
      fsyncDirectory(dirname6(targetPath));
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
  const dir = join8(root, ".adlc");
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
  const path = join8(root, ".adlc/manifest.jsonl");
  return withManifestLock(path, () => {
    const content = existsSync6(path) ? readFileSync5(path, "utf8") : "";
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
    const descriptor = openSync5(path, "a");
    try {
      writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync5(descriptor);
    }
    fsyncDirectory(dirname6(path));
    return entry;
  });
}

// packages/tickets/lib/trust-root.mjs
import { existsSync as existsSync7, lstatSync as lstatSync6, readFileSync as readFileSync6, readdirSync as readdirSync3 } from "node:fs";
import { join as join9 } from "node:path";
var STORE_MARKER = ".store.json";
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
  const directory = join9(root, ARCHIVE_DIRECTORY);
  const legacy = join9(root, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync7(directory)) {
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
          const marker = JSON.parse(readFileSync6(join9(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join9(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync6(join9(directory, entry.name), "utf8"));
      } catch {
        return true;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.id !== "string") return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync7(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync6(legacy, "utf8"));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function manifestRecordsBypass(root) {
  const rootManifest = join9(root, ".adlc", "manifest.jsonl");
  const segments = join9(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync7(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join9(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join9(segments, entry.name));
      }
    } catch {
      return true;
    }
  }
  for (const file of files) {
    if (!existsSync7(file)) continue;
    let text;
    try {
      text = readFileSync6(file, "utf8");
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
  assertNotSymlink(join9(root, ".adlc"));
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

// packages/tickets/lib/transaction.mjs
var fileHash = (path) => sha256(readFileSync7(path));
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
  const transactionId = randomUUID3();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join10(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) : null;
    const target = resolve4(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join10(transactionRoot, "stage", basename(store.path));
    const backup = join10(transactionRoot, "backup", basename(store.path));
    durableMkdir(dirname7(stage));
    durableMkdir(dirname7(backup));
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
    durableWrite(join10(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
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
    durableWrite(join10(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync8(join10(transactionRoot, "journal.json")) && existsSync8(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}

// packages/tickets/lib/stores/legacy.mjs
function repositoryRootFor(path, explicit) {
  if (explicit !== null && explicit !== void 0) return explicit;
  const parent = dirname8(path);
  if (basename2(path) === basename2(LEGACY_FILE) && basename2(parent) === dirname8(LEGACY_FILE)) {
    return dirname8(parent);
  }
  throw invalid(
    "AMBIGUOUS_STORE_ROOT",
    `cannot infer which repository governs ${path}: it is not the canonical <root>/${LEGACY_FILE} layout, so the trust-root evidence (archive, manifest, recorded overrides) would be read from the wrong directory and a frozen store could be written keylessly. Pass an explicit { root }.`
  );
}
var LegacyTicketStore = class {
  constructor(path = LEGACY_FILE) {
    this.path = path;
  }
  exists() {
    return existsSync9(this.path);
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
    const parentStat = lstatSync7(dirname8(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${dirname8(this.path)} must be a real directory`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync8(this.path, "utf8"));
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

// packages/tickets/lib/store.mjs
var rooted = (root, path) => isAbsolute3(path) ? path : join11(root, path);
function pendingTransactions(root = ".") {
  const path = join11(root, TRANSACTION_DIRECTORY);
  if (!existsSync10(path)) return [];
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
  const legacy = new LegacyTicketStore(join11(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join11(root, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict("AMBIGUOUS_STORE", "both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration");
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational("STORE_NOT_FOUND", `no ticket store found under ${resolve5(root)}`);
}

// packages/tickets/lib/generated-glob-match.mjs
var SLASH = "/".charCodeAt(0);

// packages/tickets/lib/manifest-rails.mjs
var MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);

// packages/tickets/lib/rail-existence.mjs
var GIT_MAX_BUFFER2 = 256 * 1024 * 1024;

// packages/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";

// packages/tickets/lib/stores/git-tree.mjs
var MAX_BUFFER = 64 * 1024 * 1024;

// packages/core/lib/glob.mjs
var SLASH2 = "/".charCodeAt(0);
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

// packages/core/lib/tickets.mjs
var TICKET_TRUST_ROOT_RAILS = Object.freeze([
  ".adlc/tickets.json",
  ".adlc/tickets/.store.json",
  ".adlc/tickets/**",
  ".adlc/current-ticket.json"
]);
function activeTickets(tickets) {
  const done = new Set(tickets.filter((t) => t.completed === true).map((t) => t.id));
  if (done.size === 0) return tickets;
  return tickets.filter((t) => !done.has(t.id)).map(
    (t) => Array.isArray(t.edges) && t.edges.some((e) => done.has(e.to)) ? { ...t, edges: t.edges.filter((e) => !done.has(e.to)) } : t
  );
}

// packages/core/lib/revision.mjs
var GIT_MAX_BUFFER3 = 64 * 1024 * 1024;
var NULL_OBJECT = "0".repeat(40);

// packages/core/lib/generated-glob-match.mjs
var SLASH3 = "/".charCodeAt(0);

// packages/core/lib/risk-tier.mjs
var RISK_TIER_PATTERNS = Object.freeze({
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

// packages/core/lib/prosecutor.mjs
var LENSES = [
  { key: "correctness", agent: "prosecutor-correctness", focus: "logic errors, broken invariants, wrong results" },
  { key: "security", agent: "prosecutor-security", focus: "auth/trust boundaries, injection, secrets, unsafe data flow" },
  { key: "contract", agent: "prosecutor-contract", focus: "API/schema/type conformance against the declared contract" },
  { key: "diff", agent: "prosecutor-diff", focus: "spec-vs-implementation divergence; unstated behavior changes" },
  { key: "tests", agent: "prosecutor-tests", focus: "hollow/mock-only tests; are the new tests load-bearing?" }
];
var VERIFIER = { key: "verifier", agent: "prosecutor-verifier", focus: "reproduce/refute a finding" };
var ALL_AGENTS = [...LENSES.map((l) => l.agent), VERIFIER.agent];

// packages/core/lib/shell.mjs
function collectPatchPaths(text, out) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    for (const prefix of ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "]) {
      if (line.startsWith(prefix)) {
        const path = line.slice(prefix.length).trim();
        if (path) out.add(path);
      }
    }
  }
}
function shellTokens(text) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|<>]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}
function looksPathLike(value) {
  return !value.startsWith("-") && !value.includes("=") && /^[A-Za-z0-9_./@+-]+$/.test(value) && (/[/\\]/.test(value) || /\.[A-Za-z0-9]+$/.test(value));
}
function looksBarePathLike(value) {
  return !value.startsWith("-") && !value.includes("=") && /^[A-Za-z0-9_./@+-]+$/.test(value);
}
function keyValuePath(value) {
  const match = value.match(/^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_-]*)=(.+)$/);
  if (!match) return null;
  const path = match[1].replace(/^["']|["']$/g, "");
  return looksPathLike(path) ? path : null;
}
function hasUnquotedFileRedirect(text) {
  const s = String(text ?? "");
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote === null && c === "\\") {
      i += 1;
      continue;
    }
    if (quote === null && (c === "'" || c === '"')) {
      quote = c;
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === ">") {
      let j = s[i + 1] === ">" ? i + 2 : i + 1;
      while (s[j] === " " || s[j] === "	") j += 1;
      if (s[j] !== void 0 && s[j] !== "&") return true;
    }
  }
  return false;
}
function shellHasMutation(text) {
  return /(^|[\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\s*\S+/.test(text) || hasUnquotedFileRedirect(text) || /\b(?:tee|touch|rm|mv|cp|install|dd|truncate|rsync|chmod|chown|ln|mkdir|mktemp|shred)\b/.test(text) || /\bcurl\b[^;&|]*(?:\s-[oO]\b|\s--output\b|\s--remote-name\b)/.test(text) || /\bwget\b[^;&|]*(?:\s-O\b|\s--output-document\b)/.test(text) || /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(text) || /\b(?:patch|tar|unzip)\b/.test(text) || /\bfind\b[^;&|]*(?:-delete|-exec(?:dir)?\b|-ok(?:dir)?\b)/.test(text) || /\b(?:sed|perl)\s+[^;&|]*-(?:i|p?i)\b/.test(text) || // GNU sed's `w` command accepts the filename with no space (verified
  // against the real binary). `\s*` deliberately over-matches some ordinary
  // substitution text in exchange — this classifier already errs toward
  // "mutating" on ambiguity. The boundary before `w` accepts a digit too
  // (`(?<=[0-9])`, not just `\b`): a line-address write (`1w file`, `1,5w
  // file` — real sed syntax, verified against the real binary) has a DIGIT
  // immediately before `w`, and digits are word characters, so plain `\b`
  // never fires there. Every other address form (`$w`, `/re/w`, `!w`) is
  // already a non-word character before `w`, where `\b` already matches.
  /\bsed\b[^;&|]*(?:"[^"\n]*(?:\b|(?<=[0-9]))w\s*\S+[^"\n]*"|'[^'\n]*(?:\b|(?<=[0-9]))w\s*\S+[^'\n]*')/.test(text) || /\bawk\b[^;&|]*(?:\s-i(?:\s|=)|\s--in-place\b)/.test(text) || /\b(?:node|python3?|ruby)\b[^;&|]*(?:writeFile|appendFile|rmSync|renameSync|copyFile|truncateSync|mkdirSync|write_text|write_bytes)/.test(text) || /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/.test(text) || /\bFile\.(?:write|open)\b/.test(text);
}
var SINGLE_LITERAL_INTERPRETER_WRITES = [
  /^\s*node\s+(?:-[ep]|--eval|--print)\s+"require\('(?:node:)?fs'\)\.(?:writeFileSync|appendFileSync)\('([A-Za-z0-9_./-]+)',\s*'[^'"\\$`\r\n]*'\);?"\s*$/,
  /^\s*node\s+(?:-[ep]|--eval|--print)\s+'require\("(?:node:)?fs"\)\.(?:writeFileSync|appendFileSync)\("([A-Za-z0-9_./-]+)",\s*"[^'"\\$`\r\n]*"\);?'\s*$/,
  /^\s*python3?\s+-c\s+"open\('([A-Za-z0-9_./-]+)',\s*'[wa]'\)\.write\('[^'"\\$`\r\n]*'\)"\s*$/,
  /^\s*python3?\s+-c\s+'open\("([A-Za-z0-9_./-]+)",\s*"[wa]"\)\.write\("[^'"\\$`\r\n]*"\)'\s*$/,
  /^\s*ruby\s+-e\s+"File\.write\('([A-Za-z0-9_./-]+)',\s*'[^'"\\$`\r\n]*'\)"\s*$/,
  /^\s*ruby\s+-e\s+'File\.write\("([A-Za-z0-9_./-]+)",\s*"[^'"\\$`\r\n]*"\)'\s*$/
];
function singleLiteralInterpreterWriteTarget(text) {
  for (const re of SINGLE_LITERAL_INTERPRETER_WRITES) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}
function shellHasOpaqueMutation(text) {
  const cmd = String(text ?? "");
  const hasSingleLiteralWrite = singleLiteralInterpreterWriteTarget(cmd) !== null;
  return /\bgit\s+(?:apply|am|checkout|restore|reset|clean|merge|rebase|cherry-pick|stash|commit)\b/.test(cmd) || /\b(?:patch|tar|unzip)\b/.test(cmd) || /\b(?:sh|bash|dash|zsh|ksh)\b[^;&|]*\s-[a-zA-Z]*c\b/.test(cmd) || /(?:^|[;&|()\n]\s*)(?:eval|exec|source)\s+\S+/.test(cmd) || /(?:^|[;&|()\n]\s*)\.\s+\S+/.test(cmd) || /\bnode\b[^;&|]*\s(?:-r|--require|--import|--loader)(?:=|\s|$)/.test(cmd) || /\bperl\b[^;&|]*\s-[a-zA-Z]*[ei]\b/.test(cmd) || /\blua\b[^;&|]*\s-e\b/.test(cmd) || /\bphp\b[^;&|]*\s-r\b/.test(cmd) || /\bdeno\s+eval\b/.test(cmd) || /\bbun\b[^;&|]*\s-e\b/.test(cmd) || !hasSingleLiteralWrite && (/\bnode\b[^;&|]*\s(?:-[ep]|--eval|--print)(?:=|\s|$)/.test(cmd) || /\bpython3?\b[^;&|]*\s-c\b/.test(cmd) || /\bruby\b[^;&|]*\s-e\b/.test(cmd));
}
function splitOnUnquotedSeparators(text) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === null && c === "\\") {
      current += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote === null && (c === "'" || c === '"')) {
      quote = c;
      current += c;
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && c === "\\") {
        current += c + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "&" && text[i + 1] === "&" || c === "|" && text[i + 1] === "|") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (quote !== null) return null;
  segments.push(current);
  return segments;
}
var MUTATING_BRANCH_FLAGS = /* @__PURE__ */ new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description"
]);
var READONLY_BRANCH_FLAGS = /* @__PURE__ */ new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--color",
  "--no-color"
]);
var LISTING_BRANCH_FLAGS = /* @__PURE__ */ new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged"
]);
function isReadOnlyGitBranch(segment) {
  const tokens = shellTokens(segment);
  if (tokens[0] !== "git" || tokens[1] !== "branch") return false;
  const args = tokens.slice(2);
  if (args.some((token) => MUTATING_BRANCH_FLAGS.has(token) || token.startsWith("--set-upstream-to="))) {
    return false;
  }
  const everyReadOnly = args.every((token) => READONLY_BRANCH_FLAGS.has(token) || READONLY_BRANCH_FLAGS.has(token.split("=")[0]));
  const hasListing = args.some((token) => LISTING_BRANCH_FLAGS.has(token) || LISTING_BRANCH_FLAGS.has(token.split("=")[0]));
  return everyReadOnly || hasListing;
}
var NODE_TEST_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-concurrency",
  "--test-timeout",
  "--test-shard"
]);
var NODE_TEST_FORBIDDEN_FLAGS = /^(?:-[epr]|--(?:eval|print|require|import|loader|experimental-loader))(?:=|$)/;
var SAFE_TEST_TARGET_RE = /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;
function isReadOnlyNodeTest(segment) {
  const tokens = shellTokens(segment);
  if (tokens[0] !== "node" || tokens[1] !== "--test") return false;
  const rest = tokens.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (NODE_TEST_FORBIDDEN_FLAGS.test(tok)) return false;
    if (NODE_TEST_VALUE_FLAGS.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith("-")) continue;
    if (!SAFE_TEST_TARGET_RE.test(tok.replace(/\\/g, "/"))) return false;
  }
  return true;
}
function shellIsPositivelyReadOnly(text) {
  const normalized = String(text ?? "").trim();
  if (normalized === "") return true;
  const readOnlyPrefix = /^(?:git\s+(?:status|diff|show|log|rev-parse|ls-files)\b|pwd\b|ls\b|rg\b|grep\b|cat\b|sed\s+-n\b|head\b|tail\b|wc\b|nl\b|node\s+--check\b|npm\s+(?:test|run\s+test)\b|adlc\s+(?:hollow-test|rails-guard|flail-detector|preflight|run\s+p[34])\b)/;
  const adlcRecordOption = /^adlc\s+.*(?:^|[\s"'])--record(?:$|=[\s\S]*|[\s"'])/;
  const segments = splitOnUnquotedSeparators(normalized);
  if (segments === null) return false;
  return segments.map((s) => s.trim()).filter((s) => s !== "").every((segment) => {
    if (/(?:^|[;&|()\s])GIT_EXTERNAL_DIFF=/.test(segment)) return false;
    if (/^git\s+.*(?:^|[\s"'])--(?:ext-diff|textconv)(?:$|[\s"'])/.test(segment)) return false;
    if (adlcRecordOption.test(segment)) return false;
    return isReadOnlyGitBranch(segment) || isReadOnlyNodeTest(segment) || readOnlyPrefix.test(segment);
  });
}
function shellHasWriteOption(text) {
  return /(?:^|[\s"'])--(?:output|output-file|test-reporter-destination|reporter-destination|out-file|save|write|in-place|pre|pre-glob)['"]?(?:=|\s+)\S+/.test(text);
}
function shellChangesCwd(text) {
  return /(^|[\s;&|()])(?:cd|pushd|popd)\b/.test(text);
}
function shellHasExpansion(text) {
  return /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(|`|[*?]|\[[^\]\n]+\])/.test(text);
}
function collectShellPaths(text, out) {
  const interpTarget = singleLiteralInterpreterWriteTarget(text);
  if (interpTarget) out.add(interpTarget);
  const redirectPattern = /(?:[0-9])?>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  let redirect;
  while ((redirect = redirectPattern.exec(text)) !== null) {
    out.add(redirect[1] ?? redirect[2] ?? redirect[3]);
  }
  const quotedPathPattern = /["'`]([^"'`\n]*[/\\][^"'`\n]*)["'`]/g;
  let quoted;
  while ((quoted = quotedPathPattern.exec(text)) !== null) {
    const value = quoted[1];
    if (looksPathLike(value)) out.add(value);
  }
  const sedWritePattern = /\bsed\b[^;&|]*(?:"[^"\n]*(?:\b|(?<=[0-9]))w\s*([A-Za-z0-9_./@+-]+)[^"\n]*"|'[^'\n]*(?:\b|(?<=[0-9]))w\s*([A-Za-z0-9_./@+-]+)[^'\n]*')/g;
  let sedWrite;
  while ((sedWrite = sedWritePattern.exec(text)) !== null) {
    const value = sedWrite[1] ?? sedWrite[2];
    if (value && looksPathLike(value)) out.add(value);
  }
  for (const token of shellTokens(text)) {
    const path = keyValuePath(token);
    if (path) out.add(path);
    else if (looksPathLike(token)) out.add(token);
    else if (looksBarePathLike(token)) out.add(token);
  }
}
function classifyShellCommand(text) {
  const command = String(text ?? "");
  const readOnly = shellIsPositivelyReadOnly(command);
  const mutating = shellHasMutation(command);
  const paths = /* @__PURE__ */ new Set();
  if (mutating) collectShellPaths(command, paths);
  return {
    readOnly: readOnly && !mutating,
    mutating,
    opaque: shellHasOpaqueMutation(command),
    changesCwd: shellChangesCwd(command),
    expands: shellHasExpansion(command),
    writeOption: shellHasWriteOption(command),
    paths: [...paths]
  };
}

// packages/core/lib/railpath.mjs
import { lstatSync as lstatSync9, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute as isAbsolute4, join as join12, parse, relative as relative3 } from "node:path";
var MAX_SYMLINK_HOPS = 40;
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
    return lstatSync9(p);
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
      cur = join12(cur, "..");
      continue;
    }
    const next = join12(cur, seg);
    const st = exists ? lstatOrNull(next) : null;
    if (st?.isSymbolicLink()) {
      const target = ++hops > MAX_SYMLINK_HOPS ? null : readlinkOrNull(next);
      if (target === null) return null;
      if (isAbsolute4(target)) cur = parse(target).root;
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
  const start = isAbsolute4(filePath) ? parse(filePath).root : realRoot;
  const final = walk(start, segmentsOf(filePath)) ?? (isAbsolute4(filePath) ? filePath : join12(realRoot, filePath));
  return relative3(realRoot, final).split("\\").join("/");
}

// packages/core/lib/structural-mutate.mjs
var EXEMPT_KEYS = /* @__PURE__ */ new Set(["encoding", "recursive", "force"]);
var NON_CALL_KEYWORDS = /* @__PURE__ */ new Set([
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
        const trimmed2 = segText.trim();
        if (trimmed2.length > 0) {
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
var STRUCTURAL_FALLBACK_OPERATORS = Object.freeze([
  Object.freeze({
    name: "object-arg-key-drop",
    apply: dropObjectArgKey
  })
]);

// packages/core/lib/mutate.mjs
function identifierSegments(name) {
  return String(name).replace(/[_$\d]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
}
var DISCRETE_TAIL = /* @__PURE__ */ new Set([
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
var MAGNITUDE_UNIT_TAIL = /* @__PURE__ */ new Set([
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
var TUNING_PHRASES = /* @__PURE__ */ new Set([
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
var ARRAY_LITERAL_ELEMENT = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[\w$.]+)`;
var ARRAY_LITERAL_RE = new RegExp(
  `\\[\\s*(${ARRAY_LITERAL_ELEMENT}(?:\\s*,\\s*${ARRAY_LITERAL_ELEMENT})+)\\s*\\]`
);

// packages/core/lib/syntax.mjs
import { fileURLToPath } from "node:url";

// packages/core/lib/primitives.mjs
var SECRET_REDACT_RULES = SECRET_PATTERNS.map(([pattern]) => [
  new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
  pattern === INLINE_ASSIGNMENT ? "$1[REDACTED]" : "[REDACTED]"
]);
var VALID_ATTESTATION_MODES = Object.freeze(["self-context", "headless-cli", "api"]);

// packages/core/lib/sandbox-runner.mjs
var SENSITIVE_HOME_DIRS = Object.freeze([
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
var SENSITIVE_HOME_FILES = Object.freeze([
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".claude.json",
  ".claude.json.backup"
]);
var USER_EPHEMERAL_ROOTS = Object.freeze([
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

// packages/core/lib/syntax.mjs
var TYPESCRIPT_WORKER = fileURLToPath(new URL("./syntax-check-typescript.mjs", import.meta.url));

// packages/core/lib/cluster.mjs
var BASE_STOPWORDS = Object.freeze(/* @__PURE__ */ new Set([
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

// packages/core/lib/diff-mask.mjs
var MASKED_SECRET = "[redacted]";
var NAME = String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,48}?(?:secret|token|passw(?:or)?d|pwd|credentials?|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key)[A-Za-z0-9_.-]{0,48}["']?\s*(?::=|=>|[:=])\s*`;
var ASSIGNMENT_RULES = [
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
var SHAPE_RULES = SECRET_PATTERNS.filter(([pattern]) => pattern !== INLINE_ASSIGNMENT).map(([pattern]) => [new RegExp(pattern.source, `${pattern.flags}g`), () => MASKED_SECRET]);
var MASK_RULES = [...ASSIGNMENT_RULES, ...SHAPE_RULES];

// packages/core/lib/workspace-root.mjs
import { existsSync as existsSync11, lstatSync as lstatSync10, readFileSync as readFileSync9, readlinkSync as readlinkSync2, realpathSync as realpathSync2, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename as basename3, dirname as dirname9, isAbsolute as isAbsolute5, join as join13, relative as relative4, resolve as resolve6 } from "node:path";
var GITDIR_POINTER_MAX_BYTES = 4096;
var SHELL_WORKDIR_KEYS = Object.freeze([
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
var WORKDIR_CONTAINERS = Object.freeze([
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
function readSmallRegularFile(filePath) {
  try {
    const st = lstatSync10(filePath);
    if (!st.isFile() || st.size > GITDIR_POINTER_MAX_BYTES) return null;
    return readFileSync9(filePath, "utf8");
  } catch {
    return null;
  }
}
function extractAllToolWorkdirs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = (
    /** @type {Record<string, unknown>} */
    args
  );
  const out = [];
  const seenRaw = /* @__PURE__ */ new Set();
  const pushVal = (val) => {
    if (typeof val !== "string") return;
    const trimmed2 = val.trim();
    if (!trimmed2 || seenRaw.has(trimmed2)) return;
    seenRaw.add(trimmed2);
    out.push(trimmed2);
  };
  for (const key of SHELL_WORKDIR_KEYS) {
    pushVal(record[key]);
  }
  for (const containerKey of WORKDIR_CONTAINERS) {
    const nested = record[containerKey];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const nestedRecord = (
      /** @type {Record<string, unknown>} */
      nested
    );
    for (const key of SHELL_WORKDIR_KEYS) {
      pushVal(nestedRecord[key]);
    }
  }
  return out;
}
function extractToolWorkdir(args) {
  return extractAllToolWorkdirs(args)[0] ?? null;
}
function hasConflictingToolWorkdirs(args, baseDir = process.cwd()) {
  const candidates = extractAllToolWorkdirs(args);
  if (candidates.length <= 1) return false;
  const anchor = typeof baseDir === "string" && baseDir.trim() ? baseDir : process.cwd();
  const resolved = new Set(
    candidates.map((w) => canonicalizePath(isAbsolute5(w) ? w : resolve6(anchor, w)))
  );
  return resolved.size > 1;
}
function canonicalizePath(targetPath) {
  const abs = resolve6(targetPath);
  let cur = abs;
  const pending = [];
  const seen = /* @__PURE__ */ new Set();
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const realBase = realpathSync2(cur);
      return pending.length === 0 ? realBase : join13(realBase, ...pending);
    } catch {
      if (seen.has(cur)) return abs;
      seen.add(cur);
      try {
        if (lstatSync10(cur).isSymbolicLink()) {
          cur = resolve6(dirname9(cur), readlinkSync2(cur));
          continue;
        }
      } catch {
      }
      const parent = dirname9(cur);
      if (parent === cur) return pending.length === 0 ? cur : join13(cur, ...pending);
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
  return rel === "" || !rel.startsWith("..") && !isAbsolute5(rel);
}
function inspectGitCheckout(dir) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const gitEntry = join13(dir, ".git");
  let stats;
  try {
    stats = lstatSync10(gitEntry);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    if (!existsSync11(join13(gitEntry, "HEAD"))) return null;
    const realGitDir = canonicalizePath(gitEntry);
    return { kind: "repo", gitDir: realGitDir, commonGitDir: realGitDir };
  }
  if (!stats.isFile() || stats.size > GITDIR_POINTER_MAX_BYTES) return null;
  let content;
  try {
    content = readFileSync9(gitEntry, "utf8");
  } catch {
    return null;
  }
  const trimmed2 = content.trimStart();
  if (!trimmed2.startsWith("gitdir:")) return null;
  const firstLine = trimmed2.split(/\r?\n/, 1)[0];
  const rawPtr = firstLine.slice("gitdir:".length).trim();
  if (!rawPtr) return null;
  const resolvedGitDir = resolve6(dir, rawPtr);
  try {
    const realGitDir = realpathSync2(resolvedGitDir);
    const realDir = realpathSync2(dir);
    const backRaw = readSmallRegularFile(join13(realGitDir, "gitdir"));
    const commonRaw = readSmallRegularFile(join13(realGitDir, "commondir"));
    if (backRaw && commonRaw) {
      const backTrimmed = backRaw.trim();
      const commonTrimmed = commonRaw.trim();
      if (backTrimmed && commonTrimmed) {
        const realBackDir = realpathSync2(dirname9(resolve6(realGitDir, backTrimmed)));
        const realCommon = realpathSync2(resolve6(realGitDir, commonTrimmed));
        const realWorktrees = realpathSync2(join13(realCommon, "worktrees"));
        const relWt = relative4(realWorktrees, realGitDir);
        const underWorktrees = relWt !== "" && !relWt.startsWith("..") && !isAbsolute5(relWt);
        if (realBackDir === realDir && underWorktrees && existsSync11(join13(realCommon, "HEAD"))) {
          return { kind: "worktree", gitDir: realGitDir, commonGitDir: realCommon };
        }
      }
      if (existsSync11(join13(realGitDir, "HEAD")) || existsSync11(join13(realGitDir, "commondir"))) {
        return { kind: "gitfile", gitDir: realGitDir, commonGitDir: null };
      }
    }
    if (existsSync11(join13(realGitDir, "HEAD")) || existsSync11(join13(realGitDir, "commondir"))) {
      return { kind: "gitfile", gitDir: realGitDir, commonGitDir: null };
    }
  } catch {
    return null;
  }
  return null;
}
function hasTicketStoreAt(dir, storeOverride = null) {
  if (typeof dir !== "string" || !dir.trim()) return false;
  if (typeof storeOverride === "string" && storeOverride.trim() && !isAbsolute5(storeOverride)) {
    return existsSync11(join13(dir, storeOverride.trim()));
  }
  return existsSync11(join13(dir, ".adlc", "tickets", ".store.json")) || existsSync11(join13(dir, ".adlc", "tickets.json"));
}
function hasExternalAbsoluteStore(storeOverride) {
  return typeof storeOverride === "string" && storeOverride.trim().length > 0 && isAbsolute5(storeOverride.trim()) && existsSync11(storeOverride.trim());
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
        isSym = lstatSync10(startLexical).isSymbolicLink();
      } catch {
        isSym = false;
      }
      startLexical = isSym ? dirname9(canonicalizePath(startLexical)) : dirname9(startLexical);
    }
  }
  if (pluginDir && isPathInside(startLexical, pluginDir)) return null;
  const startCanonical = canonicalizePath(startLexical);
  const realHome = typeof homeDir === "string" && homeDir.trim() ? canonicalizePath(homeDir) : null;
  const trimmedOverride = typeof storeOverride === "string" && storeOverride.trim() ? storeOverride.trim() : null;
  const isExternalOverride = trimmedOverride !== null && isAbsolute5(trimmedOverride);
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
    const parent = dirname9(rawCur);
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

// packages/hook-engine/lib/pretool.mjs
import { isAbsolute as isAbsolute6, resolve as resolve7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var READ_ONLY_TOOL_NAMES = /* @__PURE__ */ new Set([
  "read",
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "glob",
  "grep",
  "grep_search",
  "find_by_name",
  "list_dir",
  "ls",
  "search_web",
  "read_url_content",
  "web_search",
  "web_fetch",
  "todo_read",
  "ask_question",
  "list_resources",
  "read_resource"
]);
var NON_FS_UI_TOOL_NAMES = /* @__PURE__ */ new Set([
  "update_steps",
  "todo_write",
  "task_boundary",
  "enter_plan_mode",
  "exit_plan_mode"
]);
var SHELL_TOOL_NAMES = /* @__PURE__ */ new Set([
  "bash",
  "shell",
  "run_command",
  "execute_command",
  "terminal",
  "powershell",
  "exec",
  "command"
]);
var PATCH_TOOL_NAMES = /* @__PURE__ */ new Set(["apply_patch", "patch"]);
var FILE_MUTATION_TOOL_NAMES = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "write_file",
  "edit_file",
  "modify_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "create_file",
  "delete_file",
  "remove_file",
  "rename_file",
  "move_file",
  "unlink"
]);
var DELETE_OR_MOVE_TOOL_NAMES = /* @__PURE__ */ new Set([
  "delete_file",
  "remove_file",
  "rename_file",
  "move_file",
  "unlink"
]);
var DIR_DELETE_CMD_RE = /(?:^|[\s;&|()])(?:(?:command|env|sudo|busybox)\s+)*(?:[A-Za-z0-9_./-]+\/)?(?:(?:rm|rmdir|mv|unlink)\b|git\s+(?:rm|clean)\b|find\b[^\n;|&]*\s-delete\b)/;
var FILE_PATH_KEYS = [
  "file_path",
  "filePath",
  "FilePath",
  "path",
  "Path",
  "TargetFile",
  "target_file",
  "targetFile",
  "target_path",
  "targetPath",
  "AbsolutePath",
  "TargetContentPath",
  "TargetDir",
  "old_path",
  "new_path",
  "source",
  "destination",
  "dest"
];
function isOutsideRoot(rel) {
  return rel === ".." || rel.startsWith("../") || isAbsolute6(rel);
}
function allowVerdict(root) {
  return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
}
function denyVerdict(reason, root, matchedRail = null, resolvedPath = null) {
  return { decision: "deny", reason, matchedRail, resolvedPath, root };
}
function decodeFileUriOrPath(raw) {
  const trimmed2 = raw.trim();
  if (!trimmed2.startsWith("file://")) return trimmed2;
  try {
    return fileURLToPath2(trimmed2);
  } catch {
    const stripped = trimmed2.replace(/^file:\/\/(?:localhost)?/i, "");
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
}
function enclosingAdlcRoot(startPath, opts = {}) {
  const {
    outerRoot = null,
    storeOverride = null,
    pluginDir = null,
    requireStore = true
  } = opts;
  const searchOpts = { storeOverride, pluginDir, requireStore };
  if (outerRoot) {
    return preferInnermostCheckout(outerRoot, [startPath], searchOpts);
  }
  return findInnermostCheckoutRoot(startPath, searchOpts);
}
function isAncestorDirOfRail(relPath, railGlob) {
  const dir = String(relPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const glob = String(railGlob ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!glob) return false;
  if (dir === "" || dir === ".") return true;
  if (isOutsideRoot(dir)) return false;
  if (glob === dir || glob.startsWith(`${dir}/`)) return true;
  if (glob.startsWith("**/") || glob.startsWith("*")) return true;
  if (globMatch2(glob, dir)) return true;
  const dirSegs = dir.split("/");
  const globSegs = glob.split("/");
  if (dirSegs.length < globSegs.length) {
    const globPrefix = globSegs.slice(0, dirSegs.length).join("/");
    if (globMatch2(globPrefix, dir)) return true;
  }
  return false;
}
function railHit(filePath, root, rails = [], opts = {}) {
  const { checkAncestorDir = false, baseDir = root } = opts;
  const raw = String(filePath ?? "").trim();
  if (!raw || !root || !Array.isArray(rails) || rails.length === 0) {
    return { hit: false, rail: null, resolvedPath: raw, ancestorDir: false };
  }
  const decoded = decodeFileUriOrPath(raw);
  const absCandidate = isAbsolute6(decoded) ? decoded : resolve7(baseDir, decoded);
  const rel = resolveRailPath(absCandidate, root);
  if (isOutsideRoot(rel)) {
    return { hit: false, rail: null, resolvedPath: rel, ancestorDir: false };
  }
  for (const rail of rails) {
    if (typeof rail !== "string" || !rail.trim()) continue;
    if (globMatch2(rail, rel)) {
      return { hit: true, rail, resolvedPath: rel, ancestorDir: false };
    }
    if (checkAncestorDir && isAncestorDirOfRail(rel, rail)) {
      return { hit: true, rail, resolvedPath: rel, ancestorDir: true };
    }
  }
  return { hit: false, rail: null, resolvedPath: rel, ancestorDir: false };
}
function isDirectoryDeletionCommand(command) {
  return DIR_DELETE_CMD_RE.test(String(command ?? ""));
}
function resolveActiveTicketId2(root, env = process.env) {
  const resolved = resolveActiveTicketId({ root: root ?? ".", env });
  if (!resolved.ok) {
    return { id: null, conflict: true, code: resolved.code, message: resolved.message };
  }
  return {
    id: resolved.value?.id ?? null,
    conflict: false,
    code: null,
    message: null,
    ticketHash: resolved.value?.ticketHash ?? null
  };
}
function readActiveTicketRails(root, { storeOverride = null, env = process.env } = {}) {
  const cleanEnv = env.ADLC_TICKET ? { ...env } : env;
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], boundTicket: false, error: null };
  let snapshot;
  try {
    const store = detectTicketStore({ root, ticketStore: storeOverride ?? void 0, allowRecovery: true, env: cleanEnv });
    snapshot = store.load();
  } catch (err) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      boundTicket: false,
      error: `ticket store unreadable: ${err?.message ?? String(err)}`
    };
  }
  const tickets = snapshot.tickets ?? [];
  const active = activeTickets(tickets);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env: cleanEnv });
  if (!resolved.ok) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      boundTicket: false,
      error: `invalid active ticket selection: ${resolved.message ?? "conflict"}`
    };
  }
  if (resolved.value !== null) {
    const selected = resolved.value.ticket;
    if (selected.completed === true) {
      return {
        ok: false,
        tickets: [],
        activeTicket: null,
        rails: [],
        boundTicket: false,
        error: `active ticket "${selected.id}" is already completed`
      };
    }
    const rails = Array.isArray(selected.rails) ? selected.rails.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()) : [];
    return { ok: true, tickets: active, activeTicket: selected, rails, boundTicket: true, error: null };
  }
  const activeTicket = active[0] ?? null;
  const railSet = /* @__PURE__ */ new Set();
  for (const t of active) {
    if (Array.isArray(t.rails)) {
      for (const r of t.rails) {
        if (typeof r === "string" && r.trim()) railSet.add(r.trim());
      }
    }
  }
  return { ok: true, tickets: active, activeTicket, rails: [...railSet], boundTicket: false, error: null };
}
function extractFilePathsFromInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const out = [];
  for (const k of FILE_PATH_KEYS) {
    if (typeof toolInput[k] === "string" && toolInput[k].trim()) {
      out.push(decodeFileUriOrPath(toolInput[k]));
    }
  }
  for (const uriKey of ["uri", "URI"]) {
    const raw = toolInput[uriKey];
    if (typeof raw === "string" && raw.trim()) {
      const trimmed2 = raw.trim();
      if (trimmed2.startsWith("file://") || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed2)) {
        out.push(decodeFileUriOrPath(trimmed2));
      }
    }
  }
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) {
      if (typeof f === "string" && f.trim()) out.push(decodeFileUriOrPath(f));
      else if (f && typeof f === "object" && typeof f.path === "string" && f.path.trim()) {
        out.push(decodeFileUriOrPath(f.path));
      }
    }
  }
  return out;
}
function evaluatePreTool({
  toolName = "",
  toolInput = {},
  cwd = process.cwd(),
  outerRoot = null,
  rails = null,
  boundTicket = void 0,
  storeOverride = null,
  env = process.env
} = {}) {
  const effectiveBase = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
  const root = enclosingAdlcRoot(effectiveBase, { outerRoot, storeOverride });
  const normalizedTool = String(toolName ?? "").trim().toLowerCase();
  if (hasConflictingToolWorkdirs(toolInput, effectiveBase)) {
    return denyVerdict("conflicting working directory arguments in tool input", root);
  }
  let effectiveRails;
  let isBoundTicket;
  if (Array.isArray(rails)) {
    effectiveRails = rails;
    isBoundTicket = boundTicket ?? true;
  } else if (root) {
    const loaded = readActiveTicketRails(root, { storeOverride, env });
    if (!loaded.ok) {
      if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) return allowVerdict(root);
      return denyVerdict(`ADLC trust-state error (failing closed): ${loaded.error}`, root);
    }
    effectiveRails = loaded.rails;
    isBoundTicket = boundTicket !== void 0 ? boundTicket : loaded.boundTicket;
  } else {
    effectiveRails = [];
    isBoundTicket = boundTicket ?? false;
  }
  if (effectiveRails.length === 0 || READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
    return allowVerdict(root);
  }
  if (NON_FS_UI_TOOL_NAMES.has(normalizedTool) && isBoundTicket === false) {
    return allowVerdict(root);
  }
  if (toolInput?.__unparseable === true) {
    return denyVerdict("unparseable tool payload while frozen rails are active \u2014 failing closed", root);
  }
  const checkRoot = root ?? effectiveBase;
  const toolWorkdir = extractToolWorkdir(toolInput);
  const pathBase = toolWorkdir ? isAbsolute6(toolWorkdir) ? toolWorkdir : resolve7(effectiveBase, toolWorkdir) : effectiveBase;
  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    const cmd = String(toolInput?.command ?? toolInput?.CommandLine ?? toolInput?.cmd ?? "");
    const cls = classifyShellCommand(cmd);
    if (cls.readOnly && cls.writeOption) {
      return denyVerdict("shell command uses a file-writing output option while frozen rails are active", root);
    }
    if (cls.readOnly) return allowVerdict(root);
    if (!cls.mutating) {
      return denyVerdict("shell command is neither positively read-only nor a transparent file mutation while frozen rails are active", root);
    }
    if (cls.opaque || cls.changesCwd || cls.expands || cls.paths.length === 0) {
      return denyVerdict("shell mutation cannot be verified against frozen rails (opaque, cwd-changing, expanding, or targetless)", root);
    }
    const checkAncestorDir = isDirectoryDeletionCommand(cmd);
    for (const p of cls.paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? "ancestor directory of frozen rail" : "frozen rail";
        return denyVerdict(`shell command targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }
  if (PATCH_TOOL_NAMES.has(normalizedTool)) {
    const patchText = String(toolInput?.patch ?? toolInput?.input ?? toolInput?.diff ?? "");
    const patchPaths = /* @__PURE__ */ new Set();
    collectPatchPaths(patchText, patchPaths);
    if (patchPaths.size === 0) {
      return denyVerdict("patch payload exposes no verifiable target paths while frozen rails are active", root);
    }
    for (const p of patchPaths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir: false, baseDir: pathBase });
      if (hit.hit) {
        return denyVerdict(`patch targets frozen rail "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }
  if (FILE_MUTATION_TOOL_NAMES.has(normalizedTool)) {
    const paths = extractFilePathsFromInput(toolInput);
    if (paths.length === 0) {
      return denyVerdict(`${toolName} exposes no verifiable target path while frozen rails are active`, root);
    }
    const checkAncestorDir = DELETE_OR_MOVE_TOOL_NAMES.has(normalizedTool);
    for (const p of paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? "ancestor directory of frozen rail" : "frozen rail";
        return denyVerdict(`${toolName} targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }
  return denyVerdict(`unrecognized tool "${toolName || "<empty>"}" cannot be verified as read-only while frozen rails are active`, root);
}

// packages/hook-engine/lib/flail-transcript.mjs
import {
  openSync as openSync6,
  readSync as readSync4,
  closeSync as closeSync6,
  lstatSync as lstatSync11,
  fstatSync as fstatSync3,
  readdirSync as readdirSync5,
  realpathSync as realpathSync3,
  constants as fsConstants4
} from "node:fs";
import { join as join14, relative as relative5, isAbsolute as isAbsolute7, basename as basename4 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { createHash as createHash3 } from "node:crypto";
var DEFAULT_FLAIL_THRESHOLD = 3;
var DEFAULT_ERROR_REPEAT_THRESHOLD = 2;
var DEFAULT_WINDOW = 200;
var MAX_SCAN_BYTES = 262144;
var ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT|FAIL|ERR!/i;
var TRANSCRIPT_FILES = ["transcript.jsonl", "transcript_full.jsonl"];
var MAX_BRAIN_SEARCH_DEPTH = 4;
var MAX_BRAIN_DIRS_VISITED = 128;
function normalizeError(line) {
  if (typeof line !== "string") return "";
  if (line.length > 2048) line = line.slice(0, 2048);
  return line.toLowerCase().replace(/0x[0-9a-f]+/gi, "").replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "").replace(/\b[A-Za-z]:\\[^\s]*/g, "").replace(/\b\S+\/[^\s]*/g, "").replace(/\/[^\s]*/g, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}
function detectRepeatedErrors(steps, maxRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD) {
  const counts = /* @__PURE__ */ new Map();
  for (const item of steps) {
    const stepLines = typeof item === "string" ? [item] : Array.isArray(item) ? item : [];
    const stepSigs = /* @__PURE__ */ new Set();
    for (const line of stepLines) {
      if (typeof line !== "string" || !ERROR_LINE_RE.test(line)) continue;
      const sig = normalizeError(line);
      if (!sig || sig.length < 5 || /^(created|completed) at:?$/.test(sig)) continue;
      stepSigs.add(sig);
    }
    for (const sig of stepSigs) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  const results = [];
  for (const [signature, count] of counts.entries()) {
    if (count >= maxRepeat) results.push({ signature, count });
  }
  return results;
}
function detectEditChurn(logLines, threshold = DEFAULT_FLAIL_THRESHOLD) {
  const counts = /* @__PURE__ */ new Map();
  const baseCounts = /* @__PURE__ */ new Map();
  let totalEdits = 0;
  for (const line of logLines) {
    const match = typeof line === "string" ? line.match(/^Editing\s+(.+)$/) : null;
    if (!match?.[1]) continue;
    totalEdits++;
    const p = match[1].trim();
    counts.set(p, (counts.get(p) ?? 0) + 1);
    const base = basename4(p).replace(/\d+/g, "#");
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const result = [];
  for (const [path, count] of counts.entries()) {
    if (count >= threshold) result.push({ path, count });
  }
  for (const [base, count] of baseCounts.entries()) {
    if (base.includes("#") && count >= threshold && !result.some((r) => r.path === base)) {
      result.push({ path: `pattern:${base}`, count });
    }
  }
  if (totalEdits >= threshold * 4 && result.length === 0) {
    result.push({ path: "total_edits_velocity", count: totalEdits });
  }
  return result;
}
function checkRegularTranscriptInside(candidatePath, realRoot) {
  try {
    const lst = lstatSync11(candidatePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const real = realpathSync3(candidatePath);
    const rel = relative5(realRoot, real);
    return !rel.startsWith("..") && !isAbsolute7(rel) ? real : null;
  } catch {
    return null;
  }
}
function findNestedTranscript(dir, cid, realAppRoot, depth, state) {
  if (depth > MAX_BRAIN_SEARCH_DEPTH || state.visited >= MAX_BRAIN_DIRS_VISITED) return null;
  state.visited += 1;
  try {
    const lst = lstatSync11(dir);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
  } catch {
    return null;
  }
  for (const fname of TRANSCRIPT_FILES) {
    const found = checkRegularTranscriptInside(join14(dir, cid, ".system_generated", "logs", fname), realAppRoot);
    if (found) return found;
  }
  let entries;
  try {
    entries = readdirSync5(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name === cid || entry.name === ".system_generated") continue;
    const found = findNestedTranscript(join14(dir, entry.name), cid, realAppRoot, depth + 1, state);
    if (found) return found;
  }
  return null;
}
function resolveTranscriptPath({ payload, conversationId, env = process.env } = {}) {
  const effectiveHome = env?.HOME || env?.USERPROFILE || homedir2();
  const appDataDirs = [...new Set([
    env?.ANTIGRAVITY_APP_DATA_DIR,
    env?.JETSKI_APP_DATA_DIR,
    env?.GEMINI_CLI_DATA_DIR,
    join14(effectiveHome, ".gemini", "antigravity-cli"),
    join14(effectiveHome, ".gemini", "jetski")
  ].filter((d) => typeof d === "string" && d.trim()))];
  const direct = payload?.transcriptPath ?? payload?.transcript_path ?? payload?.logPath ?? payload?.log_path;
  const cidFromPayload = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id;
  const cidFromEnv = env?.ADLC_SESSION_ID ?? env?.AGY_SESSION_ID ?? env?.GEMINI_SESSION_ID;
  const cid = cidFromPayload ?? (typeof conversationId === "string" && conversationId !== "default_session" ? conversationId : null) ?? (typeof cidFromEnv === "string" && cidFromEnv !== "default_session" ? cidFromEnv : null);
  if (typeof direct === "string" && direct.trim()) {
    const trimmed2 = direct.trim();
    if (!trimmed2.split(/[/\\]/).includes("..") && /(^|[/\\]).*transcript.*\.jsonl$/i.test(trimmed2)) {
      const allowedRoots = [
        ...appDataDirs,
        env?.AGY_WORKSPACE,
        env?.ANTIGRAVITY_WORKSPACE,
        env?.GEMINI_WORKSPACE,
        env?.PROJECT_ROOT,
        env?.WORKSPACE_ROOT
      ].filter((r) => typeof r === "string" && r.trim());
      for (const r of allowedRoots) {
        try {
          const verified = checkRegularTranscriptInside(trimmed2, realpathSync3(r));
          if (verified) return verified;
        } catch {
        }
      }
    }
  }
  if (!cid || typeof cid !== "string" || cid.includes("..") || cid.includes("/") || cid.includes("\\")) return null;
  for (const appDir of appDataDirs) {
    let realAppRoot;
    try {
      realAppRoot = realpathSync3(appDir);
    } catch {
      continue;
    }
    const brainDir = join14(appDir, "brain");
    for (const fname of TRANSCRIPT_FILES) {
      const found = checkRegularTranscriptInside(join14(brainDir, cid, ".system_generated", "logs", fname), realAppRoot);
      if (found) return found;
    }
    const nested = findNestedTranscript(brainDir, cid, realAppRoot, 0, { visited: 0 });
    if (nested) return nested;
  }
  return null;
}
function parseJsonLine(rawLine) {
  try {
    return JSON.parse(rawLine);
  } catch {
    return { content: rawLine, __unparseable: true };
  }
}
function parseTranscriptRecords(filePath, options = {}) {
  const isObj = typeof options === "object" && options !== null;
  const maxScanBytes = typeof options === "number" ? options : options?.maxScanBytes ?? MAX_SCAN_BYTES;
  const readFull = isObj && options.readFull === true;
  const maxRecords = isObj ? options.maxRecords ?? 5e4 : 5e4;
  const maxLineLength = isObj ? options.maxLineLength ?? 1048576 : 1048576;
  const maxTotalBytes = isObj ? options.maxTotalBytes ?? 16 * 1024 * 1024 : 16 * 1024 * 1024;
  if (!filePath) return [];
  let fd;
  try {
    fd = openSync6(filePath, fsConstants4.O_RDONLY | fsConstants4.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const stat = fstatSync3(fd);
    if (!stat.isFile()) return [];
    const records = [];
    if (readFull) {
      const buf2 = Buffer.alloc(65536);
      let leftover = "";
      let pos2 = 0;
      let totalBytes = 0;
      while (pos2 < stat.size) {
        const bytesRead = readSync4(fd, buf2, 0, Math.min(buf2.length, stat.size - pos2), pos2);
        if (bytesRead <= 0) break;
        pos2 += bytesRead;
        totalBytes += bytesRead;
        if (totalBytes > maxTotalBytes) {
          records.push({ content: "oversized_transcript", __oversized: true });
          return records;
        }
        const lines = (leftover + buf2.toString("utf8", 0, bytesRead)).split("\n");
        leftover = lines.pop() ?? "";
        if (leftover.length > maxLineLength) {
          records.push({ content: "unterminated_oversized_line", __oversized: true });
          return records;
        }
        for (const rawLine of lines) {
          if (!rawLine.trim()) continue;
          if (records.length >= maxRecords) {
            records.push({ content: "oversized_transcript", __oversized: true });
            return records;
          }
          records.push(rawLine.length > maxLineLength ? { content: "oversized_line", __unparseable: true } : parseJsonLine(rawLine));
        }
      }
      if (leftover.trim()) records.push(records.length >= maxRecords ? { content: "oversized_transcript", __oversized: true } : parseJsonLine(leftover));
      return records;
    }
    const readLen = Math.min(stat.size, maxScanBytes);
    const buf = Buffer.alloc(readLen);
    let pos = 0;
    const start = stat.size > maxScanBytes ? stat.size - maxScanBytes : 0;
    while (pos < readLen) {
      const n = readSync4(fd, buf, pos, readLen - pos, start + pos);
      if (n <= 0) break;
      pos += n;
    }
    let content = buf.toString("utf8", 0, pos);
    if (start > 0) {
      const nl = content.indexOf("\n");
      if (nl !== -1) content = content.slice(nl + 1);
    }
    for (const rawLine of content.split("\n")) {
      if (rawLine.trim()) records.push(parseJsonLine(rawLine));
    }
    return records;
  } catch {
    return [];
  } finally {
    try {
      closeSync6(fd);
    } catch {
    }
  }
}
function isNonErrorStepRecord(obj) {
  const stepType = typeof obj.type === "string" ? obj.type.toUpperCase() : "";
  const status = typeof obj.status === "string" ? obj.status.toUpperCase() : "";
  if (status === "ERROR") return false;
  if (stepType === "USER_INPUT" || stepType === "PLANNER_RESPONSE") return true;
  if (status === "DONE") {
    const body = typeof obj.content === "string" ? obj.content : "";
    if (/Showing lines \d+-\d+ of \d+/.test(body) || /Command exited with code 0\./.test(body)) return true;
  }
  return false;
}
function parseTranscriptSteps(filePath, maxScanBytes = MAX_SCAN_BYTES) {
  const steps = [];
  for (const obj of parseTranscriptRecords(filePath, maxScanBytes)) {
    if (!obj || typeof obj !== "object") {
      if (typeof obj === "string" && obj.trim()) steps.push([obj]);
      continue;
    }
    if (isNonErrorStepRecord(obj)) continue;
    const stepLines = [];
    for (const k of ["content", "text", "message", "error"]) {
      if (typeof obj[k] === "string") stepLines.push(...obj[k].split("\n"));
    }
    if (stepLines.length > 0) steps.push(stepLines);
  }
  return steps;
}
function parseTranscriptLines(filePath, maxScanBytes = MAX_SCAN_BYTES) {
  return parseTranscriptSteps(filePath, maxScanBytes).flat();
}
function analyzeFlail({ edits = [], transcriptSteps = [], transcriptLines = [], threshold = DEFAULT_FLAIL_THRESHOLD, maxErrorRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD } = {}) {
  const churning = detectEditChurn(edits, threshold);
  const errorSteps = [...transcriptSteps, ...transcriptLines.length > 0 && transcriptSteps.length === 0 ? transcriptLines.map((l) => [l]) : []];
  const repeatedErrors = detectRepeatedErrors(errorSteps, maxErrorRepeat);
  const signals = [];
  if (churning.length > 0) signals.push({ type: "edit-churn", entries: churning });
  if (repeatedErrors.length > 0) signals.push({ type: "repeated-error", entries: repeatedErrors });
  const isFlailing = signals.length > 0;
  const parts = [];
  if (churning.length > 0) parts.push(`file edit churn (${churning.map((c) => `${c.path} ${c.count}\xD7`).join(", ")})`);
  if (repeatedErrors.length > 0) parts.push(`repeated error signatures (${repeatedErrors.map((e) => `"${e.signature}" ${e.count}\xD7`).join(", ")})`);
  const summary = parts.join("; ");
  return {
    verdict: isFlailing ? "flail" : "clean",
    signals,
    summary,
    recommendation: isFlailing ? `ADLC anti-flail: session is flailing (${summary}). Consider stepping back, isolating root causes, or starting a fresh session rather than continuing to retry.` : "Session clean"
  };
}
function createFlailTracker({ window = DEFAULT_WINDOW, threshold = DEFAULT_FLAIL_THRESHOLD, maxErrorRepeat = DEFAULT_ERROR_REPEAT_THRESHOLD } = {}) {
  const lines = /* @__PURE__ */ new Map();
  const warned = /* @__PURE__ */ new Map();
  return {
    record({ sessionID, filePath, transcriptSteps = [], transcriptLines = [] }) {
      if (!sessionID) return { churning: [], repeatedErrors: [], verdict: "clean", summary: "" };
      const buf = lines.get(sessionID) ?? [];
      if (filePath) {
        buf.push(`Editing ${filePath}`);
        if (buf.length > window) buf.splice(0, buf.length - window);
        lines.set(sessionID, buf);
      }
      const analysis = analyzeFlail({ edits: buf, transcriptSteps, transcriptLines, threshold, maxErrorRepeat });
      const hashKey = createHash3("sha1").update(JSON.stringify(analysis.signals)).digest("hex").slice(0, 16);
      const seenHashes = warned.get(sessionID) ?? /* @__PURE__ */ new Set();
      const isNew = analysis.verdict === "flail" && !seenHashes.has(hashKey);
      if (isNew) {
        seenHashes.add(hashKey);
        warned.set(sessionID, seenHashes);
      }
      const steps = [...buf.map((e) => [e]), ...transcriptSteps, ...transcriptLines.length > 0 && transcriptSteps.length === 0 ? transcriptLines.map((l) => [l]) : []];
      return {
        churning: detectEditChurn(buf, threshold),
        repeatedErrors: detectRepeatedErrors(steps, maxErrorRepeat),
        verdict: analysis.verdict,
        signals: analysis.signals,
        summary: analysis.summary,
        recommendation: analysis.recommendation,
        isNewSignal: isNew
      };
    },
    evict(sessionID) {
      lines.delete(sessionID);
      warned.delete(sessionID);
    }
  };
}
function flailMessage({ path, count }) {
  return `ADLC flail check: ${path} has been edited ${count}\xD7 this session \u2014 repeated rewrites often signal the model is stuck. Consider stepping back or starting a fresh session.`;
}

// packages/hook-engine/lib/command-verify.mjs
import { existsSync as existsSync12, lstatSync as lstatSync12, realpathSync as realpathSync4 } from "node:fs";
import { homedir as homedir3, tmpdir as tmpdir2 } from "node:os";
import { basename as basename5, dirname as dirname10, isAbsolute as isAbsolute8, join as join15, relative as relative6, resolve as resolve8 } from "node:path";
var TRUST_ROOT_RAILS = [
  ".adlc",
  ".adlc/**",
  ".adlc/tickets",
  ".adlc/tickets.json",
  ".adlc/tickets/.store.json",
  ".adlc/tickets/**",
  ".adlc/current-ticket.json",
  ".adlc/sessions.json",
  ".adlc/sessions.lock",
  ".adlc/sessions.lock/**",
  ".adlc/session-ledger.jsonl",
  ".adlc/session-ledger.jsonl*",
  ".adlc/.session-secret",
  ".adlc/.session-secret*",
  ".booster",
  ".booster/**",
  ".env.local",
  ".env.local*"
];
var MUTATING_TOOL_HINTS = ["write", "edit", "replace", "patch", "create", "delete", "remove", "rename", "move", "apply", "insert", "append", "modify"];
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
  "search",
  "findbyname",
  "searchweb",
  "managetask",
  "schedule",
  "listpermissions",
  "sendmessage",
  "askquestion",
  "invokesubagent",
  "askpermission",
  "managesubagents",
  "definesubagent",
  "readurlcontent",
  "listresources",
  "readresource"
]);
var READONLY_MCP_INNER_TOOLS = /* @__PURE__ */ new Set(["codegraphexplore", "agbstatus", "agbdoctor", "agbpreflight", "listresources", "readresource"]);
var SHELL_TOOL_NAMES2 = /* @__PURE__ */ new Set([
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
  "terminalcommand",
  "customshell"
]);
var MUTATING_PAYLOAD_KEY_RE = /^(TargetFile|target_file|dest_file|destFile|dest|destination|destPath|CodeContent|codeContent|content|Replacement|replacement|ReplacementContent|replacementContent|ReplacementChunks|replacementChunks|patch|patchText|diff|edits|changes|operations)$/i;
var CMD_KEY_RE = /(command|cmd|exec|shell|terminal|script|code|eval|run)/i;
var CODE_KEY_RE = /^(code|script|eval|expression|program|snippet|inline|payload)$/i;
var EXTRACT_CMD_KEY_RE = /^(command|cmd|commandline|command_line|exec|shell|terminal|script|eval|run|query|action|operation|program|payload)$/i;
var SKIP_CMD_KEY_RE = /content|body|diff|patch|replacement|summary|description|message/i;
var SAFE_BINS = /* @__PURE__ */ new Set(["ls", "pwd", "cat", "head", "tail", "grep", "rg", "which", "uname", "whoami", "date", "echo", "printf"]);
var FILE_READER_BINS = /* @__PURE__ */ new Set(["cat", "head", "tail", "ls", "grep", "rg"]);
var normalizeToolName = (name) => String(name ?? "").toLowerCase().replace(/[^a-z]/g, "");
function resolveUserHome(env = process.env) {
  const fromEnv = process.platform === "win32" ? env?.USERPROFILE : env?.HOME;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  try {
    return homedir3() || tmpdir2();
  } catch {
    return tmpdir2();
  }
}
function getTrustRootSecretHomes(env = process.env) {
  const customHome = (resolveUserHome(env) || "").replace(/\\/g, "/");
  let realHome = "";
  try {
    realHome = (homedir3() || tmpdir2() || "").replace(/\\/g, "/");
  } catch {
    try {
      realHome = (tmpdir2() || "").replace(/\\/g, "/");
    } catch {
      realHome = "";
    }
  }
  return [...new Set([realHome, customHome].filter(Boolean))];
}
function isSecretStatePath(p, env = process.env) {
  if (!p || typeof p !== "string") return false;
  const norm = p.replace(/\\/g, "/");
  for (const h of getTrustRootSecretHomes(env)) {
    if (norm === `${h}/.adlc` || norm.startsWith(`${h}/.adlc/`) || norm === `${h}/.config/adlc` || norm.startsWith(`${h}/.config/adlc/`)) return true;
  }
  if (/(^|\/|\b)(\.master-key|\.auth-key|\.adlc-secrets|\.adlc-runtime-secrets|\.session-secret|\.store\.json|session-[a-f0-9]+\.secret|\.adlc\/sessions|\.adlc\/session-ledger|\.env\.local)/i.test(norm)) return true;
  return norm.startsWith("~/.adlc") || norm.startsWith("~/.config/adlc");
}
function isTrustRootOrSecretPath(p, env = process.env) {
  if (!p || typeof p !== "string") return false;
  const norm = p.replace(/\\/g, "/");
  if (process.execPath) {
    const nb = process.execPath.replace(/\\/g, "/");
    if (norm === nb || norm.startsWith(nb + "/")) return true;
    try {
      const rn = realpathSync4(process.execPath).replace(/\\/g, "/");
      if (norm === rn || norm.startsWith(rn + "/")) return true;
    } catch {
    }
  }
  if (/(^|\/)(node|node\.exe)$/i.test(norm) || /(^|\/)node_modules\/\.bin\/(node|mocha|jest|vitest|npm|npx|adlc)(\.exe|\.cmd|\.ps1)?$/i.test(norm) || /(^|\/)(\.mocharc(\.(js|cjs|mjs|json|yaml|yml))?|jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|cjs|mjs|ts))$/i.test(norm)) return true;
  return isSecretStatePath(p, env);
}
function hasKeyMatching(args, re, depth = 0) {
  if (!args || typeof args !== "object" || depth > 5) return false;
  for (const [k, v] of Object.entries(args)) {
    if (re.test(k) && (typeof v === "string" && v.trim().length > 0 || Array.isArray(v) && v.length > 0)) return true;
    if (v && typeof v === "object" && hasKeyMatching(v, re, depth + 1)) return true;
  }
  return false;
}
var hasCommandLineArgs = (args, depth = 0) => hasKeyMatching(args, CMD_KEY_RE, depth);
var hasCodeExecutionArgs = (args, depth = 0) => hasKeyMatching(args, CODE_KEY_RE, depth);
function extractCommandString(args, depth = 0) {
  if (!args || typeof args !== "object" || depth > 5) return "";
  for (const [k, v] of Object.entries(args)) {
    if (SKIP_CMD_KEY_RE.test(k) || !EXTRACT_CMD_KEY_RE.test(k)) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length > 0) return v.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ").trim();
  }
  for (const [k, v] of Object.entries(args)) {
    if (!SKIP_CMD_KEY_RE.test(k) && v && typeof v === "object") {
      const n = extractCommandString(v, depth + 1);
      if (n) return n;
    }
  }
  return "";
}
function isShellTool(name, args = null) {
  if (!SHELL_TOOL_NAMES2.has(normalizeToolName(name))) return false;
  if (args && typeof args === "object") {
    const hasTarget = Boolean(args.TargetFile || args.targetFile || args.FilePath || args.filePath || args.path || args.dest_file || args.destination || args.file);
    if (hasTarget && !hasCommandLineArgs(args)) return false;
  }
  return true;
}
function hasMutatingPayloadDeep(args, depth = 0) {
  if (depth > 5) return true;
  if (!args || typeof args !== "object") return false;
  if (Array.isArray(args)) return args.some((i) => i && typeof i === "object" && hasMutatingPayloadDeep(i, depth + 1));
  for (const [k, v] of Object.entries(args)) {
    if (MUTATING_PAYLOAD_KEY_RE.test(k) && (typeof v === "string" && v.length > 0 || Array.isArray(v) && v.length > 0 || v && typeof v === "object")) return true;
    if (v && typeof v === "object" && hasMutatingPayloadDeep(v, depth + 1)) return true;
  }
  return false;
}
function classifyTool(name, args = null) {
  const n = normalizeToolName(name);
  if (!n) return "other";
  if (n === "callmcptool") {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "other";
    const inner = normalizeToolName(args.ToolName ?? args.toolName ?? args.tool_name ?? args.name ?? "");
    const qual = `${normalizeToolName(args.ServerName ?? args.serverName ?? args.server_name ?? args.server ?? "")}${inner}`;
    const ia = args.Arguments ?? args.arguments ?? args.parameters ?? args.tool_input ?? args.toolInput ?? args.input ?? args.params ?? null;
    if (!inner) return "other";
    if (MUTATING_TOOL_HINTS.some((h) => inner.includes(h))) return "mutating";
    const allowed = READONLY_MCP_INNER_TOOLS.has(inner) || READONLY_MCP_INNER_TOOLS.has(qual) || PURE_READS.has(inner);
    return allowed && !hasMutatingPayloadDeep(args) && !hasMutatingPayloadDeep(ia) && !hasCommandLineArgs(args) && !hasCodeExecutionArgs(args) && !hasCommandLineArgs(ia) && !hasCodeExecutionArgs(ia) ? "readonly" : "other";
  }
  if (MUTATING_TOOL_HINTS.some((h) => n.includes(h))) return "mutating";
  if (PURE_READS.has(n)) return args && typeof args === "object" && (hasMutatingPayloadDeep(args) || hasCommandLineArgs(args) || hasCodeExecutionArgs(args)) ? "other" : "readonly";
  return "other";
}
var caseSensitivityCache = /* @__PURE__ */ new Map();
function isCaseInsensitiveFs(root, fns) {
  const ex = fns?.existsSync ?? existsSync12;
  const rp = fns?.realpathSync ?? realpathSync4;
  if (!fns && caseSensitivityCache.has(root)) return caseSensitivityCache.get(root);
  let res = false;
  try {
    const target = ex(join15(root, ".adlc")) ? join15(root, ".adlc") : root;
    const leaf = basename5(target);
    const flipped = [...leaf].map((c) => c.toLowerCase() === c.toUpperCase() ? c : c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join("");
    if (flipped !== leaf) {
      const cand = join15(dirname10(target), flipped);
      res = ex(cand) && rp(cand) === rp(target);
    }
  } catch {
    res = false;
  }
  if (!fns) caseSensitivityCache.set(root, res);
  return res;
}
function tokenizeCommand2(cmd) {
  if (typeof cmd !== "string") return [];
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
var realpathOr2 = (p) => {
  try {
    return existsSync12(p) ? realpathSync4(p) : p;
  } catch {
    return p;
  }
};
var isAllowedSysExec = (p) => p === "/dev/null" || /^\/(bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)(\/|$)/.test(p);
var isTrustedNodeExec = (p) => {
  if (!p || !process.execPath) return false;
  if (p === process.execPath.replace(/\\/g, "/")) return true;
  try {
    return p === realpathSync4(process.execPath).replace(/\\/g, "/");
  } catch {
    return false;
  }
};
var unquote = (s) => (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) && s.length >= 2 ? s.slice(1, -1) : s;
function collectShellCandidateTokens(cmd) {
  const items = [];
  let expectingCmd = true;
  for (const raw of tokenizeCommand2(cmd)) {
    if (!raw || raw.length > 4096) continue;
    if (/^(;|&&|\|\||\|)$/.test(raw)) {
      expectingCmd = true;
      continue;
    }
    const outRedir = /^[0-9]*>+/.test(raw);
    if (!outRedir && expectingCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
      const rhs = raw.slice(raw.indexOf("=") + 1).trim();
      if (rhs) items.push({ rawToken: rhs, isOutRedirect: false, isCommandToken: false });
      continue;
    }
    const hadFlag = /^--?[a-zA-Z0-9_-]+=/.test(raw);
    const cleaned = unquote(raw.replace(/^[0-9]*[><]+/, "").replace(/^--?[a-zA-Z0-9_-]+=/, "").trim());
    if (!cleaned || cleaned.startsWith("-")) continue;
    const isCommandToken = expectingCmd && !outRedir && !hadFlag;
    if (isCommandToken) expectingCmd = false;
    items.push({ rawToken: cleaned, isOutRedirect: outRedir, isCommandToken });
  }
  for (const rm of cmd.match(/[0-9]*[><]+\s*([^<>&|;\s]+)/g) ?? []) {
    const target = unquote(rm.replace(/^[0-9]*[><]+\s*/, "").trim());
    if (target) items.push({ rawToken: target, isOutRedirect: rm.includes(">"), isCommandToken: false });
  }
  return items;
}
function isUnauthorizedWorkspaceEscape(cmd, { root = null, cwd = root } = {}) {
  if (!cmd || typeof cmd !== "string") return false;
  const norm = cmd.replace(/\\/g, "/");
  if (/(^|[\s=;,"'(])~(?=$|[\s/;"')])|(\$HOME\b|\$\{HOME\})/.test(norm)) return true;
  if (/\bfind\b/i.test(norm) && /(-exec|-execdir|-ok|-delete)\b/i.test(norm)) return true;
  if (/(^|[\s=;,"'/\\$.()[\]])\.\.(?=$|[\s=;,"'/\\$.()[\]])/.test(norm)) return true;
  const hasRoot = typeof root === "string" && root.trim().length > 0;
  const effCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : root;
  if (hasRoot && effCwd && !isPathInside(effCwd, root)) return true;
  const checkAbs = (c, isCmd = false) => !(isAllowedSysExec(c) || isCmd && isTrustedNodeExec(c)) && (hasRoot ? !isPathInside(c, root) : /^\/(home|Users|root|etc|proc|sys|dev|tmp|var|private|opt)(\/|$)/i.test(c));
  const allowedExec = /* @__PURE__ */ new Set();
  for (const { rawToken: t, isCommandToken } of collectShellCandidateTokens(cmd)) {
    if (t.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(t)) {
      const nt = t.replace(/\\/g, "/");
      if (isCommandToken && isTrustedNodeExec(nt)) allowedExec.add(nt);
      if (checkAbs(nt, isCommandToken)) return true;
    } else if (hasRoot && effCwd && (t.includes("/") || t.includes("\\")) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) && !isPathInside(resolve8(effCwd, t), root)) return true;
  }
  const re = /(?:^|[\s=;,"'`$(><])(\/[A-Za-z0-9_./~-]*)/g;
  let m;
  while ((m = re.exec(norm)) !== null) if (m[1] && !(allowedExec.has(m[1]) && m.index === 0) && checkAbs(m[1])) return true;
  return false;
}
function isTrustRootSecretAccess(cmd, overrideEscaped = null) {
  if (!cmd || typeof cmd !== "string") return false;
  const norm = cmd.replace(/\\/g, "/");
  if (overrideEscaped && (overrideEscaped.test(cmd) || overrideEscaped.test(norm))) return true;
  if (/(master[\w*?.-]*key|auth[\w*?.-]*key|session[\w*?.-]*secret|tickets?[\w*?.-]*json|session[\w*?.-]*ledger)/i.test(norm)) return true;
  if (/(^|[\s=;,"'/\\$.()[\]])\.(adlc|booster|master|auth|session|adlc-secrets)[\w*?.-]*/i.test(norm)) return true;
  const deobf = norm.replace(/[[\]{}()\\*?`"'$]/g, "");
  if (/(master-?key|auth-?key|session-?secret|tickets?\.json|session-?ledger|current-?ticket)/i.test(deobf)) return true;
  const re = /(^|[\s=;,"'/\\$.()[\]])(\.adlc|\.booster|\.master-key|\.auth-key|\.adlc-secrets|\.adlc-runtime-secrets|\.session-secret|\.store\.json|session-[a-f0-9]+\.secret|\/dev\/shm\/\.adlc|\.env\.local)/i;
  return re.test(norm) || re.test(deobf);
}
function hasShellTrustRootSecretAccess(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (!cmd || typeof cmd !== "string") return false;
  if (/\b(cat|head|tail|less|more|od|xxd|strings|source|\.)\s+.*[*?[\]{}]/i.test(cmd)) return true;
  const effCwd = cwd ?? root;
  const ro = isReadonlyCommand(cmd, { root, cwd: effCwd, env });
  const norm = cmd.replace(/\\/g, "/");
  if (!ro && /(^|[\s=;,"'/$.()[\]])(node_modules\/\.bin\/(node|mocha|jest|vitest|npm|npx|adlc)(\.exe|\.cmd|\.ps1)?|\.mocharc(\.(js|cjs|mjs|json|yaml|yml))?|jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|cjs|mjs|ts))(?=$|[\s=;,"'/$.()[\]])/i.test(norm)) {
    const items = collectShellCandidateTokens(cmd);
    if (!(items.length > 0 && !/[\r\n;&|<>$`()={}]/.test(cmd) && items.every((it) => it.isCommandToken || !/(node_modules\/\.bin\/|\.mocharc|jest\.config\.|vitest\.config\.)/i.test(it.rawToken.replace(/\\/g, "/"))))) return true;
  }
  for (const { rawToken: t, isOutRedirect, isCommandToken } of collectShellCandidateTokens(cmd)) {
    const abs = isAbsolute8(t) ? t : resolve8(effCwd, t);
    const lex = canonicalizePath(abs);
    let real = lex;
    try {
      if (existsSync12(abs) || lstatSync12(abs).isSymbolicLink()) real = realpathSync4(abs);
    } catch {
    }
    if (isSecretStatePath(abs, env) || isSecretStatePath(lex, env) || isSecretStatePath(real, env)) return true;
    if ((isOutRedirect || !isCommandToken && !ro) && (isTrustRootOrSecretPath(abs, env) || isTrustRootOrSecretPath(lex, env) || isTrustRootOrSecretPath(real, env))) return true;
    if (isCommandToken && (t.includes("/") || t.includes("\\")) && root && isPathInside(lex, root) && /(^|\/)(node|node\.exe)$/i.test(lex.replace(/\\/g, "/")) && !/\/node_modules\/\.bin\//i.test(lex.replace(/\\/g, "/"))) return true;
  }
  return false;
}
function hasShellSymlinkOrSecretEscape(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (!cmd || typeof cmd !== "string") return false;
  const effCwd = cwd ?? root;
  const simpleRead = !/[\r\n;&|<>$`()={}\\~]/.test(cmd) && /^\s*(cat|head|tail|ls|stat|file|wc)\b/.test(cmd);
  for (const { rawToken: t, isOutRedirect, isCommandToken } of collectShellCandidateTokens(cmd)) {
    const abs = isAbsolute8(t) ? t : resolve8(effCwd, t);
    try {
      const isSym = lstatSync12(abs).isSymbolicLink();
      if (isSym || existsSync12(abs)) {
        const can = realpathSync4(abs);
        if (isSecretStatePath(can, env)) return true;
        if ((isOutRedirect || !isCommandToken && !simpleRead) && isTrustRootOrSecretPath(can, env)) return true;
        if (isSym && !isAllowedSysExec(abs.replace(/\\/g, "/")) && root && !isPathInside(can, root)) return true;
      }
    } catch {
      try {
        if (lstatSync12(abs).isSymbolicLink()) return true;
      } catch {
      }
    }
  }
  return false;
}
function isReadonlyCommand(cmd, { root = process.cwd(), cwd = root, env = process.env } = {}) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const trimmed2 = cmd.trim();
  if (/[\r\n;&|<>$`()={}\\~]/.test(trimmed2) || isUnauthorizedWorkspaceEscape(trimmed2, { root, cwd }) || isTrustRootSecretAccess(trimmed2) || hasShellSymlinkOrSecretEscape(trimmed2, { root, cwd, env })) return false;
  const tokens = tokenizeCommand2(trimmed2);
  if (!tokens.length) return false;
  const bin = tokens[0];
  if (bin === "git") {
    if (tokens.length < 2) return false;
    let noPager = false;
    let sub = null;
    const args = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--no-pager") {
        noPager = true;
        continue;
      }
      if (/^(-c|-C|--exec-path|--work-tree|--git-dir|--config-env)$/i.test(t) || /^--(exec-path|work-tree|git-dir|config-env)=/i.test(t) || /(diff\.external|diff\.textconv|core\.pager|pager\.|alias\.|!)/i.test(t)) return false;
      if (!sub && !t.startsWith("-")) sub = t;
      else args.push(t);
    }
    if (!sub || !["status", "diff", "log", "rev-parse", "show", "branch"].includes(sub)) return false;
    if (args.some((t) => /^(-o|--output|--output-directory|--ext-diff|--textconv)$/i.test(t) || /^--(output|output-directory|ext-diff|textconv)=/i.test(t))) return false;
    if ((sub === "diff" || sub === "log" || sub === "show") && (!args.includes("--no-ext-diff") || !noPager)) return false;
    return !(sub === "branch" && args.some((t) => !t.startsWith("-") || /^(-[dDmMcfuU]|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|-u)$/i.test(t)));
  }
  if (!SAFE_BINS.has(bin)) return false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(-o|--output|--output-directory)$/i.test(t) || /^--output=/i.test(t) || isUnauthorizedWorkspaceEscape(t, { root }) || isTrustRootSecretAccess(t)) return false;
    if (!t.startsWith("-") && FILE_READER_BINS.has(bin)) {
      const res = isAbsolute8(t) ? t : resolve8(root, t);
      const rel = relative6(root, res);
      if (rel.startsWith("..") || isAbsolute8(rel) || isTrustRootSecretAccess(res)) return false;
      try {
        if (existsSync12(res) || lstatSync12(res).isSymbolicLink()) {
          const real = realpathSync4(res);
          const rr = relative6(root, real);
          if (rr.startsWith("..") || isAbsolute8(rr) || isTrustRootSecretAccess(real)) return false;
        }
      } catch {
        try {
          if (lstatSync12(res).isSymbolicLink()) return false;
        } catch {
        }
      }
    }
  }
  return true;
}
function isVerificationCommand(cmd, { root, workdirAnchorBase = null, toolArgs, allowImplicitCwd = true, packageManifestMutated = false, shellMutated = false } = {}) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const trimmed2 = cmd.trim();
  if (/[\r\n;&|<>$`~]/.test(trimmed2) || /(^|\s)\/dev\//i.test(trimmed2) || /(^|\s)--(\s+|$)/.test(trimmed2)) return false;
  if (/(^|\s)(--prefix|--cwd|-C|--if-present|--test-name-pattern|--test-skip-pattern|--test-only|--passWithNoTests|--test-shard|--test-reporter-destination|--output|--output-dir|--output-directory|--destination|-o|--grep|-g|--require|--import|--loader|--experimental-loader|-r|--test-global-setup|--test-global-teardown|--test-update-snapshots|--test-coverage|--experimental-test-coverage|--watch|--watch-mode|--run|-w|--workspace|--workspaces|--include-workspace-root)\b/i.test(trimmed2)) return false;
  if (/(--require=|--import=|--loader=|--experimental-loader=|--test-shard=|--test-name-pattern=|--test-skip-pattern=|--test-reporter-destination=|--output=|--destination=|--test-global-setup=|--test-global-teardown=|--test-coverage=|--experimental-test-coverage=|--workspace=)/i.test(trimmed2)) return false;
  const realRoot = root ? realpathOr2(resolve8(root)) : null;
  const wdBase = workdirAnchorBase ?? root ?? process.cwd();
  if (hasConflictingToolWorkdirs(toolArgs, wdBase)) return false;
  const cwd = extractToolWorkdir(toolArgs);
  if (typeof cwd === "string" && cwd) {
    if (!root || !realRoot || relative6(realRoot, realpathOr2(isAbsolute8(cwd) ? cwd : resolve8(wdBase, cwd))) !== "") return false;
  } else if (!allowImplicitCwd || !realRoot) return false;
  const tokens = tokenizeCommand2(trimmed2);
  if (realRoot) {
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      const tok = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
      if (tok.startsWith("~")) return false;
      if (i === 0 && isTrustedNodeExec(tok.replace(/\\/g, "/"))) continue;
      if (tok.startsWith("/") || tok.startsWith("\\") || tok.includes("/") || tok.includes("\\") || tok.includes("..")) {
        const rel = relative6(realRoot, realpathOr2(tok.startsWith("/") || tok.startsWith("\\") ? tok : resolve8(root, tok)));
        if (rel.startsWith("..") || isAbsolute8(rel)) return false;
      }
    }
  }
  if (/\s+(--help|--version|-v|-h)(\s+|$)/i.test(trimmed2) || /^(adlc|npx\s+(--no-install\s+)?adlc)\s+(ticket|doctor|status|help|version|list)/i.test(trimmed2)) return false;
  if (!packageManifestMutated && !shellMutated) {
    if (/^(npm\s+(test|run\s+(test|preflight))|((adlc|npx\s+--no-install\s+adlc)\s+(hollow-test|rails-guard|preflight))|npx\s+--no-install\s+(mocha|jest|vitest))\s*$/i.test(trimmed2)) return true;
  }
  const isNodeBin = tokens.length >= 2 && (/^node$/i.test(tokens[0]) || isTrustedNodeExec(tokens[0].replace(/\\/g, "/")));
  if (isNodeBin && tokens[1] === "--test" && (tokens.length === 2 || tokens.length === 3 && /^(test|tests|spec)\/?$/i.test(tokens[2]))) {
    return !(root && ["node", "node.exe", join15("node_modules", ".bin", "node"), join15("node_modules", ".bin", "node.exe")].some((p) => existsSync12(join15(root, p))));
  }
  return false;
}

// packages/hook-engine/lib/session-tracker.mjs
import { createHash as createHash4, createHmac as createHmac3, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync13, readFileSync as readFileSync10, writeFileSync as writeFileSync5, renameSync as renameSync3, mkdirSync as mkdirSync5, statSync as statSync2, rmSync as rmSync4, lstatSync as lstatSync13, unlinkSync as unlinkSync4, openSync as openSync7, readSync as readSync5, writeSync, closeSync as closeSync7, fstatSync as fstatSync4, readdirSync as readdirSync6, realpathSync as realpathSync5, constants as fsConstants5 } from "node:fs";
import { isAbsolute as isAbsolute9, join as join16, relative as relative7 } from "node:path";
var DEFAULT_DEPTH_THRESHOLD = 50;
var MAX_TRACKED_SESSIONS = 100;
var LOCK_TTL_MS = 5e3;
var TRUST_ROOT_PATHS = [".adlc/tickets.json", ".adlc/tickets/**", ".adlc/current-ticket.json", ".adlc/sessions.json", ".adlc/sessions.lock/**", ".adlc/session-ledger.jsonl", ".adlc/.session-secret", ".booster/**"];
var MANIFEST_PATH = ".adlc/manifest.jsonl";
var HIGH_RISK_CATEGORIES = /* @__PURE__ */ new Set(["contract", "architecture"]);
var MAX_TRANSCRIPT_HASH_BYTES = 16 * 1024 * 1024;
var HARD_MAX_LEDGER_BYTES = 2 * 1024 * 1024;
var MAX_LEDGER_RECORD_BYTES = 16 * 1024;
var ZERO_MAC = "0".repeat(64);
var loadedSecretCache = /* @__PURE__ */ new Map();
var inMemorySessionSnapshots = /* @__PURE__ */ new Map();
function ticketStoreExists(root, env = process.env) {
  if (!root || typeof root !== "string") return false;
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === "string" && ov.trim() && existsSync13(isAbsolute9(ov.trim()) ? ov.trim() : join16(root, ov.trim()))) return true;
  return existsSync13(join16(root, ".adlc", "tickets.json")) || existsSync13(join16(root, ".adlc", "tickets", ".store.json"));
}
var loadStoreSnapshot = (root, env = process.env) => detectTicketStore({ root, ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || void 0, allowRecovery: true, env }).load();
function sleepSyncWithJitter(baseMs = 5) {
  const ms = baseMs + Math.floor(Math.random() * 5);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
var isPidAlive = (pid) => {
  if (!pid || typeof pid !== "number") return false;
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return err.code !== "ESRCH";
  }
};
function computePrefixHash(filePath, targetBytes, maxBytes = MAX_TRANSCRIPT_HASH_BYTES) {
  if (typeof targetBytes !== "number" || targetBytes <= 0) return null;
  let rem = Math.min(targetBytes, maxBytes);
  let fd;
  try {
    fd = openSync7(filePath, fsConstants5.O_RDONLY | fsConstants5.O_NONBLOCK);
    const hash = createHash4("sha256");
    const buf = Buffer.allocUnsafe(Math.min(64 * 1024, rem));
    while (rem > 0) {
      const n = readSync5(fd, buf, 0, Math.min(buf.length, rem), null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      rem -= n;
    }
    return rem === 0 ? hash.digest("hex") : null;
  } catch {
    return null;
  } finally {
    if (fd !== void 0) try {
      closeSync7(fd);
    } catch {
    }
  }
}
function readTranscriptPrefixBounded(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync7(filePath, fsConstants5.O_RDONLY | fsConstants5.O_NONBLOCK);
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync5(fd, buf, 0, maxBytes, 0);
    return { prefixHash: createHash4("sha256").update(buf.subarray(0, n)).digest("hex"), prefixLength: n };
  } catch {
    return { prefixHash: null, prefixLength: 0 };
  } finally {
    if (fd !== void 0) try {
      closeSync7(fd);
    } catch {
    }
  }
}
function readTextFileBounded(filePath, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = openSync7(filePath, fsConstants5.O_RDONLY | fsConstants5.O_NONBLOCK);
    const buf = Buffer.allocUnsafe(maxBytes);
    return buf.toString("utf8", 0, readSync5(fd, buf, 0, maxBytes, 0));
  } catch {
    return null;
  } finally {
    if (fd !== void 0) try {
      closeSync7(fd);
    } catch {
    }
  }
}
var touchesAny = (globs, paths) => (globs ?? []).some((g) => paths.some((p) => g === p || globMatch2(g, p)));
function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const s = [];
  if (t.risk === "high") s.push("declared-risk-high");
  if (t.external === true) s.push("external-system-effect");
  if (t.mutatesIdentity === true) s.push("mutates-identity");
  if (t.scope !== void 0 && !Array.isArray(t.scope)) s.push("malformed-scope");
  if (t.rails !== void 0 && !Array.isArray(t.rails)) s.push("malformed-rails");
  const all = [...Array.isArray(t.scope) ? t.scope : [], ...Array.isArray(t.rails) ? t.rails : []];
  if (touchesAny(all, [MANIFEST_PATH])) s.push("mutates-manifest");
  if (touchesAny(all, TRUST_ROOT_PATHS)) s.push("touches-trust-root", "touches-trust-roots");
  if (t.category && HIGH_RISK_CATEGORIES.has(t.category)) s.push(`high-risk-category:${t.category}`);
  return s;
}
function computeRiskTier(ticket) {
  if (!ticket || typeof ticket !== "object") return { tier: "normal", signals: [] };
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? "high" : "normal", signals };
}
function createDepthTracker() {
  const c = /* @__PURE__ */ new Map();
  const comp = /* @__PURE__ */ new Set();
  return { recordToolCall: (s) => s && c.set(s, (c.get(s) ?? 0) + 1), markCompacted: (s) => s && comp.add(s), depth: (s) => c.get(s) ?? 0, isCompacted: (s) => comp.has(s), isLockFailed: () => false };
}
function sanitizeSessionId(id) {
  if (typeof id !== "string") return "default_session";
  const t = id.trim();
  return !t || t.length > 120 || !/^[a-zA-Z0-9_\-.]+$/.test(t) || ["__proto__", "constructor", "prototype", "toString", "valueOf"].includes(t) ? "default_session" : t;
}
function resolveSessionId({ payload, env = process.env } = {}) {
  const c = payload?.conversationId ?? payload?.conversation_id ?? payload?.conversationID ?? payload?.sessionID ?? payload?.sessionId ?? payload?.params?.conversationId ?? payload?.params?.conversation_id ?? env?.GEMINI_CONVERSATION_ID ?? env?.JETSKI_CONVERSATION_ID ?? env?.ANTIGRAVITY_CONVERSATION_ID ?? env?.CONVERSATION_ID ?? env?.ADLC_SESSION_ID;
  return typeof c === "string" && c.trim() ? sanitizeSessionId(c) : "default_session";
}
function readValidKeyFile(p, uid) {
  if (!existsSync13(p)) return null;
  const st = lstatSync13(p);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 || uid !== null && st.uid !== uid || (st.mode & 63) !== 0) return null;
  const raw = readFileSync10(p, "utf8").trim();
  return raw.length >= 32 ? raw : null;
}
function getMasterKeyRaw(env = process.env) {
  const h = resolveUserHome(env);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    return readValidKeyFile(join16(h, ".config", "adlc", "secrets", ".auth-key"), uid) ?? readValidKeyFile(join16(h, ".adlc", ".master-key"), uid);
  } catch {
    return null;
  }
}
function rotateMasterKey(env = process.env) {
  const h = resolveUserHome(env);
  const dir = join16(h, ".config", "adlc", "secrets");
  const file = join16(dir, ".auth-key");
  try {
    const l = join16(h, ".adlc", ".master-key");
    if (existsSync13(l)) unlinkSync4(l);
  } catch {
  }
  loadedSecretCache.clear();
  try {
    if (!existsSync13(dir)) mkdirSync5(dir, { recursive: true, mode: 448 });
    const nk = randomBytes2(32).toString("hex");
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync5(tmp, nk, { mode: 384 });
    renameSync3(tmp, file);
    return nk;
  } catch {
    return null;
  }
}
function getOrCreateSessionSecret(root, env = process.env) {
  const h = resolveUserHome(env);
  const key = `${h}:${root}`;
  if (loadedSecretCache.has(key)) return loadedSecretCache.get(key);
  let mk = getMasterKeyRaw(env);
  if (!mk) {
    const dir = join16(h, ".config", "adlc", "secrets");
    const file = join16(dir, ".auth-key");
    try {
      if (!existsSync13(dir)) mkdirSync5(dir, { recursive: true, mode: 448 });
      const nk = randomBytes2(32).toString("hex");
      writeFileSync5(file, nk, { mode: 384, flag: "wx" });
      mk = nk;
    } catch (err) {
      if (err.code === "EEXIST") mk = getMasterKeyRaw(env);
    }
  }
  if (!mk) return null;
  const derived = createHmac3("sha256", mk).update(`adlc-session-secret:${root}`).digest("hex");
  loadedSecretCache.set(key, derived);
  return derived;
}
function isNodeTestFile(fileName, relPath) {
  if (!fileName || typeof fileName !== "string" || !/\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName)) return false;
  if (relPath.replace(/\\/g, "/").split("/").some((p) => /^(tests?|specs?|__tests?__|__specs?__)$/i.test(p))) return true;
  return /\.(test|spec)\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName) || /^test-.*|.*[-_]test\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName) || /^test\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/i.test(fileName);
}
function getTestFilesMap(root) {
  const map = {};
  if (!root || typeof root !== "string") return map;
  let realRoot = root;
  try {
    realRoot = realpathSync5(root);
  } catch {
  }
  const IGNORED = /* @__PURE__ */ new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".adlc", "coverage", ".cache"]);
  function scan(dir, depth = 0, anc = /* @__PURE__ */ new Set()) {
    if (depth > 32) return;
    let real;
    try {
      real = realpathSync5(dir);
      const r = relative7(realRoot, real);
      if (r.startsWith("..") || isAbsolute9(r) || anc.has(real)) return;
    } catch {
      return;
    }
    const next = new Set(anc);
    next.add(real);
    let entries;
    try {
      entries = readdirSync6(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = join16(dir, e.name);
      try {
        if (lstatSync13(fp).isSymbolicLink()) {
          const r = relative7(realRoot, realpathSync5(fp));
          if (r.startsWith("..") || isAbsolute9(r)) continue;
        }
        const st = statSync2(fp);
        if (st.isDirectory()) {
          if (!IGNORED.has(e.name)) scan(fp, depth + 1, next);
        } else if (st.isFile()) {
          const rp = relative7(root, fp).replace(/\\/g, "/");
          if (isNodeTestFile(e.name, rp)) map[rp] = createHash4("sha256").update(readFileSync10(fp)).digest("hex");
        }
      } catch {
      }
    }
  }
  scan(root);
  return map;
}
function hasDiscoverableTests(root, filterDir = null) {
  const keys = Object.keys(getTestFilesMap(root));
  if (!filterDir) return keys.length > 0;
  const rel = relative7(root, filterDir).replace(/\\/g, "/");
  return keys.some((k) => k === rel || k.startsWith(rel + "/"));
}
function verifyPreExistingTestFiles(root, initialTestFiles, ticket = null) {
  if (!initialTestFiles || typeof initialTestFiles !== "object" || !Object.keys(initialTestFiles).length) return { ok: true, reason: null, file: null };
  const current = getTestFilesMap(root);
  const scope = Array.isArray(ticket?.scope) ? ticket.scope.filter((s) => typeof s === "string" && s.trim()) : [];
  const rails = [...Array.isArray(ticket?.rails) ? ticket.rails.filter((r) => typeof r === "string" && r.trim()) : [], ...TRUST_ROOT_RAILS];
  const matches = (list, p) => list.some((g) => g === p || globMatch2(g, p));
  for (const [relPath, origHash] of Object.entries(initialTestFiles)) {
    const inRail = matches(rails, relPath);
    const inScope = scope.length > 0 && matches(scope, relPath);
    if (!current[relPath]) return { ok: false, file: relPath, reason: `ADLC Rails-Guard: Pre-existing test file "${relPath}" was deleted or renamed.` };
    if (current[relPath] !== origHash && !(inScope && !inRail)) {
      return { ok: false, file: relPath, reason: `ADLC Rails-Guard: Pre-existing test file "${relPath}" was modified during session${inRail ? " (protected by frozen rails)" : " (outside active ticket scope)"}, weakening the verification suite.` };
    }
  }
  return { ok: true, reason: null, file: null };
}
var lockStat = (d) => {
  try {
    const st = lstatSync13(d);
    return { ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
};
var readOwnerRaw = (d) => {
  try {
    return readFileSync10(join16(d, "owner.json"), "utf8");
  } catch {
    return null;
  }
};
function judgeStaleLock(lockDir, now = Date.now()) {
  const stat = lockStat(lockDir);
  if (stat === null) return null;
  const ownerRaw = readOwnerRaw(lockDir);
  let owner = null;
  try {
    owner = ownerRaw === null ? null : JSON.parse(ownerRaw);
  } catch {
    owner = null;
  }
  return (owner && typeof owner === "object" ? now - (owner.time ?? 0) > LOCK_TTL_MS && !isPidAlive(owner.pid) : now - stat.mtimeMs > LOCK_TTL_MS) ? { ownerRaw, stat } : null;
}
function reclaimJudgedLock(lockDir, judged) {
  const claimed = `${lockDir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync3(lockDir, claimed);
  } catch {
    return false;
  }
  const ownerRaw = readOwnerRaw(claimed);
  const now = ownerRaw === null ? lockStat(claimed) : null;
  if (!(ownerRaw === judged.ownerRaw && (ownerRaw !== null || Boolean(now && judged.stat && now.ino === judged.stat.ino && now.mtimeMs === judged.stat.mtimeMs)))) {
    try {
      renameSync3(claimed, lockDir);
    } catch {
    }
    return false;
  }
  try {
    rmSync4(claimed, { recursive: true, force: true });
  } catch {
  }
  return true;
}
function computeBaselineSig(sessionID, s, root, env) {
  const k = getOrCreateSessionSecret(root, env);
  if (!k) return null;
  return createHmac3("sha256", k).update(JSON.stringify({ sessionID, t: s?.initialActiveTicket ?? null, h: s?.initialStoreHash ?? null, p: s?.initialPointer ?? null, tr: s?.initialTranscript ?? null, tf: s?.initialTestFiles ?? null, depth: s?.depth ?? 0, totalCalls: s?.totalCalls ?? 0, mutatingCalls: s?.mutatingCalls ?? 0, compacted: Boolean(s?.compacted), ended: Boolean(s?.ended), inv: Boolean(s?.invalidated), edits: Array.isArray(s?.edits) ? s.edits : [], warned: Array.isArray(s?.warned) ? s.warned : [], flailStatus: s?.flailStatus ? { verdict: s.flailStatus.verdict ?? "", summary: s.flailStatus.summary ?? "" } : null, lastTranscriptSize: s?.lastTranscriptSize ?? null, lastTranscriptHash: s?.lastTranscriptHash ?? null, lastExitCode: typeof s?.lastExitCode === "number" ? s.lastExitCode : null, ledgerSeq: s?.ledgerSeq ?? 0, ledgerMac: s?.ledgerMac ?? null })).digest("hex");
}
function openVerifiedRegular(filePath, maxBytes) {
  const ls = lstatSync13(filePath);
  if (ls.isSymbolicLink() || !ls.isFile() || ls.size > maxBytes) return null;
  const fd = openSync7(filePath, fsConstants5.O_RDONLY | fsConstants5.O_NONBLOCK | (fsConstants5.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync4(fd);
    if (!st.isFile() || st.ino !== ls.ino || st.dev !== ls.dev || st.size > maxBytes) {
      closeSync7(fd);
      return null;
    }
    return { fd, size: st.size };
  } catch {
    try {
      closeSync7(fd);
    } catch {
    }
    return null;
  }
}
function createPersistentTracker(root = process.cwd(), env = process.env) {
  const adlcDir = join16(root, ".adlc");
  const storePath = join16(adlcDir, "sessions.json");
  const ledgerPath = join16(adlcDir, "session-ledger.jsonl");
  const lockDir = join16(adlcDir, "sessions.lock");
  const ownerFile = join16(lockDir, "owner.json");
  const lockFailures = /* @__PURE__ */ new Set();
  const snapKey = (sid) => `${root}:${sid}`;
  const corruptStore = () => Object.assign(/* @__PURE__ */ Object.create(null), { _corrupted: true });
  const macOf = (prev, seq, data) => createHmac3("sha256", getOrCreateSessionSecret(root, env)).update(`${prev}:${seq}:${JSON.stringify(data)}`).digest("hex");
  function withLock(sid, fn, fallback) {
    if (!ticketStoreExists(root, env)) return fn();
    try {
      mkdirSync5(adlcDir, { recursive: true });
    } catch {
    }
    const nonce = `${process.pid}-${Date.now()}-${Math.random()}`;
    let acq = false;
    for (let i = 0; i < 250; i++) {
      try {
        mkdirSync5(lockDir);
        const tmp = `${lockDir}/owner.json.tmp.${process.pid}.${Date.now()}`;
        writeFileSync5(tmp, JSON.stringify({ pid: process.pid, nonce, time: Date.now() }));
        renameSync3(tmp, ownerFile);
        acq = true;
        break;
      } catch (err) {
        if (err.code === "EEXIST") {
          const j = judgeStaleLock(lockDir);
          if (j) reclaimJudgedLock(lockDir, j);
        }
      }
      sleepSyncWithJitter(25);
    }
    if (!acq) {
      if (sid) lockFailures.add(sid);
      return fallback;
    }
    try {
      return fn();
    } finally {
      try {
        if (existsSync13(ownerFile) && JSON.parse(readFileSync10(ownerFile, "utf8")).nonce === nonce) {
          const t = `${lockDir}.rel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          renameSync3(lockDir, t);
          rmSync4(t, { recursive: true, force: true });
        }
      } catch {
      }
    }
  }
  function replayLedger() {
    if (!existsSync13(ledgerPath)) return null;
    let op;
    try {
      op = openVerifiedRegular(ledgerPath, HARD_MAX_LEDGER_BYTES);
      if (!op) return corruptStore();
      if (!op.size) return null;
      const buf = Buffer.alloc(op.size);
      readSync5(op.fd, buf, 0, op.size, 0);
      const store = /* @__PURE__ */ Object.create(null);
      let seq = 1;
      let prev = ZERO_MAC;
      for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
        const p = JSON.parse(line);
        if (!p || typeof p !== "object" || Array.isArray(p) || p.seq !== seq || p.prevMac !== prev || p.mac !== macOf(p.prevMac, p.seq, p.payload) || !p.payload || typeof p.payload !== "object") return corruptStore();
        prev = p.mac;
        seq = p.seq + 1;
        const ev = p.payload;
        const sk = sanitizeSessionId(ev.sessionID);
        const s = store[sk] ?? { depth: 0, totalCalls: 0, mutatingCalls: 0, compacted: false, edits: [], warned: [] };
        if (ev.type === "snapshot") Object.assign(s, ev);
        else if (ev.type === "recordActiveTicket" || ev.type === "activeTicket") {
          if (!s.initialActiveTicket && (ev.activeTicketId || ev.ticketId)) {
            s.initialActiveTicket = ev.activeTicketId || ev.ticketId;
            s.initialStoreHash = ev.storeHash ?? null;
            if (ev.initialPointer) s.initialPointer = ev.initialPointer;
            if (ev.initialTestFiles) s.initialTestFiles = ev.initialTestFiles;
          }
        } else if (ev.type === "recordToolCall" || ev.type === "toolCall") {
          s.depth++;
          s.totalCalls++;
          if (ev.isMutating) s.mutatingCalls++;
        } else if (ev.type === "revertToolCall") {
          if (s.depth > 0) s.depth--;
          if (s.totalCalls > 0) s.totalCalls--;
          if (ev.isMutating && s.mutatingCalls > 0) s.mutatingCalls--;
        } else if (ev.type === "recordEdit" || ev.type === "edit") {
          if (ev.filePath) s.edits = [...s.edits, `Editing ${String(ev.filePath).slice(0, 512)}`].slice(-200);
        } else if (ev.type === "compact") s.compacted = true;
        else if (ev.type === "ended") s.ended = true;
        else if (ev.type === "invalidated") s.invalidated = true;
        else if (ev.type === "recordTranscript" || ev.type === "recordToolResult" || ev.type === "toolResult") {
          if (!s.initialTranscript && ev.initialTranscript) s.initialTranscript = ev.initialTranscript;
          if (ev.lastTranscriptHash) s.lastTranscriptHash = ev.lastTranscriptHash;
          if (ev.lastTranscriptSize) s.lastTranscriptSize = ev.lastTranscriptSize;
          if (typeof ev.exitCode === "number") s.lastExitCode = ev.exitCode;
        }
        s.updatedAt = ev.t ?? Date.now();
        s.ledgerSeq = p.seq;
        s.ledgerMac = p.mac;
        s.baselineSig = computeBaselineSig(sk, s, root, env);
        store[sk] = s;
      }
      return store;
    } catch {
      return corruptStore();
    } finally {
      if (op) try {
        closeSync7(op.fd);
      } catch {
      }
    }
  }
  function appendLedger(entry) {
    if (!ticketStoreExists(root, env)) return null;
    try {
      if (!existsSync13(adlcDir)) mkdirSync5(adlcDir, { recursive: true });
      let lastSeq = 0;
      let lastMac = ZERO_MAC;
      if (existsSync13(ledgerPath)) {
        const op = openVerifiedRegular(ledgerPath, HARD_MAX_LEDGER_BYTES);
        if (!op) {
          try {
            const ls = lstatSync13(ledgerPath);
            if (!ls.isSymbolicLink() && ls.isFile() && ls.size > HARD_MAX_LEDGER_BYTES) writeFileSync5(join16(adlcDir, ".ledger-quarantine"), JSON.stringify({ quarantinedAt: Date.now(), reason: "oversized_corrupt_ledger" }), { mode: 384 });
          } catch {
          }
          return null;
        }
        try {
          if (op.size > 0) {
            const rs = Math.min(op.size, 64 * 1024);
            const buf = Buffer.alloc(rs);
            readSync5(op.fd, buf, 0, rs, op.size - rs);
            const lines = buf.toString("utf8").split("\n").filter(Boolean);
            const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
            if (last && typeof last.seq === "number" && typeof last.mac === "string") {
              lastSeq = last.seq;
              lastMac = last.mac;
            }
          }
        } finally {
          try {
            closeSync7(op.fd);
          } catch {
          }
        }
      }
      const seq = lastSeq + 1;
      const payload = { t: Date.now(), ...entry };
      const mac = macOf(lastMac, seq, payload);
      const record = JSON.stringify({ seq, prevMac: lastMac, mac, payload }) + "\n";
      if (Buffer.byteLength(record, "utf8") > MAX_LEDGER_RECORD_BYTES) return null;
      const fd = openSync7(ledgerPath, fsConstants5.O_WRONLY | fsConstants5.O_APPEND | fsConstants5.O_CREAT | (fsConstants5.O_NOFOLLOW ?? 0), 384);
      try {
        writeSync(fd, record);
      } finally {
        try {
          closeSync7(fd);
        } catch {
        }
      }
      return { seq, mac };
    } catch {
      return null;
    }
  }
  function readStore() {
    if (!existsSync13(storePath)) {
      const f = replayLedger();
      return f && Object.keys(f).length ? f : /* @__PURE__ */ Object.create(null);
    }
    let op;
    try {
      op = openVerifiedRegular(storePath, 1024 * 1024);
      if (!op) return corruptStore();
      const buf = Buffer.alloc(op.size);
      readSync5(op.fd, buf, 0, op.size, 0);
      const parsed = JSON.parse(buf.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed._corrupted) return corruptStore();
      const store = /* @__PURE__ */ Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        const sk = sanitizeSessionId(k);
        if (k === "default_session" || sk && sk !== "default_session") store[k === "default_session" ? "default_session" : sk] = v;
      }
      if (store.default_session?.updatedAt && Date.now() - store.default_session.updatedAt > 36e5) delete store.default_session;
      return store;
    } catch {
      return corruptStore();
    } finally {
      if (op) try {
        closeSync7(op.fd);
      } catch {
      }
    }
  }
  function writeStore(data, curSid) {
    if (!ticketStoreExists(root, env)) return;
    try {
      if (!existsSync13(adlcDir)) mkdirSync5(adlcDir, { recursive: true });
      const keys = Object.keys(data).filter((k) => k !== "_corrupted");
      for (const k of keys) if (data[k] && typeof data[k] === "object") data[k].baselineSig = computeBaselineSig(k, data[k], root, env);
      if (keys.length > MAX_TRACKED_SESSIONS) {
        const sorted = keys.filter((k) => k !== curSid).sort((a, b) => Boolean(data[a]?.ended) === Boolean(data[b]?.ended) ? (data[a]?.updatedAt ?? 0) - (data[b]?.updatedAt ?? 0) : data[a]?.ended ? -1 : 1);
        for (const k of sorted.slice(0, keys.length - MAX_TRACKED_SESSIONS)) delete data[k];
      }
      if (existsSync13(storePath) && lstatSync13(storePath).isSymbolicLink()) return;
      const tmp = `${storePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync5(tmp, JSON.stringify(data, null, 2));
      renameSync3(tmp, storePath);
    } catch {
    }
  }
  function mutate(sid, fn, fallback) {
    if (!sid || !ticketStoreExists(root, env)) return fallback;
    return withLock(sid, () => {
      const store = readStore();
      if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === "1") return fallback;
      const s = store[sid] ?? { depth: 0, totalCalls: 0, mutatingCalls: 0, compacted: false, edits: [], warned: [] };
      const res = fn(s, store);
      if (res?.skip) return res.value;
      const lH = res?.ledger ? appendLedger({ sessionID: sid, ...res.ledger }) : null;
      if (lH) {
        s.ledgerSeq = lH.seq;
        s.ledgerMac = lH.mac;
      }
      s.updatedAt = Date.now();
      s.baselineSig = computeBaselineSig(sid, s, root, env);
      store[sid] = s;
      inMemorySessionSnapshots.set(snapKey(sid), { ...s });
      writeStore(store, sid);
      return res?.value;
    }, fallback);
  }
  const get = (sid, field, def = null) => sid ? readStore()[sid]?.[field] ?? inMemorySessionSnapshots.get(snapKey(sid))?.[field] ?? def : def;
  return {
    rawStore: readStore,
    recordToolCall: (sid, { isMutating = true } = {}) => mutate(sid, (s) => {
      const sn = inMemorySessionSnapshots.get(snapKey(sid));
      if (sn) {
        s.depth = Math.max(s.depth ?? 0, sn.depth ?? 0);
        s.totalCalls = Math.max(s.totalCalls ?? 0, sn.totalCalls ?? 0);
        s.mutatingCalls = Math.max(s.mutatingCalls ?? 0, sn.mutatingCalls ?? 0);
      }
      s.depth++;
      s.totalCalls++;
      if (isMutating) s.mutatingCalls++;
      return { ledger: { type: "recordToolCall", isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls } };
    }),
    revertToolCall: (sid, { isMutating = true } = {}) => mutate(sid, (s, st) => !st[sid] ? { skip: true } : (s.depth > 0 && s.depth--, s.totalCalls > 0 && s.totalCalls--, isMutating && s.mutatingCalls > 0 && s.mutatingCalls--, { ledger: { type: "revertToolCall", isMutating, depth: s.depth, totalCalls: s.totalCalls, mutatingCalls: s.mutatingCalls } })),
    recordActiveTicket: (sid, activeTicketId, storeHash2) => mutate(sid, (s) => {
      let ptr = null;
      if (!s.initialActiveTicket && activeTicketId) {
        s.initialActiveTicket = activeTicketId;
        s.initialStoreHash = storeHash2 ?? null;
        s.initialTestFiles = getTestFilesMap(root);
        const cf = join16(root, ".adlc", "current-ticket.json");
        if (existsSync13(cf)) try {
          const st = lstatSync13(cf);
          ptr = { exists: true, ino: st.ino, dev: st.dev, size: st.size };
          s.initialPointer = ptr;
        } catch {
        }
      }
      return { ledger: { type: "recordActiveTicket", activeTicketId, storeHash: storeHash2, initialPointer: ptr, initialTestFiles: s.initialTestFiles } };
    }),
    recordTranscript(sid, tp) {
      if (!tp) return;
      try {
        const st = lstatSync13(tp);
        mutate(sid, (s) => {
          const h = computePrefixHash(tp, st.size);
          if (!s.initialTranscript) s.initialTranscript = { path: tp.slice(0, 512), ino: st.ino, dev: st.dev, hash: h, size: st.size };
          if (h) s.lastTranscriptHash = h;
          s.lastTranscriptSize = st.size;
          return { ledger: { type: "recordTranscript", initialTranscript: s.initialTranscript, lastTranscriptHash: s.lastTranscriptHash, lastTranscriptSize: s.lastTranscriptSize } };
        });
      } catch {
      }
    },
    recordToolResult(sid, { exitCode, transcriptPath } = {}) {
      let st = null;
      if (transcriptPath) try {
        st = lstatSync13(transcriptPath);
      } catch {
      }
      mutate(sid, (s) => {
        if (st && st.size > 0) {
          const h = computePrefixHash(transcriptPath, st.size);
          if (h) s.lastTranscriptHash = h;
          s.lastTranscriptSize = st.size;
        }
        if (typeof exitCode === "number") s.lastExitCode = exitCode;
        return { ledger: { type: "recordToolResult", exitCode: typeof exitCode === "number" ? exitCode : null, lastTranscriptHash: s.lastTranscriptHash ?? null, lastTranscriptSize: s.lastTranscriptSize ?? null } };
      });
    },
    markCompacted: (sid) => mutate(sid, (s) => {
      s.compacted = true;
      return { ledger: { type: "compact" } };
    }),
    markSessionEnded: (sid) => mutate(sid, (s, st) => !st[sid] ? { skip: true } : (s.ended = true, { ledger: { type: "ended" } })),
    invalidateSession: (sid) => mutate(sid, (s) => {
      s.invalidated = true;
      return { ledger: { type: "invalidated", reason: "secret_disclosure" } };
    }),
    recordEdit: (sid, fp, { transcriptSteps = [], transcriptLines = [] } = {}) => mutate(sid, (s) => {
      s.edits = s.edits ?? [];
      s.warned = s.warned ?? [];
      const bp = typeof fp === "string" ? fp.slice(0, 512) : null;
      if (bp) s.edits = [...s.edits, `Editing ${bp}`].slice(-200);
      const a = analyzeFlail({ edits: s.edits, transcriptSteps, transcriptLines });
      const hk = `${a.verdict}:${a.summary}`;
      const isNew = a.verdict === "flail" && !s.warned.includes(hk);
      if (isNew) s.warned.push(hk);
      s.flailStatus = { verdict: a.verdict, summary: a.summary, updatedAt: Date.now() };
      const ch = detectEditChurn(s.edits, 3).filter((c) => !s.warned.includes(c.path));
      for (const c of ch) s.warned.push(c.path);
      return { ledger: { type: "recordEdit", filePath: bp }, value: { churning: ch, verdict: a.verdict, signals: a.signals, summary: a.summary, recommendation: a.recommendation, isNewSignal: isNew } };
    }, { churning: [], repeatedErrors: [], verdict: "clean", summary: "" }),
    totalCalls: (sid) => get(sid, "totalCalls", 0),
    mutatingCalls: (sid) => sid ? readStore()[sid]?.mutatingCalls ?? readStore()[sid]?.depth ?? inMemorySessionSnapshots.get(snapKey(sid))?.mutatingCalls ?? 0 : 0,
    depth: (sid) => sid ? readStore()[sid]?.depth ?? 0 : 0,
    edits: (sid) => sid ? readStore()[sid]?.edits ?? [] : [],
    isCompacted: (sid) => Boolean(sid && readStore()[sid]?.compacted),
    isLockFailed: (sid) => Boolean(sid && lockFailures.has(sid)),
    initialTicket: (sid) => get(sid, "initialActiveTicket", null),
    initialStoreHash: (sid) => get(sid, "initialStoreHash", null),
    initialPointer: (sid) => sid ? readStore()[sid]?.initialPointer ?? null : null,
    initialTestFiles: (sid) => get(sid, "initialTestFiles", null),
    initialTranscript: (sid) => sid ? readStore()[sid]?.initialTranscript ?? null : null,
    lastTranscript: (sid) => {
      const s = sid ? readStore()[sid] : null;
      return s ? { initial: s.initialTranscript ?? null, lastHash: s.lastTranscriptHash ?? null, lastSize: s.lastTranscriptSize ?? null } : null;
    },
    hasSnapshot: (sid) => Boolean(sid && inMemorySessionSnapshots.has(snapKey(sid))),
    isCorrupted: () => existsSync13(join16(adlcDir, ".ledger-quarantine")) || Boolean(readStore()._corrupted),
    isInvalidated: (sid) => Boolean(sid && (existsSync13(join16(adlcDir, ".ledger-quarantine")) || readStore()[sid]?.invalidated || inMemorySessionSnapshots.get(snapKey(sid))?.invalidated || replayLedger()?.[sid]?.invalidated)),
    validateBaseline(sid) {
      if (!sid) return true;
      const store = readStore();
      if (store._corrupted && env?.ADLC_P4_ENFORCEMENT === "1") return false;
      const sn = inMemorySessionSnapshots.get(snapKey(sid));
      const s = store[sid];
      if (sn && (!s || !existsSync13(storePath) || s.invalidated || sn.invalidated || (s.depth ?? 0) < (sn.depth ?? 0) || (s.mutatingCalls ?? 0) < (sn.mutatingCalls ?? 0) || (s.totalCalls ?? 0) < (sn.totalCalls ?? 0) || sn.compacted && !s.compacted)) return false;
      if (!s) {
        const l = replayLedger()?.[sid];
        return !(l && ((l.mutatingCalls ?? 0) > 0 || (l.totalCalls ?? 0) > 0));
      }
      if (s.invalidated) return false;
      if (!s.baselineSig) return !((s.totalCalls ?? 0) > 0 || (s.depth ?? 0) > 0 || s.initialActiveTicket) && env?.ADLC_P4_ENFORCEMENT !== "1";
      return s.baselineSig === computeBaselineSig(sid, s, root, env);
    },
    validateLedger(sid) {
      if (!ticketStoreExists(root, env)) return true;
      if (!existsSync13(ledgerPath)) {
        if (!existsSync13(storePath)) return true;
        const st = readStore();
        const e = sid ? st[sid] : null;
        return !st._corrupted && !(e && (e.ledgerSeq > 0 || e.depth > 0 || e.totalCalls > 0));
      }
      const rep = replayLedger();
      if (!rep || rep._corrupted) return false;
      if (sid) {
        const st = readStore();
        if (st._corrupted) return false;
        const e = st[sid];
        const r = rep[sid];
        if (e && r && ((r.ledgerSeq ?? 0) !== (e.ledgerSeq ?? 0) || (r.depth ?? 0) !== (e.depth ?? 0) || (r.totalCalls ?? 0) !== (e.totalCalls ?? 0) || (r.mutatingCalls ?? 0) !== (e.mutatingCalls ?? 0) || (r.initialActiveTicket ?? null) !== (e.initialActiveTicket ?? null) || (r.initialStoreHash ?? null) !== (e.initialStoreHash ?? null) || r.invalidated || e.invalidated)) return false;
      }
      return true;
    }
  };
}
function checkFlail({ sessionID, tracker, env = process.env }) {
  if (!sessionID || sessionID === "default_session") return { verdict: "clean", signals: [], summary: "", recommendation: "Session clean" };
  const tp = resolveTranscriptPath({ conversationId: sessionID, env });
  return analyzeFlail({ edits: tracker?.edits?.(sessionID) ?? [], transcriptSteps: tp ? parseTranscriptSteps(tp) : [] });
}
function decideBuildGate({ riskTier, degraded, bypass, sessionID } = {}) {
  if (riskTier !== "high") return { decision: "allow", reason: `ticket risk tier is '${riskTier ?? "normal"}' \u2014 gate only guards high-risk tickets` };
  if (!degraded) return { decision: "allow", reason: "high-risk ticket, but context-fitness is not degraded" };
  if (bypass) return { decision: "allow", reason: "high-risk build in a degraded session, but ADLC_BUILD_GATE_BYPASS=1 was set", overridden: true };
  return { decision: "deny", reason: sessionID === "default_session" ? "high-risk ticket build denied: context depth threshold exceeded (default_session)." : "high-risk ticket build denied: context depth threshold exceeded in this session. Resume in a fresh session." };
}
function checkBuildGate({ sessionID, tracker, root = process.cwd(), env = process.env }) {
  if (env.ADLC_P4_ENFORCEMENT !== "1") return { decision: "allow", reason: "enforcement inactive" };
  if (tracker?.isCorrupted?.()) return { decision: "deny", reason: "Session tracking store is corrupted or unreadable under enforcement (fail closed)." };
  if (!ticketStoreExists(root, env)) return { decision: "allow", reason: "repo not ADLC-initialized" };
  const active = resolveActiveTicketId2(root, env);
  if (active.conflict) return { decision: "deny", reason: active.message ?? "ticket pointer conflict between ADLC_TICKET env and .adlc/current-ticket.json" };
  if (!active.id) return { decision: "allow", reason: "no unambiguous active ticket" };
  let ticket = null;
  try {
    ticket = loadStoreSnapshot(root, env).get(active.id);
  } catch (err) {
    return { decision: "deny", reason: `corrupt or unparseable ticket store: ${err?.message ?? err}` };
  }
  if (!ticket) return { decision: "deny", reason: `active ticket ${active.id} not found in tickets.json` };
  if (tracker?.validateBaseline && !tracker.validateBaseline(sessionID)) return { decision: "deny", reason: "Session baseline signature mismatch (tampering detected)." };
  if (tracker?.validateLedger && !tracker.validateLedger(sessionID)) return { decision: "deny", reason: "Session ledger integrity verification failed (tampering or truncation detected)." };
  const { tier } = computeRiskTier(ticket);
  const depth = tracker?.depth?.(sessionID) ?? 0;
  if (sessionID && sessionID !== "default_session" && depth === 0) {
    const tp = resolveTranscriptPath({ conversationId: sessionID, env }) || (existsSync13(join16(root, "transcript.jsonl")) ? join16(root, "transcript.jsonl") : null);
    if (tp && parseTranscriptRecords(tp).some((r) => (r?.tool_calls ?? (r?.toolCall ? [r.toolCall] : [])).some((c) => {
      const n = c?.name ?? "";
      const a = c?.args ?? {};
      return isShellTool(n, a) ? Boolean(extractCommandString(a) && !/^(node\s+--test|npm\s+test|npm\s+t\b|pnpm\s+test|yarn\s+test|echo|printf|pwd|ls|dir)\b/i.test(extractCommandString(a))) : classifyTool(n, a) !== "readonly";
    }))) return { decision: "deny", reason: "ticket build denied: session tracking store was removed mid-session while transcript contains prior mutations" };
  }
  const parsedT = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH_THRESHOLD ?? "", 10);
  const thresh = Number.isNaN(parsedT) ? DEFAULT_DEPTH_THRESHOLD : parsedT;
  const degraded = depth >= thresh || Boolean(tracker?.isCompacted?.(sessionID)) || Boolean(tracker?.isLockFailed?.(sessionID));
  const v = decideBuildGate({ riskTier: tier, degraded, bypass: env.ADLC_BUILD_GATE_BYPASS === "1", sessionID });
  if (v.decision === "deny") return { ...v, reason: `${v.reason} [signal: ${tracker?.isLockFailed?.(sessionID) ? "session lock timed out" : tracker?.isCompacted?.(sessionID) ? "session was compacted" : `tool-call depth ${depth} >= ${thresh}`}]` };
  return v;
}

// packages/hook-engine/lib/gemini-stop-verify.mjs
import { existsSync as existsSync14, lstatSync as lstatSync14 } from "node:fs";
import { isAbsolute as isAbsolute10, join as join17, relative as relative8, resolve as resolve9 } from "node:path";
import { homedir as homedir4 } from "node:os";
var GLOB_SAFE_RE = /^[a-zA-Z0-9._/*?[\]{}@+!-]+$/;
function sanitizeField(value, maxLen = 128) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]/g, " ").trim().slice(0, maxLen);
}
function sanitizeGlobList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed2 = item.trim();
    if (!trimmed2 || trimmed2.length > 200) continue;
    if (!GLOB_SAFE_RE.test(trimmed2)) continue;
    out.push(trimmed2);
  }
  return out;
}
var loadStoreReadOnly = (root, env) => detectTicketStore({
  root,
  ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || void 0,
  allowRecovery: true,
  env
}).load();
function buildOverrideRegex(env) {
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (!ov || typeof ov !== "string" || !ov.trim()) return null;
  const escaped = ov.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s=;,"'/$.()[\\]])(` + escaped + "|ADLC_TICKET_STORE|ADLC_TICKETS)", "i");
}
function checkTranscriptIntegrity(transcriptPath, tracker, sessionID, cont) {
  const trackerInfo = tracker.lastTranscript ? tracker.lastTranscript(sessionID) : { initial: tracker.initialTranscript?.(sessionID) };
  const initialTranscript = trackerInfo?.initial;
  if (!transcriptPath || !initialTranscript && !trackerInfo?.lastHash) return null;
  if (initialTranscript?.path && transcriptPath !== initialTranscript.path) {
    return cont("Session transcript path changed during session.");
  }
  try {
    const curStat = lstatSync14(transcriptPath);
    if (initialTranscript && (curStat.ino !== initialTranscript.ino || curStat.dev !== initialTranscript.dev)) {
      return cont("Session transcript file identity (inode/device) changed during session.");
    }
    if (initialTranscript?.size && curStat.size < initialTranscript.size) {
      return cont("Session transcript file size shrank unexpectedly during session.");
    }
    if (initialTranscript?.hash && initialTranscript.size > 0) {
      if (computePrefixHash(transcriptPath, initialTranscript.size) !== initialTranscript.hash) {
        return cont("Session transcript prefix content was modified during session.");
      }
    }
    if (trackerInfo?.lastHash && trackerInfo?.lastSize && trackerInfo.lastSize > 0) {
      if (computePrefixHash(transcriptPath, trackerInfo.lastSize) !== trackerInfo.lastHash) {
        return cont("Session transcript content was modified during session.");
      }
    }
  } catch {
    return cont("Session transcript became unreadable or missing during Stop verification.");
  }
  return null;
}
function evaluateGeminiStop(payload, { env = process.env, helpers } = {}) {
  const cont = (reason) => ({ decision: "continue", reason: `ADLC Rails-Guard: ${reason}` });
  const {
    PLUGIN_ROOT: PLUGIN_ROOT2,
    resolveWorkspaceRoot: resolveWorkspaceRoot2,
    declaredOuterWorkspace: declaredOuterWorkspace2,
    discoverRootFromTranscriptRecords: discoverRootFromTranscriptRecords2,
    hasUnambiguousWorkspaceCwd: hasUnambiguousWorkspaceCwd2,
    extractToolCalls: extractToolCalls2,
    extractToolName: extractToolName2,
    extractArgs: extractArgs2,
    extractFilePaths: extractFilePaths2,
    findAdlcRoot: findAdlcRoot2,
    canonicalizeExisting: canonicalizeExisting2
  } = helpers;
  try {
    if (env?.ADLC_P4_ENFORCEMENT !== "1") return { decision: "stop" };
    const sid = resolveSessionId({ payload, env });
    let root = resolveWorkspaceRoot2(payload, env);
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    let records = [];
    if (tp) {
      try {
        const before = lstatSync14(tp);
        records = parseTranscriptRecords(tp, { readFull: true });
        const after = lstatSync14(tp);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          records = parseTranscriptRecords(tp, { readFull: true });
        }
      } catch {
        records = [];
      }
    }
    const outerWs = declaredOuterWorkspace2(payload, root);
    const discoveredRoot = records.length > 0 ? discoverRootFromTranscriptRecords2(records, env, { anchorBase: outerWs }) : null;
    if (!root) {
      root = discoveredRoot;
    } else if (discoveredRoot) {
      const declaredMulti = ["workspacePaths", "workspace_paths", "workspaceRoots", "workspace_roots"].flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : []).filter((s) => typeof s === "string" && s.trim());
      if (declaredMulti.length > 1 && declaredMulti.some((w) => canonicalizePath(w) === canonicalizePath(discoveredRoot))) {
        root = discoveredRoot;
      } else {
        root = preferInnermostCheckout(root, [discoveredRoot], {
          storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null,
          homeDir: resolveUserHome(env) || homedir4(),
          pluginDir: PLUGIN_ROOT2,
          preserveSpelling: true
        }) ?? root;
      }
    }
    if (!root) return cont("Repository workspace root cannot be resolved under enforcement during Stop verification.");
    const initialActive = resolveActiveTicketId2(root, env);
    const tr = createPersistentTracker(root, env);
    if (tr.isInvalidated?.(sid)) return cont("Session invalidated due to secret disclosure.");
    const transcriptErr = checkTranscriptIntegrity(tp, tr, sid, cont);
    if (transcriptErr) return transcriptErr;
    if (tr.isCorrupted?.()) return cont("Session tracking store was corrupted or unreadable under enforcement.");
    if (tr.validateBaseline && !tr.validateBaseline(sid)) return cont("Session baseline signature mismatch or missing tracking entry.");
    if (tr.validateLedger && !tr.validateLedger(sid)) return cont("Session ledger integrity verification failed.");
    const trackedInitialTicket = tr.initialTicket(sid);
    const initialActiveId = trackedInitialTicket ?? initialActive.id;
    if (!tp || records.length === 0) {
      if (initialActiveId || initialActive.conflict) {
        return cont("Session transcript is missing or unreadable under enforcement.");
      }
      return { decision: "stop" };
    }
    const overrideEscaped = buildOverrideRegex(env);
    let callSeq = 0;
    let rootCallSeq = 0;
    let mutatingCallSeq = 0;
    let lastMut = -1;
    let lastTest = -1;
    let pkgMut = false;
    let shellMut = false;
    const isNested = Boolean(outerWs) && canonicalizePath(outerWs) !== canonicalizePath(root) && isPathInside(root, outerWs);
    const fileAnchorBase = isNested ? outerWs : root;
    for (const r of records) {
      if (!r || typeof r !== "object" || Array.isArray(r) || r.__oversized || r.__unparseable) {
        return cont("Corrupted or oversized transcript records detected during Stop verification.");
      }
      const mk = getMasterKeyRaw(env);
      const sec = getOrCreateSessionSecret(root, env);
      const rStr = JSON.stringify(r);
      if (mk && rStr.includes(mk)) {
        rotateMasterKey(env);
        tr.invalidateSession?.(sid);
        return cont("Master key disclosure detected in transcript. Global key revoked and rotated, session permanently invalidated.");
      }
      if (sec && rStr.includes(sec)) {
        tr.invalidateSession?.(sid);
        return cont("Secret disclosure detected in transcript. Session is permanently invalidated.");
      }
      const calls = extractToolCalls2(r);
      if (calls.length === 0 && Object.keys(r).some((k) => /(tool|function|action|invocation)/i.test(k))) {
        return cont("Transcript record contains unrecognized tool envelope \u2014 schema corruption detected.");
      }
      for (const c of calls) {
        callSeq++;
        const name = extractToolName2({ toolCall: c }) || (c?.name ?? c?.toolName ?? c?.tool_name ?? "");
        const args = extractArgs2({ toolCall: c });
        const fps = extractFilePaths2({ toolCall: c });
        const isShell = isShellTool(name, args);
        const isMut = !isShell && classifyTool(name, args) !== "readonly";
        const rawWd = extractToolWorkdir(args);
        const effAnchor = rawWd && typeof rawWd === "string" && rawWd.trim() ? isAbsolute10(rawWd.trim()) ? rawWd.trim() : resolve9(fileAnchorBase, rawWd.trim()) : fileAnchorBase;
        let callTargetsOuterOnly = false;
        if (isNested) {
          const fpRoots = fps.filter((p) => typeof p === "string" && p.trim()).map((p) => isAbsolute10(p.trim()) ? p.trim() : resolve9(effAnchor, p.trim())).map((ap) => findAdlcRoot2(canonicalizeExisting2(ap), env) ?? findAdlcRoot2(ap, env)).filter(Boolean);
          const wdRoot = rawWd && typeof rawWd === "string" && rawWd.trim() ? findAdlcRoot2(canonicalizeExisting2(effAnchor), env) ?? findAdlcRoot2(effAnchor, env) : null;
          const allRoots = [...wdRoot ? [wdRoot] : [], ...fpRoots];
          if (allRoots.length > 0 && allRoots.every((cr) => canonicalizePath(cr) !== canonicalizePath(root))) {
            callTargetsOuterOnly = true;
          }
        }
        if (!callTargetsOuterOnly) rootCallSeq++;
        if (isMut && !callTargetsOuterOnly) mutatingCallSeq++;
        if (isMut) {
          if (fps.some((p) => /(^|[/\\])\.(adlc|booster)([/\\]|$)/i.test(p)) || overrideEscaped && fps.some((p) => overrideEscaped.test(p))) {
            return cont("Trust-root store or secret was modified during session.");
          }
          if (fps.some((p) => isTrustRootOrSecretPath(p, env))) {
            return cont("Tampering with trust-root secret or executable is strictly prohibited.");
          }
          if (fps.some((p) => /(^|[/\\]|\.system_generated[/\\]logs[/\\])transcript.*\.jsonl$/i.test(p))) {
            return cont("Tampering with session transcript files is strictly prohibited.");
          }
          if (!callTargetsOuterOnly && fps.some((p) => {
            const abs = isAbsolute10(p) ? p : resolve9(effAnchor, p);
            const rel = relative8(root, abs);
            return rel.startsWith("..") || isAbsolute10(rel);
          })) {
            return cont("File modification outside repository workspace detected.");
          }
          lastMut = callSeq;
          if (fps.length === 0) {
            pkgMut = true;
            const argsStr = JSON.stringify(args ?? {});
            if (/(^|[=\s"';,/])(\.adlc|\.adlc-secrets|\.adlc-runtime-secrets|\.system_generated|transcript.*\.jsonl)/i.test(argsStr)) {
              return cont("Trust-root store or secret was modified during session.");
            }
          }
          if (fps.some((p) => /(^|[/\\])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(p))) {
            pkgMut = true;
          }
        } else if (isShell) {
          const cmd = extractCommandString(args);
          const normCmd = String(cmd ?? "").replace(/\\/g, "/");
          const shellAnchorBase = isNested ? outerWs : root;
          const actualCwd = rawWd && typeof rawWd === "string" && rawWd.trim() ? isAbsolute10(rawWd.trim()) ? rawWd.trim() : resolve9(shellAnchorBase, rawWd.trim()) : root;
          const allowImplicit = hasUnambiguousWorkspaceCwd2(payload, env, root);
          const ro = isReadonlyCommand(cmd, { root: callTargetsOuterOnly ? outerWs : root, cwd: actualCwd, env });
          if (!ro && isTrustRootSecretAccess(cmd, overrideEscaped) || hasShellTrustRootSecretAccess(cmd, { root, cwd: actualCwd, env }) || hasShellSymlinkOrSecretEscape(cmd, { root, cwd: actualCwd, env }) || !ro && /(^|[\s=;,"'/$.()[\]])transcript.*\.jsonl/i.test(normCmd)) {
            return cont("Shell modification of trust-root store or transcript is strictly prohibited.");
          }
          if (isVerificationCommand(cmd, { root, workdirAnchorBase: shellAnchorBase, toolArgs: args, allowImplicitCwd: allowImplicit, packageManifestMutated: pkgMut, shellMutated: shellMut })) {
            const ec = r?.exit_code ?? r?.exitCode ?? c?.exitCode;
            const st = String(r?.status ?? c?.status ?? "").toLowerCase();
            const isSuccess = ec === 0 || ec === void 0 && (st === "done" || st === "success" || r?.success === true);
            const isFailure = typeof ec === "number" && ec !== 0 || st === "error" || st === "failed" || r?.success === false;
            const outStr = typeof r?.content === "string" ? r.content : typeof r?.output === "string" ? r.output : JSON.stringify(r);
            const isZeroTests = /\b(tests|pass)\s+0\b/i.test(outStr) || /\b0\s+(tests|passing)\b/i.test(outStr);
            if (isSuccess && !isFailure && hasDiscoverableTests(root) && !isZeroTests) {
              lastTest = callSeq;
            }
          } else if (!ro && !isVerificationCommand(cmd, { root, workdirAnchorBase: shellAnchorBase, toolArgs: args, allowImplicitCwd: allowImplicit })) {
            if (!callTargetsOuterOnly) mutatingCallSeq++;
            lastMut = callSeq;
            shellMut = true;
            if (/(^|[\s=;,"'/$.()[\]])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|vitest\.config|jest\.config|\.mocharc|node_modules\/\.bin|npm\s+(pkg|install|i|add|remove|rm|uninstall))\b/i.test(normCmd)) {
              pkgMut = true;
            }
          }
        }
      }
    }
    const active = resolveActiveTicketId2(root, env);
    if (initialActiveId && active.id !== initialActiveId) {
      return cont(`Active ticket ID changed from ${initialActiveId} to ${active.id ?? "none"} during session.`);
    }
    if (!active.id) {
      if (active.conflict) return cont("Active ticket state conflict detected during Stop verification.");
      if (lastMut !== -1) return cont("Active ticket is missing while unverified edits exist in session.");
      return { decision: "stop" };
    }
    const trackedInitialPointer = tr.initialPointer?.(sid) ?? null;
    if (trackedInitialPointer?.exists && !existsSync14(join17(root, ".adlc", "current-ticket.json"))) {
      return cont("Active ticket pointer (.adlc/current-ticket.json) was removed during session.");
    }
    let ticket = null;
    try {
      const snap = loadStoreReadOnly(root, env);
      ticket = snap.get(active.id);
      if (!ticket) return cont(`Active ticket ${active.id} not found in validated ticket store.`);
      if (active.ticketHash) {
        const expectedHash = snap.ticketHashes?.[active.id] ?? snap.ticketHashes?.get?.(active.id);
        if (expectedHash && expectedHash !== active.ticketHash) {
          return cont(`Active ticket hash mismatch for ${active.id} during Stop verification.`);
        }
      }
    } catch {
      return cont("Corrupt or unreadable ticket store during Stop verification.");
    }
    if (lastMut !== -1 && (lastTest === -1 || lastMut > lastTest)) {
      return cont("Active ticket has unverified file edits. Verification/test commands must be run after the last edit before completing.");
    }
    const trackedDepth = tr.mutatingCalls ? tr.mutatingCalls(sid) : tr.depth(sid);
    if (trackedDepth > 0 && mutatingCallSeq !== trackedDepth) {
      return cont("Untracked or missing tool execution records detected in transcript during Stop verification.");
    }
    const trackedTotal = tr.totalCalls ? tr.totalCalls(sid) : 0;
    if (trackedTotal > 0 && rootCallSeq !== trackedTotal) {
      return cont("Untracked or missing tool execution records detected in transcript during Stop verification.");
    }
    if (trackedDepth === 0 && mutatingCallSeq > 0 && trackedInitialTicket) {
      return cont("Untracked tool execution records detected in transcript during Stop verification.");
    }
    const sessionsFile = join17(root, ".adlc", "sessions.json");
    const ledgerFile = join17(root, ".adlc", "session-ledger.jsonl");
    const hasInfra = existsSync14(sessionsFile) || existsSync14(ledgerFile) || Boolean(tr.hasSnapshot?.(sid)) || Boolean(trackedInitialTicket) || trackedDepth > 0 || trackedTotal > 0;
    if (!hasInfra && mutatingCallSeq > 0) {
      return cont("Session tracking store was missing or deleted during verification.");
    }
    if (hasInfra && !existsSync14(sessionsFile) && (trackedDepth > 0 || trackedTotal > 0 || mutatingCallSeq > 0 || trackedInitialTicket)) {
      return cont("Session tracking store was missing or deleted during verification.");
    }
    if (hasInfra && existsSync14(sessionsFile)) {
      const sStore = tr.rawStore?.();
      if (!sStore || sStore._corrupted) {
        return cont("Session baseline signature mismatch or missing tracking entry.");
      }
      if (mutatingCallSeq > 0 && !sStore[sid]) {
        return cont("Session tracking entry was deleted, evicted, reset, or missing during Stop verification.");
      }
    }
    const testCheck = verifyPreExistingTestFiles(root, tr.initialTestFiles?.(sid), ticket);
    if (!testCheck.ok) return { decision: "continue", reason: testCheck.reason };
    tr.markSessionEnded?.(sid);
    return { decision: "stop" };
  } catch {
    return env?.ADLC_P4_ENFORCEMENT === "1" ? cont("Internal error evaluating Stop hook under enforcement.") : { decision: "stop" };
  }
}

// packages/hook-engine/lib/gemini-guard.mjs
var PLUGIN_ROOT = dirname11(dirname11(fileURLToPath3(import.meta.url)));
var TOOLCALL_KEYS = ["toolCall", "tool_call", "tool"];
var NAME_KEYS = ["name", "toolName", "tool_name"];
var ARGS_KEYS = ["args", "arguments", "params", "parameters", "input", "tool_input"];
var WORKSPACE_KEYS = ["workspacePaths", "workspace_paths", "workspaceRoots", "workspace_roots"];
var PATH_KEYS = /* @__PURE__ */ new Set(["targetfile", "absolutepath", "filepath", "path", "file_path", "target_file", "dest_file", "destfile", "dest", "destination", "destpath", "target", "file", "filename", "targetpath", "source", "sourcefile", "src", "src_file", "dst", "dst_file", "output", "output_file", "output_path", "out_file", "outfile", "outpath", "outputpath", "targetcontentpath", "targetdir"]);
var IGNORED_SCAN_KEYS = /* @__PURE__ */ new Set(["CommandLine", "command", "cmd", "code", "CodeContent", "content", "ReplacementContent", "TargetContent", "Instruction", "Description", "Prompt", "Message", "message"]);
var pass = () => ({ decision: "pass", allow_tool: true });
var deny = (r) => ({ decision: "deny", reason: `ADLC rails-guard: ${r}`, allow_tool: false, deny_reason: `ADLC rails-guard: ${r}` });
var forceAsk = (r, env) => env?.ADLC_HEADLESS === "1" ? deny(r) : { decision: "force_ask", reason: `ADLC rails-guard: ${r}`, allow_tool: false };
var isToolPayload = (p) => Boolean(p) && typeof p === "object" && !Array.isArray(p);
var realpathOr3 = (p) => {
  try {
    return existsSync15(p) ? realpathSync6(p) : p;
  } catch {
    return p;
  }
};
var nonPluginCwd = () => {
  try {
    const c = process.cwd();
    return isPathInside(c, PLUGIN_ROOT) ? null : c;
  } catch {
    return null;
  }
};
var loadStoreReadOnly2 = (root, env) => detectTicketStore({ root, ticketStore: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || void 0, allowRecovery: true, env }).load();
function storeExists(root, env) {
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === "string" && ov.trim() && existsSync15(isAbsolute11(ov.trim()) ? ov.trim() : join18(root, ov.trim()))) return true;
  return existsSync15(join18(root, ".adlc", "tickets.json")) || existsSync15(join18(root, ".adlc", "tickets", ".store.json"));
}
var canonicalizeExisting = (p) => !p || typeof p !== "string" ? p : canonicalizePath(p);
var extractCwdFromArgs = (args) => extractToolWorkdir(args);
var toolCallOf = (p) => !p || typeof p !== "object" ? void 0 : TOOLCALL_KEYS.map((k) => p[k]).find((v) => v && typeof v === "object") ?? p;
function extractToolName(payload) {
  const obj = toolCallOf(payload);
  return obj && typeof obj === "object" ? NAME_KEYS.map((k) => obj[k]).find((v) => typeof v === "string" && v.trim()) ?? "" : "";
}
function extractArgs(payload) {
  const tc = toolCallOf(payload);
  return tc && typeof tc === "object" ? ARGS_KEYS.map((k) => tc[k]).find((v) => v && typeof v === "object") ?? {} : {};
}
function decodeUri(s) {
  if (!s.startsWith("file://")) return s;
  try {
    return fileURLToPath3(s);
  } catch {
    const st = s.replace(/^file:\/\/(?:localhost)?/i, "");
    try {
      return decodeURIComponent(st);
    } catch {
      return st;
    }
  }
}
function extractFilePaths(payload) {
  const out = /* @__PURE__ */ new Set();
  const scan = (obj, pk = "", d = 0) => {
    if (!obj || typeof obj !== "object" || d > 5) return;
    for (const [k, v] of Object.entries(obj)) {
      if (IGNORED_SCAN_KEYS.has(k)) continue;
      const kl = k.toLowerCase();
      const isPath = PATH_KEYS.has(kl) || pk && PATH_KEYS.has(pk.toLowerCase());
      if (typeof v === "string" && v.trim()) {
        const t = v.trim();
        if (isPath || kl === "uri" && (t.startsWith("file://") || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t))) out.add(decodeUri(t));
      } else if (Array.isArray(v)) {
        for (const e of v) {
          if (typeof e === "string" && isPath && e.trim()) out.add(decodeUri(e.trim()));
          else if (e && typeof e === "object") scan(e, k, d + 1);
        }
      } else if (v && typeof v === "object") scan(v, k, d + 1);
    }
  };
  scan(extractArgs(payload));
  return [...out];
}
function hasPathLikeArgs(args, d = 0) {
  if (!args || typeof args !== "object" || d > 5) return false;
  for (const [k, v] of Object.entries(args)) {
    if (IGNORED_SCAN_KEYS.has(k)) continue;
    if (typeof v === "string" && (v.includes("/") || v.includes("\\") || v.includes(".") || /(file|path|dest|target|dir|src|dst)/i.test(k))) return true;
    if (v && typeof v === "object" && (/(file|path|dest|target|dir|src|dst)/i.test(k) || hasPathLikeArgs(v, d + 1))) return true;
  }
  return false;
}
function findAdlcRoot(absPath, env = process.env) {
  if (!absPath || typeof absPath !== "string" || !isAbsolute11(absPath)) return null;
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  const homeDir = resolveUserHome(env) || homedir5();
  const baseOpts = { storeOverride: ov, homeDir, pluginDir: PLUGIN_ROOT, allowFileStart: true, preserveSpelling: true };
  if (ov && isAbsolute11(ov) && existsSync15(ov)) {
    const gitRoot = findInnermostCheckoutRoot(absPath, { ...baseOpts, storeOverride: null, requireStore: false });
    for (const er of [env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].filter((r) => typeof r === "string" && r.trim() && isAbsolute11(r.trim()))) {
      if (isPathInside(absPath, er)) return preferInnermostCheckout(er, [absPath], baseOpts);
    }
    if (gitRoot) return gitRoot;
    let cur = absPath;
    try {
      if (!lstatSync15(absPath).isDirectory()) cur = dirname11(absPath);
    } catch {
      cur = dirname11(absPath);
    }
    const { root: fsRoot } = parse2(cur);
    const normHome = homeDir ? realpathOr3(resolve10(homeDir)) : null;
    while (true) {
      if (normHome && realpathOr3(cur) === normHome) break;
      if (existsSync15(join18(cur, ".adlc"))) return cur;
      if (cur === fsRoot) break;
      cur = dirname11(cur);
    }
    return null;
  }
  return findInnermostCheckoutRoot(absPath, baseOpts);
}
function declaredOuterWorkspace(payload, targetHint = null) {
  const base = nonPluginCwd() ?? process.cwd();
  const all = WORKSPACE_KEYS.flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]]).filter((s) => typeof s === "string" && s.trim()).map((s) => isAbsolute11(s.trim()) ? s.trim() : resolve10(base, s.trim()));
  if (!all.length) return null;
  return typeof targetHint === "string" && targetHint.trim() && isAbsolute11(targetHint.trim()) ? all.find((w) => isPathInside(targetHint.trim(), w)) ?? all[0] : all[0];
}
function anchorPath(rawPath, payload, env = null) {
  if (!rawPath) return { abs: null, anchored: false };
  const norm = typeof rawPath === "string" ? rawPath.replace(/\\/g, "/") : rawPath;
  if (isAbsolute11(norm)) return { abs: norm, anchored: true };
  const wd = isToolPayload(payload) ? extractCwdFromArgs(extractArgs(payload)) : null;
  const ws = WORKSPACE_KEYS.flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : []).find((s) => typeof s === "string" && s.trim()) ?? [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].find((s) => typeof s === "string" && s.trim());
  if (ws) {
    const absWs = isAbsolute11(ws) ? ws : resolve10(nonPluginCwd() ?? process.cwd(), ws);
    if (typeof wd === "string" && wd.trim() && norm !== wd.trim().replace(/\\/g, "/")) return { abs: join18(isAbsolute11(wd.trim()) ? wd.trim() : resolve10(absWs, wd.trim()), norm), anchored: true };
    return { abs: join18(absWs, norm), anchored: true };
  }
  if (typeof wd === "string" && wd.trim() && isAbsolute11(wd.trim())) return { abs: norm === wd.trim().replace(/\\/g, "/") ? wd.trim() : join18(wd.trim(), norm), anchored: true };
  return { abs: null, anchored: false };
}
function railPreconditions({ root = process.cwd(), env = process.env } = {}) {
  if (env.ADLC_P4_ENFORCEMENT !== "1") return { state: "inactive", reason: "enforcement inactive" };
  if (!storeExists(root, env)) return { state: "inactive", reason: "repo not ADLC-initialized" };
  const active = resolveActiveTicketId2(root, env);
  if (active.conflict) return { state: "deny", reason: active.message ?? "conflicting active-ticket signal" };
  if (!active.id) return { state: "inactive", reason: "no active ticket resolved" };
  let snap;
  try {
    snap = loadStoreReadOnly2(root, env);
  } catch (err) {
    return { state: "deny", reason: `ticket store failed to load (${err.message}) \u2014 failing closed` };
  }
  const ticket = snap?.get(active.id);
  if (!ticket) return { state: "deny", reason: `active ticket ${active.id} not found in ticket store \u2014 failing closed` };
  if (active.ticketHash) {
    const sh = snap.ticketHashes?.[active.id] ?? snap.ticketHashes?.get?.(active.id);
    if (sh && sh !== active.ticketHash) return { state: "deny", reason: `active ticket ${active.id} hash mismatch \u2014 failing closed` };
  }
  const declared = ticket.rails ?? [];
  if (declared.some((r) => typeof r !== "string" || !r.length)) return { state: "deny", reason: `active ticket ${active.id} has a malformed rail entry \u2014 failing closed` };
  const custom = [];
  const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  if (ov && typeof ov === "string" && ov.trim()) {
    const raw = ov.trim();
    custom.push(raw, `${raw}/**`, `${raw}/*`);
    if (isAbsolute11(raw)) {
      const rel = relative9(root, raw);
      if (!rel.startsWith("..")) custom.push(rel, `${rel}/**`);
    } else custom.push(join18(root, raw), `${join18(root, raw)}/**`);
  }
  return { state: "active", rails: [...declared, ...TRUST_ROOT_RAILS, ...custom], activeId: active.id };
}
function checkRail({ filePath, tool, toolArgs = null, root = process.cwd(), env = process.env, isCaseInsensitiveFsFn = isCaseInsensitiveFs }) {
  if (classifyTool(tool, toolArgs) === "readonly") return { decision: "allow", reason: `tool "${tool}" is read-only` };
  const pre = railPreconditions({ root, env });
  if (pre.state !== "active") return { decision: pre.state === "deny" ? "deny" : "allow", reason: pre.reason };
  const abs = isAbsolute11(filePath) ? filePath : join18(root, filePath);
  const cands = /* @__PURE__ */ new Set([relative9(root, abs).replace(/\\/g, "/"), resolveRailPath(filePath, root), abs.replace(/\\/g, "/"), realpathOr3(filePath).replace(/\\/g, "/")]);
  const insens = isCaseInsensitiveFsFn(root);
  for (const p of cands) {
    const np = String(p ?? "").replace(/\\/g, "/");
    let hit = pre.rails.find((r) => r.replace(/\\/g, "/") === np || globMatch2(r.replace(/\\/g, "/"), np));
    if (!hit && insens) {
      const lp = np.toLowerCase();
      hit = pre.rails.find((r) => r.toLowerCase() === lp || globMatch2(r.toLowerCase(), lp));
    }
    if (hit) return { decision: "deny", reason: `frozen rail "${hit}" (active ticket ${pre.activeId})` };
  }
  return { decision: "allow", reason: "path is not a frozen rail" };
}
function unwrapCall(c) {
  let cur = c;
  const keys = ["toolCall", "tool_call", "call", "tool", "payload", "functionCall", "function_call", "invocation", "action", "toolUse", "tool_use"];
  while (cur && typeof cur === "object") {
    if (typeof cur.name === "string" || typeof cur.toolName === "string" || typeof cur.tool_name === "string" || typeof cur.functionName === "string") return cur;
    const nk = keys.find((k) => cur[k] && typeof cur[k] === "object" && !Array.isArray(cur[k]));
    if (!nk) break;
    cur = cur[nk];
  }
  return null;
}
function extractToolCalls(r) {
  if (!r || typeof r !== "object") return [];
  const arrK = ["toolCalls", "tool_calls", "calls", "actions", "functionCalls", "function_calls", "invocations", "toolUses", "tool_uses", "parts", "steps"].find((k) => Array.isArray(r[k]));
  if (arrK) return r[arrK].map(unwrapCall).filter(Boolean);
  const objK = ["toolCall", "tool_call", "call", "tool", "payload", "action", "functionCall", "function_call", "invocation", "toolUse", "tool_use"].find((k) => r[k] && typeof r[k] === "object" && !Array.isArray(r[k]));
  if (objK) return [r[objK]].map(unwrapCall).filter(Boolean);
  const u = unwrapCall(r);
  return u ? [u] : [];
}
function discoverRootFromTranscriptRecords(records, env = process.env, { anchorBase = null } = {}) {
  if (!Array.isArray(records) || !records.length) return null;
  const found = [];
  for (const r of records) for (const c of extractToolCalls(r)) for (const p of [...extractAllToolWorkdirs(extractArgs({ toolCall: c })), ...extractFilePaths({ toolCall: c })]) {
    if (typeof p !== "string" || !p.trim()) continue;
    const rp = isAbsolute11(p) ? p : anchorBase ? resolve10(anchorBase, p) : null;
    if (!rp) continue;
    const cand = findAdlcRoot(canonicalizeExisting(rp), env) ?? findAdlcRoot(rp, env);
    if (cand) found.push(cand);
  }
  if (!found.length) return null;
  const opts = { storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null, homeDir: resolveUserHome(env) || homedir5(), pluginDir: PLUGIN_ROOT, preserveSpelling: true };
  return found.reduce((best, next) => preferInnermostCheckout(best, [next], opts) ?? best);
}
function hasUnambiguousWorkspaceCwd(payload, env = process.env, expectedRoot = null) {
  const baseCwd = nonPluginCwd() ?? process.cwd();
  const toCan = (s) => canonicalizePath(isAbsolute11(s.trim()) ? resolve10(s.trim()) : resolve10(baseCwd, s.trim()));
  const uniq = [...new Set(WORKSPACE_KEYS.flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]]).filter((s) => typeof s === "string" && s.trim()).map(toCan))];
  const expDir = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot].find((s) => typeof s === "string" && s.trim());
  const expEnv = [env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT].find((s) => typeof s === "string" && s.trim());
  if (uniq.length > 1 && !expDir && !expEnv) return false;
  if (typeof expectedRoot === "string" && expectedRoot.trim()) {
    const imp = expDir ?? (uniq.length === 1 ? uniq[0] : null) ?? expEnv ?? (env === process.env ? nonPluginCwd() : null) ?? env?.PWD ?? env?.INIT_CWD ?? null;
    return Boolean(imp && toCan(imp) === canonicalizePath(resolve10(expectedRoot.trim())));
  }
  return true;
}
function resolveWorkspaceRoot(payload, env = process.env) {
  const storeOverride = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
  const homeDir = resolveUserHome(env) || homedir5();
  const baseCwd = nonPluginCwd() ?? process.cwd();
  const outer = declaredOuterWorkspace(payload);
  const wds = extractAllToolWorkdirs(extractArgs(payload));
  const fps = isToolPayload(payload) ? extractFilePaths(payload) : [];
  const dyn = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, ...[...wds, ...fps].filter((s) => typeof s === "string" && s.trim()).map((s) => isAbsolute11(s.trim()) ? s.trim() : resolve10(outer ?? baseCwd, s.trim())), env === process.env ? nonPluginCwd() : null].filter((s) => typeof s === "string" && s.trim());
  const upg = (c) => preferInnermostCheckout(c, dyn, { storeOverride, homeDir, pluginDir: PLUGIN_ROOT, allowFileStart: true, preserveSpelling: true }) ?? c;
  const cands = [payload?.cwd, payload?.workingDirectory, payload?.working_directory, payload?.workspaceRoot, ...WORKSPACE_KEYS.flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : [payload?.[k]]), env?.AGY_WORKSPACE, env?.ANTIGRAVITY_WORKSPACE, env?.GEMINI_WORKSPACE, env?.PROJECT_ROOT, env?.WORKSPACE_ROOT, env === process.env ? nonPluginCwd() : null, env?.PWD, env?.INIT_CWD, ...wds.filter(isAbsolute11)].filter((s) => typeof s === "string" && s.trim());
  for (const c of cands) {
    const f = findAdlcRoot(isAbsolute11(c.trim()) ? c.trim() : join18(baseCwd, c.trim()), env);
    if (f) return upg(f);
  }
  return null;
}
function decide(payload, { env = process.env, trackerCache } = {}) {
  let enforcing = false;
  try {
    enforcing = env?.ADLC_P4_ENFORCEMENT === "1";
    if (!isToolPayload(payload)) return enforcing ? deny("unparseable tool payload while enforcing \u2014 failing closed") : pass();
    const tool = extractToolName(payload);
    if (!tool) return enforcing ? deny("tool payload exposes no tool name while enforcing \u2014 failing closed") : pass();
    const wsRoot = resolveWorkspaceRoot(payload, env);
    const args = extractArgs(payload);
    const cls = classifyTool(tool, args);
    const ov = env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null;
    const ovRe = ov && typeof ov === "string" && ov.trim() ? new RegExp(`(^|[\\s=;,"'/$.()[\\]])(` + ov.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|ADLC_TICKET_STORE|ADLC_TICKETS)", "i") : null;
    const paths = extractFilePaths(payload);
    const guard = cls === "readonly" ? isSecretStatePath : isTrustRootOrSecretPath;
    for (const raw of paths) {
      const { abs } = anchorPath(raw, payload, env);
      const can = canonicalizeExisting(abs);
      if (guard(abs, env) || guard(can, env) || guard(raw, env)) return deny("frozen rail \u2014 modification of master key or trust-root session secrets is strictly prohibited");
      if (cls !== "readonly" && /(^|[/\\])\.(adlc|booster)([/\\]|$)/i.test(String(can || abs || raw))) return deny("frozen rail \u2014 direct modification of .adlc/** or .booster/** is strictly prohibited");
    }
    const earlyWs = declaredOuterWorkspace(payload, wsRoot);
    if (hasConflictingToolWorkdirs(args, earlyWs ?? wsRoot ?? nonPluginCwd() ?? process.cwd())) return deny("conflicting working directories in tool arguments \u2014 failing closed");
    const isShell = isShellTool(tool, args);
    const swd = !isShell ? extractCwdFromArgs(args) : null;
    if (enforcing && typeof swd === "string" && swd.trim()) {
      const b = declaredOuterWorkspace(payload, isAbsolute11(swd.trim()) ? swd.trim() : wsRoot) ?? wsRoot;
      if (!b || !isPathInside(isAbsolute11(swd.trim()) ? swd.trim() : resolve10(b, swd.trim()), b)) return forceAsk("structured tool workdir targets path outside workspace", env);
    }
    if (cls === "readonly") {
      if (enforcing) {
        for (const raw of paths) if (raw && !isAbsolute11(raw.replace(/\\/g, "/"))) {
          const { abs, anchored } = anchorPath(raw, payload, env);
          const b = declaredOuterWorkspace(payload, abs) ?? wsRoot;
          if (!anchored || !b || !isPathInside(abs, b)) return forceAsk(`relative path "${raw}" escapes workspace`, env);
        }
      }
      return pass();
    }
    if (paths.length > 0) {
      const cache = trackerCache ?? /* @__PURE__ */ new Map();
      const getT = (r) => cache.has(r) ? cache.get(r) : (cache.set(r, createPersistentTracker(r, env)), cache.get(r));
      for (const raw of paths) {
        const { abs, anchored } = anchorPath(raw, payload, env);
        if (!anchored) {
          if (enforcing) return forceAsk(`unanchorable relative path "${raw}"`, env);
          continue;
        }
        const can = canonicalizeExisting(abs);
        const b = declaredOuterWorkspace(payload, abs) ?? wsRoot;
        if (enforcing && ov && typeof ov === "string" && ov.trim()) {
          const ovAbs = isAbsolute11(ov.trim()) ? ov.trim() : resolve10(wsRoot ?? b ?? process.cwd(), ov.trim());
          const ovCan = canonicalizeExisting(ovAbs);
          if (abs === ovAbs || can === ovCan || isPathInside(abs, ovAbs) || isPathInside(can, ovCan)) {
            return deny("frozen rail \u2014 direct modification of external ticket store is strictly prohibited");
          }
        }
        if (enforcing && b && !isPathInside(can, b)) return forceAsk(`target path "${raw}" mutates outside workspace`, env);
        const eff = findAdlcRoot(can, env) ?? findAdlcRoot(abs, env);
        if (!eff) continue;
        for (const fp of [can, abs]) {
          const v = checkRail({ filePath: fp, tool, toolArgs: args, root: eff, env });
          if (v.decision === "deny") return deny(`frozen rail \u2014 ${v.reason}`);
        }
        const tr = getT(eff);
        const sid = resolveSessionId({ payload, env });
        if (enforcing) {
          if (tr?.isInvalidated?.(sid)) return deny("session invalidated due to secret disclosure \u2014 failing closed");
          const g = checkBuildGate({ sessionID: sid, tracker: tr, root: eff, env });
          if (g.decision === "deny") return deny(`build-gate \u2014 ${g.reason}`);
        }
        if (cls === "mutating" && tr?.recordEdit) {
          const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
          const fl = tr.recordEdit(sid, abs, { transcriptSteps: tp ? parseTranscriptSteps(tp) : [] });
          if (fl?.verdict === "flail" && (enforcing || env?.ADLC_FLAIL_ENFORCEMENT === "1") && env?.ADLC_FLAIL_BYPASS !== "1") return deny(`flail-detector \u2014 session is flailing: ${fl.summary}. ${flailMessage({ path: abs, count: 3 })}`);
        }
      }
    }
    if (isShell) {
      const cmd = extractCommandString(args);
      const cw = extractCwdFromArgs(args);
      const b = declaredOuterWorkspace(payload, cw && isAbsolute11(cw) ? cw : wsRoot) ?? wsRoot;
      const ec = (cw ? isAbsolute11(cw) ? cw : b ? resolve10(b, cw) : null : null) ?? wsRoot ?? process.cwd();
      if (cmd) {
        if (isTrustRootSecretAccess(cmd, ovRe) && !isReadonlyCommand(cmd, { root: b ?? ec, cwd: ec, env })) return deny("shell modification of ticket store or trust-root rails is strictly prohibited");
        if (hasShellTrustRootSecretAccess(cmd, { root: b ?? ec, cwd: ec, env }) || hasShellSymlinkOrSecretEscape(cmd, { root: b ?? ec, cwd: ec, env })) return deny("shell access to master key, trust-root secrets, or escaping symlink is strictly prohibited");
        if (enforcing && isUnauthorizedWorkspaceEscape(cmd, { root: b, cwd: ec })) return forceAsk("shell command accesses filesystem paths outside workspace", env);
        if (enforcing) {
          const verRoot = (cw ? findAdlcRoot(ec, env) ?? ec : null) ?? wsRoot ?? b ?? ec;
          const ro = isReadonlyCommand(cmd, { root: b ?? ec, cwd: ec, env });
          const ver = isVerificationCommand(cmd, { root: verRoot, workdirAnchorBase: b, toolArgs: args, allowImplicitCwd: hasUnambiguousWorkspaceCwd(payload, env, verRoot) });
          if (!ro && !ver) return forceAsk(`ambiguous mutating shell command requires confirmation: ${cmd.slice(0, 120)}`, env);
        }
        return pass();
      }
      if (hasCommandLineArgs(args)) return enforcing ? forceAsk("recognized shell tool has unparseable command arguments", env) : pass();
    }
    if (!paths.length) {
      if (cls === "other") return enforcing && (hasPathLikeArgs(args) || hasCommandLineArgs(args) || hasCodeExecutionArgs(args)) ? deny(`unclassified tool "${tool}" has uninspectable arguments \u2014 failing closed`) : pass();
      return enforcing ? deny(`mutating tool "${tool}" exposed no inspectable target path \u2014 failing closed`) : pass();
    }
    return pass();
  } catch (err) {
    return enforcing ? deny(`internal error while enforcing \u2014 ${err?.message ?? err}`) : pass();
  }
}
function runFromStdin(raw, envArg = process.env) {
  const env = envArg && typeof envArg === "object" && envArg.env ? envArg.env : envArg ?? process.env;
  const enf = env?.ADLC_P4_ENFORCEMENT === "1";
  if (!raw || !raw.trim()) return enf ? deny("unparseable tool payload while enforcing \u2014 failing closed") : pass();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return enf ? deny("unparseable tool payload while enforcing \u2014 failing closed") : pass();
  }
  if (!isToolPayload(payload)) return enf ? deny("unparseable tool payload while enforcing \u2014 failing closed") : pass();
  const toolName = extractToolName(payload);
  const trackerCache = /* @__PURE__ */ new Map();
  if (!toolName) return decide(payload, { env, trackerCache });
  const wsRoot = resolveWorkspaceRoot(payload, env);
  const args = extractArgs(payload);
  const cls = classifyTool(toolName, args);
  const sid = resolveSessionId({ payload, env });
  const cmdCwd = extractCwdFromArgs(args);
  const cmdCwdRoot = cmdCwd && isAbsolute11(cmdCwd) ? findAdlcRoot(cmdCwd, env) : null;
  const pathRoots = /* @__PURE__ */ new Set();
  for (const p of extractFilePaths(payload)) {
    const { abs } = anchorPath(p, payload, env);
    if (abs) {
      const r = findAdlcRoot(abs, env);
      if (r) pathRoots.add(r);
    }
  }
  const roots = new Set(cmdCwdRoot ? [cmdCwdRoot, ...pathRoots] : pathRoots.size ? [...pathRoots] : [wsRoot].filter(Boolean));
  const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
  if (!roots.size && tp) {
    const trRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp), env, { anchorBase: declaredOuterWorkspace(payload) }) ?? findAdlcRoot(tp, env);
    if (trRoot) roots.add(trRoot);
  }
  const isShell = isShellTool(toolName, args);
  const cmd = extractCommandString(args);
  const verTarget = cmdCwdRoot ?? wsRoot ?? [...roots][0] ?? process.cwd();
  const isMut = isShell ? !isReadonlyCommand(cmd, { root: verTarget, cwd: cmdCwd && isAbsolute11(cmdCwd) ? cmdCwd : verTarget, env }) && !isVerificationCommand(cmd, { root: verTarget, workdirAnchorBase: declaredOuterWorkspace(payload, verTarget), toolArgs: args }) : cls !== "readonly";
  for (const r of roots) {
    const tr = createPersistentTracker(r, env);
    trackerCache.set(r, tr);
    tr.recordToolCall(sid, { isMutating: isMut });
    if (tp) tr.recordTranscript(sid, tp);
    const active = resolveActiveTicketId2(r, env);
    if (active.id) try {
      tr.recordActiveTicket(sid, active.id, loadStoreReadOnly2(r, env)?.hash);
    } catch {
    }
  }
  const v = decide(payload, { env, trackerCache });
  if (v.decision === "deny") for (const r of roots) trackerCache.get(r)?.revertToolCall?.(sid, { isMutating: isMut });
  return v;
}
function preInvocation(payload, { env = process.env } = {}) {
  try {
    let root = resolveWorkspaceRoot(payload, env);
    const sid = resolveSessionId({ payload, env });
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    if (tp) {
      const trRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp, { readFull: true }), env, { anchorBase: declaredOuterWorkspace(payload, root) }) ?? findAdlcRoot(tp, env);
      const multi = WORKSPACE_KEYS.flatMap((k) => Array.isArray(payload?.[k]) ? payload[k] : []).filter((s) => typeof s === "string" && s.trim());
      if (!root || trRoot && multi.length > 1 && multi.some((w) => canonicalizePath(w) === canonicalizePath(trRoot))) root = trRoot;
      else if (trRoot) root = preferInnermostCheckout(root, [trRoot], { storeOverride: env?.ADLC_TICKET_STORE || env?.ADLC_TICKETS || null, homeDir: resolveUserHome(env) || homedir5(), pluginDir: PLUGIN_ROOT, preserveSpelling: true }) ?? root;
    }
    if (!root) return { injectSteps: [] };
    const active = resolveActiveTicketId2(root, env);
    const cleanId = sanitizeField(active.id, 64);
    if (!cleanId || cleanId !== active.id || active.conflict || !/^[a-zA-Z0-9_-]+$/.test(cleanId)) return { injectSteps: [] };
    const snap = loadStoreReadOnly2(root, env);
    const ticket = snap.get(cleanId);
    if (!ticket) return { injectSteps: [] };
    const tr = createPersistentTracker(root, env);
    tr.recordActiveTicket(sid, cleanId, snap.hash);
    if (tp) tr.recordTranscript(sid, tp);
    const rails = [.../* @__PURE__ */ new Set([...sanitizeGlobList(ticket.rails), ...TRUST_ROOT_RAILS])].join(", ");
    const cleanScope = sanitizeGlobList(ticket.scope);
    const scope = cleanScope.length ? cleanScope.join(", ") : "unrestricted";
    return { injectSteps: [{ ephemeralMessage: `[ADLC Context] Active Ticket: ${cleanId} | Enforcement: ${env.ADLC_P4_ENFORCEMENT === "1" ? "ACTIVE" : "INACTIVE (advisory)"} | Scope: ${scope} | Frozen Rails: ${rails}` }] };
  } catch {
    return { injectSteps: [] };
  }
}
function postToolUse(payload, { env = process.env } = {}) {
  try {
    const sid = resolveSessionId({ payload, env });
    const rawOut = (typeof payload?.output === "string" ? payload.output + "\n" : "") + JSON.stringify(payload ?? {});
    const mk = getMasterKeyRaw(env);
    if (mk && rawOut.includes(mk)) {
      rotateMasterKey(env);
      createPersistentTracker(resolveWorkspaceRoot(payload, env) ?? process.cwd(), env)?.invalidateSession?.(sid);
    }
    const tp = resolveTranscriptPath({ payload, conversationId: sid, env });
    let wsRoot = resolveWorkspaceRoot(payload, env);
    if (!wsRoot && tp) wsRoot = discoverRootFromTranscriptRecords(parseTranscriptRecords(tp), env, { anchorBase: declaredOuterWorkspace(payload) }) ?? findAdlcRoot(tp, env);
    if (wsRoot) {
      const tr = createPersistentTracker(wsRoot, env);
      const ec = payload?.exit_code ?? payload?.exitCode ?? payload?.result?.exitCode ?? payload?.toolResult?.exitCode;
      tr.recordToolResult(sid, { exitCode: typeof ec === "number" ? ec : null, transcriptPath: tp });
      const sec = getOrCreateSessionSecret(wsRoot, env);
      if (sec && rawOut.includes(sec)) tr.invalidateSession?.(sid);
    }
  } catch {
  }
  return pass();
}
function onStop(payload, { env = process.env } = {}) {
  return evaluateGeminiStop(payload, {
    env,
    helpers: {
      PLUGIN_ROOT,
      resolveWorkspaceRoot,
      declaredOuterWorkspace,
      discoverRootFromTranscriptRecords,
      hasUnambiguousWorkspaceCwd,
      extractToolCalls,
      extractToolName,
      extractArgs,
      extractFilePaths,
      findAdlcRoot,
      canonicalizeExisting
    }
  });
}
function printStatus(root = process.cwd(), env = process.env, payload = {}) {
  const r = findAdlcRoot(isAbsolute11(root) ? root : join18(process.cwd(), root), env) ?? root;
  const a = resolveActiveTicketId2(r, env);
  const tr = createPersistentTracker(r, env);
  const sid = resolveSessionId({ payload, env });
  const fl = checkFlail({ sessionID: sid, tracker: tr, env });
  console.log(`--- ADLC Gemini Status ---
Root: ${r}
Active Ticket: ${a.id ?? (a.conflict ? "CONFLICT" : "NONE")}
Enforcement (ADLC_P4_ENFORCEMENT): ${env.ADLC_P4_ENFORCEMENT === "1" ? "ACTIVE" : "INACTIVE"}
Resolved Session ID: ${sid}
Context Depth (Tool Calls): ${tr.depth(sid)}
Session Compacted: ${tr.isCompacted(sid)}
Flail Status: ${fl.verdict.toUpperCase()}${fl.summary ? ` (${fl.summary})` : ""}`);
}
function printDoctor(root = process.cwd(), env = process.env) {
  const r = findAdlcRoot(isAbsolute11(root) ? root : join18(process.cwd(), root), env) ?? root;
  console.log(`--- ADLC Gemini Doctor ---
Node Version: ${process.version}
Root Directory: ${r}
ADLC Ticket Store Present: ${storeExists(r, env)}
Active Ticket: ${resolveActiveTicketId2(r, env).id ?? "NONE"}
CI Rail Guard Workflow: ${existsSync15(join18(r, ".github/workflows/adlc-rails-guard.yml")) ? "PRESENT" : "MISSING"}`);
}

// packages/hook-engine/lib/protocol-adapters.mjs
var HARNESS_PROTOCOLS = Object.freeze([
  "claude-code",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "opencode",
  "pi"
]);
var DECISION_LATTICE = Object.freeze({
  pass: 0,
  allow: 0,
  ask: 1,
  force_ask: 2,
  deny: 3,
  block: 3
});
var MAX_TOOL_ARGS_BYTES = 256 * 1024;
var HARNESS_ALIASES = /* @__PURE__ */ new Map([
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
  ["copilot", "copilot"],
  ["cursor", "cursor"],
  ["gemini", "gemini"],
  ["antigravity", "gemini"],
  ["agy", "gemini"],
  ["jetski", "gemini"],
  ["opencode", "opencode"],
  ["pi", "pi"]
]);
function resolveHarnessProtocol(harness) {
  const key = String(harness ?? "").trim().toLowerCase();
  const resolved = HARNESS_ALIASES.get(key);
  if (!resolved) {
    throw new Error(`Unsupported harness protocol: ${String(harness)}`);
  }
  return resolved;
}
function canonicalEventName(rawEvent) {
  const e = String(rawEvent ?? "").trim().toLowerCase();
  if (e === "pretooluse" || e === "beforetool" || e === "tool.execute.before" || e === "tool_call") {
    return "pretool";
  }
  if (e === "posttooluse" || e === "aftertool" || e === "tool.execute.after" || e === "tool_result") {
    return "posttool";
  }
  if (e === "stop" || e === "afteragent" || e === "session.idle" || e === "agent_end") {
    return "stop";
  }
  if (e === "sessionstart" || e === "session.created" || e === "session_start" || e === "preinvocation") {
    return "session-start";
  }
  return e || "pretool";
}
function isPlainObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function parseToolArgsString(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_TOOL_ARGS_BYTES) {
    return { __unparseable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObj(parsed) ? parsed : { __unparseable: true };
  } catch {
    return { __unparseable: true };
  }
}
function firstNonEmptyString(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
function extractWorkspacePaths(p) {
  const raw = [p.workspacePaths, p.workspace_paths, p.workspaceRoots, p.workspace_roots];
  const out = [];
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string" && item.trim() && !out.includes(item.trim())) {
          out.push(item.trim());
        }
      }
    } else if (typeof entry === "string" && entry.trim() && !out.includes(entry.trim())) {
      out.push(entry.trim());
    }
  }
  return out;
}
function normalizeHookInput(harness, rawPayload = {}) {
  const proto = resolveHarnessProtocol(harness);
  const p = isPlainObj(rawPayload) ? rawPayload : {};
  const tc = isPlainObj(p.toolCall) ? p.toolCall : isPlainObj(p.tool_call) ? p.tool_call : null;
  const event = canonicalEventName(
    p.hook_event_name ?? p.hookEventName ?? p.event ?? p.type ?? "pretool"
  );
  const toolName = String(
    p.tool_name ?? p.toolName ?? (typeof p.tool === "string" ? p.tool : null) ?? p.name ?? tc?.name ?? tc?.toolName ?? tc?.tool_name ?? ""
  );
  const objCandidates = [
    p.tool_input,
    p.toolInput,
    p.toolArgs,
    p.args,
    p.input,
    tc?.args,
    tc?.arguments,
    tc?.params,
    tc?.parameters,
    tc?.input,
    tc?.tool_input,
    tc?.toolInput
  ];
  let toolInput = objCandidates.find(isPlainObj) ?? null;
  if (!toolInput) {
    const strArgs = typeof p.toolArgs === "string" ? p.toolArgs : typeof tc?.arguments === "string" ? tc.arguments : null;
    if (strArgs !== null) toolInput = parseToolArgsString(strArgs);
  }
  if (!toolInput) toolInput = {};
  const toolResult = p.tool_response ?? p.toolResult ?? p.result ?? p.output ?? null;
  const cwd = firstNonEmptyString([p.cwd, p.directory, p.workingDirectory, p.working_directory]);
  const workspacePaths = extractWorkspacePaths(p);
  const outerRoot = firstNonEmptyString([workspacePaths[0], p.project_dir, p.projectRoot]);
  const conversationId = firstNonEmptyString([
    p.conversationId,
    p.conversation_id,
    p.conversationID,
    p.params?.conversationId,
    p.params?.conversation_id
  ]);
  const sessionId = firstNonEmptyString([p.session_id, p.sessionId, p.sessionID, conversationId]);
  const transcriptPath = firstNonEmptyString([p.transcript_path, p.transcriptPath]);
  return {
    harness: proto,
    event,
    toolName,
    toolInput,
    toolResult,
    cwd,
    outerRoot,
    workspacePaths,
    conversationId,
    sessionId,
    transcriptPath
  };
}
function formatHookOutput(harness, event, result = {}) {
  const proto = resolveHarnessProtocol(harness);
  const ev = canonicalEventName(event);
  const dec = String(result.decision ?? "").toLowerCase();
  const denied = dec === "deny" || dec === "block";
  const reason = result.reason ?? "";
  const context = result.additionalContext ?? result.advisory ?? "";
  let payload = {};
  let exitCode = 0;
  if (proto === "claude-code") {
    if (ev === "pretool" && denied) {
      payload = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      };
    } else if (ev === "stop" && denied) {
      payload = { decision: "block", reason };
    } else if ((ev === "session-start" || ev === "posttool") && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: ev === "session-start" ? "SessionStart" : "PostToolUse",
          additionalContext: context
        }
      };
    }
  } else if (proto === "codex") {
    if ((ev === "pretool" || ev === "stop") && denied) {
      payload = { decision: "block", reason };
      exitCode = 2;
    } else if (ev === "session-start" && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context
        }
      };
    } else if (context) {
      payload = { systemMessage: context };
    }
  } else if (proto === "copilot") {
    if ((ev === "pretool" || ev === "stop") && denied) {
      payload = { reason: reason || "ADLC hook denied tool execution" };
    } else if (context) {
      payload = { additionalContext: context };
    }
  } else if (proto === "cursor") {
    if (ev === "pretool" && denied) {
      payload = { permission: "deny", user_message: reason, agent_message: reason };
    } else if (ev === "stop" && denied) {
      payload = { followup_message: reason };
    } else if (context) {
      payload = { additional_context: context };
    }
  } else if (proto === "gemini") {
    if (ev === "pretool") {
      if (denied) {
        payload = { decision: "deny", reason, allow_tool: false, deny_reason: reason };
      } else if (dec === "force_ask") {
        payload = { decision: "force_ask", reason, allow_tool: false };
      } else if (dec === "ask") {
        payload = { decision: "ask", reason };
      } else {
        payload = { decision: "pass", allow_tool: true };
      }
    } else if (ev === "stop") {
      payload = denied || dec === "continue" ? { decision: "continue", reason } : { decision: "stop" };
    } else if (context) {
      payload = { hookSpecificOutput: { additionalContext: context } };
    }
  } else if (proto === "opencode") {
    if ((ev === "pretool" || ev === "stop") && denied) {
      payload = { blocked: true, reason };
    } else if (context) {
      payload = { advisory: context };
    }
  } else if (proto === "pi") {
    if ((ev === "pretool" || ev === "stop") && denied) {
      payload = { block: true, reason };
    } else if (context) {
      payload = { advisory: context };
    }
  }
  return {
    exitCode,
    payload,
    stdout: Object.keys(payload).length > 0 ? `${JSON.stringify(payload)}
` : ""
  };
}

// packages/hook-engine/lib/cli-gemini.mjs
async function readStdin2() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function dispatchGeminiHook(raw, env = process.env) {
  let parsed = null;
  try {
    parsed = raw && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return runFromStdin(raw, env);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return runFromStdin(raw, env);
  }
  const hasEvent = Boolean(parsed.hook_event_name ?? parsed.hookEventName ?? parsed.event ?? parsed.type);
  if (!hasEvent) {
    return runFromStdin(raw, env);
  }
  const norm = normalizeHookInput("gemini", parsed);
  if (norm.event === "session-start") return preInvocation(parsed, { env });
  if (norm.event === "posttool") return postToolUse(parsed, { env });
  if (norm.event === "stop") return onStop(parsed, { env });
  return runFromStdin(raw, env);
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const subcmd = argv[0];
  if (subcmd === "status") {
    printStatus(process.cwd(), env);
    return;
  }
  if (subcmd === "doctor") {
    printDoctor(process.cwd(), env);
    return;
  }
  const raw = await readStdin2();
  const result = dispatchGeminiHook(raw, env);
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && fileURLToPath4(import.meta.url) === process.argv[1]) {
  main();
}
export {
  DECISION_LATTICE,
  DEFAULT_DEPTH_THRESHOLD,
  DEFAULT_ERROR_REPEAT_THRESHOLD,
  DEFAULT_FLAIL_THRESHOLD,
  DEFAULT_WINDOW,
  ERROR_LINE_RE,
  HARNESS_PROTOCOLS,
  HIGH_RISK_CATEGORIES,
  LOCK_TTL_MS,
  MANIFEST_PATH,
  MAX_SCAN_BYTES,
  MAX_TRACKED_SESSIONS,
  MAX_TRANSCRIPT_HASH_BYTES,
  MUTATING_TOOL_HINTS,
  PURE_READS,
  TRUST_ROOT_PATHS,
  TRUST_ROOT_RAILS,
  analyzeFlail,
  anchorPath,
  canonicalizeExisting,
  checkBuildGate,
  checkFlail,
  checkRail,
  classifyTool,
  computePrefixHash,
  computeRiskTier,
  createDepthTracker,
  createFlailTracker,
  createPersistentTracker,
  decide,
  decideBuildGate,
  deriveRiskSignals,
  detectEditChurn,
  detectRepeatedErrors,
  discoverRootFromTranscriptRecords,
  dispatchGeminiHook,
  enclosingAdlcRoot,
  evaluatePreTool,
  extractArgs,
  extractCommandString,
  extractCwdFromArgs,
  extractFilePaths,
  extractToolCalls,
  extractToolName,
  findAdlcRoot,
  flailMessage,
  formatHookOutput,
  getMasterKeyRaw,
  getOrCreateSessionSecret,
  getTestFilesMap,
  getTrustRootSecretHomes,
  hasCodeExecutionArgs,
  hasCommandLineArgs,
  hasDiscoverableTests,
  hasMutatingPayloadDeep,
  hasShellSymlinkOrSecretEscape,
  hasShellTrustRootSecretAccess,
  hasUnambiguousWorkspaceCwd,
  isAncestorDirOfRail,
  isCaseInsensitiveFs,
  isDirectoryDeletionCommand,
  isNodeTestFile,
  isReadonlyCommand,
  isSecretStatePath,
  isShellTool,
  isTrustRootOrSecretPath,
  isTrustRootSecretAccess,
  isUnauthorizedWorkspaceEscape,
  isVerificationCommand,
  judgeStaleLock,
  main,
  normalizeError,
  normalizeHookInput,
  normalizeToolName,
  onStop,
  parseTranscriptLines,
  parseTranscriptRecords,
  parseTranscriptSteps,
  postToolUse,
  preInvocation,
  printDoctor,
  printStatus,
  railHit,
  railPreconditions,
  readActiveTicketRails,
  readTextFileBounded,
  readTranscriptPrefixBounded,
  reclaimJudgedLock,
  resolveActiveTicketId2 as resolveActiveTicketId,
  resolveHarnessProtocol,
  resolveSessionId,
  resolveTranscriptPath,
  resolveUserHome,
  resolveWorkspaceRoot,
  rotateMasterKey,
  runFromStdin,
  sanitizeSessionId,
  tokenizeCommand2 as tokenizeCommand,
  unwrapCall,
  verifyPreExistingTestFiles
};
