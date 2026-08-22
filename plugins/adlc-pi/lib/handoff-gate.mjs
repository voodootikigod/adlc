// handoff-gate.mjs — pi's context-rot handoff deny (slice 5 of
// docs/specs/context-rot-handoff.md). pi is an ENFORCING tier: under the
// deny-set the agent loses structured edits AND the shell wholesale.
//
// D1-D3, the band thresholds, the protected-path list and the mutating-shell
// detector all come from `@adlc/context-handoff`; this module only maps pi's
// event shapes onto them.
//
// pi is the first adapter with a REAL context-fill percentage:
// `ctx.getContextUsage().percent` is a live 0-100 reading of the window, not a
// transcript-size proxy. It feeds the band join as `pct`; depth and bytes stay
// absent, and the OR-join ignores missing signal kinds rather than reading them
// as zero.
//
// Session identity: pi's own `ctx.sessionManager.getSessionId()`, which every
// ExtensionContext carries on its read-only session manager. The mint below is
// a last resort for contexts that expose no session manager at all (older
// hosts, harness fakes); it names the extension instance rather than the
// session, so it survives only as a fallback that still fails closed.

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, isAbsolute, resolve, join, dirname } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isSafeSessionId,
  resolveHandoffSessionId,
} from '@adlc/context-handoff';
import { extractToolPaths } from './rails-checker.mjs';

/** pi tool names that mutate through a structured target. */
const STRUCTURED_MUTATORS = new Set(['write', 'edit']);
/** pi's shell tool. */
const SHELL_TOOLS = new Set(['bash']);

/**
 * A stable session id for this extension instance.
 *
 * Prefers whatever the host offers; falls back to a per-process mint. Returns
 * null when neither yields an id the deny store can safely name a file after —
 * the caller then fails closed under pressure rather than skipping the gate.
 *
 * @param {object} [event] pi session_start event
 * @param {object} [ctx] pi event context
 * @param {{ mint?: () => string }} [opts]
 * @returns {string|null}
 */
export function resolvePiSessionId(event, ctx, { mint = defaultMint } = {}) {
  // ctx.sessionManager.getSessionId() is pi's REAL session identity, exposed on
  // the read-only session manager every ExtensionContext carries. It must come
  // first: a minted id names the extension instance, not the session, so a
  // reload would hand the same rotten session a fresh identity and drop D2.
  let managed;
  try {
    managed =
      typeof ctx?.sessionManager?.getSessionId === 'function'
        ? ctx.sessionManager.getSessionId()
        : undefined;
  } catch {
    managed = undefined;
  }

  const hosted = resolveHandoffSessionId({
    candidates: [
      managed,
      event?.sessionId,
      event?.session_id,
      event?.session?.id,
      event?.id,
      ctx?.sessionId,
      ctx?.session?.id,
    ],
  });
  if (hosted) return hosted;
  const minted = mint();
  return isSafeSessionId(minted) ? minted : null;
}

function defaultMint() {
  return `pi-${process.pid}-${randomUUID()}`;
}

/**
 * Per-session D1 memory. `processStickyDeny` is a per-call local inside the
 * gate, so a marker write that FAILED would deny one call and then fail open
 * once the band cooled. pi runs in-process, so it can hold the fact the spec
 * asks callers to thread.
 */
export function createStickyDenyState() {
  const seen = new Set();
  return {
    /** @param {string|null} sessionId */
    has(sessionId) {
      return typeof sessionId === 'string' && seen.has(sessionId);
    },
    /** @param {string|null} sessionId @param {boolean} value */
    record(sessionId, value) {
      if (value === true && typeof sessionId === 'string' && sessionId !== '') {
        seen.add(sessionId);
      }
    },
  };
}

/** @param {unknown} toolName */
export function isStructuredMutator(toolName) {
  return STRUCTURED_MUTATORS.has(String(toolName ?? '').toLowerCase());
}

/** @param {unknown} toolName */
export function isShellTool(toolName) {
  return SHELL_TOOLS.has(String(toolName ?? '').toLowerCase());
}

