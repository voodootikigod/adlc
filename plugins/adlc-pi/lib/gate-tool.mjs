// gate-tool.mjs — registers the native `adlc_gate` tool (spec 4.3).
//
// The model calls adlc_gate({ gate, args }) instead of prose-shelling
// `adlc <gate> …`. execute() enforces the ported rails-aware argv policy
// (./gate-policy.mjs) BEFORE running, then dispatches `adlc <gate> [argv…]
// --json` via pi.exec with a timeout and renders the result: exit 0 = pass,
// exit 2 = gate-fail (isError FALSE — a failing gate is a RESULT, not a tool
// error), an exec/timeout failure throws (a real tool error). Every run records
// an 'adlc-gate-run' evidence entry.
//
// TypeBox (a pi-runtime-only peer) builds the parameter schema via the shared
// loader in ./prosecute-tool.mjs; registration is async and swallowed under a
// plain `node --test` exactly like adlc_prosecute.

import { join } from 'node:path';
import { loadTypebox } from './prosecute-tool.mjs';
import { checkGateArgv, GATE_NAMES } from './gate-policy.mjs';

// Default exec timeout for a gate run (ms). Gates are deterministic and fast,
// but hollow-test-style probes can be slow; bound generously and surface a
// timeout as a tool error so the model does not treat a hang as a gate result.
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * True when the enforcement context failed to load for the active ticket — the
 * same fail-closed condition adlc_prosecute and the tool_call gate use. Running
 * a gate under a broken context would vet argv against an untrustworthy rail
 * frame, so the tool denies (throws).
 */
function enforcementBroken(active) {
  return Boolean(active && active.ticketId && (active.error || !active.ticket));
}

/**
 * Tokenize the `args` string into an argv array. Whitespace-split with simple
 * surrounding-quote stripping (single or double) so `--rails "test/**"` yields
 * `['--rails', 'test/**']`. Deterministic and fail-safe: unmatched quotes are
 * left as literal characters, which the policy scans conservatively.
 */
