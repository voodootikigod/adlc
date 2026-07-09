// prosecute-tool.mjs — registers the native `adlc_prosecute` agent tool (spec 4.1).
//
// The deterministic loop lives in ./prosecutor.mjs (pure, injected runner). This
// module is the pi-facing wrapper: it builds the tool's execute() and registers
// it with a TypeBox parameter schema.
//
// TypeBox is a peer supplied by the pi runtime and is NOT resolvable under a
// plain `node --test` from the repo root (same nesting as @earendil-works/pi-tui
// — see renderers.mjs). So the specifier is assembled at runtime and imported
// dynamically; extension.mjs never imports typebox at module top level and stays
// loadable under `node --test`. Registration is async (fire-and-forget at load);
// the live smoke (scripts/pi-live-prosecute.mjs) proves real registration +
// callability end-to-end.

import { join } from 'node:path';
import { loadTickets } from '@adlc/core';
import { prosecute, defaultRunLens, renderSummary } from './prosecutor.mjs';
import { resolvePiPeer } from './pi-resolve.mjs';

// TypeBox is a peer supplied by the pi runtime. It is NOT hoisted to the repo
// root — it lives nested under @earendil-works/pi-coding-agent/node_modules, so
// a bare `import('typebox')` from this plugin dir does not resolve. The
// pi-anchored resolution ladder lives in ./pi-resolve.mjs (shared with
// renderers.mjs' pi-tui loader and gate-tool.mjs). Under a raw `node --test`
// from the repo root TypeBox may be genuinely absent; the caller (extension.mjs)
// swallows the resulting throw and the tool stays unregistered there, with the
// live smoke proving real registration.

/**
 * Resolve TypeBox's `Type` builder via the shared pi-peer ladder. Exported so
 * gate-tool.mjs reuses the exact same resolver. Throws if TypeBox cannot be
 * resolved (a non-pi runtime) — callers registering tools swallow that.
 */
export async function loadTypebox() {
  const mod = await resolvePiPeer('typebox');
  const T = mod.Type ?? mod.default ?? mod;
  if (T && typeof T.Object === 'function') return T;
  throw new Error('typebox resolved but exposed no Type builder');
}

/**
 * True when the enforcement context failed to load for the active ticket — the
 * same fail-closed condition the tool_call gate uses. Prosecuting under a broken
 * context would review a diff with no trustworthy rail/scope frame, so the tool
 * denies (throws) exactly as the other gates do.
 */
function enforcementBroken(active) {
  return Boolean(active && active.ticketId && (active.error || !active.ticket));
}

/** merge-base of HEAD and main (spec default base); '' if it cannot resolve. */
async function mergeBaseWithMain(pi, root) {
  try {
    const res = await pi.exec('git', ['merge-base', 'HEAD', 'main'], { cwd: root });
    const ref = (res?.stdout ?? '').trim();
    return ref;
  } catch {
    return '';
  }
}

/**
 * `base` is MODEL-CONTROLLED (a tool param) and flows into `git diff <base>`.
 * A value like `--output=<path>` would make git write/truncate an arbitrary
 * file through the extension's own pi.exec — bypassing every rail gate (P5
 * finding F1). Accept a base only when it (a) is not option-shaped and (b)
 * resolves to a real commit via `git rev-parse --verify`. Anything else is
 * rejected loudly; the caller falls back to the trusted merge-base default.
 */