/**
 * Tools the deny-set applies to: pi's structured mutators, its shell, and any
 * third-party tool the rail gate already treats as potentially mutating. A
 * custom tool with no extractable target is still gated — under an open deny
 * the session must stop, whatever it was about to call.
 *
 * @param {unknown} toolName
 * @param {string[]} [readOnlyTools] tool names known never to mutate
 * @returns {boolean}
 */
export function handoffAppliesTo(toolName, readOnlyTools = ['read', 'grep', 'glob', 'list', 'ls']) {
  const name = String(toolName ?? '').toLowerCase();
  if (name === '') return false;
  return !readOnlyTools.includes(name);
}

/** Structured edit target from a pi tool_call input, if any. */
export function editTargetOf(input) {
  const path = input?.path ?? input?.filePath ?? input?.file_path;
  return typeof path === 'string' && path.trim() !== '' ? path : null;
}

/**
 * Every extractable target from a tool_call input.
 *
 * The rail gate vets custom tools through `extractToolPaths`, which recognizes
 * `target` and `file` as well as `path`, plus one level of nesting. The handoff
 * gate read only the three `path` spellings, so a third-party tool calling
 * `{target: '.adlc/.deny-store'}` reached the deny store with an empty
 * editRelPaths while the rail checker saw the path perfectly well. One
 * extractor per plugin, not two.
 *
 * editTargetOf stays the narrow reader for pi's OWN structured mutators, whose
 * shape is known; this is the union so nothing extractable is dropped.
 *
 * @param {object} input pi tool_call input
 * @param {string} root repo root
 * @returns {string[]}
 */