export function tokenizeArgs(args) {
  if (typeof args !== 'string' || args.trim() === '') return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(args)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** Parse stdout as JSON; return null (not throw) when it is not JSON. */
function tryParseJson(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Compact human-readable rendering of a gate result for the tool content. */
function renderGateResult({ gate, code, parsed, stdout, stderr }) {
  const status = code === 0 ? 'PASS' : 'GATE FAILED';
  const head = `ADLC gate ${gate}: ${status} (exit ${code}).`;
  // Prefer a parsed JSON summary; fall back to raw stdout/stderr, bounded.
  if (parsed && typeof parsed === 'object') {
    const violations = Array.isArray(parsed.violations) ? parsed.violations : null;
    if (violations && violations.length) {
      const shown = violations.slice(0, 20).map((v) => `- ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      return `${head}\n${shown.join('\n')}${violations.length > shown.length ? `\n… ${violations.length - shown.length} more` : ''}`;
    }
    return `${head}\n${JSON.stringify(parsed).slice(0, 1000)}`;
  }
  const raw = (stdout || stderr || '').trim();
  return raw ? `${head}\n${raw.slice(0, 1000)}` : head;
}

/**
 * Build the tool's execute(). Pure of pi-runtime specifics beyond the injected
 * deps, so a wiring test can call it directly.
 *
 * @param {object} deps
 * @param {object} deps.pi
 * @param {() => object} deps.getActive
 * @param {() => string} deps.getCwd
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{stdout?:string,stderr?:string,code?:number}>} [deps.exec]
 *   defaults to pi.exec; injectable for tests
 * @param {(evt: {type: string, detail: object}) => void} [deps.note]  evidence hook
 * @param {number} [deps.timeoutMs]
 */
export function makeGateExecute({ pi, getActive, getCwd, exec, note, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const run = exec ?? ((cmd, args, opts) => pi.exec(cmd, args, opts));
  const record = (detail) => {
    try { note?.({ type: 'adlc-gate-run', detail }); } catch { /* evidence is best-effort */ }
  };

  return async function execute(_toolCallId, params = {}, signal, _onUpdate, _ctx) {
    const active = getActive?.() ?? null;
    if (enforcementBroken(active)) {
      throw new Error(
        `ADLC Locked: enforcement context failed to load for "${active.ticketId}". ` +
          `${active.error ?? ''} Gate execution is denied until the ticket loads cleanly.`
      );
    }
    const root = getCwd?.() ?? process.cwd();
    const gate = String(params.gate ?? '').trim();
    const argv = tokenizeArgs(params.args);

    // The rails-aware argv policy applies only while a ticket freezes rails
    // (pi's enforcement switch is the active ticket).
    if (active?.ticket) {
      const verdict = checkGateArgv({ gate, args: argv, ticket: active.ticket, root });
      if (verdict.decision === 'deny') {
        record({ gate, denied: true, reason: verdict.reason });
        return {
          isError: true,
          content: [{ type: 'text', text: `ADLC gate denied: ${verdict.reason}` }],
          details: { gate, denied: true, reason: verdict.reason },
        };
      }
    }

    if (signal?.aborted) throw new Error('adlc_gate aborted before it started');

    let res;
    try {
      res = await run('adlc', [gate, ...argv, '--json'], { cwd: root, timeout: timeoutMs });
    } catch (err) {
      // An exec failure or timeout is a real tool error (throw), NOT a gate
      // result — the model must not read a hang/crash as a passing/failing gate.
      throw new Error(`adlc_gate(${gate}) failed to execute: ${err.message}`);
    }

    const code = typeof res?.code === 'number' ? res.code : 1;
    const parsed = tryParseJson(res?.stdout);
    record({ gate, code });

    return {
      // A failing gate (exit 2) is a RESULT the model should act on, not a tool
      // error — surface it with isError false and the violations visible.
      isError: false,
      content: [{ type: 'text', text: renderGateResult({ gate, code, parsed, stdout: res?.stdout, stderr: res?.stderr }) }],
      details: { gate, code, pass: code === 0, result: parsed, raw: parsed ? undefined : (res?.stdout ?? '') },
    };
  };
}

/**
 * Build a TypeBox string-enum from a value list. Uses the canonical
 * Union-of-Literals idiom when available (anyOf/const), falling back to
 * String({ enum }) for minimal/fake Type builders in tests.
 */
function stringEnum(Type, values) {
  if (typeof Type.Union === 'function' && typeof Type.Literal === 'function') {
    return Type.Union(values.map((v) => Type.Literal(v)));
  }
  return Type.String({ enum: values });
}

/**
 * Register `adlc_gate` on a pi ExtensionAPI. Async: dynamically imports TypeBox
 * (runtime-only) to build the parameter schema, then registers the tool.
 * extension.mjs calls this fire-and-forget-then-awaited at load; a failure to
 * load TypeBox (a non-pi runtime) degrades to "tool not registered".
 *
 * @returns {Promise<boolean>} true once registered
 */
export async function registerGateTool(pi, deps = {}, { loadTypebox: load = loadTypebox } = {}) {
  if (typeof pi?.registerTool !== 'function') return false;
  const Type = await load();
  const parameters = Type.Object({
    gate: stringEnum(Type, GATE_NAMES),
    args: Type.Optional(Type.String({
      description: 'Extra CLI arguments for the gate (space-separated, e.g. "--ticket T1 --tickets .adlc/tickets.json"). --json is added automatically.',
    })),
  });
  const execute = makeGateExecute(deps);
  pi.registerTool({
    name: 'adlc_gate',
    label: 'ADLC Gate',
    description:
      'Run a deterministic ADLC gate (preflight, rails-guard, spec-lint, hollow-test, …) and ' +
      'return its structured verdict. While a ticket freezes rails, only read-only-by-default ' +
      'gates run through this tool; command-executor and write flags are denied — use the adlc ' +
      'CLI for those. Exit 0 is a pass; a failing gate is returned as a result, not an error.',
    promptSnippet: 'adlc_gate — run an ADLC gate and return its verdict (prefer this over shelling `adlc <gate>` inside pi).',
    promptGuidelines: [
      'Inside pi, run ADLC gates via the adlc_gate tool rather than a `bash` call to `adlc <gate>` — ' +
        'the tool enforces the rails-aware argv policy and records gate evidence. The adlc CLI remains ' +
        'the fallback for gates the tool denies (write/derived-target gates and --*cmd invocations).',
    ],
    parameters,
    execute,
  });
  return true;
}
