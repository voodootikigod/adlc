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

/** The change under prosecution: `git diff <base>...HEAD`. '' if git/base unavailable. */
export function captureDiff({ base = 'main', cwd = process.cwd(), spawnImpl = execFileSync } = {}) {
  try {
    return String(spawnImpl('git', ['diff', `${base}...HEAD`], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) || '');
  } catch { return ''; }
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
        const ask = makeLensAsk(client, { parentID: ctx?.sessionID });
        if (!ask) {
          return {
            title: 'adlc_prosecute: no session API',
            output: 'The host SDK session API is unavailable, so the deterministic runner cannot spawn lens sessions. Run the /adlc-prosecute command (prose protocol) instead.',
            metadata: { error: 'no-session-api', deterministic: false },
          };
        }
        const diff = (diffImpl ?? captureDiff)({ base, cwd });
        if (!diff.trim()) {
          return {
            title: 'adlc_prosecute: empty diff',
            output: `\`git diff ${base}...HEAD\` produced no changes to prosecute.`,
            metadata: { base, deterministic: true, confirmed: 0 },
          };
        }
        const result = await runProsecution({ ask, agentPrompt: makeAgentPromptReader(pkgRoot), diff });
        const lines = result.confirmed.map((f) =>
          `- [${f.severity ?? '?'}] ${f.title}${f.file ? ` (${f.file})` : ''}${result.unverified.includes(f) ? ' — UNVERIFIED (kept fail-closed)' : ''}`);
        const verdict = result.confirmed.length === 0 ? 'SHIP (no confirmed findings)' : `NO-SHIP (${result.confirmed.length} confirmed)`;
        return {
          title: `adlc_prosecute: ${verdict}`,
          output: [
            `Deterministic P5 loop over ${LENSES.length} lenses + verifier.`,
            `Rounds: ${result.rounds}, child sessions: ${result.sessionsUsed}${result.hitBound ? `, stopped at bound: ${result.hitBound}` : ''}.`,
            result.confirmed.length ? `\nConfirmed findings:\n${lines.join('\n')}` : '\nNo findings survived verification.',
          ].join('\n'),
          metadata: {
            base, deterministic: true, verdict,
            confirmed: result.confirmed.length,
            unverified: result.unverified.length,
            rounds: result.rounds,
            sessionsUsed: result.sessionsUsed,
            hitBound: result.hitBound,
          },
        };
      },
    },
  };
}
