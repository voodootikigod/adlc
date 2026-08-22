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
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, isAbsolute, resolve, join, dirname } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isSafeSessionId,
  resolveHandoffSessionId,
} from '@adlc/context-handoff';
import { ticketStoreExists } from '@adlc/core';
import { extractToolPaths, READONLY_TOOLS } from './rails-checker.mjs';

/**
 * Tools that never mutate, so the deny-set leaves them alone.
 *
 * The UNION of the rail checker's canonical `READONLY_TOOLS` and the names only
 * this gate knew about. Two hand-kept lists had already drifted — `find` is a
 * real pi read-only tool the rail checker classifies as one, and the gate's
 * private list omitted it, so an open deny took away the tool an operator needs
 * to inspect what is wrong. Same lesson as `editTargetsOf`: one list per
 * plugin, not two, and a union so neither side can silently drop a name.
 */
const NON_MUTATING_TOOLS = [...new Set([...READONLY_TOOLS, 'glob', 'list'])];

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

/**
 * Does any reason describe the CALL rather than the session's standing?
 *
 * `path_protected*` means this very call targets an artifact the deny-set
 * guards. No grant lifts one — measured: with a verified unbound grant in
 * place, a tool naming `.adlc/.deny-store` is still denied, and the grant is
 * not even consumed. Offering a grant there spends the operator's one shot on
 * a deny it cannot touch, which is the false-instruction class this gate was
 * rewritten to stop producing.
 *
 * @param {string[]|undefined} reasons
 * @returns {boolean}
 */
