#!/usr/bin/env node

// <define:__ADLC_MCP_BUILD_METADATA__>
var define_ADLC_MCP_BUILD_METADATA_default = { pluginVersion: "1.11.1", bundledDependencies: { "@adlc/core": "1.11.1", "@adlc/tickets": "1.11.1" }, esbuildVersion: "0.28.1" };

// plugins/adlc-cursor/bin/adlc-mcp-wrapper.mjs
import { realpathSync } from "node:fs";
import { resolve as resolve5 } from "node:path";
import { fileURLToPath } from "node:url";

// plugins/adlc-cursor/lib/mcp-roots-proxy.mjs
import { spawn as spawn2 } from "node:child_process";
import { createInterface as createInterface2 } from "node:readline";

// plugins/adlc-cursor/lib/mcp-build-metadata.mjs
var SOURCE_MCP_BUILD_METADATA = Object.freeze({
  pluginVersion: "1.11.1",
  bundledDependencies: Object.freeze({
    "@adlc/core": "1.11.1",
    "@adlc/tickets": "1.11.1"
  }),
  esbuildVersion: "0.28.1"
});
var MCP_BUILD_METADATA = typeof define_ADLC_MCP_BUILD_METADATA_default === "undefined" ? SOURCE_MCP_BUILD_METADATA : Object.freeze(define_ADLC_MCP_BUILD_METADATA_default);

