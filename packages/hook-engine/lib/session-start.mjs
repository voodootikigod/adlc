// session-start.mjs — shared SessionStart context injection builder.

import { computeRiskTier } from '@adlc/build-gate/lib/risk.mjs';
import { enclosingAdlcRoot, readActiveTicketRails } from './pretool.mjs';

/**
 * Evaluate SessionStart for a workspace: resolves enclosing checkout root,
 * active ticket, frozen rails, risk tier, and concise additionalContext text.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string | null} [opts.outerRoot]
 * @param {string | null} [opts.storeOverride]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ root: string | null, activeTicket: object | null, rails: string[], risk: { tier: 'high' | 'normal', signals: string[] }, additionalContext: string }}
 */
export function evaluateSessionStart({
  cwd = process.cwd(),
  outerRoot = null,
  storeOverride = null,
  env = process.env,
} = {}) {
  const root = enclosingAdlcRoot(cwd, { outerRoot, storeOverride });
  if (!root) {
    return {
      root: null,
      activeTicket: null,
      rails: [],
      risk: { tier: 'normal', signals: [] },
      additionalContext: '',
    };
  }

  const { activeTicket, rails } = readActiveTicketRails(root, { storeOverride, env });
  const risk = computeRiskTier(activeTicket ?? {});

  if (!activeTicket && rails.length === 0) {
    return { root, activeTicket: null, rails: [], risk, additionalContext: '' };
  }

  const lines = [];
  if (activeTicket) {
    lines.push(`ADLC active ticket: ${activeTicket.id} (risk: ${risk.tier})`);
  }
  if (rails.length > 0) {
    lines.push(`Frozen rails (${rails.length}): ${rails.join(', ')}`);
  }
  return {
    root,
    activeTicket,
    rails,
    risk,
    additionalContext: lines.join('\n'),
  };
}
