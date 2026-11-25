// packages/hook-engine/lib/pretool.mjs
import { isAbsolute as isAbsolute6, resolve as resolve7 } from "node:path";

// packages/core/lib/llm.mjs
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
  return new Promise((resolve9, reject) => {
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
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
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
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
      resolve9({ text: out.replace(/\s+$/, ""), usage: null });
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
    models: {
      cheap: "Gemini 3.5 Flash (Medium)",
      mid: "Claude Sonnet 4.6 (Thinking)",
      frontier: "Claude Opus 4.6 (Thinking)"
    },
    send: agySend
  }
];
var PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

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
import { dirname, join } from "node:path";
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
  const path = join(root, CURRENT_TICKET_FILE);
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

// packages/core/lib/ledger.mjs
var ADLC_DIR = ".adlc";

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
import { existsSync as existsSync10, lstatSync as lstatSync7, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join9, resolve as resolve5 } from "node:path";

// packages/tickets/lib/stores/directory.mjs
import { existsSync, lstatSync as lstatSync2, readFileSync, readdirSync } from "node:fs";
import { dirname as dirname2, join as join2, resolve } from "node:path";
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
      manifest = JSON.parse(readFileSync(join2(this.path, ".store.json"), "utf8"));
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
      const fullPath = join2(this.path, entry.name);
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
    const manifestPath = join2(this.path, ".store.json");
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
    const fullPath = join2(this.path, name);
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
import { existsSync as existsSync9, lstatSync as lstatSync6, readFileSync as readFileSync8 } from "node:fs";
import { basename as basename2, dirname as dirname8 } from "node:path";