// plugins/adlc-cursor/lib/workspace-resolve.mjs
import { existsSync as existsSync11, mkdirSync as mkdirSync5, readFileSync as readFileSync8, renameSync as renameSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname10, isAbsolute as isAbsolute4, join as join10, normalize as normalize2, resolve as pathResolve } from "node:path";

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
  for (const key2 of Object.keys(value).sort(compareTicketIds)) {
    const item = value[key2];
    if (item === void 0 || typeof item === "function" || typeof item === "symbol") {
      throw invalid("NON_JSON_VALUE", `${path}.${key2} is not JSON`);
    }
    output[key2] = normalize(item, `${path}.${key2}`);
  }
  return output;
}
var canonicalJson = (value) => JSON.stringify(normalize(value));
var prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}
`;
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
var ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));
function storeHash(tickets) {
  const pairs = tickets.map((ticket) => [ticket.id, ticketHash(ticket)]).sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(pairs));
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
  if (errors.length) throw invalid("INVALID_TICKET_STORE", `ticket store validation failed (${errors.length} error(s))`, errors);
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
    summary: "Relative build-time estimate used to order the ticket DAG. Defaults to 1.",
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
    summary: "Path globs frozen for the duration of the build; rails-guard denies edits to them. Once any ticket declares rails the ticket store itself becomes a frozen trust root, so later ticket writes need ADLC_RAILS_BYPASS=1.",
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
    summary: 'Ordering constraints, prerequisite to dependent. An edge with "to": "TX" on THIS ticket means this ticket must complete before TX \u2014 so making this ticket depend on an existing one is an edge added to that existing ticket, never a reversed edge here. An edge may also carry "contract": a path to the interface it guarantees TX can consume, which is what lets the two be built in parallel; ticket-sync recognizes it and nothing else on an edge.',
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["to"],
        properties: {
          to: { type: "string", minLength: 1, description: "Id of the dependent ticket, which must not start before this one completes." },
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
  const serialized = JSON.stringify(value, function reject(key2, item) {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError(`deepClone cannot round-trip the non-finite number ${item}`);
    }
    if (Array.isArray(this) && (item === void 0 || typeof item === "function" || typeof item === "symbol")) {
      throw new TypeError(`deepClone cannot round-trip ${String(item)} at array index ${key2}`);
    }
    if (Array.isArray(item)) {
      const extra = Reflect.ownKeys(item).filter((key3) => Object.getOwnPropertyDescriptor(item, key3)?.enumerable).filter((key3) => typeof key3 === "symbol" || !(/^(0|[1-9][0-9]*)$/.test(key3) && Number(key3) < 4294967295));
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
import { existsSync as existsSync9, lstatSync as lstatSync5, readdirSync as readdirSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join7, resolve as resolve4 } from "node:path";

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
  resolvedPath() {
    return resolve(this.path);
  }
};

// packages/tickets/lib/stores/legacy.mjs
import { existsSync as existsSync8, lstatSync as lstatSync4, readFileSync as readFileSync7 } from "node:fs";
import { basename as basename2, dirname as dirname7 } from "node:path";

// packages/tickets/lib/transaction.mjs
import { existsSync as existsSync7, readFileSync as readFileSync6 } from "node:fs";
import { basename, dirname as dirname6, isAbsolute, join as join6, relative as relative2, resolve as resolve3 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/tickets/lib/lock.mjs
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
var sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
function acquireTicketLock(root = ".", {
  retries = 50,
  delayMs = 20,
  command = process.argv.join(" "),
  transactionId = null,
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
      const metadata = { version: 1, pid: process.pid, hostname: hostname(), startedAt: (/* @__PURE__ */ new Date()).toISOString(), command, transactionId };
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
import { closeSync as closeSync3, existsSync as existsSync5, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync3, readFileSync as readFileSync4, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { createHmac as createHmac2, randomUUID } from "node:crypto";
import { hostname as hostname2 } from "node:os";
import { dirname as dirname5, join as join4 } from "node:path";

// packages/tickets/lib/durability.mjs
import {
  closeSync,
  copyFileSync,
  existsSync as existsSync3,
  fsyncSync,
  mkdirSync as mkdirSync2,
  openSync,
  renameSync,
  rmSync as rmSync2,
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
import { existsSync as existsSync4, lstatSync as lstatSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync3, openSync as openSync2, readSync, closeSync as closeSync2, unlinkSync, mkdirSync as mkdirSync3, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { dirname as dirname4, join as join3, relative, sep } from "node:path";
var SEGMENT_DIRNAME = "manifest.d";
var SEGMENT_NAME_RE = /^[a-z0-9-]{1,40}-[0-9A-HJKMNP-TV-Z]{26}\.jsonl$/;
var RESERVED_NAMES = /* @__PURE__ */ new Set([".store.json"]);
var MARKER_NAME = ".store.json";
var LINEAGE_NAME = ".lineage";
var MARKER_FORMAT = "adlc-manifest-segments";
var MARKER_VERSION = 1;
var MAX_LOCAL_JSON_BYTES = 4096;
var MAX_LOCK_OWNER_BYTES = 512;
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
function segmentDirPath(dir) {
  return join3(dir, SEGMENT_DIRNAME);
}
function segmentPath(dir, name) {
  return join3(segmentDirPath(dir), name);
}
function markerPath(dir) {
  return join3(segmentDirPath(dir), MARKER_NAME);
}
function lineagePath(dir) {
  return join3(segmentDirPath(dir), LINEAGE_NAME);
}
function discoverSegments(dir) {
  const segDir = segmentDirPath(dir);
  let dirStat;
  try {
    dirStat = lstatSync2(segDir);
  } catch {
    return { valid: [], invalid: [] };
  }
  if (dirStat.isSymbolicLink()) return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is a symlink" }] };
  if (!dirStat.isDirectory()) return { valid: [], invalid: [{ name: ".", reason: "manifest.d/ is not a directory" }] };
  let names;
  try {
    names = readdirSync2(segDir).sort();
  } catch (err) {
    return { valid: [], invalid: [{ name: ".", reason: `cannot read manifest.d/: ${err.message}` }] };
  }
  const valid = [];
  const invalid3 = [];
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    let st;
    try {
      st = lstatSync2(join3(segDir, name));
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
    if (name === LINEAGE_NAME) continue;
    if (name.endsWith(".lock")) {
      if (looksLikeGenuineLedgerLock(join3(segDir, name), st.size)) continue;
      invalid3.push({ name, reason: "lock-suffixed object is not a genuine advisory lock" });
      continue;
    }
    if (!SEGMENT_NAME_RE.test(name)) {
      invalid3.push({ name, reason: "bad filename grammar" });
      continue;
    }
    valid.push(name);
  }
  return { valid, invalid: invalid3 };
}
function readRawLines(filePath) {
  if (!existsSync4(filePath)) return [];
  return readFileSync3(filePath, "utf8").split("\n").filter((line) => line.trim() !== "");
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
function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}
function entrySigValid(key2, entry) {
  if (typeof entry.sig !== "string" || entry.sig.length === 0) return false;
  const expected = createHmac("sha256", key2).update(canonicalEntryBytes(entry)).digest("hex");
  const a = Buffer.from(entry.sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function chainIsIntact(lines, key2 = null) {
  let prevLine = null;
  let prevSeq = 0;
  let seenSignedEntry = false;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    const expectedPrev = prevLine === null ? null : sha256(prevLine);
    if (entry?.prev !== expectedPrev || entry?.seq !== prevSeq + 1) return false;
    if (key2 !== null) {
      const hasSig = typeof entry?.sig === "string" && entry.sig.length > 0;
      if (hasSig) {
        if (!entrySigValid(key2, entry)) return false;
        seenSignedEntry = true;
      } else if (seenSignedEntry) {
        return false;
      }
    }
    prevLine = line;
    prevSeq = entry.seq;
  }
  return true;
}
function forestChainsIntact(dir, { key: key2 = null } = {}) {
  if (!chainIsIntact(readRawLines(join3(dir, "manifest.jsonl")), key2)) return false;
  const { valid, invalid: invalid3 } = discoverSegments(dir);
  if (invalid3.length > 0) return false;
  return valid.every((name) => chainIsIntact(readRawLines(segmentPath(dir, name)), key2));
}
function readForestEntries(dir) {
  const root = parseLines(readRawLines(join3(dir, "manifest.jsonl")));
  const segments = discoverSegments(dir).valid.flatMap((name) => parseLines(readRawLines(segmentPath(dir, name))));
  return [...root, ...segments];
}
function readBoundedJsonNoFollow(path) {
  let st;
  try {
    st = lstatSync2(path);
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
function hasActivationMarker(dir) {
  const parsed = readBoundedJsonNoFollow(markerPath(dir));
  return Boolean(parsed) && typeof parsed === "object" && parsed.format === MARKER_FORMAT && parsed.version === MARKER_VERSION;
}
function rootEndsInCutover(dir) {
  const raw = readRawLines(join3(dir, "manifest.jsonl"));
  if (raw.length === 0) return false;
  try {
    const last = JSON.parse(raw.at(-1));
    return Boolean(last) && typeof last === "object" && last.gate === "manifest-cutover";
  } catch {
    return false;
  }
}
function isSegmentedRepo(dir) {
  return hasActivationMarker(dir) || rootEndsInCutover(dir);
}
var ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
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
function deriveSlug(branchName) {
  const lowered = String(branchName ?? "").toLowerCase();
  const substituted = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = substituted.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const truncated = collapsed.slice(0, 40).replace(/-+$/g, "");
  return truncated || "segment";
}
function currentBranch(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" || out === "HEAD" ? null : out;
  } catch {
    return null;
  }
}
function readLineageToken(dir) {
  const token = readBoundedJsonNoFollow(lineagePath(dir));
  if (!token || typeof token !== "object") return null;
  if (typeof token.segment !== "string" || typeof token.ulid !== "string" || typeof token.branch !== "string") return null;
  return token;
}
function isSymlinkOrOtherNonRegular(path) {
  let st;
  try {
    st = lstatSync2(path);
  } catch {
    return false;
  }
  return !st.isFile();
}
function writeLineageToken(dir, token) {
  mkdirSync3(segmentDirPath(dir), { recursive: true });
  const p = lineagePath(dir);
  if (isSymlinkOrOtherNonRegular(p)) unlinkSync(p);
  const fd = openSync2(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync3(fd, JSON.stringify(token));
  } finally {
    closeSync2(fd);
  }
}
function ulidOf(segmentName) {
  return segmentName.slice(segmentName.length - ".jsonl".length - 26, segmentName.length - ".jsonl".length);
}
function peekOpenSegment(dir, { cwd = dirname4(dir) } = {}) {
  const branch = currentBranch(cwd);
  const token = readLineageToken(dir);
  if (branch !== null && token && token.branch === branch) {
    if (discoverSegments(dir).valid.includes(token.segment) && ulidOf(token.segment) === token.ulid) {
      return { name: token.segment, isNew: false };
    }
  }
  return null;
}
var MAX_FIRST_LINE_BYTES = 65536;
var OVERSIZED_FIRST_ENTRY = /* @__PURE__ */ Symbol("oversized-first-entry");
var MALFORMED_FIRST_ENTRY = /* @__PURE__ */ Symbol("malformed-first-entry");
function firstEntryOf(dir, segmentName) {
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
function recoverOpenSegment(dir, { cwd = dirname4(dir) } = {}) {
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
function assertSegmentPathCommittable(dir, name) {
  const probeCwd = dirname4(dir);
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
function resolveOpenSegment(dir, { cwd = dirname4(dir), key: key2 = null } = {}) {
  const markerDoc = readBoundedJsonNoFollow(markerPath(dir));
  if (markerDoc && markerDoc.auth === "keyed" && key2 === null) {
    throw new Error(
      "this forest was activated in keyed mode, but no signing key was provided for this write \u2014 an unsigned entry here would permanently strand every keyed clone of this branch; configure the manifest key"
    );
  }
  const peeked = peekOpenSegment(dir, { cwd });
  if (peeked) return peeked;
  if (key2 !== null) {
    const recovered = recoverOpenSegment(dir, { cwd });
    if (recovered) {
      const lines = readRawLines(segmentPath(dir, recovered.name));
      let first = null;
      try {
        first = JSON.parse(lines[0]);
      } catch {
      }
      const firstAuthenticated = Boolean(first) && first.sigVersion === 2 && entrySigValid(key2, first);
      if (!chainIsIntact(lines, key2) || !firstAuthenticated) {
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
  const rootLines = readRawLines(join3(dir, "manifest.jsonl"));
  const rootLast = rootLines.at(-1) ?? null;
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
  assertSegmentPathCommittable(dir, name);
  if (branch !== null) writeLineageToken(dir, { segment: name, ulid, branch });
  return { name, isNew: true, anchor, ...branch !== null ? { branch } : {} };
}

// packages/tickets/lib/key-contract.mjs
function validateKeyParam(key2) {
  if (key2 === null) return null;
  if (typeof key2 === "string" && key2.length > 0) return key2;
  throw new TypeError(
    `manifest key parameter must be a non-empty string (a key) or null (explicitly no key); got ${key2 === "" ? "'' (empty string)" : typeof key2}. Resolve the environment in the bin (getKey()) and thread the value down \u2014 library code never reads process.env.`
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
        const current = JSON.parse(readFileSync4(lockPath, "utf8"));
        if (current.token === owner.token) unlinkSync2(lockPath);
      } catch {
      }
    }
  }
  throw conflict("MANIFEST_LOCK_TIMEOUT", `could not acquire manifest lock: ${lockPath}`);
}
function lastLine(content) {
  return content.split("\n").reverse().find((line) => line.trim()) ?? null;
}
function sign(key2, entry) {
  const canonical = { seq: entry.seq, gate: entry.gate, ts: entry.ts };
  if (entry.ticket !== void 0) canonical.ticket = entry.ticket;
  if (entry.data !== void 0) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return createHmac2("sha256", key2).update(JSON.stringify(canonical)).digest("hex");
}
function signV2(key2, entry) {
  const { sig: _sig, segment: _segment, ...signed } = entry;
  return createHmac2("sha256", key2).update(canonicalJson(signed)).digest("hex");
}
var AUDIT_FIELDS = ["bypass", "op", "ticketId", "storeHashBefore", "storeHashAfter", "ticketIds"];
function auditFieldsMatch(entry, data, acceptLegacyMatch) {
  if (acceptLegacyMatch && AUDIT_FIELDS.every((field) => entry.data?.[field] === void 0)) return true;
  for (const field of AUDIT_FIELDS) {
    if (canonicalJson(entry.data?.[field] ?? null) !== canonicalJson(data[field] ?? null)) return false;
  }
  return true;
}
function findMatchingEvidence(entries, { gate, data, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, transactionId, key: key2 = null, acceptLegacyMatch = false }) {
  for (const entry of entries) {
    if (entry?.data?.transactionId === transactionId && entry?.data?.action === action) {
      if (key2 !== null && !entrySigValid(key2, entry)) continue;
      const matches = entry.gate === gate && (entry.ticket ?? null) === ticketId && entry.data.operation === operation && (entry.data.ticketHash ?? null) === ticketHash2 && entry.data.storeHash === storeHash2 && (entry.data.archiveHash ?? null) === archiveHash && entry.data.bindingScope === (ticketId ? "ticket" : "store") && auditFieldsMatch(entry, data, acceptLegacyMatch);
      if (!matches) throw conflict("EVIDENCE_IDEMPOTENCY_CONFLICT", `transaction ${transactionId}/${action} already has different evidence`);
      return entry;
    }
  }
  return null;
}
function recordSegmentedTicketEvidence(dir, { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key: key2, acceptLegacyMatch = false }) {
  return withManifestLock(lineagePath(dir), () => {
    if (!forestChainsIntact(dir, { key: key2 })) {
      throw conflict("INVALID_MANIFEST", "manifest forest is invalid: a segment or root chain is broken, or an entry is unsigned/forged \u2014 refusing to append or trust the idempotency scan");
    }
    const existing = findMatchingEvidence(readForestEntries(dir), { gate, data, transactionId, operation, action, ticketId, ticketHash: ticketHash2, storeHash: storeHash2, archiveHash, key: key2, acceptLegacyMatch });
    if (existing) return existing;
    const resolved = resolveOpenSegment(dir, { cwd: dirname5(dir), key: key2 });
    const targetPath = segmentPath(dir, resolved.name);
    mkdirSync4(dirname5(targetPath), { recursive: true });
    return withManifestLock(targetPath, () => {
      const content = existsSync5(targetPath) ? readFileSync4(targetPath, "utf8") : "";
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
      if (key2) {
        if (resolved.isNew) entry.sigVersion = 2;
        entry.sig = entry.sigVersion === 2 ? signV2(key2, entry) : sign(key2, entry);
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
  key: key2,
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
  const signingKey = validateKeyParam(key2);
  const dir = join4(root, ".adlc");
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
  const path = join4(root, ".adlc/manifest.jsonl");
  return withManifestLock(path, () => {
    const content = existsSync5(path) ? readFileSync4(path, "utf8") : "";
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
import { existsSync as existsSync6, lstatSync as lstatSync3, readFileSync as readFileSync5, readdirSync as readdirSync3 } from "node:fs";
import { join as join5 } from "node:path";
var STORE_MARKER = ".store.json";
function assertNotSymlink(path) {
  let stat;
  try {
    stat = lstatSync3(path);
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
  const directory = join5(root, ARCHIVE_DIRECTORY);
  const legacy = join5(root, LEGACY_ARCHIVE_FILE);
  assertNotSymlink(directory);
  assertNotSymlink(legacy);
  if (existsSync6(directory)) {
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
          const marker = JSON.parse(readFileSync5(join5(directory, entry.name), "utf8"));
          if (!marker || typeof marker !== "object" || typeof marker.format !== "string") return true;
          sawMarker = true;
        } catch {
          return true;
        }
        continue;
      }
      if (entry.isSymbolicLink()) assertNotSymlink(join5(directory, entry.name));
      if (!entry.isFile()) return true;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync5(join5(directory, entry.name), "utf8"));
      } catch {
        return true;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.id !== "string") return true;
      if (storeDeclaresRails([parsed])) return true;
    }
    if (!sawMarker) return true;
  }
  if (existsSync6(legacy)) {
    try {
      const parsed = JSON.parse(readFileSync5(legacy, "utf8"));
      if (storeDeclaresRails(parsed?.tickets)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
function manifestRecordsBypass(root) {
  const rootManifest = join5(root, ".adlc", "manifest.jsonl");
  const segments = join5(root, ".adlc", "manifest.d");
  assertNotSymlink(rootManifest);
  assertNotSymlink(segments);
  const files = [rootManifest];
  if (existsSync6(segments)) {
    try {
      for (const entry of readdirSync3(segments, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) assertNotSymlink(join5(segments, entry.name));
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join5(segments, entry.name));
      }
    } catch {
      return true;
    }
  }
  for (const file of files) {
    if (!existsSync6(file)) continue;
    let text;
    try {
      text = readFileSync5(file, "utf8");
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
  assertNotSymlink(join5(root, ".adlc"));
  return storeDeclaresRails(tickets) || archiveDeclaresRails(root) || manifestRecordsBypass(root);
}
function assertWriteIsSignable({ key: key2, allowUnsigned = false } = {}) {
  const resolved = validateKeyParam(key2);
  if (resolved !== null || allowUnsigned) return;
  throw policy(
    "MANIFEST_KEY_REQUIRED",
    "this ticket store is a frozen trust root (a ticket declares rails), so mutating it is an audited override \u2014 and ADLC_MANIFEST_KEY is not set, so the audit entry would be written UNSIGNED, proving nothing about who made the change. Refusing before the write: nothing has changed.\n  Set ADLC_MANIFEST_KEY and re-run. It is commonly kept in the MAIN checkout's gitignored .env.local, which is ABSENT from a git worktree \u2014 from a worktree, export it explicitly.\n  To record an UNSIGNED audit entry on purpose, pass --allow-unsigned."
  );
}
function assertSignableTrustRootWrite(tickets, { key: key2, allowUnsigned = false, root = "." } = {}) {
  if (!repoDeclaresRails(root, tickets)) return false;
  assertWriteIsSignable({ key: key2, allowUnsigned });
  return true;
}

// packages/tickets/lib/transaction.mjs
var fileHash = (path) => sha256(readFileSync6(path));
function journalPath(root, path) {
  const absolute = resolve3(path);
  const rel = relative2(resolve3(root), absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) ? rel : absolute;
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
function bypassAuditPlan(before, { operation, evidenceRequired, key: key2, allowUnsigned, root }) {
  if (!assertSignableTrustRootWrite(before.tickets, { key: key2, allowUnsigned, root })) return null;
  return { gate: evidenceRequired ? `ticket-${operation}` : "ticket-mutation", storeHashBefore: before.hash };
}
function applyLegacyTransaction(store, tickets, { expectedSnapshotHash, operation = "update", evidenceRequired = false, ticketId = null, beforeTicketId = null, root = ".", faultInjector = null, lock: existingLock = null, key: key2 = null, allowUnsigned = false } = {}) {
  key2 = validateKeyParam(key2);
  validateTickets(tickets);
  const transactionId = randomUUID2();
  const lock = existingLock ?? acquireTicketLock(root, { transactionId, command: `ticket:${operation}` });
  const transactionRoot = join6(root, TRANSACTION_DIRECTORY, transactionId);
  try {
    const before = store.load();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) throw conflict("STALE_SNAPSHOT", `expected ${expectedSnapshotHash}, found ${before.hash}`);
    const bypassAudit = transactionChangesAnything(before, tickets, []) ? bypassAuditPlan(before, { operation, evidenceRequired, key: key2, allowUnsigned, root }) : null;
    const target = resolve3(store.path);
    const recordedTarget = journalPath(root, target);
    const stage = join6(transactionRoot, "stage", basename(store.path));
    const backup = join6(transactionRoot, "backup", basename(store.path));
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
    durableWrite(join6(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    faultInjector?.("journal-prepared", { transactionId, operations: 1 });
    const temporary = `${target}.txn-${transactionId}`;
    durableCopy(stage, temporary);
    durableRename(temporary, target);
    faultInjector?.("operation-applied:1", { transactionId, operation: journal.operations[0] });
    const after = store.load();
    if (after.hash !== afterHash) throw invalid("TRANSACTION_VERIFY_FAILED", `transaction produced ${after.hash}, expected ${afterHash}`);
    if (evidenceRequired || bypassAudit) recordTicketEvidence(root, {
      key: key2,
      transactionId,
      operation,
      ticketId,
      ticketHash: journal.afterTicketHash,
      storeHash: after.hash,
      ...bypassAudit ? { gate: bypassAudit.gate, bypass: true, storeHashBefore: bypassAudit.storeHashBefore } : {}
    });
    journal.state = "complete";
    durableWrite(join6(transactionRoot, "journal.json"), `${JSON.stringify(journal, null, 2)}
