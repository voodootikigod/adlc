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

import { checkToolCall } from './rails-checker.mjs';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from './lib/session-hooks.mjs';

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

  return {
    'tool.execute.before': async (input, output) => {
      const tool = input?.tool;
      if (!tool) return;
      // Pinned contract (v1.17.13): args are on output.args. The input.args
      // fallback is tolerance for older hosts, not the primary read.
      const args = output?.args ?? input?.args ?? {};

      const verdict = checkToolCall({ tool, args, root, env: process.env });
      if (verdict.decision !== 'deny') return;

      const message = `ADLC rails-guard: blocked ${tool} — ${verdict.reason}`;
      if (advisoryOnly) {
        // Explicit operator downgrade: surface loudly without claiming to block.
        await notify(`${message} [ADVISORY — ADLC_ALLOW_ADVISORY_HOOKS=1; the CI rail-freeze gate remains authoritative]`, 'warning');
        return;
      }
      // Enforcing (default): notify fire-and-forget, then throw to abort the tool.
      notify(message, 'error');
      throw new Error(message);
    },

    // session.created (Phase C): advisory environment preflight. Never throws.
    'session.created': async () => {
      try {
        const { skipped, warnings } = checkPreflight(root, { env: process.env });
        if (!skipped) for (const w of warnings) await notify(`ADLC preflight: ${w}`, 'warning');
      } catch { /* advisory: swallow */ }
    },

    // session.idle (Phase C): advisory gate-evidence audit (the plan's
    // "session.ended" — OpenCode has no such event; session.idle is the
    // end-of-work signal). Never throws.
    'session.idle': async () => {
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
    },
  };
};

export default adlcRailsGuard;