// packages/tickets/lib/transaction.mjs
import { existsSync as existsSync8, readFileSync as readFileSync7 } from "node:fs";
import { basename, dirname as dirname7, isAbsolute as isAbsolute2, join as join8, relative as relative2, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";

// packages/tickets/lib/lock.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";
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
  host = hostname(),
  writeOwner = writeFileSync,
  removeLock = rmSync,
  makeLockDirectory = mkdirSync
} = {}) {
  const path = join3(root, LOCK_DIRECTORY);
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
      writeOwner(join3(path, "owner.json"), serialized, { flag: "wx" });
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
        const currentOwner = readLockMetadata(join3(path, "owner.json"));
        if (isStaleTicketLock(currentOwner, { staleMs, now, isPidAlive, procStartTime, host })) {
          const staleDir = `${path}.stale-${process.pid}-${randomUUID()}`;
          try {
            renameSync(path, staleDir);
            const movedOwner = readLockMetadata(join3(staleDir, "owner.json"));
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
  return readLockMetadata(join3(root, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync2(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join3(lock.path, "owner.json"));
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
import { closeSync as closeSync4, existsSync as existsSync6, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync4, readFileSync as readFileSync5, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { createHmac as createHmac2, randomUUID as randomUUID2 } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname6, join as join6 } from "node:path";

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
  rmSync as rmSync2,
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
  rmSync2(path, options);
  fsyncDirectory(parent);
}

// packages/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";

// packages/tickets/lib/manifest-primitives.mjs
import {
  existsSync as existsSync4,
  lstatSync as lstatSync4,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync3,
  openSync as openSync3,
  readSync as readSync2,
  closeSync as closeSync3,
  unlinkSync as unlinkSync2,
  mkdirSync as mkdirSync3,
  constants as fsConstants2
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname5, isAbsolute, join as join4, relative, resolve as resolve3, sep } from "node:path";
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
  return join4(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir = ".adlc", name) {
  return join4(segmentDirPath(dir), name);
}
function markerPath(dir = ".adlc") {
  return join4(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir = ".adlc") {
  return join4(segmentDirPath(dir), LINEAGE_NAME);
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
    st = lstatSync4(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync4(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync3(path, fsConstants2.O_RDONLY | fsConstants2.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync2(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync3(fd);
  }
}
function hasActivationMarker(dir = ".adlc") {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir = ".adlc") {
  const rootPath = join4(dir, "manifest.jsonl");
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
    dirStat = lstatSync4(segDir);
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
    const full = join4(segDir, name);
    let st;
    try {
      st = lstatSync4(full);
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
  const fd = openSync3(p, fsConstants2.O_WRONLY | fsConstants2.O_CREAT | fsConstants2.O_TRUNC | fsConstants2.O_NOFOLLOW);
  try {
    writeFileSync3(fd, JSON.stringify(token));
  } finally {
    closeSync3(fd);
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
    fd = openSync3(segmentPath(dir, segmentName), fsConstants2.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync2(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync3(fd);
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
function entrySigValid(key, entry) {
  if (typeof entry?.sig !== "string" || entry.sig.length === 0) return false;
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
    st = lstatSync4(path);
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
function isUnsignedKeyedRoot(declaredAuth, key, requireSignatures, rootResult) {
  return key !== null && !requireSignatures && declaredAuth === "keyed" && rootResult.valid && rootResult.count > 0 && !rootResult.sawSignedEntry && rootResult.firstUnsigned !== null;
}
function verifyChain(nonEmpty, { key, requireSignatures, anchorOnFirst }) {
  if (nonEmpty.length === 0) {
    if (anchorOnFirst) {
      return { valid: false, message: "empty segment file has no first entry to carry the required anchor", count: 0, signed: false, break: { seq: null, lineNo: null, reason: "empty segment file" }, lastRawLine: null, firstAnchor: void 0, sawSignedEntry: false, firstUnsigned: null };
    }
    return { valid: true, message: "empty manifest", count: 0, signed: false, break: null, lastRawLine: null, firstAnchor: void 0, sawSignedEntry: false, firstUnsigned: null };
  }
  let prevRawLine = null;
  let prevSeq = null;
  let firstAnchor;
  let seenSignedEntry = false;
  let firstUnsigned = null;
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
    if (key !== null) {
      const hasSig = entry.sig !== void 0 && entry.sig !== null;
      if (!hasSig) {
        if (firstUnsigned === null) firstUnsigned = { seq: entry.seq, lineNo };
        const toleratedLegacyPrefix = !requireSignatures && !seenSignedEntry;
        if (!toleratedLegacyPrefix) {
          return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "unsigned entry" }, `chain broken at seq ${entry.seq} (line ${lineNo}): unsigned entry`);
        }
      } else if (!entrySigValid(key, entry)) {
        return fail2(lineNo - 1, { seq: entry.seq, lineNo, reason: "signature invalid" }, `chain broken at seq ${entry.seq} (line ${lineNo}): signature invalid`);
      } else {
        seenSignedEntry = true;
      }
    }
    prevRawLine = line;
    prevSeq = entry.seq;
  }
  const signed = key !== null && requireSignatures;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${nonEmpty.length} entries)` : `manifest ok (${nonEmpty.length} entries)`,
    count: nonEmpty.length,
    signed,
    break: null,
    lastRawLine: prevRawLine,
    firstAnchor,
    sawSignedEntry: seenSignedEntry,
    firstUnsigned
  };
  function fail2(count, breakInfo, message) {
    return { valid: false, message, count, signed: false, break: breakInfo, lastRawLine: null, firstAnchor: void 0, sawSignedEntry: false, firstUnsigned: null };
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
function verifyManifestForest(dir = ".adlc", { requireSignatures = true, requireEntries = false, key = null } = {}) {
  const rootRaw = readRawLines(join4(dir, "manifest.jsonl"));
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
    const result = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
    if (isUnsignedKeyedRoot(markerCheck.auth, key, requireSignatures, result)) {
      const u = result.firstUnsigned;
      return { valid: false, message: `chain broken at seq ${u.seq} (line ${u.lineNo}): unsigned entry`, count: result.count, segments: 0, signed: false, break: { seq: u.seq, lineNo: u.lineNo, reason: "unsigned entry", segment: "root" } };
    }
    return { valid: result.valid, message: result.message, count: result.count, segments: 0, signed: result.signed, break: result.break ? { ...result.break, segment: "root" } : null };
  }
  const rootResult = verifyChain(rootRaw, { key, requireSignatures, anchorOnFirst: false });
  if (!rootResult.valid) {
    return { valid: false, message: rootResult.message, count: rootResult.count, segments: segmentNames.length, signed: false, break: { ...rootResult.break, segment: "root" } };
  }
  const chainsBySeq = /* @__PURE__ */ new Map();
  chainsBySeq.set("root", seqMap(rootRaw));
  const anchorBySegment = /* @__PURE__ */ new Map();
  const segmentResults = /* @__PURE__ */ new Map();
  let totalCount = rootResult.count;
  let allSigned = rootResult.count === 0 ? true : rootResult.signed;
  for (const name of segmentNames) {
    const raw = readRawLines(segmentPath(dir, name));
    const result = verifyChain(raw, { key, requireSignatures, anchorOnFirst: true });
    if (!result.valid) {
      return { valid: false, message: `manifest.d/${name}: ${result.message}`, count: totalCount + result.count, segments: segmentNames.length, signed: false, break: { ...result.break, segment: name } };
    }
    chainsBySeq.set(name, seqMap(raw));
    anchorBySegment.set(name, result.firstAnchor === void 0 ? null : result.firstAnchor);
    segmentResults.set(name, result);
    totalCount += result.count;
    allSigned = allSigned && (result.count === 0 ? true : result.signed);
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
  if (key !== null && !requireSignatures) {
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
  const signed = allSigned;
  return {
    valid: true,
    message: signed ? `manifest ok, signed (${totalCount} entries, ${segmentNames.length} segments)` : `manifest ok (${totalCount} entries, ${segmentNames.length} segments)`,
    count: totalCount,
    segments: segmentNames.length,
    signed,
    break: null
  };
}
function isChainIntact(lines, key) {
  return verifyChain(
    lines.map((line, i) => ({ line, lineNo: i + 1 })),
    { key, requireSignatures: false, anchorOnFirst: true }
  ).valid;
}
function resolveOpenSegment(dir = ".adlc", opts = {}) {
  const key = opts?.key ?? null;
  let cwd;
  ({ dir, cwd } = normalizeManifestDirAndCwd(dir, opts));
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
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key, first);
      if (!isChainIntact(lines, key) || !firstAuthenticated) {
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
  const rootPath = join4(dir, "manifest.jsonl");
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
function forestChainsIntact(dir, { key = null } = {}) {
  return verifyManifestForest(dir, { key, requireSignatures: false }).valid;
}
function readForestEntries(dir) {
  const root = parseLines(readRawLines2(join5(dir, "manifest.jsonl")));
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
      descriptor = openSync4(lockPath, "wx");
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
      closeSync4(descriptor);
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
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key, acceptLegacyMatch = false }) {
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
        entry.sig = signV2(key, entry);
      }
      const descriptor = openSync4(targetPath, "a");
      try {
        writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync2(descriptor);
      } finally {
        closeSync4(descriptor);
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
  const dir = join6(root, ".adlc");
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
  const path = join6(root, ".adlc/manifest.jsonl");
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
    if (signingKey) entry.sig = sign(signingKey, entry);
    const descriptor = openSync4(path, "a");
    try {
      writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync4(descriptor);
    }
    fsyncDirectory(dirname6(path));
    return entry;
  });
}

// packages/tickets/lib/trust-root.mjs
import { existsSync as existsSync7, lstatSync as lstatSync5, readFileSync as readFileSync6, readdirSync as readdirSync3 } from "node:fs";
import { join as join7 } from "node:path";
var STORE_MARKER = ".store.json";
function assertNotSymlink(path) {
  let stat;
  try {
    stat = lstatSync5(path);
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
  const directory = join7(root, ARCHIVE_DIRECTORY);
  const legacy = join7(root, LEGACY_ARCHIVE_FILE);
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
          const marker = JSON.parse(readFileSync6(join7(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join7(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync6(join7(directory, entry.name), "utf8"));
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
  const rootManifest = join7(root, ".adlc", "manifest.jsonl");
  const segments = join7(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync7(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join7(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join7(segments, entry.name));
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
  assertNotSymlink(join7(root, ".adlc"));
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
  const transactionRoot = join8(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) : null;
    const target = resolve4(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join8(transactionRoot, "stage", basename(store.path));
    const backup = join8(transactionRoot, "backup", basename(store.path));
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
    durableWrite(join8(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
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
    durableWrite(join8(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync8(join8(transactionRoot, "journal.json")) && existsSync8(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
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
    const stat = lstatSync6(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
    const parentStat = lstatSync6(dirname8(this.path));
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
var rooted = (root, path) => isAbsolute3(path) ? path : join9(root, path);
function pendingTransactions(root = ".") {
  const path = join9(root, TRANSACTION_DIRECTORY);
  if (!existsSync10(path)) return [];
  const stat = lstatSync7(path);
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
  const legacy = new LegacyTicketStore(join9(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join9(root, ACTIVE_DIRECTORY));
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
import { lstatSync as lstatSync8, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute as isAbsolute4, join as join10, parse, relative as relative3 } from "node:path";
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
    return lstatSync8(p);
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
      cur = join10(cur, "..");
      continue;
    }
    const next = join10(cur, seg);
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
  const final = walk(start, segmentsOf(filePath)) ?? (isAbsolute4(filePath) ? filePath : join10(realRoot, filePath));
  return relative3(realRoot, final).split("\\").join("/");
}

// packages/core/lib/mutate.mjs
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
import { existsSync as existsSync11, lstatSync as lstatSync9, readFileSync as readFileSync9, readlinkSync as readlinkSync2, realpathSync as realpathSync2, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename as basename3, dirname as dirname9, isAbsolute as isAbsolute5, join as join11, relative as relative4, resolve as resolve6 } from "node:path";
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
    const st = lstatSync9(filePath);
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
      return pending.length === 0 ? realBase : join11(realBase, ...pending);
    } catch {
      if (seen.has(cur)) return abs;
      seen.add(cur);
      try {
        if (lstatSync9(cur).isSymbolicLink()) {
          cur = resolve6(dirname9(cur), readlinkSync2(cur));
          continue;
        }
      } catch {
      }
      const parent = dirname9(cur);
      if (parent === cur) return pending.length === 0 ? cur : join11(cur, ...pending);
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
  const gitEntry = join11(dir, ".git");
  let stats;
  try {
    stats = lstatSync9(gitEntry);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    if (!existsSync11(join11(gitEntry, "HEAD"))) return null;
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
    const backRaw = readSmallRegularFile(join11(realGitDir, "gitdir"));
    const commonRaw = readSmallRegularFile(join11(realGitDir, "commondir"));
    if (backRaw && commonRaw) {
      const backTrimmed = backRaw.trim();
      const commonTrimmed = commonRaw.trim();
      if (backTrimmed && commonTrimmed) {
        const realBackDir = realpathSync2(dirname9(resolve6(realGitDir, backTrimmed)));
        const realCommon = realpathSync2(resolve6(realGitDir, commonTrimmed));
        const realWorktrees = realpathSync2(join11(realCommon, "worktrees"));
        const relWt = relative4(realWorktrees, realGitDir);
        const underWorktrees = relWt !== "" && !relWt.startsWith("..") && !isAbsolute5(relWt);
        if (realBackDir === realDir && underWorktrees && existsSync11(join11(realCommon, "HEAD"))) {
          return { kind: "worktree", gitDir: realGitDir, commonGitDir: realCommon };
        }
      }
      if (existsSync11(join11(realGitDir, "HEAD")) || existsSync11(join11(realGitDir, "commondir"))) {
        return { kind: "gitfile", gitDir: realGitDir, commonGitDir: null };
      }
    }
    if (existsSync11(join11(realGitDir, "HEAD")) || existsSync11(join11(realGitDir, "commondir"))) {
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
    return existsSync11(join11(dir, storeOverride.trim()));
  }
  return existsSync11(join11(dir, ".adlc", "tickets", ".store.json")) || existsSync11(join11(dir, ".adlc", "tickets.json"));
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
        isSym = lstatSync9(startLexical).isSymbolicLink();
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
var PATCH_TOOL_NAMES = /* @__PURE__ */ new Set([
  "apply_patch",
  "patch"
]);
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
function isOutsideRoot(rel) {
  return rel === ".." || rel.startsWith("../") || isAbsolute6(rel);
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
  const absCandidate = isAbsolute6(raw) ? raw : resolve7(baseDir, raw);
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
function readActiveTicketRails(root, { storeOverride = null, env = process.env } = {}) {
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], error: null };
  let snapshot;
  try {
    const store = detectTicketStore({ root, ticketStore: storeOverride ?? void 0, allowRecovery: true, env });
    snapshot = store.load();
  } catch (err) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      error: `ticket store unreadable: ${err?.message ?? String(err)}`
    };
  }
  const tickets = snapshot.tickets ?? [];
  const active = activeTickets(tickets);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env });
  if (!resolved.ok) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
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
        error: `active ticket "${selected.id}" is already completed`
      };
    }
    const rails = Array.isArray(selected.rails) ? selected.rails.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()) : [];
    return { ok: true, tickets: active, activeTicket: selected, rails, error: null };
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
  return { ok: true, tickets: active, activeTicket, rails: [...railSet], error: null };
}
function extractFilePathsFromInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const out = [];
  const keys = [
    "file_path",
    "filePath",
    "path",
    "Path",
    "TargetFile",
    "target_file",
    "target_path",
    "old_path",
    "new_path",
    "source",
    "destination",
    "dest"
  ];
  for (const k of keys) {
    if (typeof toolInput[k] === "string" && toolInput[k].trim()) {
      out.push(toolInput[k].trim());
    }
  }
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) {
      if (typeof f === "string" && f.trim()) out.push(f.trim());
      else if (f && typeof f === "object" && typeof f.path === "string" && f.path.trim()) {
        out.push(f.path.trim());
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
  storeOverride = null,
  env = process.env
} = {}) {
  const effectiveBase = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd();
  const root = enclosingAdlcRoot(effectiveBase, { outerRoot, storeOverride });
  const normalizedTool = String(toolName ?? "").trim().toLowerCase();
  if (hasConflictingToolWorkdirs(toolInput, effectiveBase)) {
    return {
      decision: "deny",
      reason: "conflicting working directory arguments in tool input",
      matchedRail: null,
      resolvedPath: null,
      root
    };
  }
  let effectiveRails;
  if (Array.isArray(rails)) {
    effectiveRails = rails;
  } else if (root) {
    const loaded = readActiveTicketRails(root, { storeOverride, env });
    if (!loaded.ok) {
      if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
        return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
      }
      return {
        decision: "deny",
        reason: `ADLC trust-state error (failing closed): ${loaded.error}`,
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    effectiveRails = loaded.rails;
  } else {
    effectiveRails = [];
  }
  if (effectiveRails.length === 0) {
    return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
  }
  if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
    return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
  }
  if (toolInput?.__unparseable === true) {
    return {
      decision: "deny",
      reason: "unparseable tool payload while frozen rails are active \u2014 failing closed",
      matchedRail: null,
      resolvedPath: null,
      root
    };
  }
  const checkRoot = root ?? effectiveBase;
  const toolWorkdir = extractToolWorkdir(toolInput);
  const pathBase = toolWorkdir ? isAbsolute6(toolWorkdir) ? toolWorkdir : resolve7(effectiveBase, toolWorkdir) : effectiveBase;
  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    const cmd = String(
      toolInput?.command ?? toolInput?.CommandLine ?? toolInput?.cmd ?? ""
    );
    const cls = classifyShellCommand(cmd);
    if (cls.readOnly && cls.writeOption) {
      return {
        decision: "deny",
        reason: "shell command uses a file-writing output option while frozen rails are active",
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    if (cls.readOnly) {
      return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
    }
    if (!cls.mutating) {
      return {
        decision: "deny",
        reason: "shell command is neither positively read-only nor a transparent file mutation while frozen rails are active",
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    if (cls.opaque || cls.changesCwd || cls.expands || cls.paths.length === 0) {
      return {
        decision: "deny",
        reason: "shell mutation cannot be verified against frozen rails (opaque, cwd-changing, expanding, or targetless)",
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    const checkAncestorDir = isDirectoryDeletionCommand(cmd);
    for (const p of cls.paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? "ancestor directory of frozen rail" : "frozen rail";
        return {
          decision: "deny",
          reason: `shell command targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root
        };
      }
    }
    return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
  }
  if (PATCH_TOOL_NAMES.has(normalizedTool)) {
    const patchText = String(toolInput?.patch ?? toolInput?.input ?? toolInput?.diff ?? "");
    const patchPaths = /* @__PURE__ */ new Set();
    collectPatchPaths(patchText, patchPaths);
    if (patchPaths.size === 0) {
      return {
        decision: "deny",
        reason: "patch payload exposes no verifiable target paths while frozen rails are active",
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    for (const p of patchPaths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir: false, baseDir: pathBase });
      if (hit.hit) {
        return {
          decision: "deny",
          reason: `patch targets frozen rail "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root
        };
      }
    }
    return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
  }
  if (FILE_MUTATION_TOOL_NAMES.has(normalizedTool)) {
    const paths = extractFilePathsFromInput(toolInput);
    if (paths.length === 0) {
      return {
        decision: "deny",
        reason: `${toolName} exposes no verifiable target path while frozen rails are active`,
        matchedRail: null,
        resolvedPath: null,
        root
      };
    }
    const checkAncestorDir = DELETE_OR_MOVE_TOOL_NAMES.has(normalizedTool);
    for (const p of paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? "ancestor directory of frozen rail" : "frozen rail";
        return {
          decision: "deny",
          reason: `${toolName} targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root
        };
      }
    }
    return { decision: "allow", reason: null, matchedRail: null, resolvedPath: null, root };
  }
  return {
    decision: "deny",
    reason: `unrecognized tool "${toolName || "<empty>"}" cannot be verified as read-only while frozen rails are active`,
    matchedRail: null,
    resolvedPath: null,
    root
  };
}

// packages/flail-detector/lib/signals.mjs
import { isAbsolute as isAbsolute7, relative as relative5, resolve as resolve8 } from "node:path";
var ERROR_LINE_RE = /error|exception|failed|cannot|ENOENT/i;
var LOG_PREFIX = String.raw`(?:(?:\[[^\]\n]*\]|\d[\d:.,+\-TZ/]*|INFO|WARN|WARNING|DEBUG|TRACE|ERROR|NOTICE):?[ \t]+)*`;
var VERB = "(?:[Ww]riting|[Ee]diting|[Cc]reated|WRITING|EDITING|CREATED)";
var VERB_PATTERN = new RegExp(String.raw`^[ \t]*${LOG_PREFIX}${VERB}[ \t]+(\S+)`);
var PATH_EXTRACT_PATTERNS = [
  VERB_PATTERN,
  /"file_path"\s*:\s*"([^"]+)"/
];
function normalizeError(line) {
  return line.toLowerCase().replace(/0x[0-9a-f]+/gi, "").replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "").replace(/(?:\/[^\s/][^\s]*|[A-Za-z]:\\[^\s]*)/g, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
}
function extractPath(line) {
  for (const re of PATH_EXTRACT_PATTERNS) {
    const m = re.exec(line);
    if (m !== null) return m[1];
  }
  return null;
}
function detectRepeatedErrors(steps, maxRepeat) {
  const counts = /* @__PURE__ */ new Map();
  const normalizedSteps = steps.map((item) => {
    if (typeof item === "string") return [item];
    if (Array.isArray(item)) return item;
    return [];
  });
  for (const stepLines of normalizedSteps) {
    if (!Array.isArray(stepLines)) continue;
    const stepSigs = /* @__PURE__ */ new Set();
    for (const line of stepLines) {
      if (typeof line !== "string" || !ERROR_LINE_RE.test(line)) continue;
      const sig = normalizeError(line);
      if (!sig || sig.length < 5) continue;
      if (/^created at:?$/.test(sig) || /^completed at:?$/.test(sig)) continue;
      stepSigs.add(sig);
    }
    for (const sig of stepSigs) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
  }
  const results = [];
  for (const [signature, count] of counts) {
    if (count >= maxRepeat) {
      results.push({ signature, count });
    }
  }
  return results;
}
function normalizeScopePath(rawPath, cwd = null) {
  let p = String(rawPath ?? "").replace(/\\/g, "/");
  if (cwd && (isAbsolute7(p) || /^[a-zA-Z]:\//.test(p))) {
    const rel = relative5(resolve8(cwd), resolve8(p)).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..") && !isAbsolute7(rel)) {
      p = rel;
    }
  }
  return p.replace(/^\.\//, "");
}
function detectScopeViolations(lines, scopes, { cwd = null } = {}) {
  if (!scopes || scopes.length === 0) return [];
  const violations = [];
  for (const line of lines) {
    const rawPath = extractPath(line);
    if (!rawPath) continue;
    const path = normalizeScopePath(rawPath, cwd);
    const inScope = scopes.some((g) => globMatch2(g, path));
    if (!inScope) {
      violations.push({ path, line: line.trimEnd() });
    }
  }
  return violations;
}
function detectEditChurn(lines, { cwd = null } = {}) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const rawPath = extractPath(line);
    if (!rawPath) continue;
    const path = normalizeScopePath(rawPath, cwd);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const results = [];
  for (const [path, count] of counts) {
    if (count >= 3) {
      results.push({ path, count });
    }
  }
  return results;
}
function detectSizeExceeded(bytes, maxBytes) {
  if (maxBytes == null) return false;
  return bytes > maxBytes;
}
function detectBudgetExceeded(spentTokens, budget) {
  if (spentTokens == null || budget == null) return false;
  return spentTokens > budget;
}

// packages/flail-detector/lib/analyze.mjs
function analyze({ lines, bytes, scopes, maxRepeat, maxBytes, spentTokens = null, budget = null, cwd = null }) {
  const repeatedErrors = detectRepeatedErrors(lines, maxRepeat);
  const scopeViolations = detectScopeViolations(lines, scopes, { cwd });
  const editChurn = detectEditChurn(lines, { cwd });
  const sizeExceeded = detectSizeExceeded(bytes, maxBytes);
  const budgetExceeded = detectBudgetExceeded(spentTokens, budget);
  const isFlail = repeatedErrors.length > 0 || scopeViolations.length > 0 || editChurn.length > 0 || sizeExceeded || budgetExceeded;
  const signals = [];
  if (repeatedErrors.length > 0) {
    signals.push({
      type: "repeated-error",
      entries: repeatedErrors
    });
  }
  if (scopeViolations.length > 0) {
    signals.push({
      type: "scope-violation",
      entries: scopeViolations
    });
  }
  if (editChurn.length > 0) {
    signals.push({
      type: "edit-churn",
      entries: editChurn
    });
  }
  if (sizeExceeded) {
    signals.push({
      type: "size",
      bytes,
      maxBytes
    });
  }
  if (budgetExceeded) {
    signals.push({
      type: "budget",
      spentTokens,
      budget
    });
  }
  let deadEnds = null;
  if (isFlail && repeatedErrors.length > 0) {
    deadEnds = repeatedErrors.map((e) => e.signature);
  }
  return {
    verdict: isFlail ? "flail" : "clean",
    signals,
    bytes,
    ...isFlail && {
      recommendation: buildRecommendation(deadEnds)
    }
  };
}
function buildRecommendation(deadEnds) {
  if (deadEnds && deadEnds.length > 0) {
    return "Kill the session. Append these dead-ends to the ticket: " + deadEnds.join("; ");
  }
  return "Kill the session. Review signals above and regenerate fresh.";
}

// packages/hook-engine/lib/posttool.mjs
var DEFAULT_MAX_REPEAT = 3;
function evaluatePostTool({
  lines = [],
  bytes = 0,
  scopes = [],
  maxRepeat = DEFAULT_MAX_REPEAT,
  maxBytes = null,
  spentTokens = null,
  budget = null,
  cwd = null
} = {}) {
  const analysis = analyze({
    lines,
    bytes,
    scopes,
    maxRepeat,
    maxBytes,
    spentTokens,
    budget,
    cwd
  });
  if (analysis.verdict !== "flail") {
    return { status: "ok", flailing: false, signals: [], advisory: null };
  }
  const labels = analysis.signals.map((s) => s.type).join(", ");
  return {
    status: "warn",
    flailing: true,
    signals: analysis.signals,
    advisory: `ADLC flail-detector warning: ${labels}`
  };
}

// packages/hook-engine/lib/stop.mjs
import { closeSync as closeSync5, constants as fsConstants3, fstatSync as fstatSync2, openSync as openSync5, readSync as readSync3 } from "node:fs";
import { join as join12 } from "node:path";

// packages/build-gate/lib/risk.mjs
var TRUST_ROOT_PATHS = [".adlc/tickets.json", ".adlc/tickets/**", ".adlc/current-ticket.json"];
var MANIFEST_PATH = ".adlc/manifest.jsonl";
var MANIFEST_PATHS = [MANIFEST_PATH, ".adlc/manifest.d/**"];
var HIGH_RISK_CATEGORIES = /* @__PURE__ */ new Set(["contract", "architecture"]);
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

// packages/gate-manifest/lib/verify.mjs
function verify(dir = ADLC_DIR, { requireSignatures = true, requireEntries = false, key: keyParam } = {}) {
  const key = validateKeyParam(keyParam);
  return verifyManifestForest(dir, { requireSignatures, requireEntries, key });
}

// packages/hook-engine/lib/stop.mjs
var MAX_MANIFEST_FILE_BYTES = 4 * 1024 * 1024;
var MAX_MANIFEST_SEGMENTS = 64;
var MAX_MANIFEST_LINES = 5e4;
function readBoundedRegularFile(filePath, maxBytes = MAX_MANIFEST_FILE_BYTES) {
  const flags = fsConstants3.O_RDONLY | (fsConstants3.O_NOFOLLOW ?? 0) | (fsConstants3.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = openSync5(filePath, flags);
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "absent", content: null };
    return { status: "error", reason: `cannot open ${filePath}: ${err?.message ?? String(err)}` };
  }
  try {
    const st = fstatSync2(fd);
    if (!st.isFile()) {
      return { status: "error", reason: `${filePath} is not a regular file` };
    }
    if (st.size > maxBytes) {
      return { status: "error", reason: `${filePath} exceeds ${maxBytes}-byte manifest scan bound` };
    }
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync3(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return { status: "ok", content: buf.toString("utf8", 0, offset) };
  } finally {
    closeSync5(fd);
  }
}
function parseStrictJsonl(filePath, { maxBytes = MAX_MANIFEST_FILE_BYTES, remainingLines }) {
  const read = readBoundedRegularFile(filePath, maxBytes);
  if (read.status === "absent") return { ok: true, entries: [], linesRead: 0, error: null };
  if (read.status !== "ok") return { ok: false, entries: [], linesRead: 0, error: read.reason };
  const entries = [];
  let linesRead = 0;
  for (const line of read.content.split(/\r?\n/)) {
    const trimmed2 = line.trim();
    if (!trimmed2) continue;
    linesRead += 1;
    if (linesRead > remainingLines) {
      return { ok: false, entries: [], linesRead, error: `manifest scan exceeded ${MAX_MANIFEST_LINES}-line bound` };
    }
    let obj;
    try {
      obj = JSON.parse(trimmed2);
    } catch {
      return { ok: false, entries: [], linesRead, error: `malformed JSONL line in ${filePath}` };
    }
    if (!obj || typeof obj !== "object") {
      return { ok: false, entries: [], linesRead, error: `non-object JSONL entry in ${filePath}` };
    }
    entries.push(obj);
  }
  return { ok: true, entries, linesRead, error: null };
}
function hasManifestEvidence(root, {
  gate = null,
  ticketId = null,
  revision = null,
  ticketHash: ticketHash2 = null,
  key = process.env.ADLC_MANIFEST_KEY ?? null,
  maxBytes = MAX_MANIFEST_FILE_BYTES,
  maxSegments = MAX_MANIFEST_SEGMENTS
} = {}) {
  if (!root) return { found: false, matchingEntries: [], manifestSegments: [], error: null };
  if (typeof key !== "string" || key.length === 0) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: [],
      error: "ADLC_MANIFEST_KEY is required to verify manifest evidence"
    };
  }
  const adlcDir = join12(root, ".adlc");
  const rootManifest = join12(adlcDir, "manifest.jsonl");
  const { valid: segments, invalid: invalid3 } = discoverSegments(adlcDir);
  if (invalid3.length > 0) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: segments,
      error: `invalid manifest.d/ entry: ${invalid3[0].name} (${invalid3[0].reason})`
    };
  }
  if (segments.length > maxSegments) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: segments,
      error: `manifest.d/ exceeds ${maxSegments}-segment scan bound`
    };
  }
  let remainingLines = MAX_MANIFEST_LINES;
  const allEntries = [];
  const filesToScan = [rootManifest, ...segments.map((seg) => segmentPath(adlcDir, seg))];
  for (const filePath of filesToScan) {
    const parsed = parseStrictJsonl(filePath, { maxBytes, remainingLines });
    if (!parsed.ok) {
      return { found: false, matchingEntries: [], manifestSegments: segments, error: parsed.error };
    }
    remainingLines -= parsed.linesRead;
    allEntries.push(...parsed.entries);
  }
  if (allEntries.length > 0) {
    const forestCheck = verify(adlcDir, { requireSignatures: true, requireEntries: false, key });
    if (!forestCheck.valid) {
      const reason = Array.isArray(forestCheck.errors) && forestCheck.errors.length > 0 ? forestCheck.errors[0] : "manifest forest verification failed";
      return { found: false, matchingEntries: [], manifestSegments: segments, error: reason };
    }
  }
  const matchingEntries = allEntries.filter((entry) => {
    if (gate && entry.gate !== gate) return false;
    if (ticketId && entry.ticket !== ticketId) return false;
    if (revision && entry.data?.revision !== revision) return false;
    if (ticketHash2) {
      const entryHash = entry.data?.ticketHash ?? entry.data?.cache?.ticketHash ?? null;
      if (entryHash !== ticketHash2) return false;
    }
    return true;
  });
  return {
    found: matchingEntries.length > 0,
    matchingEntries,
    manifestSegments: segments,
    error: null
  };
}
function evaluateStop({
  cwd = process.cwd(),
  outerRoot = null,
  ticket = null,
  requiredGate = null,
  revision = null,
  ticketHash: ticketHash2 = null,
  requireEvidence = false,
  key = process.env.ADLC_MANIFEST_KEY ?? null
} = {}) {
  const root = enclosingAdlcRoot(cwd, { outerRoot });
  const loaded = !ticket && root ? readActiveTicketRails(root) : null;
  if (loaded && !loaded.ok && requireEvidence) {
    return {
      decision: "block",
      reason: `ADLC trust-state error: ${loaded.error}`,
      risk: { tier: "high", signals: ["trust-state-error"] },
      hasEvidence: false,
      manifestSegments: [],
      root
    };
  }
  const activeTicket = ticket ?? loaded?.activeTicket ?? null;
  const risk = computeRiskTier(activeTicket ?? {});
  const evidence = root ? hasManifestEvidence(root, {
    gate: requiredGate,
    ticketId: activeTicket?.id ?? null,
    revision,
    ticketHash: ticketHash2,
    key
  }) : { found: false, matchingEntries: [], manifestSegments: [], error: null };
  if (requireEvidence && (evidence.error || !evidence.found)) {
    const label = requiredGate ? `gate "${requiredGate}"` : "gate";
    const ticketLabel = activeTicket?.id ? ` for ticket "${activeTicket.id}"` : "";
    const detail = evidence.error ? `cannot verify ${label} evidence: ${evidence.error}` : `missing signed ${label} evidence in .adlc/manifest.jsonl or .adlc/manifest.d/${ticketLabel}`;
    return {
      decision: "block",
      reason: detail,
      risk,
      hasEvidence: false,
      manifestSegments: evidence.manifestSegments,
      root
    };
  }
  return {
    decision: "allow",
    reason: null,
    risk,
    hasEvidence: evidence.found,
    manifestSegments: evidence.manifestSegments,
    root
  };
}

