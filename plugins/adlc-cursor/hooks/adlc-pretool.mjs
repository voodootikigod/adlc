#!/usr/bin/env node
// adlc-pretool.mjs — the SINGLE Cursor `preToolUse` dispatcher (T18 / T64).
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
// rail immutability, not fitness-to-build; the depth signal is an
// agent-writable file under the user-scoped ADLC state dir. The gate ships
// DISABLED by default behind ADLC_BUILD_GATE_ENFORCEMENT=1 (mirroring
// ADLC_P4_ENFORCEMENT).
//
// Depth signal (T64): per-session counters under ~/.adlc/ (or
// ADLC_CURSOR_STATE_DIR), keyed by SHA-256 session id; idempotent on
// tool_use_id. Session id from resolveSessionIdentity (session_id /
// conversation_id / ADLC_CURSOR_SESSION_ID only).

import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { decide, extractToolName, extractFilePaths, resolveOwning } from './adlc-rails-guard.mjs';
import { classifyTool, isShellTool } from '../rails-checker.mjs';
import { loadTickets, ticketStoreExists } from '@adlc/core';
import { resolveSessionIdentity } from '../lib/session-identity.mjs';
import { bumpDepthCounter as bumpDepthCounterState } from '../lib/session-state.mjs';
import { decideP5SubagentPolicy, isP5TaskPayload } from '../lib/p5-subagent-policy.mjs';

/**
 * Prefer pinned session_id / conversation_id (+ env). Rejects thread/generation
 * as session keys (T64). Legacy name kept for build-gate tests.
 */
export function extractConversationId(payload, env = process.env) {
  const id = resolveSessionIdentity(payload, env);
  if (!id.ok || id.conflict) return null;
  return id.sessionId;
}

/** Per-session depth bump (user-scoped state). Re-exported shape for tests. */
export function bumpDepthCounter(rootIgnored, opts = {}) {
  const {
    now = Date.now(),
    conversationId = null,
    sessionId = conversationId,
    toolUseId = null,
    env = process.env,
    ttlMs,
  } = opts;
  return bumpDepthCounterState(rootIgnored, {
    now,
    sessionId,
    toolUseId: toolUseId ?? opts.tool_use_id ?? null,
    env,
    ttlMs,
  });
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
    const identity = resolveSessionIdentity(payload, env);
    let depth;
    let counterError;
    if (identity.conflict) {
      // Env≠payload: do not mutate named session state; anonymous TTL singleton
      // would still muddy isolation — treat as unreadable depth for mutating.
      counterError = new Error(identity.message ?? 'session identity conflict');
    } else {
      try {
        const toolUseId = typeof payload?.tool_use_id === 'string'
          ? payload.tool_use_id
          : (typeof payload?.toolUseId === 'string' ? payload.toolUseId : null);
        depth = bumpDepthCounter(root, {
          now,
          sessionId: identity.sessionId,
          toolUseId,
          env,
        });
      } catch (err) {
        counterError = err;
      }
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
        // The hook is the process entry point: env resolution happens HERE (the
        // dispatcher's import surface is pinned to @adlc/build-gate/lib/ by test).
        key: typeof env.ADLC_MANIFEST_KEY === 'string' && env.ADLC_MANIFEST_KEY.length > 0 ? env.ADLC_MANIFEST_KEY : null,
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

  // T67: authoritative P5 Task/subagent allowlist on preToolUse (after rails allow).
  const toolName = extractToolName(payload);
  if (isP5TaskPayload(payload, toolName)) {
    const p5 = decideP5SubagentPolicy(payload, { env, now: now ?? Date.now(), toolName });
    if (p5.permission !== 'allow') {
      return {
        permission: p5.permission,
        user_message: p5.reason,
        agent_message:
          `${p5.reason} (authoritative preToolUse Task allowlist during P5). ` +
          'Nested Task lineage is degraded/permissive until proven — see ADR-0006.',
      };
    }
  }

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
