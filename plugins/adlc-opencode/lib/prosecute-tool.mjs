// prosecute-tool.mjs — T33: the native `adlc_prosecute` tool. The model calls
// adlc_prosecute({ base? }) and execute() drives the deterministic P5 loop in
// FIRST-PARTY code (runProsecution) — fan-out → dedupe → verify → loop-until-dry
// across write-disabled child sessions — instead of the model orchestrating it.
// Returns a structured result the model reports for the P6 human gate.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LENSES, VERIFIER } from './prosecutor.mjs';
import { runProsecution, makeLensAsk } from './prosecute-runner.mjs';

/** Read an agent's system prompt from the packaged agent/<name>.md, '' if absent. */
export function makeAgentPromptReader(pkgRoot) {
  return (agent) => {
    const path = join(pkgRoot, 'agent', `${agent}.md`);
    if (!existsSync(path)) return '';
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
}

/**
 * Collect which model answered each lens/verifier call (fed by makeLensAsk's
 * `onResolved`). `summary()` returns the per-agent models; the agents that ran
 * on the session model because they are not registered (`unregisteredAgents`);
 * `agentListUnavailable` when the host could not list agents, so every lens ran
 * on the session model for that reason instead; and `singleModel` when every
 * reviewer provably answered on one model — a fresh-context but NOT
 * cross-model review. A reviewer whose model is unknown never counts as proof.
 */
export function makeModelLedger() {
  const byAgent = new Map();
  let agentListUnavailable = false;
  return {
    record({ agent, model, agentModel, agentsListed = true }) {
      const key = agent ?? '(unnamed)';
      const entry = byAgent.get(key) ?? { models: new Set(), unregistered: false };
      entry.models.add(model ?? 'unknown');
      if (!agentsListed) {
        agentListUnavailable = true;
      } else if (!agentModel) {
        entry.unregistered = true;
      }
      byAgent.set(key, entry);
    },
    summary() {
      const models = Object.fromEntries([...byAgent].map(([agent, e]) => [agent, [...e.models].sort()]));
      const unregisteredAgents = [...byAgent].filter(([, e]) => e.unregistered).map(([agent]) => agent).sort();
      const answered = Object.values(models).flat();
      const singleModel = byAgent.size > 1 && !answered.includes('unknown') && new Set(answered).size === 1;
      return { models, unregisteredAgents, agentListUnavailable, singleModel };
    },
  };
}

function modelLines({ models, unregisteredAgents, agentListUnavailable, singleModel }) {
  const agents = Object.keys(models);
  if (!agents.length) {
    return [];
  }
  const lines = ['\nReviewer models:'];
  if (agentListUnavailable) {
    lines.push('Could not list OpenCode agents, so every reviewer ran on the session model (per-lens models not applied).');
  }
  for (const agent of agents) {
    const note = unregisteredAgents.includes(agent) ? ' (session model: agent not registered)' : '';
    lines.push(`- ${agent}: ${models[agent].join(', ')}${note}`);
  }
  if (singleModel) {
    lines.push('Every reviewer answered on the same model: fresh-context, single-model review (not cross-model).');
  }
  return lines;
}

/**
 * The change under prosecution: `git diff <base>...HEAD`.
 * Returns { diff, error }. A git FAILURE (bad base ref, non-git cwd, buffer
 * overflow) sets error — the caller must NOT treat that as an empty diff (which
 * would falsely SHIP); a genuine clean tree returns { diff: '', error: null }.
 */
export function captureDiff({ base = 'main', cwd = process.cwd(), spawnImpl = execFileSync } = {}) {
  try {
    return { diff: String(spawnImpl('git', ['diff', `${base}...HEAD`], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) || ''), error: null };
  } catch (err) {
    return { diff: '', error: String(err?.message ?? err) };
  }
}

/**
 * Build the `adlc_prosecute` tool definition map for the plugin `tool` hook.
 * `schema` is the host zod (injected for testability). `client` is the SDK
 * client — required for the child-session fan-out; without a usable session API
 * the tool returns a structured "use the /adlc-prosecute prose protocol"
 * message rather than silently doing nothing. `pkgRoot` locates the agent
 * prompts. Returns `{ adlc_prosecute: ToolDefinition }`.
 */
export function buildProsecuteTool(schema, { root = process.cwd(), pkgRoot, client, diffImpl } = {}) {
  return {
    adlc_prosecute: {
      description:
        'Run the ADLC P5 prosecution loop (fan-out → dedupe → verify → ' +
        'loop-until-dry) deterministically in first-party code over ' +
        `${LENSES.length} lenses + the ${VERIFIER.agent}. Lens/verifier work runs ` +
        'in isolated, WRITE-DISABLED child sessions — they read the diff and ' +
        'return findings, they cannot edit. Prefer this over orchestrating the ' +
        'prosecution by hand. Returns the confirmed findings for the human gate.',
      args: {
        base: schema.string().optional().describe('Base ref to diff against (default "main").'),
      },
      execute: async (a, ctx) => {
        const base = String(a?.base ?? 'main');
        const cwd = ctx?.directory ?? ctx?.worktree ?? root;
        const ledger = makeModelLedger();
        const ask = makeLensAsk(client, { parentID: ctx?.sessionID, onResolved: ledger.record });
        if (!ask) {
          return {
            title: 'adlc_prosecute: no session API',
            output: 'The host SDK session API is unavailable, so the deterministic runner cannot spawn lens sessions. Run the /adlc-prosecute command (prose protocol) instead.',
            metadata: { error: 'no-session-api', deterministic: false },
          };
        }
        const captured = (diffImpl ?? captureDiff)({ base, cwd });
        // Normalize: diffImpl (tests) may return a bare string; captureDiff returns {diff,error}.
        const { diff, error } = typeof captured === 'string' ? { diff: captured, error: null } : captured;
        if (error) {
          // A git FAILURE is NOT "nothing to prosecute" — fail closed.
          return {
            title: 'adlc_prosecute: NO-SHIP (diff capture failed)',
            output: `Could not capture \`git diff ${base}...HEAD\`: ${error}. Not treating this as an empty change — resolve the base ref / repo state and re-run.`,
            metadata: { base, deterministic: true, verdict: 'NO-SHIP (diff-capture-failed)', error: 'diff-capture-failed', confirmed: 0 },
          };
        }
        if (!diff.trim()) {
          return {
            title: 'adlc_prosecute: empty diff',
            output: `\`git diff ${base}...HEAD\` produced no changes to prosecute.`,
            metadata: { base, deterministic: true, confirmed: 0, empty: true },
          };
        }
        const result = await runProsecution({ ask, agentPrompt: makeAgentPromptReader(pkgRoot), diff });
        const lines = result.confirmed.map((f) =>
          `- [${f.severity ?? '?'}] ${f.title}${f.file ? ` (${f.file})` : ''}${result.unverified.includes(f) ? ' — UNVERIFIED (kept fail-closed)' : ''}`);
        // A bounded/incomplete run is NOT a clean pass: only a converged run with
        // zero confirmed findings SHIPs. hitBound → NO-SHIP (INCOMPLETE).
        const verdict = result.hitBound
          ? `NO-SHIP (INCOMPLETE — stopped at ${result.hitBound}${result.confirmed.length ? `, ${result.confirmed.length} confirmed` : ''})`
          : result.confirmed.length === 0
            ? 'SHIP (no confirmed findings)'
            : `NO-SHIP (${result.confirmed.length} confirmed)`;
        const reviewers = ledger.summary();
        return {
          title: `adlc_prosecute: ${verdict}`,
          output: [
            `Deterministic P5 loop over ${LENSES.length} lenses + verifier.`,
            `Rounds: ${result.rounds}, child sessions: ${result.sessionsUsed}${result.hitBound ? `, stopped at bound: ${result.hitBound} (INCOMPLETE — not a converged pass)` : ''}.`,
            result.confirmed.length ? `\nConfirmed findings:\n${lines.join('\n')}` : (result.hitBound ? '\nNo confirmed findings yet, but the run did NOT converge.' : '\nNo findings survived verification.'),
            ...modelLines(reviewers),
          ].join('\n'),
          metadata: {
            base, deterministic: true, verdict,
            confirmed: result.confirmed.length,
            unverified: result.unverified.length,
            rounds: result.rounds,
            sessionsUsed: result.sessionsUsed,
            hitBound: result.hitBound,
            models: reviewers.models,
            unregisteredAgents: reviewers.unregisteredAgents,
            agentListUnavailable: reviewers.agentListUnavailable,
            singleModel: reviewers.singleModel,
          },
        };
      },
    },
  };
}
