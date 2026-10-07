// index.mjs — the ADLC OpenCode plugin entrypoint (OpenCode v2 plugin API).
//
// Wires OpenCode's `ctx.tool.hook('execute.before')` to the rail-enforcement
// decision in rails-checker.mjs (which delegates to @adlc/core). It does NOT
// reimplement any gate. The deny path imports only Node builtins + @adlc/core
// (first-party, zero third-party dependency).
//
// Enforcement contract: a thrown error in `execute.before` ABORTS the tool call,
// so the hook ENFORCES BY DEFAULT. The mutable tool input is `event.input`. The
// only downgrade is the explicit operator escape hatch ADLC_ALLOW_ADVISORY_HOOKS=1
// (or the `advisoryHooks` plugin option): surface, don't block. The live deny
// proof (scripts/opencode-live-deny.mjs) regression-tests the contract against a
// real opencode binary.
//
// The host requires a default export `{ id, setup(ctx) }`. `Plugin.define` from
// @opencode/plugin is the identity function, so the object literal is exported
// directly and the module imports nothing from the host at load.

import { checkToolCall, resolveRailsInForce, resolveActiveTicketId, railHit, extractTargets, READONLY_TOOLS, UNGATED_TOOLS, SHELL_TOOLS } from './rails-checker.mjs';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from './lib/session-hooks.mjs';
import { createDepthTracker, checkBuildGate } from './lib/build-gate.mjs';
import { checkHandoff, createStickyDenyState, createInitLatch } from './lib/handoff-gate.mjs';
import { handleFileEdited, createWatcherState } from './lib/watcher.mjs';
import { buildSystemContext, buildToolRailNotice, buildStatusLine } from './lib/context-inject.mjs';
import { createFlailTracker, flailMessage } from './lib/flail.mjs';
import { buildGateTool } from './lib/gate-tool.mjs';
import { buildProsecuteTool } from './lib/prosecute-tool.mjs';
import { buildCompactionContext } from './lib/compaction.mjs';
import { checkCommandOrder, checkCommandTamper } from './lib/command-gate.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The plugin package root (…/plugins/adlc-opencode), used to byte-compare a
// deployed command against its packaged source for the tamper advisory, and to
// locate the packaged agent prompts.
const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

/** Built-in tools whose descriptions carry the frozen-rail notice. */
export const RAIL_NOTICE_TOOLS = ['edit', 'write', 'patch', 'apply_patch'];

const RESUBSCRIBE_INITIAL_MS = 100;
const RESUBSCRIBE_MAX_MS = 5000;

/**
 * Surface a message to the operator on stderr. The v2 plugin context has no
 * toast or log API, so stderr (captured in the opencode log — see
 * `opencode debug paths`) is the only operator channel. Never throws.
 */
function makeNotify() {
  return (message, variant = 'error') => {
    try { console.error(`[adlc] ${variant}: ${message}`); } catch { /* stderr closed */ }
  };
}

/**
 * Map the plugin options (opencode.json: `"plugins": [{ "package":
 * "@adlc/opencode", "options": {...} }]`, delivered as `ctx.options`) onto the
 * env knobs the hooks already read. Env vars WIN over options: an explicitly set
 * variable is a per-invocation operator decision, the options are the per-repo
 * default. Deliberately NOT mapped: the audited bypasses (ADLC_RAILS_BYPASS,
 * ADLC_BUILD_GATE_BYPASS) — those must stay per-invocation, never repo config.
 */
export function optionsToEnv(options = {}) {
  const env = {};
  if (options.advisoryHooks === true) env.ADLC_ALLOW_ADVISORY_HOOKS = '1';
  if (Array.isArray(options.ungatedTools) && options.ungatedTools.length) {
    env.ADLC_UNGATED_TOOLS = options.ungatedTools.map(String).join(',');
  } else if (typeof options.ungatedTools === 'string' && options.ungatedTools) {
    env.ADLC_UNGATED_TOOLS = options.ungatedTools;
  }
  if (options.suppressionEnforcement === true) env.ADLC_SUPPRESSION_ENFORCEMENT = '1';
  if (options.scopeEnforcement === true) env.ADLC_SCOPE_ENFORCEMENT = '1';
  return env;
}

