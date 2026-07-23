// p5-subagent-policy.mjs — P5 Task/subagent allowlist (T67).
// Authoritative enforcement is preToolUse; subagentStart is defense-in-depth.
// Nested Task during P5 is explicitly degraded/permissive until lineage is proven.

import { readP5Marker } from './session-state.mjs';
import { resolveSessionIdentity } from './session-identity.mjs';

export const PROSECUTOR_AGENT_NAMES = new Set([
  'prosecutor-correctness',
  'prosecutor-security',
  'prosecutor-contract',
  'prosecutor-diff',
  'prosecutor-tests',
  'prosecutor-verifier',
  'prosecutor', // optional orchestrator
]);

/** Extra types the prosecute command may use (only when marker is fresh). */
export const P5_EXTRA_ALLOWED = new Set(['generalPurpose', 'explore']);

export function isTaskSpawnTool(toolName) {
  if (typeof toolName !== 'string') return false;
  const n = toolName.trim().toLowerCase();
  return n === 'task' || n === 'task_tool' || n === 'agent' || n === 'spawn_agent';
}

/**
 * Extract agent/subagent name from docs-pinned / fixture Task payloads.
 */
export function extractAgentName(payload) {
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
    payload?.agentName,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

export function resolveMarkerSessionId(payload, env = process.env) {
  const id = resolveSessionIdentity(payload, env);
  if (id.conflict) return { ok: false, conflict: true, message: id.message };
  return { ok: true, sessionId: id.sessionId ?? null };
}

/**
 * @returns {{ permission: 'allow'|'ask'|'deny', reason: string, marker: object|null }}
 */
export function decideP5SubagentPolicy(payload, {
  env = process.env,
  now = Date.now(),
  toolName = null,
} = {}) {
  const session = resolveMarkerSessionId(payload, env);
  if (session.conflict) {
    // Do not brick the editor on identity conflict — allow ordinary spawns.
    return { permission: 'allow', reason: 'session identity conflict — P5 allowlist skipped', marker: null };
  }

  const marker = readP5Marker(session.sessionId, { env, now });
  if (!marker) {
    return { permission: 'allow', reason: 'no fresh session-matching P5 marker', marker: null };
  }

  const name = extractAgentName(payload);
  if (!name) {
    return {
      permission: 'ask',
      reason: 'P5 marker present but Task/subagent agent name missing — cannot verify allowlist',
      marker,
    };
  }

  if (PROSECUTOR_AGENT_NAMES.has(name) || P5_EXTRA_ALLOWED.has(name)) {
    return { permission: 'allow', reason: `P5 allowlist: ${name}`, marker };
  }

  // Unrelated agent under a fresh matching marker → ask (prefer ask over silent deny
  // so operators can override; T68 live proof may observe deny when configured).
  const mode = env.ADLC_CURSOR_P5_UNRELATED === 'deny' ? 'deny' : 'ask';
  return {
    permission: mode,
    reason: `P5 marker active — unrelated subagent/agent "${name}" not on prosecutor allowlist`,
    marker,
  };
}

export function isP5TaskPayload(payload, toolName) {
  const tn = toolName ?? payload?.tool_name ?? payload?.toolName ?? null;
  return isTaskSpawnTool(tn);
}