export async function validateBaseRef(pi, root, base) {
  if (typeof base !== 'string') return null;
  const trimmed = base.trim();
  if (trimmed === '') return null;
  // Option-shaped or containing shell/path/whitespace metacharacters → reject.
  // A git ref never legitimately starts with '-' or contains these.
  if (trimmed.startsWith('-') || /[\s~^:?*[\]\\@{}]|\.\.|\/\//.test(trimmed)) {
    throw new Error(`adlc_prosecute: refusing suspicious base ref "${base}"`);
  }
  try {
    const res = await pi.exec('git', ['rev-parse', '--verify', '--quiet', `${trimmed}^{commit}`], { cwd: root });
    const sha = (res?.stdout ?? '').trim();
    if (res?.code === 0 && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
  } catch { /* fall through to reject */ }
  throw new Error(`adlc_prosecute: base ref "${base}" does not resolve to a commit`);
}

/**
 * The diff under prosecution: `git diff <base> HEAD --`. Empty when no base.
 * `base` here is already validated by validateBaseRef (a bare sha), and the
 * trailing `--` pathspec terminator is defense-in-depth so nothing downstream
 * can be misread as an option.
 */
async function collectDiff(pi, root, base) {
  const args = base ? ['diff', base, 'HEAD', '--'] : ['diff', 'HEAD', '--'];
  try {
    const res = await pi.exec('git', args, { cwd: root });
    return res?.stdout ?? '';
  } catch (err) {
    throw new Error(`could not collect the diff (git ${args.join(' ')}): ${err.message}`);
  }
}

/**
 * Resolve the ticket object for prompt context. Prefer an explicit id (loaded
 * from tickets.json), else the active ticket. Best-effort: a lookup miss falls
 * back to the active ticket (or null) — the loop prosecutes the diff regardless,
 * so a missing ticket weakens context but is not a hard failure.
 */
function resolveTicketContext({ requestedId, active, env, root }) {
  if (!requestedId) return active?.ticket ?? null;
  try {
    const path = env.ADLC_TICKETS ?? join(root, '.adlc', 'tickets.json');
    const { tickets } = loadTickets(path);
    const match = tickets.find((t) => t.id === requestedId);
    if (match) return match;
  } catch { /* fall back to active */ }
  return active?.ticket ?? null;
}

/**
 * Build the tool's execute(). Pure of pi-runtime specifics beyond the injected
 * deps, so a wiring test can call it directly.
 *
 * @param {object} deps
 * @param {object} deps.pi
 * @param {() => object} deps.getActive
 * @param {() => string} deps.getCwd
 * @param {object} [deps.env]
 * @param {(root: string) => Function} [deps.runLensFactory]  default child-pi runner
 * @param {object} [deps.options]  loop bounds override
 * @param {(evt: {type: string, detail: object}) => void} [deps.note]  evidence hook
 */
export function makeProsecuteExecute({ pi, getActive, getCwd, env = process.env, runLensFactory = defaultRunLens, options = {}, note } = {}) {
  return async function execute(_toolCallId, params = {}, signal, _onUpdate, _ctx) {
    const active = getActive?.() ?? null;
    if (enforcementBroken(active)) {
      // Fail closed — deny by throwing (pi surfaces it as a tool error).
      throw new Error(
        `ADLC Locked: enforcement context failed to load for "${active.ticketId}". ` +
          `${active.error ?? ''} Prosecution is denied until the ticket loads cleanly.`
      );
    }
    const root = getCwd?.() ?? process.cwd();
    // A model-supplied base is validated to a real commit sha (or rejected);
    // absent/blank falls back to the trusted merge-base. Never let raw model
    // text reach `git diff` as an argument (F1).
    const base = (typeof params.base === 'string' && params.base.trim())
      ? await validateBaseRef(pi, root, params.base)
      : await mergeBaseWithMain(pi, root);
    const ticket = resolveTicketContext({ requestedId: params.ticket, active, env, root });
    const diff = await collectDiff(pi, root, base);

    if (signal?.aborted) throw new Error('adlc_prosecute aborted before it started');

    const summary = await prosecute({
      diff,
      ticket,
      runLens: runLensFactory(root),
      options,
      recordDir: join(root, '.adlc'),
    });

    try {
      note?.({
        type: 'prosecute-run',
        detail: {
          ticketId: ticket?.id ?? active?.ticketId ?? null,
          base,
          verdict: summary.verdict,
          rounds: summary.rounds,
          findings: summary.findings.length,
          degraded: summary.degradedLenses.length,
        },
      });
    } catch { /* evidence is best-effort — never fail the tool on it */ }

    return {
      isError: false,
      content: [{ type: 'text', text: renderSummary(summary) }],
      details: summary,
    };
  };
}

/**
 * Register `adlc_prosecute` on a pi ExtensionAPI. Async: it dynamically imports
 * TypeBox (runtime-only) to build the parameter schema, then registers the tool.
 * extension.mjs calls this fire-and-forget at load; a failure to load TypeBox
 * (e.g. a non-pi runtime) degrades to "tool not registered" rather than crashing
 * the extension.
 *
 * @returns {Promise<boolean>} true once registered
 */
export async function registerProsecuteTool(pi, deps = {}, { loadTypebox: load = loadTypebox } = {}) {
  if (typeof pi?.registerTool !== 'function') return false;
  const Type = await load();
  const parameters = Type.Object({
    base: Type.Optional(Type.String({ description: 'Git ref to diff against (default: merge-base with main).' })),
    ticket: Type.Optional(Type.String({ description: 'Ticket id to prosecute (default: the active ticket).' })),
  });
  const execute = makeProsecuteExecute(deps);
  pi.registerTool({
    name: 'adlc_prosecute',
    label: 'ADLC Prosecute',
    description:
      'Run the deterministic ADLC P5 prosecution loop over the ticket diff: fan out ' +
      'fresh-context lens children, dedupe, verify survivors, loop until dry, and record ' +
      'confirmed findings. Returns a structured verdict (CLEAN or FINDINGS).',
    promptSnippet: 'adlc_prosecute — run the P5 prosecution loop and return a ship/no-ship verdict.',
    promptGuidelines: [
      'Use adlc_prosecute to prosecute a change before claiming a ticket done (P5). Do not ' +
        'prose-shell the lenses — call adlc_prosecute so the loop runs deterministically.',
    ],
    parameters,
    execute,
  });
  return true;
}
