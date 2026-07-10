// keyless-bridge.mjs — run LLM-backed ADLC gates without an API key.
//
// Inside OpenCode *the host model is the provider*. Every LLM-backed gate supports
// `--prompt-only`: it prints the exact prompt(s) and exits 0 without calling a
// provider. This bridge runs a gate in prompt-only mode, extracts the prompt(s),
// routes each to an isolated model sub-context, and returns the answers — the
// "two-phase stdio cascade" of integration-plan §4.3.
//
// The model call itself is the only SDK-dependent piece, so it is INJECTED (`ask`)
// and capability-gated (`makeAsk`). That keeps the protocol pure and unit-testable
// offline. makeAsk is now wired to the REAL, source-verified SDK
// (client.session.create + client.session.prompt, v1.17.13) — an isolated child
// session runs the gate Q&A without polluting the active thread. There is NO
// server-side structured-output mode, so the answer is the concatenated text of
// the reply's text parts (the gate prompts already specify their own output shape).

import { spawnSync } from 'node:child_process';

const PROMPT_SPLIT = /^---\s*prompt\s+\d+\s+of\s+\d+\s*---\s*$/im;
const PROMPT_SPLIT_G = /^---\s*prompt\s+\d+\s+of\s+\d+\s*---\s*$/gim;

/**
 * Split a gate's --prompt-only stdout into ordered prompt segments. Gates that
 * fan out (e.g. parallax) emit "--- prompt N of M ---" separators; single-prompt
 * gates emit one block. Returns [{ index, text }].
 */
export function extractPrompts(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) return [];
  if (!PROMPT_SPLIT.test(text)) return [{ index: 1, text }];
  return text
    .split(PROMPT_SPLIT_G)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((t, i) => ({ index: i + 1, text: t }));
}

/**
 * Run an ADLC gate keylessly. `ask(promptText, ctx)` resolves the prompt against
 * the host model (injected; see makeAsk). `spawnImpl` is injectable for tests.
 * Multi-prompt cascades are asked in order with prior answers threaded as context.
 * Returns { prompts, answers } or throws on a gate operational failure.
 */
/** Hard cap on prompt fan-out — a gate emitting more than this is treated as
 *  malformed rather than spawning an unbounded number of child sessions. */
export const MAX_PROMPTS = 12;

export async function runGateKeyless({ bin, args = [], ask, spawnImpl = spawnSync, cwd = process.cwd(), maxPrompts = MAX_PROMPTS }) {
  if (typeof ask !== 'function') throw new Error('runGateKeyless: an ask(prompt) function is required');
  const res = spawnImpl(bin, [...args, '--prompt-only'], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    const err = new Error(`gate ${bin} --prompt-only exited ${res.status}: ${stderr}`);
    // Distinguish "this gate does not IMPLEMENT --prompt-only" (caller may fall
    // back to the plain CLI) from a genuine failure of a prompt-only-supporting
    // gate (must surface, not be silently downgraded to a CLI run).
    if (/ERR_PARSE_ARGS_UNKNOWN_OPTION|unknown option.{0,4}--prompt-only/i.test(stderr)) {
      err.code = 'PROMPT_ONLY_UNSUPPORTED';
    }
    throw err;
  }
  const prompts = extractPrompts(res.stdout);
  if (prompts.length > maxPrompts) {
    throw new Error(`gate ${bin} emitted ${prompts.length} prompts (> ${maxPrompts}) — refusing to spawn that many child sessions`);
  }
  const answers = [];
  for (const p of prompts) {
    // Await each answer: the host SDK prompt API is async, and later prompts in a
    // cascade must receive RESOLVED prior answers, not pending Promises.
    answers.push(await ask(p.text, { index: p.index, total: prompts.length, prior: answers.slice() }));
  }
  return { prompts, answers };
}

/**
 * Extract the text answer from a session.prompt response. The SDK returns
 * `{ data: { info, parts } }`; the reply text is the concatenation of the
 * TextPart parts (there is no structured-output field on the response).
 */
export function answerFromPrompt(res) {
  const parts = res?.data?.parts ?? res?.parts ?? [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/**
 * Build the keyless "ask" function from the host SDK client (source-verified
 * v1.17.13). Each ask spins up an ISOLATED child session (parentID = the active
 * session) so the gate Q&A is side-effect-free, prompts it with the gate text
 * (tools disabled — pure Q&A), returns the reply text, and best-effort deletes
 * the child. Returns null when the client lacks the session API, so the caller
 * fails closed rather than silently skipping a gate.
 *
 * @param {object} client  the plugin's input.client (OpencodeClient)
 * @param {object} [opts]
 * @param {string} [opts.parentID]  active session id → child's parent
 * @param {{providerID:string, modelID:string}} [opts.model]  child model; omit
 *   to inherit the session default
 */
/** Per-child-prompt timeout — a hung provider must not hang the tool turn. */
export const PROMPT_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, onTimeoutMessage) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function makeAsk(client, { parentID, model, timeoutMs = PROMPT_TIMEOUT_MS } = {}) {
  const session = client?.session;
  // NOTE: call the methods ON `session` (session.create(...)), never via a
  // destructured reference — the SDK methods are `this`-bound (they read
  // `this._client`), so a detached `const create = session.create` call throws.
  if (typeof session?.create !== 'function' || typeof session?.prompt !== 'function') return null;

  return async (text) => {
    const created = await withTimeout(
      session.create({ body: { ...(parentID ? { parentID } : {}), title: 'adlc-gate' } }),
      timeoutMs, 'keyless: child session.create timed out');
    const childId = created?.data?.id ?? created?.id;
    try {
      const res = await withTimeout(
        session.prompt({
          path: { id: childId },
          body: {
            ...(model ? { model } : {}),
            // A pure Q/A turn needs NO tools. `tools: {}` is NOT "no tools" —
            // opencode treats an empty map as "no overrides" → all tools inherit
            // the base agent default (`"*": "allow"`) = ALL ENABLED. Deny
            // everything with the wildcard rule so the gate child can't act.
            tools: { '*': false },
            parts: [{ type: 'text', text }],
          },
        }),
        timeoutMs, 'keyless: child session.prompt timed out');
      return answerFromPrompt(res);
    } finally {
      // Runs on success, error, AND timeout — so a stalled prompt still deletes
      // the child rather than leaking it.
      try { if (childId && typeof session.delete === 'function') await session.delete({ path: { id: childId } }); }
      catch { /* best-effort cleanup — never fail the gate on teardown */ }
    }
  };
}