`);
    durableRemove(transactionRoot, { recursive: true, force: true });
    return after;
  } catch (error) {
    if (!existsSync7(join6(transactionRoot, "journal.json")) && existsSync7(transactionRoot)) durableRemove(transactionRoot, { recursive: true, force: true });
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
    return existsSync8(this.path);
  }
  /**
   * `root` is where the trust-root evidence is read from — the archive, the manifest,
   * and the recorded overrides that decide whether this store is frozen. It is
   * INFERRED only for the canonical `<root>/.adlc/tickets.json` layout, which keeps
   * the 1.x one-argument call working; anywhere else it must be passed, because
   * guessing wrong is not a cosmetic error (see repositoryRootFor).
   */
  write(tickets, { key: key2 = null, allowUnsigned = false, root = null } = {}) {
    return applyLegacyTransaction(this, tickets, {
      root: repositoryRootFor(this.path, root),
      operation: "update",
      key: key2,
      allowUnsigned
    });
  }
  load() {
    if (!this.exists()) throw operational("STORE_NOT_FOUND", `tickets file not found: ${this.path}`);
    const stat = lstatSync4(this.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalid("UNSAFE_STORE_PATH", `${this.path} must be a regular file`);
    const parentStat = lstatSync4(dirname7(this.path));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw invalid("UNSAFE_STORE_PATH", `${dirname7(this.path)} must be a real directory`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync7(this.path, "utf8"));
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
var rooted = (root, path) => isAbsolute2(path) ? path : join7(root, path);
function pendingTransactions(root = ".") {
  const path = join7(root, TRANSACTION_DIRECTORY);
  if (!existsSync9(path)) return [];
  const stat = lstatSync5(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("RECOVERY_REQUIRED", `${path} is not a safe transaction directory`);
  return readdirSync4(path).filter((entry) => !entry.startsWith(".")).sort();
}
function resolveStoreOverride({ root = ".", ticketStore, legacyTickets, env = process.env } = {}) {
  const modern = ticketStore ?? env.ADLC_TICKET_STORE;
  const legacy = legacyTickets ?? env.ADLC_TICKETS;
  if (modern && legacy && resolve4(rooted(root, modern)) !== resolve4(rooted(root, legacy))) {
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
  const legacy = new LegacyTicketStore(join7(root, LEGACY_FILE));
  const directory = new DirectoryTicketStore(join7(root, ACTIVE_DIRECTORY));
  if (legacy.exists() && directory.exists()) throw conflict("AMBIGUOUS_STORE", "both .adlc/tickets.json and .adlc/tickets/ exist; complete or roll back migration");
  if (directory.exists()) return directory;
  if (legacy.exists()) return legacy;
  throw operational("STORE_NOT_FOUND", `no ticket store found under ${resolve4(root)}`);
}

// packages/tickets/lib/generated-glob-match.mjs
var SLASH = "/".charCodeAt(0);

// packages/tickets/lib/manifest-rails.mjs
var MANIFEST_BASENAMES = Object.freeze(["package.json", "plugin.json", "marketplace.json"]);

// packages/tickets/lib/prompt.mjs
import { createInterface } from "node:readline/promises";

// packages/core/lib/llm.mjs
import { spawn } from "node:child_process";
function isAgyTimeout(out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}
function agySend({ apiKey, model, system, prompt }, env = process.env) {
  const bin = apiKey === "1" || apiKey === "true" ? "agy" : apiKey;
  const args = ["--print", "--print-timeout", env.ADLC_AGY_TIMEOUT ?? "300s", "--model", model];
  if (env.ADLC_AGY_SANDBOX === "1") args.push("--sandbox");
  const input = system ? `${system}

