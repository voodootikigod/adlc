// prosecute-runner.mjs — T33: the DETERMINISTIC P5 prosecution loop, in
// first-party code. Instead of prose-instructing the host model to orchestrate
// fan-out → dedupe → verify → loop-until-dry, the native `adlc_prosecute` tool
// calls runProsecution(), which drives that protocol itself using the tested
// @adlc/core helpers (via lib/prosecutor.mjs) and spawns lens/verifier work as
// isolated, WRITE-DISABLED child sessions.
//
// Everything here is pure + injectable: runProsecution takes an `ask` function
// (real → child session; test → mock), so the control flow is unit-testable
// offline. The session wiring (makeLensAsk) is proven end-to-end by the live
// harness against a real opencode.

import {
  LENSES, VERIFIER, findingKey, dedupeFindings, survivesVerification, shouldContinue,
} from './prosecutor.mjs';
import { MUTATING_TOOLS, SHELL_TOOLS } from '../rails-checker.mjs';
import { PROMPT_TIMEOUT_MS } from './keyless-bridge.mjs';

// A lens/verifier session must be able to READ but never MUTATE. Disabling by
// an explicit false map (not an allowlist) means a write tool the host adds
// later still can't be enabled here without a code change.
export const WRITE_TOOLS = [...MUTATING_TOOLS, ...SHELL_TOOLS];

/** The tools disable-map handed to a lens/verifier child session.prompt. */
export function lensToolsMap(extra = []) {
  const map = {};
  for (const t of [...WRITE_TOOLS, ...extra]) map[t] = false;
  return map;
}

/**
 * Extract a fenced JSON payload from a reply. Findings/verdicts are requested
 * as a ```json block. Returns the parsed value, or null on absence/parse
 * failure — the caller decides the fail-closed behavior (never silently drop).
 */
