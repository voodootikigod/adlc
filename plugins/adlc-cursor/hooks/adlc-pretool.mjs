#!/usr/bin/env node
// adlc-pretool.mjs — the SINGLE Cursor `preToolUse` dispatcher (T18).
//
// Cursor's multi-entry-per-event ordering and permission-combination semantics
// are UNPINNED (ADR 0006), so a second preToolUse entry could mask a rails
// deny. This dispatcher is therefore the ONLY preToolUse entry the scaffolder
// wires. Its contract (T18, binding):
//
//   1. RAILS FIRST, VERBATIM. It obtains the rails verdict by calling the
//      frozen guard's exported decide() with the UNMODIFIED parsed payload and
//      returns any deny VERBATIM. It never re-assembles extraction from the
//      guard's lower-level exports — that would silently lose the hardened
//      extraction paths (MultiEdit edits[], apply_patch envelope headers,
//      no-path opaque-mutator fail-closed, multi-root ownership).
//   2. BUILDGATE IS LAZY AND OPT-IN. Only when rails allowed AND
//      ADLC_BUILD_GATE_ENFORCEMENT=1 does it dynamic-import() the
//      @adlc/build-gate lib deep subpaths (the package has no exports map;
//      lib/*.mjs subpaths resolve under legacy resolution). A buildgate
//      module-load failure degrades the buildgate only — it can never take
//      down the rails path.
//
// HONESTY (binding, cursor-native-parity spec decision 7): the buildgate is
// ADVISORY and has NO unbypassable backstop. The CI rail-freeze gate enforces
// rail immutability, not fitness-to-build; the depth signal below is an
// agent-writable .adlc/ file. The gate ships DISABLED by default behind
// ADLC_BUILD_GATE_ENFORCEMENT=1 (mirroring ADLC_P4_ENFORCEMENT).
//
// Depth signal: Cursor hooks receive no transcript_path, so depth is a
// tool-call counter this hook persists under .adlc/ (a weak, agent-writable
// proxy — documented as such). Session scoping: the preToolUse payload is NOT
// pinned to carry a conversation/session id (ADR 0006), so the counter is
// scoped by TTL staleness (SESSION_TTL_MS of inactivity resets it) plus an
// opportunistic reset when a conversation-id-shaped field IS present and
// changes. ADLC_BUILD_GATE_DEPTH overrides the counter when set (numeric).

import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { decide, extractToolName, extractFilePaths, resolveOwning } from './adlc-rails-guard.mjs';
import { classifyTool, isShellTool } from '../rails-checker.mjs';
import { SESSION_TTL_MS, DEPTH_COUNTER_FILE } from '../constants.mjs';
import { loadTickets, ticketStoreExists } from '@adlc/core';

// Conversation/session-id-shaped fields seen across agent-hook payloads. NOT
// pinned for Cursor (ADR 0006) — read opportunistically and defensively, the
// same discipline as the frozen guard's TOOL_NAME_KEYS.
const CONVERSATION_ID_KEYS = [
  'conversation_id', 'conversationId', 'session_id', 'sessionId',
  'thread_id', 'threadId', 'generation_id', 'generationId',
];

/** Best-effort conversation/session id from an (unpinned) hook payload. */
export function extractConversationId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const k of CONVERSATION_ID_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Increment the session-scoped tool-call depth counter persisted at
 * .adlc/<DEPTH_COUNTER_FILE>. The stored count is REUSED only when the file is
 * fresh (updated within SESSION_TTL_MS) AND the conversation id (when both
 * sides have one) matches; otherwise the counter resets to zero first — a
 * fresh session must start un-degraded. Returns the post-increment depth.
 * Throws on persistence failure (the caller decides the fail direction).
 */
export function bumpDepthCounter(root, { now = Date.now(), conversationId = null, ttlMs = SESSION_TTL_MS } = {}) {
  const file = join(root, '.adlc', DEPTH_COUNTER_FILE);
  let count = 0;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const fresh = typeof data?.updatedAt === 'number' && now - data.updatedAt >= 0 && now - data.updatedAt <= ttlMs;
    const sameConversation = !conversationId || !data?.conversationId || data.conversationId === conversationId;
    if (fresh && sameConversation && Number.isInteger(data?.count) && data.count >= 0) count = data.count;
  } catch {
    // Missing or corrupt counter file → treat as a fresh session (count 0).
  }
  const next = count + 1;
  const record = { count: next, updatedAt: now };
  if (conversationId) record.conversationId = conversationId;
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  return next;
}