/** The repo root: the first non-empty of the documented location candidates. */
function resolveRoot(location) {
  for (const candidate of [location?.worktree, location?.directory, location?.project?.worktree]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return process.cwd();
}

const sleep = (ms, signal) => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

/**
 * Consume the server-wide event stream until `signal` aborts. A stream that
 * ends or throws is resubscribed with bounded backoff (100 ms doubling, capped
 * at 5 s); the backoff resets once a stream delivers an event.
 */
async function runEventLoop(event, signal, onEvent) {
  let backoff = RESUBSCRIBE_INITIAL_MS;
  while (!signal.aborted) {
    try {
      for await (const ev of event.subscribe({ signal })) {
        if (signal.aborted) return;
        backoff = RESUBSCRIBE_INITIAL_MS;
        try { await onEvent(ev); } catch { /* one bad event never ends the loop */ }
      }
    } catch { /* stream failed — resubscribe below */ }
    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, RESUBSCRIBE_MAX_MS);
  }
}

/** `/adlc-<name> …` → `adlc-<name>`; anything else → null. */
function adlcCommandOf(prompt) {
  const text = typeof prompt?.text === 'string' ? prompt.text.trimStart() : '';
  const m = text.match(/^\/(adlc-[a-z0-9-]+)(?:\s|$)/i);
  return m ? m[1] : null;
}