export function parseFenced(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (m ? m[1] : text).trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** Normalize a lens reply into a findings array (fail-closed to []). */
export function parseFindings(text) {
  const v = parseFenced(text);
  if (Array.isArray(v)) return v.filter((f) => f && typeof f === 'object');
  if (v && Array.isArray(v.findings)) return v.findings.filter((f) => f && typeof f === 'object');
  return [];
}

/** Normalize a verifier reply into a {real:boolean} vote, or null if unparseable. */
export function parseVerdict(text) {
  const v = parseFenced(text);
  if (v && typeof v.real === 'boolean') return { real: v.real, reason: typeof v.reason === 'string' ? v.reason : undefined };
  return null;
}

/**
 * Build the real lens/verifier `ask` from the host SDK client: each call spins
 * up an isolated child session (parentID = active session) with a per-call
 * SYSTEM override (the agent prompt) and the WRITE-DISABLED tools map, returns
 * the reply text, and best-effort deletes the child. Returns null when the
 * client lacks the session API (caller falls back to the prose protocol).
 * Mirrors keyless-bridge makeAsk, adding `system` + the tools disable-map.
 */
export function makeLensAsk(client, { parentID, model, timeoutMs = PROMPT_TIMEOUT_MS, withTimeout } = {}) {
  const session = client?.session;
  if (typeof session?.create !== 'function' || typeof session?.prompt !== 'function') return null;
  const race = withTimeout ?? ((p) => p);
  return async ({ system, prompt }) => {
    const created = await race(
      session.create({ body: { ...(parentID ? { parentID } : {}), title: 'adlc-prosecute' } }),
      timeoutMs, 'prosecute: child session.create timed out');
    const childId = created?.data?.id ?? created?.id;
    try {
      const res = await race(
        session.prompt({
          path: { id: childId },
          body: {
            ...(model ? { model } : {}),
            ...(system ? { system } : {}),
            tools: lensToolsMap(),
            parts: [{ type: 'text', text: prompt }],
          },
        }),
        timeoutMs, 'prosecute: child session.prompt timed out');
      const parts = res?.data?.parts ?? res?.parts ?? [];
      return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('') || '';
    } finally {
      try { if (childId && typeof session.delete === 'function') await session.delete({ path: { id: childId } }); }
      catch { /* best-effort cleanup */ }
    }
  };
}

const DEFAULTS = { maxRounds: 4, maxSessions: 40, maxDry: 2, verifierVotes: 1 };

/**
 * Drive the deterministic P5 loop.
 *
 * @param {object} opts
 * @param {(req:{agent:string,system:string,prompt:string}) => Promise<string>} opts.ask
 *   lens/verifier caller (real child session or test mock).
 * @param {(agent:string) => string} opts.agentPrompt  system prompt for an agent key.
 * @param {string} opts.diff   the change under prosecution (lens/verifier context).
 * @param {object} [opts.bounds]  { maxRounds, maxSessions, maxDry, verifierVotes }
 * @returns {Promise<{confirmed:object[], unverified:object[], rounds:number, sessionsUsed:number, hitBound:string|null}>}
 */
export async function runProsecution({ ask, agentPrompt, diff, bounds = {} } = {}) {
  const { maxRounds, maxSessions, maxDry, verifierVotes } = { ...DEFAULTS, ...bounds };
  if (typeof ask !== 'function') throw new Error('runProsecution: an ask() function is required');

  const seen = new Set();          // findingKey of every finding ever surfaced (dedupe across rounds)
  const confirmed = [];
  const unverified = [];
  let sessionsUsed = 0;
  let dryStreak = 0;
  let round = 0;
  let hitBound = null;
  let naturalStop = false; // loop went dry (converged) rather than hitting a bound

  const askOne = async (agent, prompt) => {
    if (sessionsUsed >= maxSessions) { hitBound = 'maxSessions'; return null; }
    sessionsUsed += 1;
    return ask({ agent, system: agentPrompt ? agentPrompt(agent) : '', prompt });
  };

  while (round < maxRounds) {
    round += 1;

    // Fan out every lens for this round (each in its own write-disabled session).
    const lensReplies = await Promise.all(LENSES.map(async (lens) => {
      const text = await askOne(lens.agent, `Prosecute this change through the ${lens.focus} lens. Return findings as a fenced \`\`\`json array of {title, severity, file, detail}.\n\n${diff}`);
      return text == null ? [] : parseFindings(text);
    }));
    if (hitBound) break;

    const roundFindings = dedupeFindings(lensReplies.flat());
    const fresh = roundFindings.filter((f) => !seen.has(findingKey(f)));
    for (const f of fresh) seen.add(findingKey(f));

    // Verify each fresh finding (verifierVotes independent votes). An unparseable
    // verdict yields NO valid vote → survivesVerification keeps it (fail-closed).
    for (const f of fresh) {
      const votes = [];
      let unparsedVote = false;
      for (let i = 0; i < verifierVotes; i += 1) {
        const text = await askOne(VERIFIER.agent, `Try to REFUTE this finding — reproduce it or prove it false. Return a fenced \`\`\`json {"real": boolean, "reason": string}.\n\nFinding: ${JSON.stringify(f)}\n\n${diff}`);
        if (hitBound) break;
        const v = parseVerdict(text);
        if (v) votes.push(v); else unparsedVote = true;
      }
      if (hitBound) break;
      const kept = survivesVerification(votes);
      if (kept) {
        confirmed.push(f);
        if (unparsedVote && votes.length === 0) unverified.push(f); // kept but never verifiably confirmed
      }
    }
    if (hitBound) break;

    const step = shouldContinue({ freshThisRound: fresh.length, dryStreak, maxDry });
    dryStreak = step.dryStreak;
    if (!step.continue) { naturalStop = true; break; }
  }
  // Only a bound if we exhausted the round budget WITHOUT converging.
  if (!hitBound && !naturalStop && round >= maxRounds) hitBound = 'maxRounds';

  return { confirmed: dedupeFindings(confirmed), unverified, rounds: round, sessionsUsed, hitBound };
}
