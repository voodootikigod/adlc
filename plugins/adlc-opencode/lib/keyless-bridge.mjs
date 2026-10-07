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
// offline. makeAsk is wired to the OpenCode v2 `ctx.generate.text` — a stateless,
// tool-less generation that answers the gate Q&A without touching the active
// thread. There is NO structured-output mode, so the answer is the returned
// text (the gate prompts already specify their own output shape).

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

// Bound on the `--prompt-only` run, which executes in-process inside the host;
// the same budget a plain CLI gate run gets. SIGKILL: not ignorable.
const PROMPT_ONLY_TIMEOUT_MS = 120_000;

export async function runGateKeyless({ bin, args = [], ask, spawnImpl = spawnSync, cwd = process.cwd(), maxPrompts = MAX_PROMPTS }) {
  if (typeof ask !== 'function') throw new Error('runGateKeyless: an ask(prompt) function is required');
  const res = spawnImpl(bin, [...args, '--prompt-only'], {
    cwd, encoding: 'utf8', timeout: PROMPT_ONLY_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    const how = typeof res.status === 'number'
      ? `exited ${res.status}`
      : `did not complete (${res.error?.code ?? res.signal ?? 'no exit code'})`;
    const err = new Error(`gate ${bin} --prompt-only ${how}: ${stderr}`);
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
 * Extract the text answer from v2 session messages (`session.context` resolves
 * to `SessionMessageInfo[]`): the concatenated `text` content of the LAST
 * assistant message. Reasoning and tool content are not the answer.
 */
export function answerFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const reply = [...messages].reverse().find((m) => m?.type === 'assistant');
  return (reply?.content ?? [])
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Per-child-prompt timeout — a hung provider must not hang the tool turn. */
export const PROMPT_TIMEOUT_MS = 120_000;

export function withTimeout(promise, ms, onTimeoutMessage) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(onTimeoutMessage)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** v1 `{ providerID, modelID }` and v2 `{ providerID, id }` model refs → v2. */
function toModelRef(model) {
  if (!model || typeof model !== 'object' || !model.providerID) return null;
  const id = model.id ?? model.modelID;
  return id ? { providerID: model.providerID, id, ...(model.variant ? { variant: model.variant } : {}) } : null;
}

/**
 * A child-session ask for work that needs tools (prosecution lenses). Each call
 * creates an ISOLATED v2 session with `permissions`, prompts it, waits for it to
 * go idle, and reads the last assistant reply from `session.context`. Returns
 * null when `session` lacks any of those methods, so the caller fails closed
 * rather than silently skipping work.
 *
 * The plugin `ctx.session` domain has no `remove`, so the child session stays
 * in the session list after the call.
 *
 * Methods are called ON `session` — the client's methods may read `this`.
 *
 * Per call, `agent` creates the child AS that agent and `model` runs it on that
 * model (overriding the factory `model`). OpenCode does NOT apply an agent's
 * configured model to a plugin-created session, so a caller that wants the
 * agent's model must pass it. `onMessages` receives the child's messages before
 * the answer is returned.
 */
export function makeSessionAsk(session, { title, permissions, directory, model, timeoutMs = PROMPT_TIMEOUT_MS, label = 'keyless' } = {}) {
  if (typeof session?.create !== 'function' || typeof session?.prompt !== 'function'
    || typeof session?.wait !== 'function' || typeof session?.context !== 'function') return null;
  const modelRef = toModelRef(model);
  return async (text, { agent, model: callModel, onMessages } = {}) => {
    const ref = toModelRef(callModel) ?? modelRef;
    const created = await withTimeout(
      session.create({
        title,
        permissions: [...permissions],
        ...(agent ? { agent } : {}),
        ...(directory ? { location: { directory } } : {}),
        ...(ref ? { model: ref } : {}),
      }),
      timeoutMs, `${label}: child session.create timed out`);
    const sessionID = created?.id;
    if (!sessionID) throw new Error(`${label}: child session.create returned no session id`);
    const messages = await withTimeout((async () => {
      await session.prompt({ sessionID, text });
      await session.wait({ sessionID });
      return session.context({ sessionID });
    })(), timeoutMs, `${label}: child session reply timed out`);
    onMessages?.(messages);
    return answerFromMessages(messages);
  };
}

/**
 * Build the keyless "ask" function from the v2 generate API (`ctx.generate`):
 * one stateless, tool-less text generation per gate prompt — nothing for the
 * model to act with, and no child session left behind.
 *
 * @param {object} generate  the plugin context's `ctx.generate`
 * @param {object} [opts]
 * @param {{providerID:string, id?:string, modelID?:string}} [opts.model]
 *   model; omit to use the host default
 */
export function makeAsk(generate, { model, timeoutMs = PROMPT_TIMEOUT_MS } = {}) {
  if (typeof generate?.text !== 'function') return null;
  const modelRef = toModelRef(model);
  return async (text) => {
    const res = await withTimeout(
      generate.text({ prompt: text, ...(modelRef ? { model: modelRef } : {}) }),
      timeoutMs, 'keyless: generate.text timed out');
    return typeof res?.text === 'string' ? res.text.trim() : '';
  };
}