export function editTargetsOf(input, root) {
  const out = new Set(extractToolPaths(input, root));
  const narrow = editTargetOf(input);
  if (narrow) out.add(narrow);
  return [...out];
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their own form. */
export function toRepoRelative(path, root) {
  const normalized = String(path).replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') ? normalized : rel;
}

/**
 * Observed band signals from pi's live context usage. Thresholds live in
 * `@adlc/context-handoff`; nothing here compares against one.
 *
 * A usage object that is present but carries a non-numeric percent is reported
 * as NaN, which the band classifier treats as invalid (fail closed) rather than
 * as a healthy zero. An ABSENT usage object contributes no signal at all — pi
 * degrades `getContextUsage()` to null on hosts that do not provide it, and a
 * missing telemetry source must not hard-lock the repo.
 *
 * @param {{ percent?: unknown }|null|undefined} usage
 * @returns {{ pct?: number }}
 */
export function observeHandoffSignals(usage) {
  if (usage === null || usage === undefined) return {};
  const percent = usage.percent;
  if (percent === null || percent === undefined) return {};
  const asNumber = Number(percent);
  return { pct: Number.isFinite(asNumber) ? asNumber : Number.NaN };
}

/**
 * Did this repo opt in to ADLC? `.adlc/` is the marker every adapter reads, and
 * the gate treats its absence as "not my repo".
 * @param {unknown} root
 * @returns {boolean}
 */
function isAdlcRoot(root) {
  return typeof root === 'string' && root !== '' && existsSync(join(root, '.adlc'));
}

/**
 * Per-process memory of the roots that WERE ADLC repos, so containment can
 * never become an off switch.
 *
 * A bare presence check reads `.adlc` fresh on every call, which makes removing
 * it a way to disarm the gate: a custom tool whose target the extractor cannot
 * see is not rail-checked while the store is cold, so an agent below the band
 * could delete the directory and walk past every later deny — including one it
 * had already tripped. Before containment the band alone denied there, and that
 * must stay true.
 *
 * Keyed by CANONICAL root, not global and not by spelling: remembering one repo
 * must not arm another (that would undo the containment this protects), and
 * `/repo`, `/repo/.` and a symlink to the same checkout must not be three
 * different keys — otherwise reaching the repo by another name forgets the
 * opt-in.
 *
 * Process scope is the right ceiling, not a compromise. Anything more durable
 * would keep denying a repo whose `.adlc` the user deliberately removed, which
 * is the un-recoverable lock this whole change exists to remove.
 */
export function createAdlcRootState() {
  const seen = new Set();
  const key = (root) =>
    typeof root === 'string' && root !== '' ? trustedRealpath(resolve(root)) : null;
  return {
    /** @param {unknown} root */
    has(root) {
      const k = key(root);
      return k !== null && seen.has(k);
    },
    /** @param {unknown} root */
    record(root) {
      const k = key(root);
      if (k !== null) seen.add(k);
    },
  };
}

/**
 * The process-wide opt-in memory the extension uses.
 *
 * A per-instance Set would let "delete `.adlc`, then reload the extension"
 * forget the opt-in, so the memory has to outlive any one instance. Tests build
 * isolated states with `createAdlcRootState()` instead of sharing this one.
 */
const processAdlcRoots = createAdlcRootState();

/** @returns {{ has: Function, record: Function }} */
export function sharedAdlcRootState() {
  return processAdlcRoots;
}

// ---- recovery diagnostic ---------------------------------------------------
//
// Trusted LOCAL twins of `@adlc/context-handoff`'s recovery formatters, kept
// here for the same reason codex's hook keeps its own (adlc-handoff-gate.mjs's
// `recoveryDiagnostic`): the deny message is what an operator is left holding,
// and a message assembled out of package exports can fail in precisely the
// broken-install case it exists to report. Nothing below imports the package.

// These two mirror `recovery-exception.mjs`'s PATH_UNQUOTED_RE / VALUE_RE
// exactly; pi-helper-drift.test.mjs pins them to the canonical copies. They are
// the TOKEN grammar only — `matchRecoveryCommand`'s per-subcommand flag
// whitelist admits neither `--dir` nor `--unbound-reason`, so the command
// printed below is deliberately NOT one that matcher would accept. That costs
// nothing today (pi has no recovery exception; its shell is denied wholesale),
// and it is why the command is described as host-side throughout.
/** Path-token grammar accepted unquoted. */
const RECOVERY_PATH_UNQUOTED_RE = /^[A-Za-z0-9_./=-]+$/;
/** Flag-value grammar, session ids included. */
const RECOVERY_VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;

/**
 * Can this session id appear as a `--session` value in a printed command?
 *
 * Both gates, not just the matcher's: `RECOVERY_VALUE_RE` admits `.` and `/`,
 * so the grammar alone would happily print `--session ../escape` — a traversal
 * id the deny store would refuse and no operator should be handed. Anything the
 * store will not name a marker file after has no recovery command either.
 */
function isRecoverySessionId(sessionId) {
  return typeof sessionId === 'string' && RECOVERY_VALUE_RE.test(sessionId) && isSafeSessionId(sessionId);
}

/**
 * Quote a path the way the grammar requires, or null when it cannot be
 * represented at all — a literal apostrophe would terminate the quote early and
 * hand anyone who copy-pastes the diagnostic a second shell command.
 * @param {string} p
 * @returns {string|null}
 */
function quotePathForDisplay(p) {
  if (typeof p !== 'string' || p.includes("'") || /[\r\n]/.test(p)) return null;
  return RECOVERY_PATH_UNQUOTED_RE.test(p) ? p : `'${p}'`;
}

/** realpath where possible; a diagnostic must never be what throws. */
function trustedRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Single-token reason recorded against an operator's unbound grant. */
const UNBOUND_REASON = 'pi-handoff-operator-recovery';

/** The `--unbound-reason` clause a foreign open record needs, or nothing. */
function unboundClause(unbound) {
  return unbound ? ` --unbound-reason ${UNBOUND_REASON}` : '';
}

/**
 * The session named by a `D3:unauthorized_open:<id>` reason when it is NOT this
 * session.
 *
 * This is the difference between a command that works and one that quietly does
 * not. A band-generated marker is unbound (`ticket_id` and `content_hash` are
 * both null), and a BOUND grant only authorizes an unbound record belonging to
 * its own session — so against another session's record it is consumed and the
 * caller stays denied. Measured, not read: see the cross-session test.
 *
 * @param {string[]|undefined} reasons
 * @param {unknown} sessionId
 * @returns {string|null}
 */
export function foreignDenierOf(reasons, sessionId) {
  for (const reason of reasons ?? []) {
    const match = /^D3:unauthorized_open:(.+)$/.exec(String(reason));
    if (match && match[1] !== sessionId) return match[1];
  }
  return null;
}

/**
 * Prose for a path no shell command can safely carry. The raw paths are safe
 * here precisely because this string is never meant to be executed.
 * @param {{ interpreterPath: string, scriptPath: string, adlcDir: string, sessionId: string, unbound?: boolean }} opts
 * @returns {string}
 */
export function formatUnsafeInstallPathMessage({
  interpreterPath,
  scriptPath,
  adlcDir,
  sessionId,
  unbound = false,
}) {
  return (
    'The recovery command cannot be printed as a safe, copy-pasteable shell command: a resolved path ' +
    'contains a character (a literal apostrophe or a newline) that cannot be represented in one. Run the ' +
    `operator recovery CLI manually — interpreter at ${interpreterPath}, script at ${scriptPath}, ` +
    `subcommand "bypass --session ${sessionId}${unboundClause(unbound)} --write" against ${adlcDir}.`
  );
}

/**
 * The copy-pasteable host-side recovery command, or prose when one cannot be
 * built. Degrades rather than ever emitting a broken or injectable command.
 *
 * `--dir` is not optional decoration. The CLI resolves its ledger relative to
 * `process.cwd()`, so the same command pasted into a shell sitting anywhere
 * else writes the grant into THAT directory and exits 0 — the denied repo is
 * untouched and the operator is told it worked.
 *
 * @param {{ interpreterPath: string, scriptPath: string, adlcDir: string, sessionId: unknown, unbound?: boolean }} opts
 * @returns {string}
 */
export function formatRecoveryCommand({
  interpreterPath,
  scriptPath,
  adlcDir,
  sessionId,
  unbound = false,
}) {
  if (!isRecoverySessionId(sessionId)) return formatNoSessionIdMessage();
  const [interpreterDisplay, scriptDisplay, dirDisplay] = [interpreterPath, scriptPath, adlcDir].map(
    quotePathForDisplay,
  );
  if (interpreterDisplay === null || scriptDisplay === null || dirDisplay === null) {
    return formatUnsafeInstallPathMessage({ interpreterPath, scriptPath, adlcDir, sessionId, unbound });
  }
  return (
    `${interpreterDisplay} ${scriptDisplay} bypass --session ${sessionId}` +
    `${unboundClause(unbound)} --dir ${dirDisplay} --write`
  );
}

/**
 * Deliberately NOT the package's wording, which tells the operator to start a
 * fresh session. That is true of a band-only degrade and false of an open deny:
 * the record lives in the repo and reaches the next session too.
 * @returns {string}
 */
export function formatNoSessionIdMessage() {
  return (
    'No session id resolved here, so no session-bound recovery command can be printed. An open deny is ' +
    'recorded in the repo and reaches a new session as well, so starting one does not clear it.'
  );
}

/**
 * What an operator with no `ADLC_MANIFEST_KEY` can actually do.
 *
 * Verified against the CLI rather than inferred: write, resume, continue,
 * supervise, bypass and repair all call `requireKeyOrExit`
 * (packages/context-handoff/bin/handoff.mjs). `unlock` is the one mutating verb
 * that does not — and it reclaims a session LOCK, not a deny, so naming it as
 * the keyless recovery would send the operator in a circle.
 *
 * Every path, not just the marker: a `.deny-store` sentinel is what makes an
 * emptied `denies/` directory read as tampered-with and keep denying, so
 * deleting a marker alone leaves the repo exactly as locked. BOTH sentinel
 * locations are named — a repo carrying the pre-migration
 * `.adlc/handoffs/.deny-store` re-creates the canonical one from it on the next
 * read, so a recipe naming only the canonical path never terminates (measured:
 * D0:deny_store_unavailable, forever).
 * @returns {string}
 */
export function formatKeylessRecovery() {
  return (
    'No ADLC_MANIFEST_KEY is configured, so that command — and every other mutating handoff verb ' +
    '(write/resume/continue/supervise/bypass/repair) — exits before it runs. `adlc handoff unlock` needs no ' +
    'key but reclaims a session lock, not a deny, so it does not clear this either. Keyless recovery — and ' +
    "the only durable clear — from a host shell outside the agent: delete this repo's open deny markers " +
    'under `.adlc/handoffs/denies/` AND both sentinels, `.adlc/.deny-store` and the legacy ' +
    '`.adlc/handoffs/.deny-store` if it exists. Deleting a marker on its own is not enough — a sentinel ' +
    'makes an emptied store fail closed (and the legacy one re-creates the other), and any marker left ' +
    'behind keeps denying every session in the repo.'
  );
}

/**
 * `@adlc/context-handoff`'s own `bin/handoff.mjs`, by absolute path.
 *
 * A pure module-resolution lookup, never an `import()` of the package, so the
 * diagnostic can name the CLI even where loading the package would fail.
 * Returns null instead of throwing.
 * @param {{ req?: { resolve: (spec: string) => string } }} [opts]
 * @returns {string|null}
 */
export function resolveRecoveryCliPath({ req = createRequire(import.meta.url) } = {}) {
  try {
    return join(dirname(dirname(req.resolve('@adlc/context-handoff'))), 'bin', 'handoff.mjs');
  } catch {
    return null;
  }
}

/**
 * The recovery tail every pi handoff deny carries: the command an operator can
 * actually run, named by absolute path, plus the keyless path when there is no
 * key to run it with.
 *
 * `hasManifestKey` is a boolean, not the key: the deny text is rendered into
 * the session UI, and a diagnostic has no business holding the secret.
 *
 * @param {object} opts
 * @param {unknown} opts.sessionId
 * @param {string} [opts.root] repo root the deny belongs to — the command is
 *        pinned to it with `--dir`, never left to the operator's cwd
 * @param {string[]} [opts.reasons] deny reasons, read only to tell a foreign
 *        open record from this session's own
 * @param {boolean} [opts.hasManifestKey]
 * @param {string|null} [opts.cliPath]
 * @returns {string}
 */
export function handoffRecoveryDiagnostic({
  sessionId,
  root = '',
  reasons = [],
  hasManifestKey = false,
  cliPath = resolveRecoveryCliPath(),
}) {
  const parts = [];
  if (cliPath === null) {
    parts.push(
      'Host-side recovery: @adlc/context-handoff could not be resolved from this install, so its recovery ' +
        'CLI cannot be named by path. Install it (npm install -g @adlc/cli), then drive it with its own bin: ' +
        'handoff bypass|repair|resume.',
    );
  } else {
    const interpreterPath = trustedRealpath(process.execPath);
    const scriptPath = trustedRealpath(cliPath);
    // Realpath the ROOT and join afterwards: realpathing `<root>/.adlc` itself
    // would follow a symlink to a directory named something else, and the CLI
    // rejects a --dir whose last segment is not `.adlc`.
    const adlcDir = join(trustedRealpath(root), '.adlc');
    const unbound = foreignDenierOf(reasons, sessionId) !== null;
    const command = formatRecoveryCommand({ interpreterPath, scriptPath, adlcDir, sessionId, unbound });
    // Label it as a command only when it IS one — same representability test
    // `formatRecoveryCommand` itself used, so the two can never disagree.
    const runnable =
      isRecoverySessionId(sessionId) &&
      quotePathForDisplay(interpreterPath) !== null &&
      quotePathForDisplay(scriptPath) !== null &&
      quotePathForDisplay(adlcDir) !== null;
    // "One-shot" and "next mutation only" are measured, not copied from the
    // CLI's help: the grant is consumed by the mutation it authorizes, and the
    // one after that is denied again. Calling this "recovery" without saying so
    // would replace one misleading instruction with another.
    const label = unbound
      ? 'One-shot host-side grant (needs ADLC_MANIFEST_KEY; authorizes the NEXT mutation only, and is ' +
        'unbound because the deny belongs to another session — the reason is recorded)'
      : 'One-shot host-side grant (needs ADLC_MANIFEST_KEY; authorizes the NEXT mutation only)';
    parts.push(runnable ? `${label}: ${command}` : command);
  }
  parts.push(
    hasManifestKey
      ? 'That grant is consumed by the mutation it authorizes, so it unblocks one call rather than the ' +
          'session. `adlc handoff resume` / `continue` are the durable handoff flows.'
      : formatKeylessRecovery(),
  );
  return parts.join('\n\n');
}

/**
 * Evaluate the handoff deny-set for one pi tool call.
 *
 * @param {object} opts
 * @param {unknown} opts.toolName
 * @param {object} [opts.input] pi tool_call input
 * @param {string|null} opts.sessionId
 * @param {object|null} [opts.usage] ctx.getContextUsage() reading
 * @param {string|null} [opts.ticketId]
 * @param {string} opts.root
 * @param {string|null} [opts.manifestKey] lets a signed resume-auth be VERIFIED;
 *        without it `authorized()` can never accept one, so a completed
 *        `adlc handoff resume` could not clear the deny it was minted to clear
 * @param {{ has: Function, record: Function }} [opts.sticky] per-session D1
 *        memory: a marker write that FAILED must stay sticky after the band
 *        cools, and only a caller with memory across calls can carry that
 * @param {{ has: Function, record: Function }} [opts.adlcRoots] per-process
 *        memory of roots that opted in, so removing `.adlc` cannot disarm the
 *        gate for a repo that was already under it
 * @param {Function} [opts.evaluate] injection seam for tests
 * @returns {{ decision: 'allow'|'deny', reason?: string, reasons?: string[] }}
 */
export function checkHandoff({
  toolName,
  input = {},
  sessionId,
  usage = null,
  ticketId = null,
  root,
  manifestKey = null,
  sticky,
  adlcRoots,
  evaluate = evaluateHandoffPreToolUse,
}) {
  if (!handoffAppliesTo(toolName)) return { decision: 'allow' };

  // Containment. ADLC enforcement belongs to repos that installed ADLC: without
  // this, the band alone denied write/edit/bash in ANY directory the agent
  // happened to open, wrote `.adlc` state into it, and — the deny store being
  // durable — followed that directory into every later session, with no
  // key-free way out. `.adlc/` is the opt-in. Same guard codex's hook opens
  // with, resolved against the SAME root the rest of this gate uses so a
  // contained repo and an enforced one can never be decided from two places.
  //
  // Monotonic: opting in is remembered for the process, so deleting `.adlc`
  // mid-session cannot turn enforcement back off (see createAdlcRootState).
  if (isAdlcRoot(root)) {
    if (adlcRoots) adlcRoots.record(root);
  } else if (!(adlcRoots && adlcRoots.has(root))) {
    return { decision: 'allow' };
  }

  const shell = isShellTool(toolName);
  const targets = shell ? [] : editTargetsOf(input, root);
  const safeSessionId = isSafeSessionId(sessionId) ? sessionId : null;
  const key = typeof manifestKey === 'string' && manifestKey !== '' ? manifestKey : null;

  const result = evaluate({
    root,
    sessionId: safeSessionId,
    observed: observeHandoffSignals(usage),
    ticketId,
    editRelPaths: targets.map((p) => toRepoRelative(p, root)),
    isBash: shell,
    bashCommand: shell && typeof input?.command === 'string' ? input.command : '',
    host: 'pi',
    manifestKey: key,
    denyEverWritten: sticky ? sticky.has(safeSessionId) : false,
  });
  if (sticky) sticky.record(safeSessionId, result.denyEverWritten);

  if (!result.deny) return { decision: 'allow' };
  return {
    decision: 'deny',
    reasons: result.reasons,
    // No "continue in a fresh session": the deny record lives in the repo, so a
    // new session walks straight back into it. Saying otherwise sent operators
    // round a loop that could not terminate.
    reason:
      `context-rot handoff deny (${result.reasons.join(', ')}). The deny is recorded in the repo and ` +
      'scoped to session trust rather than to a ticket: it holds for new sessions here until an operator ' +
      'clears it, and the agent shell cannot.\n\n' +
      handoffRecoveryDiagnostic({
        sessionId: safeSessionId,
        root,
        reasons: result.reasons,
        hasManifestKey: key !== null,
      }),
  };
}