---

${prompt}` : prompt;
  return new Promise((resolve6, reject) => {
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => out += d);
    p.stderr.on("data", (d) => err += d);
    p.on("error", (e) => reject(new Error(`agy spawn failed: ${e.message}`)));
    p.stdin.end(input);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
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
    outputTokens: raw.candidatesTokenCount ?? 0,
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
    async send({ apiKey, model, system, prompt, maxTokens, cacheable }) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
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
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
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
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

// packages/core/lib/tickets.mjs
import { existsSync as existsSync10, lstatSync as lstatSync6 } from "node:fs";
import { dirname as dirname8, isAbsolute as isAbsolute3, join as join8 } from "node:path";

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
  if (override) return existsSync10(isAbsolute3(override) ? override : join8(root, override));
  return existsSync10(join8(root, ".adlc/tickets.json")) || existsSync10(join8(root, ".adlc/tickets/.store.json"));
}

// packages/core/lib/revision.mjs
var GIT_MAX_BUFFER2 = 64 * 1024 * 1024;
var NULL_OBJECT = "0".repeat(40);

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

// plugins/adlc-cursor/generated-active-ticket.mjs
import { lstatSync as lstatSync7, openSync as openSync4, fstatSync, readSync as readSync2, closeSync as closeSync4, constants as fsConstants2 } from "node:fs";
import { dirname as dirname9, join as join9 } from "node:path";
var CURRENT_TICKET_FILE2 = ".adlc/current-ticket.json";
var MAX_POINTER_BYTES2 = 64 * 1024;
var ABSENT = /* @__PURE__ */ Symbol("pointer-absent");
function readPointerFileBounded(path) {
  let parentLst;
  try {
    parentLst = lstatSync7(dirname9(path));
  } catch (err) {
    return err && err.code === "ENOENT" ? ABSENT : null;
  }
  if (!parentLst.isDirectory()) return null;
  let lst;
  try {
    lst = lstatSync7(path);
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
var isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var trimmed = (value) => typeof value === "string" ? value.trim() : "";
function conflictMessage(envId, fileId) {
  return `ADLC_TICKET ("${envId}") conflicts with ${CURRENT_TICKET_FILE2} ("${fileId}"): they name different tickets. The active ticket is per-worktree state \u2014 ADLC supports exactly one active ticket per worktree, and parallel work on a second ticket needs its own worktree (git worktree add <path> -b <branch>), not a second pointer in this one. Failing closed: which ticket governs this build cannot be determined.`;
}
function readActiveTicketPointer2(root = ".") {
  const path = join9(root, CURRENT_TICKET_FILE2);
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
  if (!isPlainObject(parsed)) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} must be an object like {"id":"T1","ticketHash":"<64 hex>"} (got ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}). To deactivate, delete the file.`
    );
  }
  let usedKey = null;
  for (const key2 of [CANONICAL_ID_KEY, ...DEPRECATED_ID_KEYS2]) {
    if (Object.hasOwn(parsed, key2)) {
      usedKey = key2;
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
  const id = trimmed(parsed[usedKey]);
  if (!id) {
    return invalid2(
      "INVALID_CURRENT_TICKET",
      `${CURRENT_TICKET_FILE2} has a "${usedKey}" that is not a non-empty string`
    );
  }
  const value = { present: true, id, ticketHash: trimmed(parsed.ticketHash) || null, legacyString: false };
  if (usedKey !== CANONICAL_ID_KEY) value.deprecatedAlias = usedKey;
  return ok(value);
}
function resolveActiveTicketId({ root = ".", env = process.env } = {}) {
  const pointer = readActiveTicketPointer2(root);
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

// plugins/adlc-cursor/lib/session-identity.mjs
var PAYLOAD_SESSION_KEYS = Object.freeze(["session_id", "sessionId", "conversation_id", "conversationId"]);
var REJECTED_AS_SESSION_KEYS = Object.freeze(["thread_id", "threadId", "generation_id", "generationId"]);

// plugins/adlc-cursor/lib/workspace-resolve.mjs
function normalizeRootPath(raw) {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  const win = p.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (win) p = `${win[1]}:\\${win[2].replace(/\//g, "\\")}`;
  p = normalize2(p);
  try {
    if (existsSync11(p)) return pathResolve(p);
  } catch {
  }
  return isAbsolute4(p) ? p : null;
}
function isAdlcBearing(root, env = process.env) {
  if (!root) return false;
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  if (ticketStoreExists(root, override)) return true;
  return existsSync11(join10(root, ".adlc", "tickets.json")) || existsSync11(join10(root, ".adlc", "tickets")) || existsSync11(join10(root, ".adlc", "ticket-transactions"));
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

// plugins/adlc-cursor/lib/mcp-file-uri.mjs
function fileUriToPath(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  let raw = uri.trim();
  if (!/^file:/i.test(raw)) return null;
  try {
    const u = new URL(raw);
    let pathname = decodeURIComponent(u.pathname || "");
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (u.hostname && u.hostname !== "localhost" && u.hostname !== "") {
      pathname = `//${u.hostname}${pathname}`;
    }
    return normalizeRootPath(pathname) || (pathname ? normalizeRootPath(pathname.replace(/\//g, "\\")) : null) || pathname || null;
  } catch {
    return null;
  }
}
function rootUriToPath(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const raw = uri.trim();
  if (/^file:/i.test(raw)) return fileUriToPath(raw);
  const windows = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windows) {
    return normalizeRootPath(raw) || `${windows[1]}:\\${windows[2].replace(/\//g, "\\")}`;
  }
  const cursorWindows = raw.match(/^\/([A-Za-z]):\/(.*)$/);
  if (cursorWindows) {
    return normalizeRootPath(raw) || `${cursorWindows[1]}:\\${cursorWindows[2].replace(/\//g, "\\")}`;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(raw)) return null;
  if (!raw.startsWith("/")) return null;
  return normalizeRootPath(raw);
}
function decodeRootsListResult(result) {
  const roots = result?.roots;
  if (!Array.isArray(roots)) {
    return { ok: false, message: "roots/list result must contain a roots array" };
  }
  const out = [];
  for (const [index, root] of roots.entries()) {
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      return { ok: false, message: `Root at index ${index} must be an object with a uri` };
    }
    const uri = root.uri;
    if (typeof uri !== "string" || !uri.trim()) {
      return { ok: false, message: `Root at index ${index} must have a uri` };
    }
    const path = rootUriToPath(uri);
    if (!path) {
      return { ok: false, message: `Root at index ${index} has an unsupported or relative uri` };
    }
    out.push(path);
  }
  return { ok: true, paths: [...new Set(out)] };
}

// plugins/adlc-cursor/lib/mcp-hostenv.mjs
function resolveHostEnvRoot(env = process.env) {
  const raw = env.ADLC_CURSOR_MCP_ROOT ?? env.CURSOR_PROJECT_DIR ?? null;
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      code: "HOST_ENV_ABSENT",
      message: "ADLC MCP host-env root absent (set ADLC_CURSOR_MCP_ROOT for tests). Production uses the lifecycle Roots proxy; process.cwd() is never used."
    };
  }
  const root = normalizeRootPath(raw.trim());
  if (!root) {
    return { ok: false, code: "HOST_ENV_INVALID", message: `host env root is not a usable absolute path: ${raw}` };
  }
  if (!isAdlcBearing(root, env)) {
    return { ok: false, code: "HOST_ENV_NOT_ADLC", message: `host env root is not ADLC-bearing: ${root}` };
  }
  const classified = classifyRoot(root, env);
  if (classified.kind === "error-bearing") {
    return { ok: false, code: classified.code || "HOST_ENV_ERROR", message: classified.message };
  }
  return { ok: true, root };
}

// plugins/adlc-cursor/lib/mcp-json-rpc-bridge.mjs
function isJsonRpcResponse(message) {
  return message && typeof message === "object" && !Object.hasOwn(message, "method") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}
function isJsonRpcMethodMessage(message) {
  return message && typeof message === "object" && typeof message.method === "string";
}
function hasJsonRpcRequestId(message) {
  return isJsonRpcMethodMessage(message) && message.id !== void 0 && message.id !== null;
}
function key(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}
var JsonRpcIdBridge = class {
  #clientToChildSequence = 0;
  #childToClientSequence = 0;
  #clientToChild = /* @__PURE__ */ new Map();
  #childToClient = /* @__PURE__ */ new Map();
  forwardClientRequest(message, child, generation) {
    if (!hasJsonRpcRequestId(message)) {
      return message;
    }
    const id = `__adlc_proxy_to_child_${++this.#clientToChildSequence}`;
    this.#clientToChild.set(key(id), {
      child,
      generation,
      originalId: message.id
    });
    return { ...message, id };
  }
  forwardChildRequest(message, child, generation) {
    if (!hasJsonRpcRequestId(message)) {
      return message;
    }
    const id = `__adlc_proxy_to_client_${++this.#childToClientSequence}`;
    this.#childToClient.set(key(id), {
      child,
      generation,
      originalId: message.id
    });
    return { ...message, id };
  }
  takeClientResponse(id, child, generation) {
    return this.#take(this.#clientToChild, id, child, generation);
  }
  takeChildResponse(id, child, generation) {
    return this.#take(this.#childToClient, id, child, generation);
  }
  clear(child = null) {
    this.#clear(this.#clientToChild, child);
    this.#clear(this.#childToClient, child);
  }
  #take(mappings, id, child, generation) {
    const mapping = mappings.get(key(id));
    if (!mapping) {
      return null;
    }
    mappings.delete(key(id));
    if (mapping.child !== child || mapping.generation !== generation) {
      return null;
    }
    return mapping;
  }
  #clear(mappings, child) {
    for (const [id, mapping] of mappings) {
      if (!child || mapping.child === child) {
        mappings.delete(id);
      }
    }
  }
};