/** The buildgate deny verdict in the pinned Cursor preToolUse stdout shape. */
function buildGateDeny(reason) {
  return {
    permission: 'deny',
    user_message: `ADLC build-gate: ${reason}`,
    agent_message:
      `ADLC build-gate (advisory, opt-in via ADLC_BUILD_GATE_ENFORCEMENT=1): ${reason} ` +
      `To override deliberately, set ADLC_BUILD_GATE_BYPASS=1 — the bypass is recorded to the ` +
      `gate-manifest; an unaudited bypass is refused.`,
  };
}

/**
 * Consult the fitness-to-build gate (issue #48) for a payload that RAILS
 * ALREADY ALLOWED, with ADLC_BUILD_GATE_ENFORCEMENT=1. Returns a deny verdict
 * object, or null for allow / not-applicable. All risk/decide/depth/override
 * logic is imported from @adlc/build-gate lib subpaths — no local copies.
 *
 * `importModule` is a test seam: a broken importer simulates a missing
 * @adlc/build-gate install, which must degrade this gate only (return null).
 */
export async function consultBuildGate(payload, {
  root,
  env = process.env,
  now = Date.now(),
  importModule = (spec) => import(spec),
} = {}) {
  let risk, decideMod, depthSignal, activeTicket, override;
  try {
    risk = await importModule('@adlc/build-gate/lib/risk.mjs');
    decideMod = await importModule('@adlc/build-gate/lib/decide.mjs');
    depthSignal = await importModule('@adlc/build-gate/lib/depth-signal.mjs');
    activeTicket = await importModule('@adlc/build-gate/lib/active-ticket.mjs');
    override = await importModule('@adlc/build-gate/lib/override.mjs');
  } catch (err) {
    // Module-load failure must NEVER take down the rails path (T18 round-2
    // amendment 2): degrade the buildgate to a stderr notice and allow.
    process.stderr.write(
      `adlc-pretool: @adlc/build-gate failed to load — buildgate skipped, rails verdict unaffected (${err?.message ?? err})\n`,
    );
    return null;
  }

  // Buildgate must cover the SAME mutation surface the rails path treats as a
  // mutation (adlc-rails-guard.mjs opaque-mutator branch): a known mutator OR an
  // unrecognized non-shell structured tool. A narrow `=== 'mutating'` hint list
  // would let a novel mutator name (`modify_file`, `save_file`) that the rails
  // classifier fail-closed-CHECKS slip past the fitness-to-build gate entirely —
  // the exact allowlist hole ADR-0006's fail-closed classifier rejects. Mutating
  // classification wins over shell (so `terminal_edit` can't masquerade as shell),
  // mirroring the guard's own precedence.
  const cls = classifyTool(extractToolName(payload));
  const mutating = cls === 'mutating' || (cls === 'other' && !isShellTool(extractToolName(payload)));
  try {
    const storeOverride = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
    const ticketsPath = storeOverride ? (isAbsolute(storeOverride) ? storeOverride : join(root, storeOverride)) : join(root, '.adlc', 'tickets.json');
    if (!ticketStoreExists(root, storeOverride)) return null; // not an ADLC repo → no-op

    const active = activeTicket.resolveActiveTicketId({ dir: root, env });
    if (active.conflict) {
      if (!mutating) return null;
      return buildGateDeny(`${active.message ?? 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)'} — failing closed.`);
    }
    if (!active.id) return null; // no active ticket → opt-in gate no-ops

    // Depth accrues on EVERY dispatched tool call while enforcement is on
    // (reads included) — the gate itself only ever denies a structured mutation
    // attempt (the `mutating` surface above: a known mutator OR an unrecognized
    // non-shell structured tool), matching the rails path's fail-closed surface
    // rather than a narrow known-name allowlist.
    let depth;
    let counterError;
    try {
      depth = bumpDepthCounter(root, { now, conversationId: extractConversationId(payload) });
    } catch (err) {
      counterError = err;
    }
    const envDepth = Number.parseInt(env.ADLC_BUILD_GATE_DEPTH ?? '', 10);
    if (Number.isFinite(envDepth)) depth = envDepth;

    if (!mutating) return null;

    const loaded = loadTickets(ticketsPath);
    if (loaded.errors.length) return buildGateDeny(`cannot read ticket store (${loaded.errors[0]}) — active ticket ${active.id}'s risk cannot be verified, failing closed.`);
    const ticket = loaded.tickets.find((t) => t && typeof t === 'object' && t.id === active.id);
    if (!ticket) {
      return buildGateDeny(`active ticket ${active.id} not found in .adlc/tickets.json — failing closed.`);
    }

    const { tier, signals } = risk.computeRiskTier(ticket);
    if (tier !== 'high') return null; // the gate only guards high-risk tickets

    if (depth === undefined) {
      // High-risk ticket whose context-fitness signal cannot be computed —
      // fail closed (mirrors the CC hook's unreadable-transcript branch).
      return buildGateDeny(
        `active ticket ${active.id} is high-risk but the session depth counter could not be ` +
        `read/persisted (${counterError?.message ?? counterError}) — the context-fitness signal ` +
        `cannot be verified, failing closed.`,
      );
    }

    const degraded = depthSignal.isDegraded({ depth });
    const verdict = decideMod.decideBuildGate({
      riskTier: tier,
      degraded,
      bypass: env.ADLC_BUILD_GATE_BYPASS === '1',
      recordBypass: () => override.recordOverride({
        ticketId: active.id,
        signals,
        depth,
        sessionBytes: null,
        reason: 'cursor preToolUse dispatcher bypass (ADLC_BUILD_GATE_BYPASS=1)',
        dir: join(root, '.adlc'),
      }),
    });
    if (verdict.decision === 'deny') return buildGateDeny(`${verdict.reason} (depth=${depth}).`);
    return null;
  } catch (err) {
    // The gate was explicitly opted into (ADLC_BUILD_GATE_ENFORCEMENT=1), so an
    // unexpected error while evaluating a MUTATING tool fails closed (the CC
    // sibling's discipline); anything else stays a no-op.
    if (mutating) {
      return buildGateDeny(`internal error while enforcing (${err?.message ?? err}) — failing closed.`);
    }
    return null;
  }
}

