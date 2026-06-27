// index.mjs — the ADLC OpenCode plugin entrypoint.
//
// Wires OpenCode's `tool.execute.before` hook to the rail-enforcement decision in
// rails-checker.mjs (which delegates to @adlc/core). It does NOT reimplement any
// gate. The deny path imports only Node builtins + @adlc/core (first-party,
// zero third-party dependency).
//
// Enforcement-capability gate (integration-plan Phase D): a thrown error in
// `tool.execute.before` only blocks the write if the host SDK honors it
// (onFailure:deny). When the capability is unproven, the hook runs ADVISORY
// (surfaces the violation, does not claim to block) unless the operator opts into
// advisory mode; otherwise it signals that preflight should fail closed.

import { checkRail, probeEnforcementCapability } from './rails-checker.mjs';
import { checkPreflight, auditGateManifest } from './lib/session-hooks.mjs';

/** @typedef {import('@opencode-ai/plugin').Plugin} Plugin */

/** @type {Plugin} */
export const adlcRailsGuard = async ({ directory, worktree, project } = {}) => {
  // The repo root used to locate .adlc/ and to canonicalize edited paths.
  const root = worktree ?? directory ?? project?.worktree ?? process.cwd();
  const enforces = probeEnforcementCapability({ directory, worktree, project });
  const advisoryAllowed = process.env.ADLC_ALLOW_ADVISORY_HOOKS === '1';

  return {
    'tool.execute.before': async (input, output) => {
      const tool = input?.tool;
      // Sources disagree on whether the edited path is on input.args or
      // output.args; read input first, fall back to output. (ADR 0004 tracks
      // pinning this against a captured real payload.)
      const filePath = input?.args?.filePath ?? output?.args?.filePath;
      if (!filePath || !tool) return;

      const verdict = checkRail({ filePath, tool, root, env: process.env });
      if (verdict.decision !== 'deny') return;

      const message = `ADLC rails-guard: blocked edit to ${verdict.reason}`;
      if (enforces || !advisoryAllowed) {
        // Enforcing (or refusing to silently downgrade): throw to abort the tool.
        throw new Error(message);
      }
      // Advisory mode: cannot abort, so surface loudly without claiming to block.
      console.error(`${message} [ADVISORY — host SDK does not honor deny; rely on the CI rail-freeze gate]`);
    },

    // session.created (Phase C): advisory environment preflight. Never throws.
    'session.created': async () => {
      try {
        const { skipped, warnings } = checkPreflight(root, { env: process.env });
        if (!skipped) for (const w of warnings) console.error(`ADLC preflight: ${w}`);
      } catch { /* advisory: swallow */ }
    },

    // session.idle (Phase C): advisory gate-evidence audit (the plan's
    // "session.ended" — OpenCode has no such event; session.idle is the
    // end-of-work signal). Never throws.
    'session.idle': async () => {
      try {
        const { warning } = auditGateManifest(root);
        if (warning) console.error(`ADLC gate-manifest audit: ${warning}`);
      } catch { /* advisory: swallow */ }
    },
  };
};

export default adlcRailsGuard;
