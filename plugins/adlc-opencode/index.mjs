// index.mjs — the ADLC OpenCode plugin entrypoint.
//
// Wires OpenCode's `tool.execute.before` hook to the rail-enforcement decision in
// rails-checker.mjs (which delegates to @adlc/core). It does NOT reimplement any
// gate. The deny path imports only Node builtins + @adlc/core (first-party,
// zero third-party dependency).
//
// Enforcement contract (pinned against @opencode-ai/plugin v1.17.13): a thrown
// error in `tool.execute.before` ABORTS the tool call — this is documented host
// behavior, so the hook ENFORCES BY DEFAULT. The mutable tool args live on the
// second hook parameter (`output.args`); `input` carries only
// { tool, sessionID, callID }. The only downgrade is the explicit operator
// escape hatch ADLC_ALLOW_ADVISORY_HOOKS=1 (surface, don't block) — there is no
// capability probe anymore, because the capability is documented, and the live
// deny proof (scripts/opencode-live-deny.mjs) regression-tests it against a real
// opencode binary.

import { checkToolCall, resolveRailsInForce, railHit, extractTargets, READONLY_TOOLS, UNGATED_TOOLS, SHELL_TOOLS } from './rails-checker.mjs';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from './lib/session-hooks.mjs';
import { createDepthTracker, checkBuildGate } from './lib/build-gate.mjs';
import { handleFileEdited, createWatcherState } from './lib/watcher.mjs';
import { buildSystemContext, buildToolRailNotice, buildStatusLine } from './lib/context-inject.mjs';
import { createFlailTracker, flailMessage } from './lib/flail.mjs';

/** @typedef {import('@opencode-ai/plugin').Plugin} Plugin */

/**
 * Surface a message to the operator. Best-effort on every channel, never
 * throws, never blocks the caller: the OpenCode TUI toast (the channel a TUI
 * user actually sees), the server log, and stderr as the always-available
 * fallback.
 */
function makeNotify(client) {
  return (message, variant = 'error') => {
    console.error(message);
    const deliveries = [];
    try {
      const toast = client?.tui?.showToast?.({ body: { title: 'ADLC', message, variant } });
      if (toast?.catch) deliveries.push(toast.catch(() => {}));
    } catch { /* toast channel unavailable — stderr already carried it */ }
    try {
      const log = client?.app?.log?.({ body: { service: 'adlc-opencode', level: variant === 'error' ? 'error' : 'warn', message } });
      if (log?.catch) deliveries.push(log.catch(() => {}));
    } catch { /* log channel unavailable */ }
    return Promise.all(deliveries).then(() => undefined);
  };
}