async function setup(ctx = {}) {
  // The repo root used to locate .adlc/ and to canonicalize edited paths.
  const root = resolveRoot(ctx.location);
  // Per-repo plugin options as the base, real env vars override (see optionsToEnv).
  const optEnv = optionsToEnv(ctx.options ?? {});
  const env = { ...optEnv, ...process.env };
  // Kill switch: the context-rot handoff deny-set (slice 5) is not yet
  // stable enough for real sessions — it was blocking edits/shell wholesale
  // across workstreams, so it defaults OFF. checkHandoff() and its test
  // suite stay intact and exercise it via this env var; deliberately NOT
  // mapped through optionsToEnv (unlike advisoryHooks/ungatedTools above) —
  // this is not a repo-config knob a reviewed repo's opencode.json should be
  // able to flip. Flip the default once the deny-set has baked longer.
  const CONTEXT_ROT_HANDOFF_ENABLED = env.ADLC_CONTEXT_ROT_HANDOFF_ENABLED === '1';
  const advisoryOnly = env.ADLC_ALLOW_ADVISORY_HOOKS === '1';
  // Attribute the downgrade to its ACTUAL source: an operator grepping their
  // environment for a cited env var they never set is a dead end.
  const advisorySource = process.env.ADLC_ALLOW_ADVISORY_HOOKS === '1'
    ? 'ADLC_ALLOW_ADVISORY_HOOKS=1'
    : 'plugin option advisoryHooks:true in opencode.json';
  const notify = makeNotify();
  // Repo config weakening enforcement must be visible ONCE at load, not only
  // per-event (advisoryHooks warns per deny; ungatedTools would otherwise be
  // silent).
  const optionWeakenings = [
    ...(optEnv.ADLC_ALLOW_ADVISORY_HOOKS && process.env.ADLC_ALLOW_ADVISORY_HOOKS === undefined
      ? ['advisoryHooks:true (rails guard downgraded to advisory)'] : []),
    ...(optEnv.ADLC_UNGATED_TOOLS && process.env.ADLC_UNGATED_TOOLS === undefined
      ? [`ungatedTools:[${optEnv.ADLC_UNGATED_TOOLS}] (exempted from gating; still spoof-guarded)`] : []),
  ];
  if (optionWeakenings.length) {
    notify(`ADLC: opencode.json plugin options weaken enforcement — ${optionWeakenings.join('; ')}. The CI rail-freeze gate remains authoritative.`, 'warning');
  }
  // Phase 2.3: per-session context-fitness state for the build-gate backstop.
  const tracker = createDepthTracker();
  // Phase 2.4/2.5: restore-loop-guard state for the filesystem watcher.
  const watcherState = createWatcherState();
  // Phase 3.3: per-session churn tracker for the flail advisory.
  const flail = createFlailTracker();
  // Slice 5: per-session D1 memory so a FAILED deny-marker write stays sticky
  // after the band cools, instead of denying exactly one tool call.
  const handoffSticky = createStickyDenyState();
  // Containment latch: once this root is seen initialized it stays armed for
  // the life of the plugin. The ticket store is an unprotected file (verified:
  // it is not a protected handoff path and `rm .adlc/tickets.json` is not a
  // mutating-shell match), so without this an agent could delete the store
  // below the band and never be denied.
  const handoffInit = createInitLatch();

  // The ticket a deny marker is bound to. Resolved from the canonical
  // active-ticket pointer rather than from resolveRailsInForce: that ladder is
  // gated on ADLC_P4_ENFORCEMENT, while the deny-set is evaluated whether or
  // not rails are in force — binding to it would leave the marker unbound
  // (ticket_id:null, which `adlc handoff repair`/`resume` refuses) in exactly
  // the sessions that need recovery most. Same source the sibling enforcing
  // adapters use: codex `activeTicketIdOrNull`, claude-code
  // `resolveActiveTicketIdForBuildGate`.
  //
  // Passed to checkHandoff as a thunk so only gated calls inside an ADLC repo
  // pay for the read.
  //
  // No separate `conflict` branch: resolveActiveTicketId already returns a null
  // id alongside `conflict: true`, so a tamper signal reaches the marker as an
  // unbound ticket without one. Re-checking it here would be logic no test
  // could ever observe.
  const activeTicketIdOrNull = () => {
    try {
      return resolveActiveTicketId(root, env).id ?? null;
    } catch {
      return null; // an unbound marker beats a gate that throws
    }
  };

  const deny = (message) => {
    if (advisoryOnly) {
      // Explicit operator downgrade: surface loudly without claiming to block.
      notify(`${message} [ADVISORY — ${advisorySource}; the CI rail-freeze gate remains authoritative]`, 'warning');
      return;
    }
    // Enforcing (default): throw to abort the tool; the error text reaches the model.
    notify(message, 'error');
    throw new Error(message);
  };

  // The context-handoff deny does NOT honour advisoryHooks. That escape hatch
  // downgrades the RAIL guard, whose authoritative backstop is the CI
  // rail-freeze gate. The deny-set has no CI backstop — it is a live
  // session-trust decision, and the spec's only exits from it are a signed
  // resume-auth, a signed bypass, or privileged host repair. An env var must
  // not be a fourth one.
  const denyHandoff = (message) => {
    notify(message, 'error');
    throw new Error(message);
  };

  // The EFFECTIVE ungated set includes operator additions (env or plugin
  // option) — the build-gate backstop must honor the same set as the rails
  // guard, or a configured ungated tool gets denied exactly in the degraded
  // high-risk case the option exists for (T30 review round-1 finding).
  const extraUngated = String(env.ADLC_UNGATED_TOOLS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isStructuredMutator = (name) =>
    !READONLY_TOOLS.includes(name) && !UNGATED_TOOLS.includes(name) &&
    !SHELL_TOOLS.includes(name) && !extraUngated.includes(name);

  const sameLocation = (ev) => {
    const dir = ev?.location?.directory;
    return typeof dir !== 'string' || !dir || resolve(dir) === resolve(root);
  };

  const onEvent = async (ev) => {
    if (!sameLocation(ev)) return; // the stream is server-wide
    const type = ev?.type;
    const sessionID = ev?.data?.sessionID;

    // Phase 2.3: a compacted session IS the context-rot event — mark it degraded.
    if (type === 'session.compaction.ended') {
      tracker.markCompacted(sessionID);
      return;
    }

    // Phase 2.4/2.5: filesystem changes drive the post-hoc watcher (suppression,
    // scope, and the tool-name-independent rail backstop). Events cannot block,
    // so these are all post-hoc.
    if (type === 'filesystem.changed') {
      if (ev?.data?.event === 'unlink') return;
      const { actions } = handleFileEdited({ file: ev?.data?.file, root, env, state: watcherState });
      for (const a of actions) notify(a.message, a.action === 'restored' ? 'error' : 'warning');
      return;
    }

    // session.created (Phase C): the active-ticket statusline (Phase 3.4) and
    // the advisory environment preflight.
    if (type === 'session.created') {
      try {
        const line = buildStatusLine(root, env);
        if (line) notify(line, 'info');
      } catch { /* advisory: swallow */ }
      try {
        const { skipped, warnings } = checkPreflight(root, { env });
        if (!skipped) for (const w of warnings) notify(`ADLC preflight: ${w}`, 'warning');
      } catch { /* advisory: swallow */ }
      return;
    }

    // session.idle (Phase C): advisory gate-evidence audits — OpenCode has no
    // "session.ended"; idle is the end-of-work signal.
    if (type === 'session.idle') {
      try {
        const { warning } = auditGateManifest(root);
        if (warning) notify(`ADLC gate-manifest audit: ${warning}`, 'warning');
      } catch { /* advisory: swallow */ }
      // Mechanical adversarial-review trigger (issue #59): deterministic,
      // no-LLM check that a risk-gated change has a recorded review.
      try {
        const { warning } = auditAdversarialReview(root, { env });
        if (warning) notify(`ADLC adversarial-review audit: ${warning}`, 'warning');
      } catch { /* advisory: swallow */ }
      // Phase 3.3: release this session's churn state now that it's idle. The
      // hard memory bound is the tracker's LRU session cap; this is an
      // optimization.
      try { if (sessionID) flail.evict(sessionID); } catch { /* advisory: swallow */ }
    }
  };

  // Advisory registrations must not cost plugin load (and with it the
  // enforcement already registered): a failure is reported, not thrown.
  const advisory = async (name, register) => {
    try { await register(); } catch (err) { notify(`${name} hook NOT registered: ${err?.message ?? err}`, 'warning'); }
  };

  // The enforcing hook is registered FIRST and awaited, so no tool call can run
  // before the deny path exists.
  await ctx.tool.hook('execute.before', async (e) => {
    const tool = e?.tool;
    if (!tool) return;
    tracker.recordToolCall(e?.sessionID);
    const args = e?.input ?? {};

    // Slice-5 context-rot handoff: evaluated FIRST. A session past the
    // handoff band should not be told which rail it hit — it should be told
    // to stop and hand off.
    if (CONTEXT_ROT_HANDOFF_ENABLED) {
      const handoff = checkHandoff({
        tool,
        args,
        sessionID: e?.sessionID,
        tracker,
        root,
        env,
        ticketId: activeTicketIdOrNull,
        sticky: handoffSticky,
        initLatch: handoffInit,
      });
      if (handoff.decision === 'deny') {
        return denyHandoff(`ADLC context-handoff: blocked ${tool} — ${handoff.reason}`);
      }
    }

    const verdict = checkToolCall({ tool, args, root, env });
    if (verdict.decision === 'deny') {
      return deny(`ADLC rails-guard: blocked ${tool} — ${verdict.reason}`);
    }

    // Phase 2.3 build-gate backstop: a structured mutation on a HIGH-RISK
    // ticket in a context-degraded session is denied even off-rails.
    if (isStructuredMutator(String(tool).toLowerCase())) {
      const gate = checkBuildGate({ sessionID: e?.sessionID, tracker, root, env });
      if (gate.decision === 'deny') {
        return deny(`ADLC build-gate: blocked ${tool} — ${gate.reason}`);
      }
      if (gate.overridden) {
        notify(`ADLC build-gate: audited override recorded for ${tool}`, 'warning');
      }
    }
  });

  // Phase 3.3: churn/flail advisory. A file rewritten many times in one
  // session often means the model is stuck; warn once per churning file.
  await advisory('execute.after', () => ctx.tool.hook('execute.after', (e) => {
    try {
      // extractTargets covers path/filePath/files[]/edits[] AND patch envelope
      // bodies (patchText/patch/input), so churn is counted for patch-only
      // models too. Dedupe per event: one tool call editing a file is one churn
      // increment, even if its input names that file twice.
      const targets = [...new Set(extractTargets(e?.input))];
      for (const filePath of targets) {
        const { churning } = flail.record({ sessionID: e?.sessionID, tool: e?.tool, filePath });
        for (const c of churning) notify(flailMessage(c), 'warning');
      }
    } catch { /* advisory: swallow */ }
  }));

  // Phase 2.1 — permission deny lever.
  // permission.evaluate: dispatched — the v2 host triggers this hook AFTER
  // `execute.before`, for each permission request its configured rules did not
  // already deny, with the permission action (`write`/`patch` arrive as `edit`)
  // and project-relative `resources` (observed in scripts/opencode-live-deny.mjs).
  // A rails hit is normally thrown earlier by `execute.before`; this lever
  // covers requests that reach the permission step by another route. Sets
  // `effect = 'deny'` with the same predicates as the tool hook; never throws.
  await ctx.permission.hook('evaluate', (e) => {
    try {
      const kind = String(e?.action ?? '').toLowerCase();
      if (READONLY_TOOLS.includes(kind)) return;
      // The deny-set outranks the rail set here too: a session that must hand
      // off should not be able to buy its way past a permission prompt.
      if (CONTEXT_ROT_HANDOFF_ENABLED) {
        const handoff = checkHandoff({
          tool: kind,
          args: {},
          sessionID: e?.sessionID,
          tracker,
          root,
          env,
          ticketId: activeTicketIdOrNull,
          sticky: handoffSticky,
          initLatch: handoffInit,
        });
        if (handoff.decision === 'deny') {
          e.effect = 'deny';
          e.message = `ADLC context-handoff: denied permission "${kind}" — ${handoff.reason}`;
          notify(e.message, 'error');
          return;
        }
      }
      const force = resolveRailsInForce(root, env);
      if (!force.active) return;
      if (force.conflict) {
        e.effect = 'deny';
        e.message = 'ADLC rails-guard: active-ticket conflict — rails cannot be resolved';
        return;
      }
      const targets = (Array.isArray(e?.resources) ? e.resources : [])
        .filter((p) => typeof p === 'string' && p.trim());
      for (const target of targets) {
        const hit = railHit(target, force.rails, root);
        if (hit) {
          e.effect = 'deny';
          e.message = `ADLC rails-guard: denied permission "${kind}" — frozen rail "${hit}" (active ticket ${force.ticketId})`;
          notify(e.message, 'error');
          return;
        }
      }
    } catch { /* the permission lever must never break the host */ }
  });

  // Phase 3.1: re-state the active build's constraints (ticket, frozen rails,
  // scope) in the system prompt every turn — a context-rot defense so the
  // model is reminded BEFORE it acts, not only blocked after.
  await advisory('context', () => ctx.session.hook('context', (e) => {
    try {
      const block = buildSystemContext(root, env);
      if (block && Array.isArray(e?.system)) e.system.push({ type: 'text', text: block });
    } catch { /* advisory: swallow — never break prompt assembly */ }
  }));

  // T32.1 — keep ADLC enforcement context alive across compaction, so
  // summarization can't quietly drop it (context-rot defense).
  await advisory('compaction', () => ctx.session.hook('compaction', (e) => {
    try {
      const extra = buildCompactionContext(root, env);
      if (Array.isArray(e?.system)) for (const text of extra) e.system.push({ type: 'text', text });
    } catch { /* advisory: swallow — never break compaction */ }
  }));

  // T32.3 — advisory checks when an ADLC slash-command runs. Never blocks and
  // never mutates the prompt (commands are human-invoked): (a) lifecycle-order —
  // a phase invoked before its prerequisite phase left evidence; (b) tamper —
  // the command's deployed markdown differs from the packaged source.
  await advisory('prompt', () => ctx.session.hook('prompt', (e) => {
    try {
      const command = adlcCommandOf(e?.prompt);
      if (!command) return;
      const order = checkCommandOrder(command, root, env);
      if (order.warn) notify(order.warn, 'warning');
      const tamper = checkCommandTamper(command, PKG_ROOT, root);
      if (tamper.warn) notify(tamper.warn, 'warning');
    } catch { /* advisory: swallow */ }
  }));

  // Phase 3.2: name the frozen rails in the mutating tools' descriptions so the
  // model sees the constraint at the point of choosing to write. Computed once,
  // here: a ticket change takes effect on the next plugin load.
  await advisory('rail notice', () => ctx.tool.transform((ed) => {
    try {
      const notice = buildToolRailNotice(root, env);
      if (!notice) return;
      for (const id of RAIL_NOTICE_TOOLS) {
        ed.update(id, (t) => { if (typeof t.description === 'string') t.description += notice; });
      }
    } catch { /* advisory: swallow */ }
  }));

  // Phase 4.2 + T33: the native `adlc_gate` and `adlc_prosecute` tools. A
  // failure here must be VISIBLE — a silent drop would present as "the model
  // never calls gates" — and must not cost the enforcement registered above.
  try {
    const tools = [
      buildGateTool({ root, generate: ctx.generate }),
      buildProsecuteTool({ root, pkgRoot: PKG_ROOT, session: ctx.session, agent: ctx.agent }),
    ];
    await ctx.tool.transform((ed) => { for (const t of tools) ed.add(t); });
  } catch (err) {
    console.error(`[adlc] native tools NOT registered: ${err?.message ?? err}`);
  }

  const controller = new AbortController();
  if (typeof ctx.event?.subscribe === 'function') {
    runEventLoop(ctx.event, controller.signal, onEvent).catch(() => {});
  }
  return () => controller.abort();
}

export default { id: 'adlc', setup };
