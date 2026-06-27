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
// offline, and lets the integration degrade gracefully when the host SDK lacks the
// proposed isolated-prompt extension (plan §6.4).

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
export async function runGateKeyless({ bin, args = [], ask, spawnImpl = spawnSync, cwd = process.cwd() }) {
  if (typeof ask !== 'function') throw new Error('runGateKeyless: an ask(prompt) function is required');
  const res = spawnImpl(bin, [...args, '--prompt-only'], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`gate ${bin} --prompt-only exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  const prompts = extractPrompts(res.stdout);
  const answers = [];
  for (const p of prompts) {
    // Await each answer: the host SDK prompt API is async, and later prompts in a
    // cascade must receive RESOLVED prior answers, not pending Promises.
    answers.push(await ask(p.text, { index: p.index, total: prompts.length, prior: answers.slice() }));
  }
  return { prompts, answers };
}

/**
 * Resolve the keyless "ask" function from host capability (plan §6.4).
 *  - If the SDK exposes an isolated-prompt extension, use it (best: fresh,
 *    side-effect-free sub-context, optionally a different model).
 *  - Else, if degraded mode is allowed, fall back to the active session model.
 *  - Else return null — keyless dispatch is unavailable; the caller must fail
 *    closed rather than silently skip a gate.
 */
export function makeAsk(api, { allowDegraded = false, model } = {}) {
  const isolated = api?.client?.prompt;
  if (typeof isolated === 'function') {
    return (text, ctx) => isolated({ prompt: text, isolated: true, model, context: ctx });
  }
  const active = api?.client?.session?.prompt ?? api?.prompt;
  if (allowDegraded && typeof active === 'function') {
    return (text, ctx) => active({ prompt: text, context: ctx });
  }
  return null;
}
