#!/usr/bin/env node

// plugins/adlc-cursor/hooks/adlc-session-start.mjs
import { fileURLToPath as fileURLToPath2 } from "node:url";

// plugins/adlc-cursor/lib/session-identity.mjs
import { createHash } from "node:crypto";
var SESSION_ENV_KEY = "ADLC_CURSOR_SESSION_ID";
var PAYLOAD_SESSION_KEYS = Object.freeze(["session_id", "sessionId", "conversation_id", "conversationId"]);
var REJECTED_AS_SESSION_KEYS = Object.freeze(["thread_id", "threadId", "generation_id", "generationId"]);
function resolveSessionIdentity(payload = {}, env = process.env) {
  const envId = trimmed(env?.[SESSION_ENV_KEY]);
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
  return createHash("sha256").update(String(sessionId), "utf8").digest("hex");
}
function trimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function collectPayloadSessionIds(payload) {
  if (!payload || typeof payload !== "object") return { id: null };
  const found = [];
  for (const key of PAYLOAD_SESSION_KEYS) {
    if (!Object.hasOwn(payload, key)) continue;
    const v = trimmed(payload[key]);
    if (v) found.push({ key, v });
  }
  for (const key of REJECTED_AS_SESSION_KEYS) {
    if (Object.hasOwn(payload, key) && trimmed(payload[key]) && found.length === 0) {
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

// plugins/adlc-cursor/lib/workspace-resolve.mjs
import { existsSync as existsSync13, mkdirSync as mkdirSync6, readFileSync as readFileSync10, renameSync as renameSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname11, isAbsolute as isAbsolute5, join as join12, normalize as normalize2, resolve as pathResolve } from "node:path";

// packages/tickets/lib/pointer.mjs
var MAX_POINTER_BYTES = 64 * 1024;
var DEPRECATED_ID_KEYS = Object.freeze(["ticket", "ticketId"]);

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

// packages/tickets/lib/canonical.mjs
import { createHash as createHash2 } from "node:crypto";
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
var sha256 = (value) => createHash2("sha256").update(value).digest("hex");
var ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));
function storeHashFromPairs(pairs) {
  const sorted = [...pairs].sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(sorted));
}
function storeHash(tickets) {
  return storeHashFromPairs(tickets.map((ticket) => [ticket.id, ticketHash(ticket)]));
}

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
import { existsSync as existsSync10, lstatSync as lstatSync6, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join8, resolve as resolve5 } from "node:path";

