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
import { PROMPT_TIMEOUT_MS, makeSessionAsk } from './keyless-bridge.mjs';
import { fence } from '@adlc/core';

// The diff and the finding under verification are authored outside this
// repo's trust boundary, so each reaches a child session only inside a fence().
const MAX_DIFF_CHARS = 1_000_000;
const MAX_FINDING_CHARS = 20_000;
const fencedDiff = (diff) => fence('DIFF', String(diff ?? ''), MAX_DIFF_CHARS, { bias: 'head' });

// A lens/verifier session must READ but never MUTATE. OpenCode v2 session
// `permissions` are rules over permission ACTIONS (a tool's action is its name;
// edit/write/patch all request `edit`), evaluated `findLast` over the agent's
// rules then the session's; unmatched → `ask`. So a DENYLIST fails OPEN — a
// write action not in the list (`subagent`, MCP tools, any future tool) keeps
// the agent's allow.
//
// The fix is a wildcard-deny-first ALLOWLIST: `*` deny, then one allow per
// read-only action. Anything unlisted matches only `*` → HARD DENY (enforced
// even in a headless child with no interactive approver). ORDER IS
// LOAD-BEARING: the `*` rule MUST come first, or the deny wins for everything.
export const LENS_READ_TOOLS = READONLY_TOOLS; // single source: the rail guard's read-only set

export function lensPermissions() {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...LENS_READ_TOOLS.map((action) => ({ action, resource: '*', effect: 'allow' })),
  ];
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
 * `provider/model` that answered a child session, read from the LAST assistant
 * message `session.context` returned (v2 `SessionMessageAssistant.model`), or
 * null when it is absent or only half known.
 */
export function replyModel(messages) {
  if (!Array.isArray(messages)) return null;
  const reply = [...messages].reverse().find((m) => m?.type === 'assistant');
  const ref = reply?.model;
  return ref?.providerID && ref?.id ? `${ref.providerID}/${ref.id}` : null;
}

/** An agent's configured model as a v2 ref, or null when unset or half known. */
function agentModelRef(model) {
  if (!model?.providerID || !model?.id) return null;
  return { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) };
}

/** Bound on the one agent-listing call per run; a local server answers in milliseconds. */
export const AGENT_LIST_TIMEOUT_MS = 5_000;

/**
 * The agents registered in this OpenCode instance (`ctx.agent.list`, v2
 * `AgentListOutput.data[]`), as a Map from agent id (a file agent's id is its
 * file name) to its configured model ref (`{ providerID, id, variant? }`, or
 * null when the agent sets none). Null when the host cannot list them (no API,
 * error, bad payload, or no answer within `timeoutMs`). Never throws: an
 * unlistable host keeps the pre-per-lens behavior (every lens on the session
 * model).
 */
export async function listRegisteredAgents(agentApi, { directory, timeoutMs = AGENT_LIST_TIMEOUT_MS } = {}) {
  if (typeof agentApi?.list !== 'function') {
    return null;
  }
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const res = await Promise.race([agentApi.list(directory ? { location: { directory } } : undefined), timeout]);
    const list = res?.data ?? res;
    if (!Array.isArray(list)) return null;
    return new Map(list.filter((a) => typeof a?.id === 'string').map((a) => [a.id, agentModelRef(a.model)]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the real lens/verifier `ask` from the v2 session API (`ctx.session`):
 * each call runs an isolated READ-ONLY child session (lensPermissions) and
 * returns the reply text. Returns null when the session API is missing (caller
 * falls back to the prose protocol).
 *
 * A call whose `agent` is registered (`agentApi` = `ctx.agent`) creates the
 * child AS that agent and, when the agent configures a `model` (frontmatter or
 * `opencode.json` `agents.<id>.model`), passes that model explicitly: OpenCode
 * v2 does not apply an agent's model to a plugin-created session (verified
 * against the 2.0.23 binary — the child answered on the session model). The session's
 * permission rules are evaluated after the agent's, so the wildcard deny still
 * holds. v2 `session.prompt` has no system override, so the authoritative
 * packaged charter always leads the prompt text — a repo-controlled agent file
 * or version drift cannot replace the reviewer instructions. The registered
 * set is read once per ask. An unregistered agent is never named; its call runs
 * on the session model with the charter.
 * `onResolved` is told which model answered each call, whether the agent's
 * config was used, and whether the agent listing succeeded at all
 * (`agentsListed: false` → every lens fell back because the host could not list
 * agents, not because a lens agent is missing).
 */
export function makeLensAsk(session, {
  agentApi, directory, model, timeoutMs = PROMPT_TIMEOUT_MS, agentListTimeoutMs = AGENT_LIST_TIMEOUT_MS, onResolved,
} = {}) {
  const ask = makeSessionAsk(session, {
    title: 'adlc-prosecute', permissions: lensPermissions(), directory, model, timeoutMs, label: 'prosecute',
  });
  if (!ask) return null;
  let registered;

  return async ({ agent, system, prompt }) => {
    registered ??= listRegisteredAgents(agentApi, { directory, timeoutMs: agentListTimeoutMs });
    const agents = await registered;
    const asAgent = Boolean(agent) && (agents?.has(agent) ?? false);
    const agentModel = asAgent ? agents.get(agent) : null;
    let answered = null;
    const text = await ask(system ? `${system}\n\n---\n\n${prompt}` : prompt, {
      ...(asAgent ? { agent } : {}),
      ...(agentModel ? { model: agentModel } : {}),
      onMessages: (messages) => { answered = replyModel(messages); },
    });
    onResolved?.({ agent, model: answered, agentModel: asAgent, agentsListed: agents !== null });
    return text;
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
      const text = await askOne(lens.agent, `Prosecute this change through the ${lens.focus} lens. Return findings as a fenced \`\`\`json array of {title, severity, file, detail}.\n\n${fencedDiff(diff)}`);
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
        const text = await askOne(VERIFIER.agent, `Try to REFUTE this finding — reproduce it or prove it false. Return a fenced \`\`\`json {"real": boolean, "reason": string}.\n\nFinding: ${fence('FINDING', JSON.stringify(f), MAX_FINDING_CHARS, { bias: 'head' })}\n\n${fencedDiff(diff)}`);
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
