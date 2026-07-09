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

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTickets } from '@adlc/core';
import { prosecute, defaultRunLens, renderSummary } from './prosecutor.mjs';

// TypeBox is a peer supplied by the pi runtime. It is NOT hoisted to the repo
// root — it lives nested under @earendil-works/pi-coding-agent/node_modules, so
// a bare `import('typebox')` from this plugin dir does not resolve (and the pi
// package's exports map is ESM-only, blocking require.resolve on it). We resolve
// TypeBox the way pi does — anchored on the pi package — via a small ladder of
// strategies so it works under jiti (how pi loads extensions) and plain Node.
// Under a raw `node --test` from the repo root TypeBox is genuinely absent; the
// caller (extension.mjs) swallows the resulting throw and the tool stays
// unregistered there, with the live smoke proving real registration.

/** Import a typebox module by path/URL and return its `Type` builder. */
async function importType(pathOrUrl) {
  const url = pathOrUrl.startsWith('file:') ? pathOrUrl : pathToFileURL(pathOrUrl).href;
  const mod = await import(url);
  const T = mod.Type ?? mod.default ?? mod;
  return T && typeof T.Object === 'function' ? T : null;
}

/** Resolve typebox's ESM entry file from an installed typebox package dir. */
function typeboxEntry(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const exp = pkg.exports;
    const dot = exp && typeof exp === 'object' ? exp['.'] ?? exp : undefined;
    const rel =
      (dot && typeof dot === 'object' ? dot.import ?? dot.default : typeof dot === 'string' ? dot : undefined) ??
      pkg.module ?? pkg.main ?? 'index.js';
    return join(pkgDir, rel);
  } catch {
    return null;
  }
}

async function loadTypebox() {
  const require = createRequire(import.meta.url);

  // 1. Direct: works if typebox is hoisted / a direct dependency.
  try {
    const T = await importType(require.resolve('typebox'));
    if (T) return T;
  } catch { /* try next */ }

  // 2. Anchor on the pi package via the ESM resolver, then resolve the nested
  //    typebox from there (the layout pi ships).
  if (typeof import.meta.resolve === 'function') {
    try {
      const piUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
      const piRequire = createRequire(fileURLToPath(piUrl));
      const T = await importType(piRequire.resolve('typebox'));
      if (T) return T;
    } catch { /* try next */ }
  }

  // 3. Filesystem walk up from this module: look for a nested (then hoisted)
  //    typebox install. Jiti-agnostic and deterministic.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    for (const rel of [
      ['node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', 'typebox'],
      ['node_modules', 'typebox'],
    ]) {
      const pkgDir = join(dir, ...rel);
      if (existsSync(join(pkgDir, 'package.json'))) {
        const entry = typeboxEntry(pkgDir);
        if (entry && existsSync(entry)) {
          try {
            const T = await importType(entry);
            if (T) return T;
          } catch { /* keep walking */ }
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error('typebox could not be resolved for adlc_prosecute registration');
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

/** The diff under prosecution: `git diff <base> HEAD`. Empty when base===HEAD. */
async function collectDiff(pi, root, base) {
  const args = base ? ['diff', base, 'HEAD'] : ['diff', 'HEAD'];
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
    const base = typeof params.base === 'string' && params.base.trim()
      ? params.base.trim()
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