/**
 * The dispatcher decision: rails first (verbatim), then — only on rails-allow
 * AND ADLC_BUILD_GATE_ENFORCEMENT=1 — the lazy buildgate consult.
 */
export async function dispatch(payload, { root, env = process.env, now, importModule } = {}) {
  const rails = decide(payload, root != null ? { root, env } : { env });
  if (rails.permission !== 'allow') return rails; // any non-allow returned VERBATIM

  if (env.ADLC_BUILD_GATE_ENFORCEMENT !== '1') return rails; // buildgate is default-OFF

  const owningRoot = root ?? resolveOwning(payload, extractFilePaths(payload)[0]).root;
  const gate = await consultBuildGate(payload, { root: owningRoot, env, now, importModule });
  return gate ?? rails;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      // Same enforcement-aware fail-safe as the frozen guard's own wire
      // handler: an unparseable payload under active enforcement cannot be
      // verified → fail CLOSED; otherwise fail open (don't brick the editor).
      const enforcing = process.env.ADLC_P4_ENFORCEMENT === '1';
      process.stderr.write(`adlc-pretool: malformed payload JSON (failing ${enforcing ? 'CLOSED' : 'OPEN'}) — ${err.message}\n`);
      process.stdout.write(JSON.stringify(enforcing
        ? {
            permission: 'deny',
            user_message: 'ADLC rails-guard: unparseable tool payload while enforcement is active — failing closed',
            agent_message: 'The rail guard received a tool payload it could not parse during an active build, so the edit cannot be verified against the frozen rails and is denied. Retry with a well-formed structured edit.',
          }
        : { permission: 'allow' }));
      return;
    }
  }
  const verdict = await dispatch(payload, { env: process.env });
  process.stdout.write(JSON.stringify(verdict));
}

// Run as a hook only when invoked directly (tests import dispatch() instead).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