export function hasProtectedPathFault(reasons) {
  return (reasons ?? []).some((reason) => String(reason).startsWith('path_protected'));
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
export function handoffAppliesTo(toolName, readOnlyTools = NON_MUTATING_TOOLS) {
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
 * The root of the ADLC repo this path sits in, canonicalized — or null when it
 * sits in none.
 *
 * "Installed ADLC" means the TICKET STORE exists: the same predicate
 * `resolveRailsInForce` keys on, and nothing more. Not the mere presence of
 * `.adlc/`, which is self-defeating here — the bug this branch fixes littered
 * ordinary directories with `.adlc/.deny-store` and deny markers, so a
 * bare-directory test lets those artifacts vouch for the gate that created them
 * and a repo already hit by the bug stays bricked by its own fix. And not the
 * store AND a local `.adlc` either: `ADLC_TICKET_STORE` may name an absolute
 * store outside the worktree, which the rail guard accepts with no local
 * directory, so ANDing one on would leave rails enforcing while the deny-set
 * silently stood down.
 *
 * Containment asks whether a path is INSIDE an ADLC repo, not whether it IS
 * one. pi hands the gate its cwd, which is routinely a subdirectory, so an
 * exact-match check let a session started in `<repo>/src` walk past an open
 * repo-wide deny, and wrote band markers into a stray `<repo>/src/.adlc` no
 * operator would think to clear. Resolving the real root instead fixes the
 * containment question and the deny-store lookup with one answer.
 *
 * The walk stops at a `.git` boundary: a checkout vendored inside an ADLC repo
 * is its own project, and capturing it would bring back the blocker this guard
 * exists to fix for anyone whose scratch repo lives under one.
 *
 * @param {unknown} root
 * @returns {string|null}
 */
export function resolveAdlcRoot(root, storeOverride = null, adlcRoots = null) {
  if (typeof root !== 'string' || root === '') return null;
  const start = trustedRealpath(resolve(root));

  // A RELATIVE override names a store per-directory, so it participates in the
  // walk. An ABSOLUTE one lives outside the tree and is true of every directory
  // equally — it says THAT ADLC is in force, never WHERE the repo is, so it is
  // deliberately excluded here and handled once, below.
  const perDirectoryOverride = storeOverride && !isAbsolute(storeOverride) ? storeOverride : null;

  // Walk once, unbounded, recording what each ancestor is. The boundary
  // decision needs to see the WHOLE chain before it can be made — see below.
  /** @type {{ dir: string, remembered: boolean, store: boolean, checkout: boolean }[]} */
  const chain = [];
  let dir = start;
  for (;;) {
    chain.push({
      dir,
      remembered: adlcRoots ? adlcRoots.has(dir) : false,
      store: ticketStoreExists(dir, perDirectoryOverride),
      checkout: looksLikeCheckout(dir),
    });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Is some ancestor a real ADLC repo — a git checkout that also holds a ticket
  // store — containing this path?
  //
  // This is the tiebreaker between two requirements that otherwise conflict,
  // given that no filesystem test can tell a forged checkout from a real one:
  //  - a `.git` an agent can create must not release an enclosing ADLC repo
  //    (a bare `mkdir src/.git` + HEAD turned deny into allow, even cold, once
  //    the process restarted and the session_start memory was gone);
  //  - a ticket store sitting above an unrelated checkout — a stray
  //    `~/.adlc/tickets.json` — must not enforce over every repo beneath it.
  // An enclosing git+store ancestor distinguishes them: the first case has one,
  // the second does not (a home directory is not a checkout). So the boundary
  // is honoured only when nothing above it is a real ADLC repo.
  // …and the test is per-directory: is there a real ADLC repo STRICTLY above
  // this one? A boundary is climbed past only while one remains above it, so
  // the walk stops at the OUTERMOST enclosing ADLC repo rather than sailing
  // past it. Disabling the boundary outright instead let a stray parent
  // `.adlc/tickets.json` outrank the repo itself (measured), which is the very
  // shadowing the boundary exists to prevent.
  const adlcRepoAbove = chain.map(() => false);
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    adlcRepoAbove[i] = adlcRepoAbove[i + 1] || (chain[i + 1].checkout && chain[i + 1].store);
  }

  let outermost = null;
  let checkoutRoot = null;
  let insideCheckout = true;
  for (const [i, link] of chain.entries()) {
    if (link.remembered || (insideCheckout && link.store)) outermost = link.dir;
    // The boundary applies from the NEXT ancestor up, so a checkout root that
    // holds the store still counts as one.
    if (insideCheckout && link.checkout) {
      checkoutRoot = link.dir;
      if (!adlcRepoAbove[i]) insideCheckout = false;
    }
  }
  if (outermost !== null) return outermost;

  // An external absolute store: ADLC is in force, but the store says nothing
  // about WHERE, so structure answers it — the checkout root, falling back to
  // the working directory when there is no checkout. Letting the walk answer it
  // instead matched every ancestor and marched enforcement to `/`, where
  // durable deny state would have landed; answering it with the cwd alone split
  // one checkout into a separate deny store per subdirectory, so an open deny
  // stopped being repo-wide.
  if (!ticketStoreExists(start, storeOverride)) return null;
  return checkoutRoot ?? start;
}

/**
 * Does this directory hold something that could actually be a git checkout?
 *
 * `.git` existing is not enough, because `mkdir .git` is a thing an agent can
 * do — and before this check that was a one-command opt-out of an enclosing
 * repo's deny on the very first gated call, before any root was remembered. A
 * real checkout has `.git/HEAD`, or a `.git` FILE holding a `gitdir:` pointer
 * (worktrees and submodules).
 *
 * This shape check is a filter, not the defence. No filesystem test separates a
 * real vendored checkout from one an agent constructed — an agent that can
 * write files can write whatever git would have written — so escalating it
 * raises the effort and never decides. What actually decides is `resolveAdlcRoot`,
 * which honours a boundary only when nothing above it is a real ADLC repo; see
 * the `enclosingAdlcRepo` comment there for why that resolves the conflict this
 * check cannot.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeCheckout(dir) {
  const gitPath = join(dir, '.git');
  try {
    const stats = lstatSync(gitPath);
    if (stats.isFile()) {
      // Not any file: git writes exactly `gitdir: <path>`. Accepting a regular
      // file on sight made `echo x > src/.git` the same one-command escape the
      // HEAD check had just closed for directories.
      if (stats.size > GITDIR_POINTER_MAX_BYTES) return false;
      return readFileSync(gitPath, 'utf8').trimStart().startsWith('gitdir:');
    }
    return stats.isDirectory() && existsSync(join(gitPath, 'HEAD'));
  } catch {
    return false;
  }
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
  /** canonical root -> filesystem identity observed when it opted in */
  const seen = new Map();
  const key = (root) =>
    typeof root === 'string' && root !== '' ? trustedRealpath(resolve(root)) : null;

  /**
   * Is the directory at this remembered path still the checkout that opted in?
   *
   * The memory has to separate two states a path alone cannot: `.adlc` deleted
   * out from under an opted-in repo (keep enforcing — that deletion is the off
   * switch this memory exists to close) and the whole checkout replaced by
   * another project at the same path (do NOT enforce, or the blocker returns as
   * stray ADLC state in a repo that never opted in). The directory's own
   * identity tells them apart: deleting a child leaves it untouched, replacing
   * the checkout does not.
   *
   * Unknown identity on either side keeps enforcing. A platform without stable
   * inodes, or a path that cannot be stat'd, must not become the soft spot.
   *
   * ACCEPTED LIMIT: replacing a checkout's CONTENTS in place keeps the
   * directory's identity, so it still reads as the repo that opted in. That is
   * not an oversight to fix later — from the filesystem alone, "same repo with
   * `.adlc` deleted" and "different project written over it" are the same
   * observation, and any identity strong enough to separate them (`.git`, a
   * marker file) can be deleted by the same agent the memory exists to stop.
   * Erring toward enforcing is the safe half of an undecidable question, and it
   * expires with the process.
   */
  const sameCheckout = (dir) => {
    if (!seen.has(dir)) return false;
    const recorded = seen.get(dir);
    const now = directoryIdentity(dir);
    if (recorded === null || now === null) return true;
    return recorded === now;
  };

  return {
    /**
     * Is this exact directory a remembered, still-present opt-in?
     *
     * `checkHandoff` calls this once per ancestor as the walk's predicate, so
     * it answers about the directory given, never about its parents — the walk
     * owns the climbing, and owning it in one place is what keeps the live and
     * remembered lookups from drifting apart again.
     * @param {unknown} root
     */
    has(root) {
      const k = key(root);
      return k !== null && sameCheckout(k);
    },
    /** @param {unknown} root */
    record(root) {
      const k = key(root);
      if (k !== null) seen.set(k, directoryIdentity(k));
    },
  };
}

/**
 * A directory's filesystem identity, or null when it cannot be established.
 * Never throws: this feeds a guard, and a guard that throws is an outage.
 * @param {string} dir
 * @returns {string|null}
 */
function directoryIdentity(dir) {
  try {
    const stats = statSync(dir);
    return stats.ino ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
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

/** A `.git` pointer file is one short line; anything larger is not one. */
const GITDIR_POINTER_MAX_BYTES = 4096;

/** Single-token reason recorded against an operator's unbound grant. */
const UNBOUND_REASON = 'pi-handoff-operator-recovery';

/**
 * Deny reasons that describe the STORE rather than a session's standing.
 *
 * These need the UNBOUND grant, exactly like a foreign record: the shared gate
 * lifts `D0:deny_store_unavailable` and `D3:invalid_record:*` only for an
 * unbound operator override (mutation-gate.mjs — "legacy `true` bypass
 * cannot"). Measured against a clean store fault: unbound clears it, bound does
 * not. An earlier reading here mistook a co-occurring `D1:process_sticky` for
 * the store fault surviving and concluded no grant worked at all — which would
 * have pushed operators to delete files when a non-destructive repair existed.
 */
const STORE_INTEGRITY_CODES = new Set([
  'D0:deny_store_unavailable',
  'D0:invalid_deny_records',
  'D3:invalid_record',
]);

/**
 * Does any reason describe the store rather than a session's standing?
 *
 * Matched on the CODE, not the whole string: the shared gate emits
 * `D3:invalid_record:<label>` and never the bare form, so an exact-string set
 * missed every real one — the same shape `D3:unauthorized_open:<id>` has. The
 * neighbouring `D3:unauthorized_open` deliberately does NOT belong here: an
 * unbound grant does clear one, so it must keep being offered.
 *
 * @param {string[]|undefined} reasons
 * @returns {boolean}
 */
export function hasStoreIntegrityFault(reasons) {
  return (reasons ?? []).some((reason) => {
    const text = String(reason);
    for (const code of STORE_INTEGRITY_CODES) {
      if (text === code || text.startsWith(`${code}:`)) return true;
    }
    return false;
  });
}

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
 * The whole `handoffs/` tree plus the canonical sentinel, and NO glob. Three
 * things forced that shape:
 *  - a marker alone is not enough — a `.deny-store` sentinel makes an emptied
 *    `denies/` read as tampered-with and keep denying;
 *  - the pre-migration `.adlc/handoffs/.deny-store` re-creates the canonical
 *    sentinel on the next read, so a recipe that misses it never terminates
 *    (measured: D0:deny_store_unavailable, forever) — removing `handoffs/`
 *    takes it along;
 *  - `rm .adlc/handoffs/denies/*.json` EXPANDS THROUGH A SYMLINK. An agent that
 *    points `denies` somewhere else has the operator delete files outside the
 *    repo when they run the recovery (measured). `rm -rf` on the directory
 *    removes a symlink itself rather than following it.
 * @returns {string}
 */
export function formatKeylessRecovery(adlcDir = null) {
  const targets = formatKeylessTargets(adlcDir);
  return (
    'No ADLC_MANIFEST_KEY is configured, so that command — and every other mutating handoff verb ' +
    '(write/resume/continue/supervise/bypass/repair) — exits before it runs. `adlc handoff unlock` needs no ' +
    'key but reclaims a session lock, not a deny, so it does not clear this either. Keyless recovery — and ' +
    `the only durable clear — from a host shell outside the agent: ${targets} That clears every open marker ` +
    'and both sentinels at once. Do not pick off one marker or glob inside `denies/`: any marker left behind ' +
    'keeps denying every session, a sentinel makes an emptied store fail closed, and a glob follows a ' +
    'symlink out of the repo.'
  );
}

/**
 * The removal command, naming RESOLVED ABSOLUTE paths.
 *
 * Resolved, because `.adlc` may itself be a symlink — an external ticket store
 * is a supported layout — and `rm -rf .adlc/handoffs` follows it. Printing the
 * relative form hid that: the operator ran a command that looked local and
 * deleted through the link (measured). Naming the real target makes the reach
 * visible before they run it, which is the honest fix — for a genuine external
 * store, deleting there is exactly right, and for a repointed one the operator
 * can see the path is not their repo and stop.
 *
 * @param {string|null} adlcDir resolved `.adlc` directory
 * @returns {string}
 */
function formatKeylessTargets(adlcDir) {
  const display = typeof adlcDir === 'string' && adlcDir !== '' ? quotePathForDisplay(adlcDir) : null;
  if (display === null) {
    return (
      'delete the `handoffs` directory and the `.deny-store` file inside this repo\'s `.adlc`, by absolute ' +
      'path — resolve `.adlc` first, since it may be a symlink to a store outside the checkout and a ' +
      'relative `rm` would follow it without showing you where.'
    );
  }
  return `\`rm -rf ${display}/handoffs ${display}/.deny-store\` (paths resolved — check they are where you expect).`;
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
 * @param {string|null} [opts.root] repo root the deny belongs to — the command
 *        is pinned to it with `--dir`, never left to the operator's cwd, and no
 *        command is printed at all when it is missing
 * @param {string[]} [opts.reasons] deny reasons, read only to tell a foreign
 *        open record from this session's own
 * @param {boolean} [opts.hasManifestKey]
 * @param {string|null} [opts.cliPath]
 * @returns {string}
 */
export function handoffRecoveryDiagnostic({
  sessionId,
  root = null,
  reasons = [],
  hasManifestKey = false,
  cliPath = resolveRecoveryCliPath(),
}) {
  const parts = [];
  const storeFault = hasStoreIntegrityFault(reasons);
  const protectedPath = hasProtectedPathFault(reasons);
  // Whether a runnable grant was actually printed. The keyed follow-up below
  // describes how "that grant" behaves, and saying it when none exists — an
  // unusable session id, an unquotable path, an unresolved CLI — promises the
  // operator a recovery that was never offered.
  let grantOffered = false;
  if (cliPath === null) {
    parts.push(
      // `adlc handoff`, not a bare `handoff`: the global install route is
      // @adlc/cli, whose bin is `adlc`. context-handoff's own `handoff` bin is
      // a transitive dependency's and is not linked onto PATH by that install,
      // so naming it would be one more instruction that does not run.
      'Host-side recovery: @adlc/context-handoff could not be resolved from this install, so its recovery ' +
        'CLI cannot be named by path. Install it (npm install -g @adlc/cli) and drive it through that bin, ' +
        'run from the denied repo: ' +
        (storeFault
          ? '`adlc handoff bypass --session <id> --unbound-reason <text> --write` — a bound grant does not ' +
            'lift a store fault.'
          : '`adlc handoff bypass|repair|resume`.'),
    );
  } else if (protectedPath) {
    parts.push(
      'This call was refused because it targets an ADLC artifact the deny-set protects, not because of ' +
        'this session\'s standing, and no grant authorizes that — so there is no command to run here: ' +
        'target something outside `.adlc/` instead. Do NOT retry it through the shell while holding a ' +
        'grant: a SHELL call naming a protected path is still refused but SPENDS the grant anyway ' +
        '(measured; a structured tool call does not), so you would lose your one shot to a call that ' +
        'could never have been authorized. Any handoff deny behind this one is reported separately once ' +
        'the call stops naming a protected path.',
    );
  } else if (typeof root !== 'string' || root === '') {
    // No repo, no command. `resolve('')` is process.cwd(), so a missing root
    // would have printed a --dir naming whatever directory this process happens
    // to sit in — a confidently wrong path is worse than none.
    parts.push(
      'No repository root was resolved for this deny, so no `--dir`-pinned command can be printed. Run the ' +
        'operator recovery CLI from the denied repo itself.',
    );
  } else {
    const interpreterPath = trustedRealpath(process.execPath);
    const scriptPath = trustedRealpath(cliPath);
    // Realpath the ROOT and join afterwards: realpathing `<root>/.adlc` itself
    // would follow a symlink to a directory named something else, and the CLI
    // rejects a --dir whose last segment is not `.adlc`.
    const adlcDir = join(trustedRealpath(root), '.adlc');
    // Unbound is required for a foreign record AND for a store fault; a bound
    // grant lifts neither.
    const unbound = foreignDenierOf(reasons, sessionId) !== null || storeFault;
    const command = formatRecoveryCommand({ interpreterPath, scriptPath, adlcDir, sessionId, unbound });
    // Label it as a command only when it IS one — same representability test
    // `formatRecoveryCommand` itself used, so the two can never disagree.
    const runnable =
      isRecoverySessionId(sessionId) &&
      quotePathForDisplay(interpreterPath) !== null &&
      quotePathForDisplay(scriptPath) !== null &&
      quotePathForDisplay(adlcDir) !== null;
    // Every clause here is measured, not copied from the CLI's help. The grant
    // is consumed by the next GATED CALL — pi gates every tool but a read, so a
    // `bash pwd` spends it without mutating anything — and the call after that
    // is denied again.
    const why = storeFault ? 'the deny reports the store itself' : 'the deny belongs to another session';
    const label = unbound
      ? 'One-shot host-side grant (needs ADLC_MANIFEST_KEY; authorizes the NEXT gated tool call only, ' +
        `and is unbound because ${why} — the reason is recorded)`
      : 'One-shot host-side grant (needs ADLC_MANIFEST_KEY; authorizes the NEXT gated tool call only)';
    parts.push(runnable ? `${label}: ${command}` : command);
    grantOffered = runnable;
  }
  // A store-integrity fault is not a standing the grant above can lift, so the
  // grant must not be left looking like the answer.
  // The `.adlc` a removal command must name is the RESOLVED one: it may be a
  // symlink to an external store, and `rm -rf .adlc/handoffs` follows it.
  // (`--dir` above deliberately keeps the unresolved form — the CLI requires
  // that argument's last segment to be `.adlc`.)
  const resolvedAdlcDir =
    typeof root === 'string' && root !== '' ? trustedRealpath(join(trustedRealpath(root), '.adlc')) : null;
  if (storeFault) {
    parts.push(
      'This deny reports the deny STORE itself, not this session\'s standing: a marker is unreadable, or the ' +
        'store looks emptied. Only the unbound form above lifts it — a bound grant does not — and that grant ' +
        'is still one-shot, so it buys a call, not a repaired store. The durable fix is to clear the state, ' +
        `from a host shell: ${formatKeylessTargets(resolvedAdlcDir)}`,
    );
  }
  if (hasManifestKey) {
    if (grantOffered) {
      parts.push(
        'That grant is consumed by the next gated tool call — every tool but a read, whether or not it ' +
          'mutates, so a `bash pwd` spends it — and unblocks one call rather than the session. ' +
          '`adlc handoff resume` / `continue` are the durable handoff flows.',
      );
    }
  } else {
    parts.push(formatKeylessRecovery(resolvedAdlcDir));
  }
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
 *        memory of roots that opted in, so removing the store cannot disarm the
 *        gate for a repo that was already under it
 * @param {string|null} [opts.storeOverride] ADLC_TICKET_STORE / ADLC_TICKETS —
 *        the same override the rail guard resolves the ticket store through
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
  storeOverride = null,
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
  //
  // Everything below uses `repoRoot`, never the raw `root` pi supplied: the
  // deny store, the protected-path checks and the printed recovery command all
  // have to name the same repo, or a session in a subdirectory reads a
  // different store than the one denying it.
  // ONE walk accepting either a live `.adlc` or a remembered root, taking the
  // OUTERMOST match in this checkout — so a remembered root survives its
  // `.adlc` being deleted, and a `.adlc` the agent creates in a subdirectory
  // cannot outrank the repo it is trying to escape.
  const repoRoot = resolveAdlcRoot(root, storeOverride, adlcRoots);
  if (repoRoot === null) return { decision: 'allow' };
  if (adlcRoots && ticketStoreExists(repoRoot, storeOverride)) adlcRoots.record(repoRoot);

  const shell = isShellTool(toolName);
  // Extraction uses the cwd pi supplied, because a tool's relative path is
  // relative to the SESSION, not to the repo root the walk found. The
  // repo-relative form below is then taken against `repoRoot`, so a target in
  // `<repo>/src` is reported as `src/…` rather than `…`. No bypass rides on
  // this — every spelling of a protected path is denied either way (measured)
  // — but conflating the two roots misreports which file was touched.
  const targets = shell ? [] : editTargetsOf(input, root);
  const safeSessionId = isSafeSessionId(sessionId) ? sessionId : null;
  const key = typeof manifestKey === 'string' && manifestKey !== '' ? manifestKey : null;

  const result = evaluate({
    root: repoRoot,
    sessionId: safeSessionId,
    observed: observeHandoffSignals(usage),
    ticketId,
    editRelPaths: targets.map((p) => toRepoRelative(resolve(root, p), repoRoot)),
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
        root: repoRoot,
        reasons: result.reasons,
        hasManifestKey: key !== null,
      }),
  };
}