// plugins/adlc-cursor/lib/mcp-proxy-runtime.mjs
var ClientRequests = class {
  #fail;
  #inFlight = /* @__PURE__ */ new Map();
  #pending = [];
  constructor(fail2) {
    this.#fail = fail2;
  }
  queue(message) {
    this.#pending.push(message);
  }
  track(message) {
    if (typeof message.method === "string" && message.id !== void 0 && message.id !== null) {
      this.#inFlight.set(this.#key(message.id), message);
    }
  }
  complete(id) {
    const key2 = this.#key(id);
    if (!this.#inFlight.has(key2)) {
      return false;
    }
    this.#inFlight.delete(key2);
    return true;
  }
  flush(forward) {
    const pending = this.#pending;
    this.#pending = [];
    for (const message of pending) {
      this.track(message);
      forward(message);
    }
  }
  failPending(message, code = -32e3) {
    const pending = this.#pending;
    this.#pending = [];
    this.#failAll(pending, message, code);
  }
  failInFlight(message, code = -32e3) {
    const inFlight = [...this.#inFlight.values()];
    this.#inFlight.clear();
    this.#failAll(inFlight, message, code);
  }
  #failAll(requests, message, code) {
    for (const request of requests) {
      this.#fail(request.id, message, code);
    }
  }
  // JSON-RPC ids may be number or string; 1 and '1' are distinct requests.
  #key(id) {
    return `${typeof id}:${JSON.stringify(id)}`;
  }
};
function retireChildProcess(child, childReadline, timers, timeoutMs = 500, killTimeoutMs = 2e3) {
  if (childReadline) {
    try {
      childReadline.close();
    } catch {
    }
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve6) => {
    let settled = false;
    const ownTimers = /* @__PURE__ */ new Set();
    const finish = () => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      for (const timer of ownTimers) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      ownTimers.clear();
      resolve6();
    };
    const schedule = (callback, delayMs) => {
      const timer = setTimeout(() => {
        ownTimers.delete(timer);
        timers.delete(timer);
        callback();
      }, delayMs);
      ownTimers.add(timer);
      timers.add(timer);
    };
    child.once("exit", finish);
    child.once("error", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    schedule(() => {
      try {
        const signaled = child.kill("SIGKILL");
        if (!signaled) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }
      schedule(() => {
        process.stderr.write(
          `adlc-mcp-wrapper: child ${child.pid ?? "?"} did not exit ${killTimeoutMs}ms after SIGKILL; continuing
`
        );
        finish();
      }, killTimeoutMs);
    }, timeoutMs);
  });
}