/** @type {Plugin} */
export const adlcRailsGuard = async ({ directory, worktree, project, client } = {}) => {
  // The repo root used to locate .adlc/ and to canonicalize edited paths.
  const root = worktree ?? directory ?? project?.worktree ?? process.cwd();
  const advisoryOnly = process.env.ADLC_ALLOW_ADVISORY_HOOKS === '1';
  const notify = makeNotify(client);
  // Phase 2.3: per-session context-fitness state for the build-gate backstop.
  const tracker = createDepthTracker();
  // Phase 2.4/2.5: restore-loop-guard state for the file.edited watcher.
  const watcherState = createWatcherState();
  // Phase 3.3: per-session churn tracker for the flail advisory.
  const flail = createFlailTracker();

  const deny = async (message) => {
    if (advisoryOnly) {
      // Explicit operator downgrade: surface loudly without claiming to block.
      await notify(`${message} [ADVISORY — ADLC_ALLOW_ADVISORY_HOOKS=1; the CI rail-freeze gate remains authoritative]`, 'warning');
      return;
    }
    // Enforcing (default): notify fire-and-forget, then throw to abort the tool.
    notify(message, 'error');
    throw new Error(message);
  };

  const isStructuredMutator = (name) =>
    !READONLY_TOOLS.includes(name) && !UNGATED_TOOLS.includes(name) && !SHELL_TOOLS.includes(name);

  return {
    'tool.execute.before': async (input, output) => {
      const tool = input?.tool;
      if (!tool) return;
      tracker.recordToolCall(input?.sessionID);
      // Pinned contract (v1.17.13): args are on output.args. The input.args
      // fallback is tolerance for older hosts, not the primary read.
      const args = output?.args ?? input?.args ?? {};

      const verdict = checkToolCall({ tool, args, root, env: process.env });
      if (verdict.decision === 'deny') {
        return deny(`ADLC rails-guard: blocked ${tool} — ${verdict.reason}`);
      }

      // Phase 2.3 build-gate backstop: a structured mutation on a HIGH-RISK
      // ticket in a context-degraded session is denied even off-rails.
      if (isStructuredMutator(String(tool).toLowerCase())) {
        const gate = checkBuildGate({ sessionID: input?.sessionID, tracker, root, env: process.env });
        if (gate.decision === 'deny') {
          return deny(`ADLC build-gate: blocked ${tool} — ${gate.reason}`);
        }
        if (gate.overridden) {
          await notify(`ADLC build-gate: audited override recorded for ${tool}`, 'warning');
        }
      }
    },

    // Phase 2.3: a compacted session IS the context-rot event — mark it degraded.
    // Phase 2.4/2.5: file.edited drives the post-hoc watcher (suppression,
    // scope, and the tool-name-independent rail backstop). The event hook is
    // fire-and-forget in the host (cannot block), so these are all post-hoc.
    event: async ({ event } = {}) => {
      try {
        if (event?.type === 'session.compacted') {
          const sessionID = event?.properties?.sessionID ?? event?.properties?.info?.id;
          tracker.markCompacted(sessionID);
          return;
        }
        if (event?.type === 'file.edited') {
          const { actions } = handleFileEdited({
            file: event?.properties?.file,
            root,
            env: process.env,
            state: watcherState,
          });
          for (const a of actions) {
            await notify(a.message, a.action === 'restored' ? 'error' : 'warning');
          }
        }
      } catch { /* advisory: swallow — the watcher must never break the host */ }
    },

    // Phase 2.1 — DORMANT deny lever. At opencode 1.17.13 `permission.ask` is
    // defined in the Hooks interface but never dispatched (upstream #7006);
    // the enforcing control is the tool.execute.before throw above. This
    // handler exists so rail denial extends to permission prompts the moment
    // upstream wires the hook. Tolerant of both documented Permission shapes
    // (V1 {type, pattern} and V2 {action, resources[]}); never throws.
    'permission.ask': async (input, output) => {
      try {
        const kind = String(input?.type ?? input?.action ?? '').toLowerCase();
        if (READONLY_TOOLS.includes(kind)) return;
        const force = resolveRailsInForce(root, process.env);
        if (!force.active) return;
        if (force.conflict) { output.status = 'deny'; return; }
        const raw = [
          ...(Array.isArray(input?.pattern) ? input.pattern : [input?.pattern]),
          ...(Array.isArray(input?.resources) ? input.resources : []),
        ].filter((p) => typeof p === 'string' && p.trim());
        for (const target of raw) {
          const hit = railHit(target, force.rails, root);
          if (hit) {
            output.status = 'deny';
            await notify(`ADLC rails-guard: denied permission "${kind}" — frozen rail "${hit}" (active ticket ${force.ticketId})`, 'error');
            return;
          }
        }
      } catch { /* dormant lever must never break the host */ }
    },

    // Phase 3.3: churn/flail advisory. A file rewritten many times in one
    // session often means the model is stuck; warn once per churning file.
    // tool.execute.after carries args on the INPUT side (unlike before). Never
    // throws — advisory only.
    'tool.execute.after': async (input) => {
      try {
        // extractTargets covers filePath/path/files[]/edits[] AND apply_patch
        // envelope bodies — so churn is counted for GPT-5-class models too,
        // where apply_patch is the ONLY mutator (bare filePath would miss it).
        // Dedupe per event: one tool call editing a file is one churn increment,
        // even if its args name that file twice (repeated edits[]/filePath+patch).
        const targets = [...new Set(extractTargets(input?.args))];
        for (const filePath of targets) {
          const { churning } = flail.record({ sessionID: input?.sessionID, tool: input?.tool, filePath });
          for (const c of churning) await notify(flailMessage(c), 'warning');
        }
      } catch { /* advisory: swallow */ }
    },

    // Phase 3.1: re-state the active build's constraints (ticket, frozen rails,
    // scope) in the system prompt every turn — a context-rot defense so the
    // model is reminded BEFORE it acts, not only blocked after. Mutates
    // output.system in place (the host reads that array); never throws.
    'experimental.chat.system.transform': async (_input, output) => {
      try {
        const block = buildSystemContext(root, process.env);
        if (block && Array.isArray(output?.system)) output.system.push(block);
      } catch { /* advisory: swallow — never break prompt assembly */ }
    },

    // Phase 3.2: name the frozen rails in the edit/write/apply_patch tool
    // descriptions so the model sees the constraint at the point of choosing to
    // write. Mutates output.description in place; never throws.
    'tool.definition': async (input, output) => {
      try {
        const tool = String(input?.toolID ?? '').toLowerCase();
        if (!['edit', 'write', 'apply_patch'].includes(tool)) return;
        const notice = buildToolRailNotice(root, process.env);
        if (notice && typeof output?.description === 'string') output.description += notice;
      } catch { /* advisory: swallow */ }
    },

    // session.created (Phase C): advisory environment preflight. Never throws.
    // Phase 3.4 (verifiable native touch): surface the active-ticket statusline
    // as an info toast via the confirmed client.tui.showToast channel (the
    // persistent JSX statusline slot is deferred — see docs).
    'session.created': async () => {
      try {
        const line = buildStatusLine(root, process.env);
        if (line) await notify(line, 'info');
      } catch { /* advisory: swallow */ }
      try {
        const { skipped, warnings } = checkPreflight(root, { env: process.env });
        if (!skipped) for (const w of warnings) await notify(`ADLC preflight: ${w}`, 'warning');
      } catch { /* advisory: swallow */ }
    },

    // session.idle (Phase C): advisory gate-evidence audit (the plan's
    // "session.ended" — OpenCode has no such event; session.idle is the
    // end-of-work signal). Never throws.
    'session.idle': async (input) => {
      try {
        const { warning } = auditGateManifest(root);
        if (warning) await notify(`ADLC gate-manifest audit: ${warning}`, 'warning');
      } catch { /* advisory: swallow */ }

      // Mechanical adversarial-review trigger (issue #59): deterministic,
      // no-LLM check that a risk-gated change has a recorded review. Advisory
      // only — session.idle has no blocking contract in OpenCode.
      try {
        const { warning } = auditAdversarialReview(root, { env: process.env });
        if (warning) await notify(`ADLC adversarial-review audit: ${warning}`, 'warning');
      } catch { /* advisory: swallow */ }

      // Phase 3.3: best-effort release of this session's churn state now that
      // it's idle. The hard memory bound is the tracker's LRU session cap; this
      // is an optimization, so it tolerates not knowing session.idle's exact
      // payload shape (reads a couple of candidates).
      try {
        const sessionID = input?.sessionID ?? input?.event?.properties?.sessionID;
        if (sessionID) flail.evict(sessionID);
      } catch { /* advisory: swallow */ }
    },
  };
};

export default adlcRailsGuard;
