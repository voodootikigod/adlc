#!/usr/bin/env node

// plugins/adlc-cursor/hooks/adlc-subagent.mjs
import { fileURLToPath } from "node:url";

// plugins/adlc-cursor/lib/session-state.mjs
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// plugins/adlc-cursor/constants.mjs
var SESSION_TTL_MS = 30 * 60 * 1e3;

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

// plugins/adlc-cursor/lib/session-state.mjs
function resolveStateDir(env = process.env) {
  const override = typeof env.ADLC_CURSOR_STATE_DIR === "string" && env.ADLC_CURSOR_STATE_DIR.trim() ? env.ADLC_CURSOR_STATE_DIR.trim() : null;
  return override || join(homedir(), ".cursor", "adlc");
}
function markerPath(stateDir, sessionId) {
  const name = sessionId ? `cursor-p5-marker-${sessionSafeId(sessionId)}.json` : "cursor-p5-marker-anonymous.json";
  const path = join(stateDir, name);
  if (!path.startsWith(stateDir)) throw new Error("marker path escaped state dir");
  return path;
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
var LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));
function readP5Marker(sessionId, { env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const cur = readJson(markerPath(resolveStateDir(env), sessionId));
  if (!cur) return null;
  if (typeof cur.ts !== "number" || now - cur.ts > ttlMs) return null;
  if ((cur.sessionId ?? null) !== (sessionId ?? null)) return null;
  return cur;
}

// plugins/adlc-cursor/lib/p5-subagent-policy.mjs
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

// plugins/adlc-cursor/hooks/adlc-subagent.mjs
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function handleSubagentStart(payload, { env = process.env, now = Date.now() } = {}) {
  const decision = decideP5SubagentPolicy(payload, { env, now });
  if (decision.permission === "allow") {
    return {
      permission: "allow",
      agent_message: decision.reason
    };
  }
  return {
    permission: decision.permission,
    user_message: decision.reason,
    agent_message: `${decision.reason}. Nested Task during P5 is degraded/permissive until lineage is proven (ADR-0006). Authoritative Task allowlist is also enforced on preToolUse.`
  };
}
function handleSubagentStop() {
  return {
    agent_message: "ADLC subagentStop: prosecution marker cleanup remains the command's responsibility (runId compare-and-delete)."
  };
}
async function main() {
  const event = process.argv.includes("--stop") ? "subagentStop" : process.env.ADLC_CURSOR_HOOK_EVENT === "subagentStop" ? "subagentStop" : "subagentStart";
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      process.stdout.write(JSON.stringify({ permission: "allow" }));
      return;
    }
  }
  if (event === "subagentStop") {
    process.stdout.write(JSON.stringify(handleSubagentStop()));
    return;
  }
  process.stdout.write(JSON.stringify(handleSubagentStart(payload, { env: process.env })));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
export {
  handleSubagentStart,
  handleSubagentStop
};