// plugins/adlc-cursor/lib/mcp-spawn.mjs
import { accessSync, constants, statSync } from "node:fs";
import { dirname as dirname11, join as join11 } from "node:path";
function isRunnableFile(path) {
  try {
    const stat = statSync(path);
    accessSync(path, constants.R_OK);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
function nodeModulesForPrefix(prefix, platform) {
  if (platform === "win32") {
    return [join11(prefix, "node_modules")];
  }
  return [join11(prefix, "lib", "node_modules"), join11(prefix, "node_modules")];
}
function npmGlobalRoots(env, platform, execPath) {
  const roots = [];
  const add = (root) => {
    if (root && !roots.includes(root)) {
      roots.push(root);
    }
  };
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (prefix) {
    for (const root of nodeModulesForPrefix(prefix, platform)) {
      add(root);
    }
  }
  const binDir = dirname11(execPath);
  if (platform === "win32") {
    add(join11(binDir, "node_modules"));
    if (env.APPDATA) {
      add(join11(env.APPDATA, "npm", "node_modules"));
    }
  } else {
    add(join11(binDir, "..", "lib", "node_modules"));
    add(join11(binDir, "node_modules"));
  }
  if (env.NODE_PATH) {
    for (const root of env.NODE_PATH.split(platform === "win32" ? ";" : ":")) {
      add(root);
    }
  }
  if (env.VOLTA_HOME) {
    add(join11(env.VOLTA_HOME, "tools", "image", "packages", "@adlc", "cli", "node_modules"));
  }
  if (env.PNPM_HOME) {
    for (const version of ["5", "6", "7", "8", "9", "10"]) {
      add(join11(env.PNPM_HOME, "global", version, "node_modules"));
    }
  }
  return roots;
}
function entryAt(nodeModules) {
  return join11(nodeModules, "@adlc", "cli", "bin", "adlc.mjs");
}
function resolveAdlcMcpSpawn(env = process.env, platform = process.platform, { execPath = process.execPath, isFile = isRunnableFile } = {}) {
  if (env.ADLC_CLI_BIN) {
    return {
      command: execPath,
      args: [env.ADLC_CLI_BIN, "mcp-server"],
      resolved: true,
      probed: [env.ADLC_CLI_BIN]
    };
  }
  const probed = [];
  for (const nodeModules of npmGlobalRoots(env, platform, execPath)) {
    const entry = entryAt(nodeModules);
    probed.push(entry);
    if (isFile(entry)) {
      return { command: execPath, args: [entry, "mcp-server"], resolved: true, probed };
    }
  }
  if (platform !== "win32") {
    return {
      command: "adlc",
      args: ["mcp-server"],
      resolved: false,
      probed,
      diagnostic: `ADLC MCP CLI was not found in the Node/npm global locations (${probed.join(", ")}); falling back to adlc on PATH`
    };
  }
  return {
    command: null,
    args: [],
    resolved: false,
    probed,
    diagnostic: `ADLC MCP CLI was not found in the Node/npm global locations (${probed.join(", ")}). Install @adlc/cli globally for the Node Cursor uses, or set ADLC_CLI_BIN to its adlc.mjs entrypoint`
  };
}

// plugins/adlc-cursor/lib/mcp-roots-proxy.mjs
var VERSION = MCP_BUILD_METADATA.pluginVersion;
var ROOTS_REQ_PREFIX = "__adlc_roots_list_";
var ROOTS_RESPONSE_TIMEOUT_MS = 1e4;
var PRE_INITIALIZED_TIMEOUT_MS = 1e4;
var CHILD_HANDSHAKE_TIMEOUT_MS = 1e4;
var CHILD_HANDSHAKE_TIMEOUT_CODE = -32001;
function send(stream, message) {
  stream.write(`${JSON.stringify(message)}
`);
}
function failClosed(output, id, message, code = -32e3) {
  if (id !== void 0 && id !== null) {
    send(output, { jsonrpc: "2.0", id, error: { code, message } });
  }
}
function mcpRootFromWorkspace(workspace) {
  if (!workspace)
    return {
      ok: false,
      code: "UNRESOLVED",
      message: "no workspace resolution"
    };
  if (workspace.outcome === "active" || workspace.outcome === "inactive") {
    if (!workspace.root)
      return {
        ok: false,
        code: "UNRESOLVED",
        message: "resolved outcome without root"
      };
    return {
      ok: true,
      root: workspace.root,
      outcome: workspace.outcome,
      ticketId: workspace.ticketId ?? null
    };
  }
  return {
    ok: false,
    code: workspace.outcome?.toUpperCase?.() || "UNRESOLVED",
    message: workspace.message || `MCP refuses to launch (${workspace.outcome})`
  };
}
async function runRootsProxy({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  spawnImpl = spawn2,
  allowHostEnvFallback = false,
  platform = process.platform,
  signalSource,
  rootsResponseTimeoutMs = ROOTS_RESPONSE_TIMEOUT_MS,
  preInitializedTimeoutMs = PRE_INITIALIZED_TIMEOUT_MS,
  childHandshakeTimeoutMs = CHILD_HANDSHAKE_TIMEOUT_MS,
  childRetirementTimeoutMs = 500
} = {}) {
  let child = null;
  let childRl = null;
  let childAcceptingRequests = false;
  let boundRoot = null;
  let generation = 1;
  let rootsRequestSequence = 0;
  let activeRootsRequest = null;
  const idBridge = new JsonRpcIdBridge();
  let initializeReceived = false;
  let initializedReceived = false;
  let initializationExpired = false;
  let clientHasRoots = false;
  let binding = false;
  let shuttingDown = false;
  let rebindTail = Promise.resolve();
  const retirementTimers = /* @__PURE__ */ new Set();
  const retirementPromises = /* @__PURE__ */ new Set();
  let preInitializedTimer = null;
  let childHandshakeWait = null;
  const requests = new ClientRequests(
    (id, message, code) => failClosed(output, id, message, code)
  );
  const clearChildHandshakeWait = (childProcess) => {
    if (!childHandshakeWait || childProcess && childHandshakeWait.child !== childProcess) {
      return;
    }
    clearTimeout(childHandshakeWait.timer);
    childHandshakeWait = null;
  };
  const waitForRetirements = async () => {
    await Promise.all([...retirementPromises]);
  };
  const retireSpecificChild = (retiringChild, retiringRl) => {
    clearChildHandshakeWait(retiringChild);
    idBridge.clear(retiringChild);
    const retirement = retireChildProcess(
      retiringChild,
      retiringRl,
      retirementTimers,
      childRetirementTimeoutMs
    );
    retirementPromises.add(retirement);
    void retirement.finally(() => retirementPromises.delete(retirement));
    return retirement;
  };
  const retireChild = () => {
    const retiringChild = child;
    const retiringRl = childRl;
    child = null;
    childRl = null;
    childAcceptingRequests = false;
    return retireSpecificChild(retiringChild, retiringRl);
  };
  const bindChild = (root) => {
    const myGen = generation;
    const target = resolveAdlcMcpSpawn(env, platform);
    if (!target.command) {
      const message = target.diagnostic;
      requests.failPending(message);
      requests.failInFlight(message);
      return { ok: false, message };
    }
    try {
      child = spawnImpl(target.command, target.args, {
        cwd: root,
        env: { ...env, ADLC_CURSOR_MCP_BOUND_ROOT: root },
        stdio: ["pipe", "pipe", "inherit"]
      });
    } catch (err) {
      const message = `ADLC MCP child failed to spawn: ${err.message}`;
      child = null;
      childRl = null;
      boundRoot = null;
      requests.failPending(message);
      requests.failInFlight(message);
      return { ok: false, message };
    }
    boundRoot = root;
    childAcceptingRequests = false;
    binding = true;
    const childHandshakeId = `__adlc_child_init_${myGen}`;
    const childProcess = child;
    const readline = createInterface2({
      input: childProcess.stdout,
      crlfDelay: Infinity
    });
    childRl = readline;
    const state = {
      error: null,
      exited: false,
      processClosed: false,
      readlineClosed: false,
      terminal: false,
      handshakeComplete: false,
      retired: false
    };
    const clearBoundChild = () => {
      if (child !== childProcess) return;
      idBridge.clear(childProcess);
      child = null;
      childRl = null;
      childAcceptingRequests = false;
      boundRoot = null;
      binding = false;
    };
    const stopAcceptingRequests = () => {
      if (child !== childProcess) return;
      childAcceptingRequests = false;
      boundRoot = null;
      binding = false;
    };
    const failAfterOutputDrains = () => {
      if (state.retired || myGen !== generation) return;
      if (state.terminal || !state.readlineClosed || !state.exited && !state.processClosed && !state.error)
        return;
      state.terminal = true;
      clearChildHandshakeWait(childProcess);
      clearBoundChild();
      const message = state.error ? `ADLC MCP child failed${target.diagnostic ? ` (${target.diagnostic})` : ""}: ${state.error.message}` : "ADLC MCP child exited before replying";
      requests.failPending(message);
      requests.failInFlight(message);
    };
    const closeReadlineAfterOutput = () => {
      try {
        readline.close();
      } catch {
      }
    };
    readline.on("close", () => {
      state.readlineClosed = true;
      failAfterOutputDrains();
    });
    childProcess.stdout.on("end", closeReadlineAfterOutput);
    childProcess.stdout.on("close", closeReadlineAfterOutput);
    childProcess.stdin.on("error", (err) => {
      if (myGen !== generation || state.retired) return;
      state.error = err;
      if (state.exited || state.processClosed) {
        failAfterOutputDrains();
        return;
      }
      state.retired = true;
      clearChildHandshakeWait(childProcess);
      clearBoundChild();
      const message = `ADLC MCP child stdin failed: ${err.message}`;
      requests.failPending(message);
      requests.failInFlight(message);
      void retireSpecificChild(childProcess, readline);
    });
    readline.on("line", (line) => {
      if (myGen !== generation || state.retired) return;
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        const isResponse = isJsonRpcResponse(parsed);
        if (!state.handshakeComplete && parsed.id === childHandshakeId && isResponse) {
          state.handshakeComplete = true;
          clearChildHandshakeWait(childProcess);
          if (parsed.error) {
            const message = `ADLC MCP child initialization failed: ${parsed.error.message || "error"}`;
            state.retired = true;
            clearBoundChild();
            requests.failPending(
              message,
              Number.isInteger(parsed.error.code) ? parsed.error.code : -32e3
            );
            requests.failInFlight(
              message,
              Number.isInteger(parsed.error.code) ? parsed.error.code : -32e3
            );
            process.stderr.write(`adlc-mcp-wrapper: ${message}
`);
            void retireSpecificChild(childProcess, readline);
            return;
          }
          if (!state.exited && !state.processClosed && !state.error && child === childProcess) {
            send(childProcess.stdin, {
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {}
            });
            childAcceptingRequests = true;
            binding = false;
            flushPending();
          }
          return;
        }
        if (!state.handshakeComplete) return;
        if (isResponse) {
          const mapping = idBridge.takeClientResponse(
            parsed.id,
            childProcess,
            myGen
          );
          if (!mapping || !requests.complete(mapping.originalId)) {
            return;
          }
          send(output, { ...parsed, id: mapping.originalId });
          return;
        }
        if (isJsonRpcMethodMessage(parsed)) {
          send(
            output,
            idBridge.forwardChildRequest(parsed, childProcess, myGen)
          );
          return;
        }
      } catch {
      }
      output.write(`${line}
`);
    });
    childProcess.on("exit", () => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.exited = true;
      stopAcceptingRequests();
      failAfterOutputDrains();
    });
    childProcess.on("close", () => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.processClosed = true;
      stopAcceptingRequests();
      closeReadlineAfterOutput();
      failAfterOutputDrains();
    });
    childProcess.on("error", (err) => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.error = err;
      stopAcceptingRequests();
      if (childProcess.stdout.readableEnded || childProcess.stdout.destroyed)
        closeReadlineAfterOutput();
      failAfterOutputDrains();
    });
    childHandshakeWait = {
      child: childProcess,
      timer: setTimeout(() => {
        if (childHandshakeWait?.child !== childProcess) {
          return;
        }
        childHandshakeWait = null;
        if (shuttingDown || myGen !== generation || state.handshakeComplete || state.retired || child !== childProcess) {
          return;
        }
        state.retired = true;
        clearBoundChild();
        const message = `ADLC MCP child initialization timed out after ${childHandshakeTimeoutMs}ms`;
        requests.failPending(message, CHILD_HANDSHAKE_TIMEOUT_CODE);
        requests.failInFlight(message, CHILD_HANDSHAKE_TIMEOUT_CODE);
        process.stderr.write(`adlc-mcp-wrapper: ${message}
`);
        void retireSpecificChild(childProcess, readline);
      }, childHandshakeTimeoutMs)
    };
    send(childProcess.stdin, {
      jsonrpc: "2.0",
      id: childHandshakeId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "adlc-cursor-proxy", version: VERSION }
      }
    });
    return { ok: true };
  };
  const flushPending = () => {
    if (!child?.stdin || !childAcceptingRequests) return;
    requests.flush(
      (msg) => send(child.stdin, idBridge.forwardClientRequest(msg, child, generation))
    );
  };
  const resolveAndBindFromPaths = (paths) => {
    const rootsOnlyEnv = { ...env };
    delete rootsOnlyEnv.CURSOR_PROJECT_DIR;
    const workspace = resolveConsumerWorkspace(
      { workspace_roots: paths },
      rootsOnlyEnv
    );
    const picked = mcpRootFromWorkspace(workspace);
    if (!picked.ok) {
      return picked;
    }
    const bound = bindChild(picked.root);
    if (!bound.ok)
      return { ok: false, code: "SPAWN_FAILED", message: bound.message };
    return picked;
  };
  const tryHostEnvBind = () => {
    if (!allowHostEnvFallback) return null;
    const host = resolveHostEnvRoot(env);
    if (!host.ok) return host;
    const bound = bindChild(host.root);
    if (!bound.ok)
      return { ok: false, code: "SPAWN_FAILED", message: bound.message };
    return { ok: true, root: host.root, via: "host-env" };
  };
  const retireActiveRootsRequest = () => {
    if (!activeRootsRequest) {
      return;
    }
    if (activeRootsRequest.timer) clearTimeout(activeRootsRequest.timer);
    activeRootsRequest = null;
  };
  const clearPreInitializedWait = () => {
    if (preInitializedTimer) {
      clearTimeout(preInitializedTimer);
    }
    preInitializedTimer = null;
  };
  const startPreInitializedWait = () => {
    clearPreInitializedWait();
    preInitializedTimer = setTimeout(() => {
      preInitializedTimer = null;
      if (initializedReceived || shuttingDown) {
        return;
      }
      initializationExpired = true;
      const message = `client did not send notifications/initialized within ${preInitializedTimeoutMs}ms`;
      requests.failPending(message);
      process.stderr.write(`adlc-mcp-wrapper: ${message}
`);
    }, preInitializedTimeoutMs);
  };
  const requestRoots = () => {
    if (shuttingDown) {
      return;
    }
    const id = `${ROOTS_REQ_PREFIX}${generation}_${++rootsRequestSequence}`;
    activeRootsRequest = { id, generation, timer: null };
    send(output, { jsonrpc: "2.0", id, method: "roots/list", params: {} });
    activeRootsRequest.timer = setTimeout(() => {
      if (activeRootsRequest?.id !== id) return;
      retireActiveRootsRequest();
      binding = false;
      const message = `roots/list timed out after ${rootsResponseTimeoutMs}ms`;
      requests.failPending(message);
      process.stderr.write(`adlc-mcp-wrapper: ${message}
`);
    }, rootsResponseTimeoutMs);
  };
  return new Promise((resolvePromise) => {
    const lines = createInterface2({ input, crlfDelay: Infinity });
    const signals = signalSource === void 0 ? input === process.stdin ? process : null : signalSource;
    let shutdownPromise = null;
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        shuttingDown = true;
        generation += 1;
        retireActiveRootsRequest();
        idBridge.clear();
        clearPreInitializedWait();
        requests.failPending("ADLC MCP proxy is shutting down");
        requests.failInFlight("ADLC MCP proxy is shutting down");
        await rebindTail;
        await retireChild();
        await waitForRetirements();
        for (const timer of retirementTimers) clearTimeout(timer);
        retirementTimers.clear();
        signals?.removeListener("SIGTERM", onSignal);
        signals?.removeListener("SIGINT", onSignal);
        resolvePromise();
      })();
      return shutdownPromise;
    };
    const onSignal = () => {
      lines.close();
      input.destroy?.();
      void shutdown();
    };
    signals?.on("SIGTERM", onSignal);
    signals?.on("SIGINT", onSignal);
    lines.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const isResponse = isJsonRpcResponse(msg);
      if (activeRootsRequest && msg.id === activeRootsRequest.id && activeRootsRequest.generation === generation && isResponse) {
        retireActiveRootsRequest();
        binding = false;
        if (msg.error) {
          requests.failPending(
            `roots/list failed: ${msg.error.message || "error"}`,
            Number.isInteger(msg.error.code) ? msg.error.code : -32e3
          );
          process.stderr.write(
            `adlc-mcp-wrapper: roots/list error \u2014 ${msg.error.message}
`
          );
          return;
        }
        const decoded = decodeRootsListResult(msg.result);
        if (!decoded.ok) {
          process.stderr.write(
            `adlc-mcp-wrapper: INVALID_ROOTS: ${decoded.message}
`
          );
          requests.failPending(`INVALID_ROOTS: ${decoded.message}`);
          return;
        }
        const picked = resolveAndBindFromPaths(decoded.paths);
        if (!picked.ok) {
          process.stderr.write(
            `adlc-mcp-wrapper: ${picked.code}: ${picked.message}
`
          );
          requests.failPending(`${picked.code}: ${picked.message}`);
        }
        return;
      }
      if (isResponse) {
        const mapping = idBridge.takeChildResponse(msg.id, child, generation);
        if (mapping && child?.stdin && childAcceptingRequests && boundRoot && !binding) {
          send(child.stdin, { ...msg, id: mapping.originalId });
        }
        return;
      }
      if (msg.method === "initialize") {
        const caps = msg.params?.capabilities ?? {};
        clientHasRoots = Boolean(caps.roots);
        send(output, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "adlc-cursor", version: VERSION }
          }
        });
        initializeReceived = true;
        if (!initializedReceived) {
          startPreInitializedWait();
        }
        return;
      }
      if (msg.method === "notifications/initialized") {
        if (!initializeReceived || initializedReceived) return;
        clearPreInitializedWait();
        initializedReceived = true;
        initializationExpired = false;
        if (clientHasRoots) {
          binding = true;
          requestRoots();
          return;
        }
        const host = tryHostEnvBind();
        if (!host || !host.ok) {
          requests.failPending(
            host?.message || "client lacks roots capability; refusing to guess cwd"
          );
          process.stderr.write(
            "adlc-mcp-wrapper: client lacks roots capability; refusing to guess cwd. Install @adlc/cli and use a Roots-capable Cursor build.\n"
          );
        }
        return;
      }
      if (msg.method === "notifications/roots/list_changed") {
        if (shuttingDown) {
          return;
        }
        if (!clientHasRoots) {
          process.stderr.write(
            "adlc-mcp-wrapper: ignoring roots/list_changed from a client without Roots capability\n"
          );
          return;
        }
        const reason = "ADLC MCP roots changed; request failed during rebind";
        requests.failPending(reason);
        requests.failInFlight(reason);
        idBridge.clear();
        generation += 1;
        const rebindGeneration = generation;
        retireActiveRootsRequest();
        boundRoot = null;
        binding = true;
        rebindTail = rebindTail.then(async () => {
          await retireChild();
          await waitForRetirements();
          if (!shuttingDown && rebindGeneration === generation && initializedReceived && clientHasRoots) {
            requestRoots();
          }
        });
        return;
      }
      if (child?.stdin && childAcceptingRequests && boundRoot && !binding) {
        requests.track(msg);
        send(
          child.stdin,
          idBridge.forwardClientRequest(msg, child, generation)
        );
        return;
      }
      if (msg.method === "tools/call" || msg.method === "tools/list") {
        if (!initializeReceived) {
          failClosed(output, msg.id, "ADLC MCP proxy not initialized");
          return;
        }
        if (!initializedReceived || binding) {
          if (!initializedReceived && initializationExpired) {
            failClosed(
              output,
              msg.id,
              `client did not send notifications/initialized within ${preInitializedTimeoutMs}ms`
            );
            return;
          }
          requests.queue(msg);
          return;
        }
        if (!boundRoot) {
          const host = tryHostEnvBind();
          if (host?.ok) {
            requests.queue(msg);
            flushPending();
            return;
          }
          failClosed(
            output,
            msg.id,
            host?.message || "ADLC MCP proxy not bound to a consumer root (Roots unresolved or refused)"
          );
          return;
        }
      }
      if (msg.method?.startsWith("notifications/")) return;
      if (msg.id !== void 0) {
        failClosed(
          output,
          msg.id,
          `ADLC MCP proxy not bound to a consumer root yet (${msg.method})`
        );
      }
    });
    lines.on("close", () => {
      void shutdown();
    });
  });
}

// plugins/adlc-cursor/bin/adlc-mcp-wrapper.mjs
async function main() {
  await runRootsProxy({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    allowHostEnvFallback: false
  });
}
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve5(path);
  }
}
if (process.argv[1] && canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`adlc-mcp-wrapper: ${err?.message ?? err}
`);
    process.exit(1);
  });
}
