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
import { READONLY_TOOLS } from '../rails-checker.mjs';
import { PROMPT_TIMEOUT_MS } from './keyless-bridge.mjs';

// A lens/verifier session must READ but never MUTATE. The session.prompt `tools`
// map compiles to opencode PERMISSION RULES (session/prompt.ts): each key → one
// rule, `findLast` match wins, unmatched → the agent default (base `build` =
// `"*": "allow"`). So a DENYLIST fails OPEN — a write tool not in the list
// (`task` sub-agent spawner, MCP tools, any future tool) stays enabled.
//
// The fix is a wildcard-deny-first ALLOWLIST — the exact shape opencode's own
// read-only `explore`/`compaction` agents use: `{ "*": false, <read tools>: true }`.
// `"*": false` denies everything; the read tools re-allow themselves via a LATER
// rule (findLast). Anything unlisted — edit/write/patch, `task`, MCP, unknown —
// matches only `*` → HARD DENY (an explicit deny rule, enforced even in a
// headless child with no interactive approver). ORDER IS LOAD-BEARING: `"*"`
// MUST be the first key, or the deny wins for everything.
export const LENS_READ_TOOLS = READONLY_TOOLS; // single source: the rail guard's read-only set

export function lensToolsMap() {
  const map = { '*': false };            // deny-all first (insertion order preserved)
  for (const t of LENS_READ_TOOLS) map[t] = true; // re-allow only read-only tools
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

/**
 * Normalize a lens reply into { findings, parsed }. A CLEAN empty result
 * (`[]` / `{findings:[]}`) is parsed:true, findings:[]. An unparseable or
 * schema-drifted NON-EMPTY reply is parsed:false — the caller must NOT treat it
 * as "found nothing" (fail-open); a lens that produced garbage is not a lens
 * that cleanly cleared the change.
 */
export function parseFindings(text) {
  const v = parseFenced(text);
  if (Array.isArray(v)) return { findings: v.filter((f) => f && typeof f === 'object'), parsed: true };
  if (v && Array.isArray(v.findings)) return { findings: v.findings.filter((f) => f && typeof f === 'object'), parsed: true };
  // Nothing parseable → parse FAILURE. A well-behaved lens with nothing to say
  // returns an explicit empty array (`[]`), which parses cleanly above. An
  // EMPTY/whitespace or garbage reply is anomalous — fail closed (parsed:false),
  // symmetric with a null/no-reply, so a silent lens can't read as "found nothing".
  return { findings: [], parsed: false };
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
      if (text == null) return { lens, findings: [], parsed: false }; // bound hit / no reply → fail closed
      const p = parseFindings(text);
      return { lens, findings: p.findings, parsed: p.parsed };
    }));
    if (hitBound) break;

    // A lens whose reply couldn't be parsed did NOT clear the change — surface a
    // synthetic blocker so an all-garbage round can never masquerade as dry/SHIP.
    const unparsedLenses = lensReplies.filter((r) => !r.parsed);
    const parseBlockers = unparsedLenses.map((r) => ({
      title: `unparseable lens output: ${r.lens.agent}`,
      severity: 'high', file: '(prosecution)', detail: 'lens reply was not valid findings JSON — treated as an unverified blocker (fail-closed)',
      _unparsed: true,
    }));

    const roundFindings = dedupeFindings([...lensReplies.flatMap((r) => r.findings), ...parseBlockers]);
    const fresh = roundFindings.filter((f) => !seen.has(findingKey(f)));
    for (const f of fresh) seen.add(findingKey(f));

    // Verify each fresh finding (verifierVotes independent votes). An unparseable
    // verdict yields NO valid vote → survivesVerification keeps it (fail-closed).
    for (const f of fresh) {
      // A parse-failure blocker has nothing to refute — keep it as an unverified
      // blocker directly (no verifier session spent, no false convergence).
      if (f._unparsed) { confirmed.push(f); unverified.push(f); continue; }
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