// packages/tickets/lib/stores/directory.mjs
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
function assertRealDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") throw operational("STORE_NOT_FOUND", `ticket store not found: ${path}`);
    throw operational("STORE_READ_FAILED", `cannot inspect ${path}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${path} must be a real directory`);
  const parent = dirname(path);
  if (parent !== path) {
    const parentStat = lstatSync(parent);
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
      manifest = JSON.parse(readFileSync(join(this.path, ".store.json"), "utf8"));
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
      const fullPath = join(this.path, entry.name);
      const stat = lstatSync(fullPath);
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
    const manifestPath = join(this.path, ".store.json");
    let manifestStat;
    try {
      manifestStat = lstatSync(manifestPath);
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
    const fullPath = join(this.path, name);
    let stat;
    try {
      stat = lstatSync(fullPath);
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
    return Object.freeze(ticket);
  }
  resolvedPath() {
    return resolve(this.path);
  }
};

// packages/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync9, lstatSync as lstatSync5, readFileSync as readFileSync8 } from "node:fs";
import { basename as basename2, dirname as dirname7 } from "node:path";

// packages/tickets/lib/transaction.mjs
import { existsSync as existsSync8, readFileSync as readFileSync7 } from "node:fs";
import { basename, dirname as dirname6, isAbsolute as isAbsolute2, join as join7, relative as relative2, resolve as resolve4 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/tickets/lib/lock.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
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
  const path = join2(root, LOCK_DIRECTORY);
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: "", startedAt: "", command, transactionId })) {
    throw invalid(
      "INVALID_LOCK_OPTIONS",
      "acquireTicketLock requires a string command and a string-or-null transactionId; a lock written from other values could not be released by its own owner."
    );
  }
  mkdirSync(dirname2(path), { recursive: true });
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
      writeOwner(join2(path, "owner.json"), serialized, { flag: "wx" });
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
        const currentOwner = readLockMetadata(join2(path, "owner.json"));
        if (isStaleTicketLock(currentOwner, { staleMs, now, isPidAlive, procStartTime, host })) {
          try {
            removeLock(path, { recursive: true, force: true });
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
  return readLockMetadata(join2(root, LOCK_DIRECTORY, "owner.json"));
}
function releaseTicketLock(lock, { removeLock = rmSync } = {}) {
  if (!lock?.path) return { released: false, reason: "no-lock" };
  if (!existsSync2(lock.path)) return { released: false, reason: "no-lock" };
  const owner = readLockMetadata(join2(lock.path, "owner.json"));
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
import { closeSync as closeSync3, existsSync as existsSync6, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync3, readFileSync as readFileSync5, unlinkSync as unlinkSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { createHmac as createHmac2, randomUUID } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname5, join as join5 } from "node:path";

// packages/tickets/lib/durability.mjs
import {
  closeSync,
  copyFileSync,
  existsSync as existsSync3,
  fsyncSync,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  openSync,
  renameSync,
  rmSync as rmSync2,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname3, resolve as resolve2 } from "node:path";
function fsyncFile(path) {
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function fsyncDirectory(path) {
  if (process.platform === "win32") return false;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}
function durableMkdir(path) {
  const missing = [];
  let cursor = resolve2(path);
  while (!existsSync3(cursor)) {
    missing.push(cursor);
    const parent = dirname3(cursor);
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
    fsyncDirectory(dirname3(directory));
  }
}
function durableWrite(path, content) {
  let st = null;
  try {
    st = lstatSync2(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (st && st.isSymbolicLink()) {
    throw new Error("refusing to write through symlink: " + path);
  }
  const descriptor = openSync(path, "w");
  try {
    writeFileSync2(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname3(resolve2(path)));
}
function durableCopy(source, target) {
  copyFileSync(source, target);
  fsyncFile(target);
  fsyncDirectory(dirname3(resolve2(target)));
}
function durableRename(source, target) {
  const sourceParent = dirname3(resolve2(source));
  const targetParent = dirname3(resolve2(target));
  renameSync(source, target);
  fsyncDirectory(targetParent);
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent);
}
function durableRemove(path, options) {
  const parent = dirname3(resolve2(path));
  rmSync2(path, options);
  fsyncDirectory(parent);
}

// packages/tickets/lib/manifest-segments.mjs
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";

// packages/tickets/lib/manifest-primitives.mjs
import {
  existsSync as existsSync4,
  lstatSync as lstatSync3,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync3,
  openSync as openSync2,
  readSync,
  closeSync as closeSync2,
  unlinkSync as unlinkSync2,
  mkdirSync as mkdirSync3,
  constants as fsConstants
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname4, isAbsolute, join as join3, relative, resolve as resolve3, sep } from "node:path";
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
  return join3(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir = ".adlc", name) {
  return join3(segmentDirPath(dir), name);
}
function markerPath(dir = ".adlc") {
  return join3(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir = ".adlc") {
  return join3(segmentDirPath(dir), LINEAGE_NAME);
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
    st = lstatSync3(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync3(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let fd;
  try {
    fd = openSync2(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_LOCAL_JSON_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_LOCAL_JSON_BYTES, 0);
    if (bytesRead >= MAX_LOCAL_JSON_BYTES) return null;
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync2(fd);
  }
}
function hasActivationMarker(dir = ".adlc") {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir = ".adlc") {
  const rootPath = join3(dir, "manifest.jsonl");
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
    dirStat = lstatSync3(segDir);
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
    const full = join3(segDir, name);
    let st;
    try {
      st = lstatSync3(full);
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
  const fd = openSync2(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync3(fd, JSON.stringify(token));
  } finally {
    closeSync2(fd);
  }
}
function normalizeManifestDirAndCwd(dir = ".adlc", opts = {}) {
  const effectiveDir = dir ?? ".adlc";
  if (opts?.cwd === void 0 || opts?.cwd === null) {
    const resolvedDir2 = resolve3(effectiveDir);
    const defaultCwd = effectiveDir === ".adlc" ? process.cwd() : dirname4(resolvedDir2);
    return { dir: resolvedDir2, cwd: defaultCwd };
  }
  const resolvedCwd = resolve3(opts.cwd);
  const resolvedDir = isAbsolute(effectiveDir) ? resolve3(effectiveDir) : effectiveDir !== ".adlc" && resolve3(dirname4(effectiveDir)) === resolvedCwd ? resolve3(effectiveDir) : resolve3(resolvedCwd, effectiveDir);
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
    fd = openSync2(segmentPath(dir, segmentName), fsConstants.O_RDONLY);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  }
  try {
    const buf = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_FIRST_LINE_BYTES, 0);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1 && bytesRead >= MAX_FIRST_LINE_BYTES) return OVERSIZED_FIRST_ENTRY;
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    if (firstLine.trim() === "") return MALFORMED_FIRST_ENTRY;
    return JSON.parse(firstLine);
  } catch {
    return MALFORMED_FIRST_ENTRY;
  } finally {
    closeSync2(fd);
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
    st = lstatSync3(path);
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
  const rootRaw = readRawLines(join3(dir, "manifest.jsonl"));
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
  const rootPath = join3(dir, "manifest.jsonl");
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
  const root = parseLines(readRawLines2(join4(dir, "manifest.jsonl")));
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
  mkdirSync4(dirname5(path), { recursive: true });
  const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname2(), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync3(lockPath, "wx");
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
      closeSync3(descriptor);
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
    const resolved = resolveOpenSegment(dir, { cwd: dirname5(dir), key });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync4(dirname5(targetPath), { recursive: true });
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
      const descriptor = openSync3(targetPath, "a");
      try {
        writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
        fsyncSync2(descriptor);
      } finally {
        closeSync3(descriptor);
      }
      fsyncDirectory(dirname5(targetPath));
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
  const dir = join5(root, ".adlc");
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
  const path = join5(root, ".adlc/manifest.jsonl");
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
    const descriptor = openSync3(path, "a");
    try {
      writeFileSync4(descriptor, `${JSON.stringify(entry)}
`);
      fsyncSync2(descriptor);
    } finally {
      closeSync3(descriptor);
    }
    fsyncDirectory(dirname5(path));
    return entry;
  });
}

// packages/tickets/lib/trust-root.mjs
import { existsSync as existsSync7, lstatSync as lstatSync4, readFileSync as readFileSync6, readdirSync as readdirSync3 } from "node:fs";
import { join as join6 } from "node:path";
var STORE_MARKER = ".store.json";
function assertNotSymlink(path) {
  let stat;
  try {
    stat = lstatSync4(path);
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
  const directory = join6(root, ARCHIVE_DIRECTORY);
  const legacy = join6(root, LEGACY_ARCHIVE_FILE);
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
          const marker = JSON.parse(readFileSync6(join6(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join6(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync6(join6(directory, entry.name), "utf8"));
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
  const rootManifest = join6(root, ".adlc", "manifest.jsonl");
  const segments = join6(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync7(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join6(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join6(segments, entry.name));
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
  assertNotSymlink(join6(root, ".adlc"));
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
  const transactionId = randomUUID2();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join7(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key, allowUnsigned, root }) : null;
    const target = resolve4(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join7(transactionRoot, "stage", basename(store.path));
    const backup = join7(transactionRoot, "backup", basename(store.path));
    durableMkdir(dirname6(stage));
    durableMkdir(dirname6(backup));
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
    durableWrite(join7(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
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
    durableWrite(join7(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync8(join7(transactionRoot, "journal.json")) && existsSync8(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (!existingLock) releaseTicketLock(lock);
  }
}

// packages/tickets/lib/stores/legacy.mjs
function repositoryRootFor(path, explicit) {
  if (explicit !== null && explicit !== void 0) return explicit;
  const parent = dirname7(path);
  if (basename2(path) === basename2(LEGACY_FILE) && basename2(parent) === dirname7(LEGACY_FILE)) {
    return dirname7(parent);
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
    const stat = lstatSync5(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
    const parentStat = lstatSync5(dirname7(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${dirname7(this.path)} must be a real directory`);
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
var rooted = (root, path) => isAbsolute3(path) ? path : join8(root, path);
function pendingTransactions(root = ".") {
  const path = join8(root, TRANSACTION_DIRECTORY);
  if (!existsSync10(path)) return [];
  const stat = lstatSync6(path);
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
  const legacy = new LegacyTicketStore(join8(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join8(root, ACTIVE_DIRECTORY));
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
var GIT_MAX_BUFFER = 256 * 1024 * 1024;

// packages/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";

// packages/tickets/lib/stores/git-tree.mjs
var MAX_BUFFER = 64 * 1024 * 1024;

// packages/core/lib/llm.mjs
import { spawn } from "node:child_process";
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
  return new Promise((resolve6, reject) => {
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
    p.stdout.on("data", (d) => out += d);
    p.stderr.on("data", (d) => err += d);
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
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
      if (stdinError) return reject(new Error(`agy did not read the full prompt: ${stdinError.message}`));
      if (isAgyTimeout(out)) {
        return reject(new Error("agy: timed out waiting for response"));
      }
      resolve6({ text: out.replace(/\s+$/, ""), usage: null });
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
var GIT_MAX_BUFFER2 = 64 * 1024 * 1024;

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

// packages/core/lib/tickets.mjs
import { existsSync as existsSync11, lstatSync as lstatSync7 } from "node:fs";
import { dirname as dirname8, isAbsolute as isAbsolute4, join as join9 } from "node:path";

// packages/core/lib/glob.mjs
var SLASH2 = "/".charCodeAt(0);

// packages/core/lib/tickets.mjs
var TICKET_TRUST_ROOT_RAILS = Object.freeze([
  ".adlc/tickets.json",
  ".adlc/tickets/.store.json",
  ".adlc/tickets/**",
  ".adlc/current-ticket.json"
]);
function ticketStoreExists(root = ".", override = null) {
  if (override) return existsSync11(isAbsolute4(override) ? override : join9(root, override));
  return existsSync11(join9(root, ".adlc/tickets.json")) || existsSync11(join9(root, ".adlc/tickets/.store.json"));
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

// plugins/adlc-cursor/generated-active-ticket.mjs
import { lstatSync as lstatSync8, openSync as openSync4, fstatSync, readSync as readSync2, closeSync as closeSync4, constants as fsConstants2 } from "node:fs";
import { dirname as dirname9, join as join10 } from "node:path";
var CURRENT_TICKET_FILE2 = ".adlc/current-ticket.json";
var MAX_POINTER_BYTES2 = 64 * 1024;
var ABSENT = /* @__PURE__ */ Symbol("pointer-absent");
function readPointerFileBounded(path) {
  let parentLst;
  try {
    parentLst = lstatSync8(dirname9(path));
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!parentLst.isDirectory()) return null;
  let lst;
  try {
    lst = lstatSync8(path);
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!lst.isFile() || lst.size > MAX_POINTER_BYTES2) return null;
  let fd;
  try {
    fd = openSync4(path, fsConstants2.O_RDONLY | fsConstants2.O_NONBLOCK | fsConstants2.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES2) return null;
    if (lst.dev !== 0 && lst.ino !== 0 && (stat.dev !== lst.dev || stat.ino !== lst.ino)) return null;
    const length = stat.size;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync2(fd, buf, read, length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    try {
      closeSync4(fd);
    } catch {
    }
  }
}
var CANONICAL_ID_KEY = "id";
var DEPRECATED_ID_KEYS2 = Object.freeze(["ticket", "ticketId"]);
var ok = (value) => ({ ok: true, value });
var fail = (kind, code, message) => ({ ok: false, kind, code, message });
var invalid2 = (code, message) => fail("invalid", code, message);
var conflict2 = (code, message) => fail("conflict", code, message);
var isPlainObject2 = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var trimmed2 = (value) => typeof value === "string" ? value.trim() : "";
function conflictMessage(envId, fileId) {
  return `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE2} ("${fileId}"): they name different tickets. The active ticket is per-worktree state \u2014 ADLC supports exactly one active ticket per worktree, and parallel work on a second ticket needs its own worktree (git worktree add <path> -b <branch>), not a second pointer in this one. Failing closed: which ticket governs this build cannot be determined.`;
}
function readActiveTicketPointer2(root = ".") {
  const path = join10(root, CURRENT_TICKET_FILE2);
  const raw = readPointerFileBounded(path);
  if (raw === ABSENT) return ok({ present: false });
  if (raw === null) {
    return fail("operational", "INVALID_CURRENT_TICKET", `cannot read ${CURRENT_TICKET_FILE2} as a bounded regular file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid2("INVALID_CURRENT_TICKET", `cannot parse ${CURRENT_TICKET_FILE2}: ${error.message}`);
  }
  if (typeof parsed === "string") {
    const id2 = parsed.trim();
    if (!id2) return invalid2("INVALID_CURRENT_TICKET", `${CURRENT_TICKET_FILE2} is an empty string pointer`);
    return ok({ present: true, id: id2, ticketHash: null, legacyString: true });
  }
  if (!isPlainObject2(parsed)) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} must be an object like {"id":"T1","ticketHash":"<64 hex>"} (got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}). To deactivate, delete the file.`
    );
  }
  let usedKey = null;
  for (const key of [CANONICAL_ID_KEY, ...DEPRECATED_ID_KEYS2]) {
    if (Object.hasOwn(parsed, key)) {
      usedKey = key;
      break;
    }
  }
  if (usedKey === null) {
    const found = Object.keys(parsed);
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} declares no ticket id: expected "${CANONICAL_ID_KEY}" (or deprecated ${DEPRECATED_ID_KEYS2.map((k) => `"${k}"`).join("/")}), found ${found.length ? found.map((k) => `"${k}"`).join(", ") : "no keys"}. Failing closed rather than treating an unrecognized pointer as "no active ticket". To deactivate, delete the file.`
    );
  }
  const id = trimmed2(parsed[usedKey]);
  if (!id) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} has a "${usedKey}" that is not a non-empty string`
    );
  }
  const value = { present: true, id, ticketHash: trimmed2(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY) value.deprecatedAlias = usedKey;
  return ok(value);
}
function resolveActiveTicketId({ root = ".", env = process.env } = {}) {
  const pointer = readActiveTicketPointer2(root);
  if (!pointer.ok) return pointer;
  const envId = trimmed2(env.ADLC_TICKET) || null;
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
function resolveActiveTicketAgainst2(snapshot, { root = ".", env = process.env, allowLegacyPointer = false } = {}) {
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
      `${CURRENT_TICKET_FILE2} uses the deprecated "${deprecatedAlias}" key; rewrite it as {"id":"${id}","ticketHash":"${expected}"} ("${deprecatedAlias}" is removed in 2.0).`
    );
  }
  if (pointerPresent) {
    if (!ticketHash2) {
      const detail = legacyString ? "a legacy bare-string pointer pins no ticketHash" : `${CURRENT_TICKET_FILE2} pins no ticketHash`;
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

// plugins/adlc-cursor/constants.mjs
var SESSION_TTL_MS = 30 * 60 * 1e3;

// plugins/adlc-cursor/lib/session-state.mjs
import {
  existsSync as existsSync12,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync9,
  renameSync as renameSync2,
  unlinkSync as unlinkSync4,
  writeFileSync as writeFileSync5
} from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname10, join as join11 } from "node:path";
function resolveStateDir(env = process.env) {
  const override = typeof env.ADLC_CURSOR_STATE_DIR === "string" && env.ADLC_CURSOR_STATE_DIR.trim() ? env.ADLC_CURSOR_STATE_DIR.trim() : null;
  return override || join11(homedir(), ".cursor", "adlc");
}
function ensureDir(dir) {
  mkdirSync5(dir, { recursive: true });
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync9(path, "utf8"));
  } catch {
    return null;
  }
}
var LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
function withStateLock(lockPath, fn, {
  now = Date.now(),
  leaseMs = 5e3,
  retries = 40,
  backoffMs = 25,
  wait = Atomics.wait
} = {}) {
  ensureDir(dirname10(lockPath));
  const owner = `${process.pid}.${now}.${Math.random().toString(16).slice(2)}`;
  for (let i = 0; i < retries; i++) {
    try {
      if (existsSync12(lockPath)) {
        const cur = readJson(lockPath);
        if (cur?.leaseUntil && cur.leaseUntil < now) {
          try {
            unlinkSync4(lockPath);
          } catch {
          }
        }
      }
      writeFileSync5(lockPath, `${JSON.stringify({ owner, leaseUntil: now + leaseMs })}
`, { flag: "wx" });
      try {
        return fn({ owner, revalidate() {
          const cur = readJson(lockPath);
          if (!cur || cur.owner !== owner) throw new Error("STATE_LOCK_LOST");
        } });
      } finally {
        const cur = readJson(lockPath);
        if (cur?.owner === owner) {
          try {
            unlinkSync4(lockPath);
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
  throw new Error(`could not acquire state lock: ${lockPath}`);
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
    if (existsSync13(p)) return pathResolve(p);
  } catch {
  }
  return isAbsolute5(p) ? p : null;
}
function isAdlcBearing(root, env = process.env) {
  if (!root) return false;
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  if (ticketStoreExists(root, override)) return true;
  return existsSync13(join12(root, ".adlc", "tickets.json")) || existsSync13(join12(root, ".adlc", "tickets")) || existsSync13(join12(root, ".adlc", "ticket-transactions"));
}
function classifyRoot(root, env = process.env) {
  let snapshot;
  try {
    const store = detectTicketStore({
      root,
      ticketStore: env.ADLC_TICKET_STORE,
      legacyTickets: env.ADLC_TICKETS,
      env
    });
    snapshot = store.load();
  } catch (err) {
    return {
      kind: "error-bearing",
      root,
      code: err?.code || "STORE_LOAD",
      message: err?.message || String(err)
    };
  }
  const against = resolveActiveTicketAgainst2(snapshot, { root, env, allowLegacyPointer: true });
  if (!against.ok) {
    return { kind: "error-bearing", root, code: against.code, message: against.message };
  }
  if (!against.value) {
    return { kind: "inactive", root, ticketId: null };
  }
  return {
    kind: "active-ticket-bearing",
    root,
    ticketId: against.value.id,
    warnings: against.value.warnings ?? []
  };
}
function resolveConsumerWorkspace(payload = {}, env = process.env) {
  const roots = [];
  const wr = payload.workspace_roots ?? payload.workspaceRoots;
  if (Array.isArray(wr)) {
    for (const r of wr) {
      const n = normalizeRootPath(r);
      if (n) roots.push(n);
    }
  }
  const envRoot = normalizeRootPath(env.CURSOR_PROJECT_DIR);
  if (envRoot) roots.push(envRoot);
  const unique = [...new Set(roots)];
  const bearing = unique.filter((r) => isAdlcBearing(r, env));
  const classified = bearing.map((r) => classifyRoot(r, env));
  const errors = classified.filter((c) => c.kind === "error-bearing");
  if (errors.length) {
    return {
      outcome: "error",
      root: null,
      ticketId: null,
      errorClass: errors[0].code,
      message: errors.map((e) => `${e.root}: ${e.message}`).join("; "),
      candidates: classified
    };
  }
  const active = classified.filter((c) => c.kind === "active-ticket-bearing");
  if (active.length === 1) {
    return {
      outcome: "active",
      root: active[0].root,
      ticketId: active[0].ticketId,
      candidates: classified
    };
  }
  if (active.length > 1) {
    return {
      outcome: "ambiguous",
      root: null,
      ticketId: null,
      message: active.map((a) => `${a.root}\u2192${a.ticketId}`).join("; "),
      candidates: classified
    };
  }
  const inactive = classified.filter((c) => c.kind === "inactive");
  if (inactive.length === 1) {
    return {
      outcome: "inactive",
      root: inactive[0].root,
      ticketId: null,
      candidates: classified
    };
  }
  if (inactive.length > 1) {
    const prefer = envRoot && inactive.find((i) => i.root === envRoot);
    const chosen = prefer || inactive.find((i) => unique.includes(i.root)) || inactive[0];
    return {
      outcome: "inactive",
      root: chosen.root,
      ticketId: null,
      candidates: classified
    };
  }
  return {
    outcome: "unresolved",
    root: null,
    ticketId: null,
    message: "no host-supplied ADLC-bearing consumer root",
    candidates: classified
  };
}
var INDEX_NAME = "cursor-session-workspaces.json";
function sessionIndexPath(env = process.env) {
  return env.ADLC_CURSOR_SESSION_INDEX?.trim() || join12(resolveStateDir(env), INDEX_NAME);
}
function upsertSessionResolution({
  sessionId,
  outcome,
  root = null,
  ticketId = null,
  candidates = null,
  errorClass = null,
  env = process.env,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS
}) {
  if (!sessionId) return null;
  const path = sessionIndexPath(env);
  mkdirSync6(dirname11(path), { recursive: true });
  const lockPath = `${path}.lock`;
  return withStateLock(lockPath, ({ revalidate }) => {
    let index = { v: 1, sessions: {} };
    try {
      index = JSON.parse(readFileSync10(path, "utf8"));
      if (!index.sessions || typeof index.sessions !== "object") index.sessions = {};
    } catch {
    }
    for (const [k, rec] of Object.entries(index.sessions)) {
      if (typeof rec?.ts !== "number" || now - rec.ts > ttlMs) delete index.sessions[k];
    }
    const key = sessionSafeId(sessionId);
    const prev = index.sessions[key];
    const generation = (prev?.generation ?? 0) + 1;
    const record = {
      v: 1,
      sessionId,
      outcome,
      root,
      ticketId,
      candidates: candidates?.map((c) => ({ root: c.root, kind: c.kind, ticketId: c.ticketId ?? null })) ?? null,
      errorClass,
      generation,
      ts: now
    };
    index.sessions[key] = record;
    revalidate();
    const tmp = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync6(tmp, `${JSON.stringify(index, null, 2)}
`);
    renameSync3(tmp, path);
    return record;
  }, { now });
}
function enforcementActive(env = process.env) {
  return env.ADLC_P4_ENFORCEMENT !== "0";
}
function phaseHint({ ticketId, enforcing }) {
  if (enforcing) return "enforcing";
  if (ticketId) return "ticketed";
  return "idle";
}

// plugins/adlc-cursor/hooks/adlc-session-start.mjs
function handleSessionStart(payload = {}, { env = process.env, now = Date.now() } = {}) {
  const identity = resolveSessionIdentity(payload, env);
  const workspace = resolveConsumerWorkspace(payload, env);
  const enforcing = enforcementActive(env);
  const contextLines = [];
  let ticketId = null;
  if (identity.conflict) {
    contextLines.push(
      `ADLC session identity conflict: ${identity.message ?? "session id aliases disagree"}.`,
      "Named session state (depth / markers / session index) will not be mutated."
    );
  } else if (workspace.outcome === "active") {
    ticketId = workspace.ticketId;
    contextLines.push(`ADLC active ticket: **${ticketId}**.`);
  } else if (workspace.outcome === "inactive") {
    contextLines.push("ADLC: no active ticket in the resolved consumer workspace.");
  } else if (workspace.outcome === "ambiguous") {
    contextLines.push(
      `ADLC workspace ambiguity: multiple active-ticket-bearing roots (${workspace.message}).`,
      "No consumer root selected \u2014 resolve to a single ADLC worktree."
    );
  } else if (workspace.outcome === "error") {
    contextLines.push(
      `ADLC workspace error (${workspace.errorClass ?? "error"}): ${workspace.message}`
    );
  } else {
    contextLines.push(
      "ADLC: unresolved / no host-supplied ADLC-bearing consumer root (plugin cwd is never selected as a silent fallback)."
    );
  }
  const phase = phaseHint({ ticketId, enforcing });
  contextLines.push(
    `Enforcement: ${enforcing ? "active (ADLC_P4_ENFORCEMENT=1)" : "inactive"} \u2014 phase hint: ${phase}.`
  );
  contextLines.push(
    "Route work through `/adlc-*` commands or the `adlc` skill; do not treat a raw `.adlc/current-ticket.json` or `ADLC_TICKET` read as authoritative alone."
  );
  if (identity.ok && identity.sessionId && !identity.conflict) {
    upsertSessionResolution({
      sessionId: identity.sessionId,
      outcome: workspace.outcome,
      root: workspace.root,
      ticketId: workspace.ticketId,
      candidates: workspace.candidates,
      errorClass: workspace.errorClass ?? null,
      env,
      now
    });
  }
  const out = { additional_context: contextLines.join("\n") };
  if (identity.ok && identity.sessionId && identity.source !== "anonymous") {
    out.env = { [SESSION_ENV_KEY]: identity.sessionId };
  }
  return { ...out, identity, workspace };
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
      process.stderr.write(`adlc-session-start: malformed payload JSON \u2014 ${err.message}
`);
      process.stdout.write(JSON.stringify({
        additional_context: "ADLC sessionStart: unparseable payload; no consumer root selected."
      }));
      return;
    }
  }
  const result = handleSessionStart(payload, { env: process.env });
  const wire = { additional_context: result.additional_context };
  if (result.env) wire.env = result.env;
  process.stdout.write(JSON.stringify(wire));
}
if (process.argv[1] && fileURLToPath2(import.meta.url) === process.argv[1]) {
  main();
}
export {
  handleSessionStart
};