// packages/hook-engine/lib/session-start.mjs
function evaluateSessionStart({
  cwd = process.cwd(),
  outerRoot = null,
  storeOverride = null,
  env = process.env
} = {}) {
  const root = enclosingAdlcRoot(cwd, { outerRoot, storeOverride });
  if (!root) {
    return {
      root: null,
      activeTicket: null,
      rails: [],
      risk: { tier: "normal", signals: [] },
      additionalContext: ""
    };
  }
  const { activeTicket, rails } = readActiveTicketRails(root, { storeOverride, env });
  const risk = computeRiskTier(activeTicket ?? {});
  if (!activeTicket && rails.length === 0) {
    return { root, activeTicket: null, rails: [], risk, additionalContext: "" };
  }
  const lines = [];
  if (activeTicket) {
    lines.push(`ADLC active ticket: ${activeTicket.id} (risk: ${risk.tier})`);
  }
  if (rails.length > 0) {
    lines.push(`Frozen rails (${rails.length}): ${rails.join(", ")}`);
  }
  return {
    root,
    activeTicket,
    rails,
    risk,
    additionalContext: lines.join("\n")
  };
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
  if (e === "sessionstart" || e === "session.created" || e === "session_start") {
    return "session-start";
  }
  return e || "pretool";
}
function parseToolArgsString(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_TOOL_ARGS_BYTES) {
    return { __unparseable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { __unparseable: true };
  } catch {
    return { __unparseable: true };
  }
}
function normalizeHookInput(harness, rawPayload = {}) {
  const proto = resolveHarnessProtocol(harness);
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const event = canonicalEventName(
    p.hook_event_name ?? p.hookEventName ?? p.event ?? p.type ?? "pretool"
  );
  const toolName = String(
    p.tool_name ?? p.toolName ?? p.tool ?? p.name ?? ""
  );
  let toolInput = (p.tool_input && typeof p.tool_input === "object" && !Array.isArray(p.tool_input) ? p.tool_input : null) ?? (p.toolInput && typeof p.toolInput === "object" && !Array.isArray(p.toolInput) ? p.toolInput : null) ?? (p.toolArgs && typeof p.toolArgs === "object" && !Array.isArray(p.toolArgs) ? p.toolArgs : null) ?? (p.args && typeof p.args === "object" && !Array.isArray(p.args) ? p.args : null) ?? (p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : null);
  if (!toolInput && typeof p.toolArgs === "string") {
    toolInput = parseToolArgsString(p.toolArgs);
  }
  if (!toolInput) {
    toolInput = {};
  }
  const toolResult = p.tool_response ?? p.toolResult ?? p.result ?? p.output ?? null;
  const cwd = (typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : null) ?? (typeof p.directory === "string" && p.directory.trim() ? p.directory.trim() : null) ?? (typeof p.workingDirectory === "string" && p.workingDirectory.trim() ? p.workingDirectory.trim() : null) ?? null;
  const outerRoot = (Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === "string" ? p.workspace_roots[0] : null) ?? (typeof p.project_dir === "string" ? p.project_dir : null) ?? (typeof p.projectRoot === "string" ? p.projectRoot : null) ?? null;
  const sessionId = (typeof p.session_id === "string" ? p.session_id : null) ?? (typeof p.sessionId === "string" ? p.sessionId : null) ?? null;
  return { harness: proto, event, toolName, toolInput, toolResult, cwd, outerRoot, sessionId };
}
function formatHookOutput(harness, event, result = {}) {
  const proto = resolveHarnessProtocol(harness);
  const ev = canonicalEventName(event);
  const denied = result.decision === "deny" || result.decision === "block";
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
    } else if (ev === "session-start" && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context
        }
      };
    } else if (ev === "posttool" && context) {
      payload = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
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
      payload = denied ? { decision: "deny", reason, allow_tool: false, deny_reason: reason } : { decision: "allow", allow_tool: true };
    } else if (ev === "stop") {
      payload = denied ? { decision: "continue", reason } : { decision: "stop" };
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
export {
  DEFAULT_MAX_REPEAT,
  HARNESS_PROTOCOLS,
  MAX_MANIFEST_FILE_BYTES,
  MAX_MANIFEST_LINES,
  MAX_MANIFEST_SEGMENTS,
  enclosingAdlcRoot,
  evaluatePostTool,
  evaluatePreTool,
  evaluateSessionStart,
  evaluateStop,
  formatHookOutput,
  hasManifestEvidence,
  isAncestorDirOfRail,
  isDirectoryDeletionCommand,
  normalizeHookInput,
  railHit,
  readActiveTicketRails,
  resolveHarnessProtocol
};
