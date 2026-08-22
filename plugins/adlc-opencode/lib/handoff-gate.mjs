// handoff-gate.mjs — OpenCode's context-rot handoff deny (slice 5 of
// docs/specs/context-rot-handoff.md). OpenCode is an ENFORCING tier: under the
// deny-set the agent loses structured edits AND the shell wholesale.
//
// D1-D3, the band thresholds, the protected-path list and the mutating-shell
// detector all come from `@adlc/context-handoff`. Unlike the hook-script
// harnesses, this plugin IS loaded by the host as an npm package, so it simply
// declares the dependency and imports it.
//
// Session identity is the host's own `input.sessionID`. The depth signal is the
// in-process tracker the build-gate backstop already maintains — OpenCode
// exposes no transcript file, so depth is the only signal available, and the
// OR-join ignores the kinds that are missing rather than reading them as zero.

import { relative, isAbsolute, resolve } from 'node:path';

import {
  evaluateHandoffPreToolUse,
  isHandoffMutatingShell,
} from '@adlc/context-handoff';

import { ticketStoreExists } from '@adlc/core';

import { READONLY_TOOLS, SHELL_TOOLS, extractTargets } from '../rails-checker.mjs';

/**
 * Tools the handoff deny-set applies to: everything that is not a known
 * read-only tool, shell included.
 *
 * Deliberately NOT honouring `ADLC_UNGATED_TOOLS` / `UNGATED_TOOLS`: those
 * exempt a tool from the RAIL check, which is a per-ticket path policy. The
 * deny-set is a session-level trust decision — a tool that cannot edit a rail
 * can still burn a rotted session's context — and the spec's only exits from it
 * are a signed resume-auth, a signed bypass, or host repair.
 *
 * @param {unknown} tool
 * @returns {boolean}
 */
export function handoffAppliesTo(tool) {
  const name = String(tool ?? '').toLowerCase();
  if (name === '') return false;
  return !READONLY_TOOLS.includes(name);
}

/** @param {unknown} tool */
export function isShellTool(tool) {
  return SHELL_TOOLS.includes(String(tool ?? '').toLowerCase());
}

/**
 * Every candidate target the deny-set should vet on a tool call.
 *
 * `extractTargets` is the rail checker's extractor and covers the shapes
 * OpenCode's OWN mutators use — `path`, `file`, `filePath`, `files[]`,
 * `edits[]`, apply_patch bodies. It does not read `target`/`targetPath`, which
 * third-party writers commonly use and which pi's equivalent extractor does
 * recognize, so a custom tool could name a protected artifact and reach the
 * handoff core with an empty path list.
 *
 * Widened here rather than in the rail checker: this is the deny-set's
 * always-on artifact protection, whereas extractTargets also drives per-ticket
 * rail policy whose behaviour is frozen. The rails-side gap is real but
 * separate.
 *
 * @param {object} args OpenCode tool args
 * @returns {string[]}
 */
export function handoffTargetsOf(args) {
  const out = new Set(extractTargets(args));
  for (const key of ['target', 'targetPath', 'target_path']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim() !== '') out.add(value);
  }
  return [...out];
}

/** Shell command text from OpenCode tool args. */
export function shellCommandOf(args) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return '';
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their own form. */
export function toRepoRelative(path, root) {
  const normalized = String(path).replaceAll('\\', '/');
  const absolute = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, absolute).replaceAll('\\', '/');
  return rel.startsWith('..') ? normalized : rel;
}

/**
 * The value grammar a session id must satisfy before it can be interpolated
 * into the copy-pasteable recovery command below. Same conservative set as the
 * codex hook's twin (RECOVERY_VALUE_RE): no whitespace, no quotes, no shell
 * metacharacters, so a host-supplied id can never smuggle a second command into
 * a string an operator is being invited to paste into a shell.
 */
const RECOVERY_VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;

/**
 * Paths are quoted, not grammar-checked, so their safe set is wider than a
 * session id's — but a literal apostrophe or a newline still cannot be
 * represented in a single-quoted shell word. Codex's twin, same reasoning.
 */
const RECOVERY_PATH_UNQUOTED_RE = /^[A-Za-z0-9_./=-]+$/;

/**
 * Module-private with one call site, which passes `${root}/.adlc` only after
 * checking root is a string — so `p` is always a non-empty string here. No
 * typeof/empty guard: it would be logic no test could ever observe.
 *
 * @param {string} p
 * @returns {string|null} null when the path cannot be safely displayed
 */
function quotePathForDisplay(p) {
  if (p.includes("'") || /[\r\n]/.test(p)) return null;
  return RECOVERY_PATH_UNQUOTED_RE.test(p) ? p : `'${p}'`;
}

/**
 * Every marker a deny names, and whether the store also holds one that cannot
 * be addressed by id at all.
 *
 * Not "the owner", singular: `mutation-gate.mjs` pushes one
 * `D3:unauthorized_open:<owner>` PER open record, so a store with several open
 * denies names several. Taking only the first told the operator to clear one
 * marker and left them denied by the rest. Verified against the real gate: a
 * depth-band self-deny reports BOTH `D2:denier_session` and
 * `D3:unauthorized_open:<self>`, so the session's own marker arrives as an
 * owner like any other and needs no special case.
 *
 * `D3:invalid_record:<label>` is deliberately NOT an owner. That label is the
 * session_id read off a record the gate just judged INVALID, so it is not a
 * binding a repair command may be pointed at; it flags a store an operator has
 * to look at directly.
 *
 * @param {string[]} reasons
 * @returns {{ owners: string[], invalid: boolean }}
 */
export function denyTargetsOf(reasons) {
  const OPEN = 'D3:unauthorized_open:';
  const INVALID = 'D3:invalid_record:';
  const owners = [];
  let invalid = false;
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (typeof reason !== 'string') continue;
    if (reason.startsWith(OPEN)) {
      const owner = reason.slice(OPEN.length);
      if (!owners.includes(owner)) owners.push(owner);
    } else if (reason.startsWith(INVALID)) {
      invalid = true;
    }
  }
  return { owners, invalid };
}

/**
 * The recovery tail every deny message carries: which session is denied, who
 * owns the deny, and the literal host-side commands that clear it. A deny with
 * none of that is what the release audit found — an agent told to "resume via
 * host" with no session id and no command, from inside a shell that is itself
 * denied.
 *
 * Built ENTIRELY from local code, deliberately: this is the codex hook's
 * round-5 reasoning (formatRecoveryCommand, adlc-handoff-gate.mjs) applied
 * here. The deny message is precisely what an operator reads when the handoff
 * machinery is misbehaving, so the diagnostic must not be rendered by the
 * machinery it is describing.
 *
 * The owner is held to the same value grammar as the session id, and for a
 * stronger reason: the session id comes from the host, but the owner is read
 * off a deny record on disk, so it is the less trusted of the two.
 *
 * @param {unknown} sessionId the session being denied
 * @param {string[]} [reasons] the gate's reason codes, source of the D3 owners
 * @param {string} [root] repo root, pinned into --dir so the command works from
 *        any cwd the operator happens to paste it into
 * @returns {string}
 */
export function recoveryTail(sessionId, reasons = [], root = undefined) {
  const { owners, invalid } = denyTargetsOf(reasons);
  const safeOwners = owners.filter((o) => RECOVERY_VALUE_RE.test(o));
  const droppedOwners = owners.length - safeOwners.length;
  const said = typeof sessionId === 'string' && RECOVERY_VALUE_RE.test(sessionId) ? sessionId : null;

  // An invalid record is not repairable by id, and an owner we cannot quote is
  // not printable at all. Either way the operator has to open the store.
  const storeNote =
    invalid || droppedOwners > 0
      ? ` The deny store also holds ${invalid ? 'a record the gate judged INVALID' : 'an owner id that cannot be safely printed'}, which no id-targeted command can clear — inspect .adlc/handoffs/denies/ on the host directly.`
      : '';

  // Fall back to this session's own id ONLY when the reasons named no owner at
  // all — then it is the only marker the deny could mean. When owners WERE
  // named but none survived quoting, falling back would point repair at a
  // session that owns no marker: the round-1 defect, re-entering through the
  // unsafe-owner door. Say what cannot be printed instead of guessing.
  const targets =
    safeOwners.length > 0 ? safeOwners : owners.length === 0 && said ? [said] : [];
  if (targets.length === 0) {
    // This branch already IS the whole explanation, so storeNote would only
    // repeat it.
    if (owners.length > 0 || invalid) {
      return (
        'The open deny cannot be addressed by a printed command: no owner id in the deny store can be ' +
        'rendered as a safe, copy-pasteable shell word. Read the owning id from .adlc/handoffs/denies/ ' +
        'on the host and run `adlc handoff` against it there. Read-only tools remain usable in the ' +
        'interim.'
      );
    }
    return (
      'No safe session id could be resolved for this session, so no session-specific recovery command ' +
      'can be printed. End this session and start a new one — the host mints a fresh session id, ' +
      'unaffected by this resolution failure. Read-only tools remain usable in the interim.'
    );
  }

  const whose = said === null
    ? `This session has no safe id of its own; the open deny belongs to session ${targets[0]}.`
    : targets[0] === said
      ? `Denied session id: ${said}.`
      : `Denied session id: ${said}; the open deny belongs to session ${targets[0]}.`;
  // Every open marker blocks, so clearing one is not recovery. Say so rather
  // than letting the operator run the sequence once and stay denied.
  const more =
    targets.length > 1
      ? ` ${targets.length} open denies are blocking this repo (${targets.join(', ')}) — repeat the sequence for each.`
      : '';
  return `${whose} ${recoverySteps(targets[0], root)}${more}${storeNote}`;
}

/**
 * The ordered recovery steps for one marker.
 *
 * `resume` FIRST, `repair` only as the fallback the CLI itself directs you to.
 * The reverse order — which this tail shipped at first — is destructive: a
 * marker that already carries a ticket and content hash is resumable as-is, and
 * `repair` REWRITES that binding, so prescribing it unconditionally can discard
 * a valid handoff checkpoint before the successor ever consumes it.
 *
 * The fallback condition names EVERY way resume declines, because the CLI has
 * three distinct refusals (bin/handoff.mjs runResume) — "final checkpoint
 * unavailable", "final content_hash is null" and "ticket_id is null" — and
 * repair answers all three: its own help is "refresh final AND bind", and it
 * rebuilds the final via buildFinal. Enumerating a subset strands operators
 * twice over. Naming only the unbound case missed the ordinary one, since every
 * marker this plugin writes carries a null content hash. Naming only the two
 * null-field cases then missed the bound-marker-with-missing-final case — and
 * worse, the old "never repair a bound marker" absolute actively steered them
 * away from the one command that fixes it. The rule is about ORDER, not about
 * the marker's bind state: never repair BEFORE resume has refused.
 *
 * `--dir` is pinned to the repo's own .adlc. Without it the CLI resolves the
 * store relative to the pasting shell's cwd, so a command run from anywhere
 * else operates on — or creates — a different store and exits 0 while the
 * denied repo stays denied. When the path cannot be rendered as a safe shell
 * word the flag is dropped and the operator is told to cd instead, which is
 * wrong-but-visible rather than silently pointed elsewhere.
 *
 * @param {string} target the session that OWNS the marker, already validated
 * @param {string} [root] repo root
 * @returns {string}
 */
function recoverySteps(target, root) {
  const dirDisplay = typeof root === 'string' ? quotePathForDisplay(`${root}/.adlc`) : null;
  const dir = dirDisplay === null ? '' : ` --dir ${dirDisplay}`;
  const cdNote =
    typeof root === 'string' && dirDisplay === null
      ? ' Run them from the repo root — its path cannot be printed as a safe shell word, so --dir is omitted and the CLI would otherwise resolve the store against your cwd.'
      : '';
  return (
    'Recover from a HOST shell (the agent shell is inside the deny-set): ' +
    `\`adlc handoff resume --session <new-session> --deny-session ${target}${dir} --write\`. ` +
    'If resume declines for ANY reason it names — an unbound deny (null ticket_id or null final ' +
    'content_hash) or a final checkpoint it cannot read — repair is the answer to all of them, ' +
    `because it refreshes the final AND rebinds: \`adlc handoff repair --session ${target} ` +
    `--ticket <id> --content-hash <hash>${dir} --write\`, then re-run resume. Repair rewrites an ` +
    'existing binding, so run it only AFTER resume has actually refused, never as the first move.' +
    cdNote
  );
}

/**
 * Per-session D1 memory. `processStickyDeny` is a per-call local inside the
 * gate, so a marker write that FAILED would deny one call and then fail open
 * once the band cooled. OpenCode runs in-process, so it can actually hold the
 * fact the spec asks callers to thread.
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
 * Evaluate the handoff deny-set for one tool call.
 *
 * @param {object} opts
 * @param {unknown} opts.tool
 * @param {object} [opts.args] mutable tool args (output.args)
 * @param {string|undefined} opts.sessionID
 * @param {{ depth: (id: string) => number }} [opts.tracker]
 * @param {string} opts.root
 * @param {object} [opts.env] supplies ADLC_MANIFEST_KEY so a signed resume-auth
 *        can be VERIFIED — without it `authorized()` can never accept one
 * @param {string|null|(() => string|null)} [opts.ticketId] the ticket the deny
 *        marker is bound to. May be a thunk: resolving it reads the ticket
 *        pointer, and the read-only hot path must not pay for a marker it will
 *        never write.
 * @param {ReturnType<typeof createStickyDenyState>} [opts.sticky]
 * @param {(o: object) => { deny: boolean, reasons: string[] }} [opts.evaluate]
 *        injection seam for tests; defaults to the package implementation
 * @returns {{ decision: 'allow'|'deny', reason?: string, reasons?: string[] }}
 */
export function checkHandoff({
  tool,
  args = {},
  sessionID,
  tracker,
  root,
  env = process.env,
  ticketId = null,
  sticky,
  evaluate = evaluateHandoffPreToolUse,
}) {
  // Containment, before anything else can evaluate or write: the deny-set has
  // no jurisdiction over a directory that never opted into ADLC. Without this
  // the depth band denied tool call 30 and every call after it in an ordinary
  // repo, and CREATED .adlc/.deny-store plus .adlc/handoffs/denies/<id>.json
  // there.
  //
  // The signal is a ticket store, NOT the bare existence of .adlc — the
  // sibling adapters' check. That difference is deliberate and is an upgrade
  // path: a directory contaminated by the very bug above HAS a .adlc, holding
  // nothing but the deny artifacts the old build wrote there. Keying on the
  // directory would let those artifacts vouch for themselves, so installing
  // the fix would leave exactly the bricked repos it exists to free — and
  // bricked past reach of the agent shell needed to clean them. `ticketStore
  // Exists` is this plugin's own definition of initialized (rails-checker.mjs
  // calls its absence "repo not ADLC-initialized"), so the deny-set and the
  // rail guard now agree on what an ADLC repo is instead of holding two.
  //
  // Checked against the caller's `root` — the value every other path in this
  // gate resolves against — never a re-derived cwd, or the guard and the writes
  // it is guarding could disagree about which repo is in play. A root that is
  // not a usable string is NOT containment: it means the caller is broken, and
  // that falls through to the evaluation path (which fails closed) rather than
  // buying an allow.
  if (typeof root === 'string' && root !== '') {
    const storeOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
    // The ticket store ALONE, with no additional `.adlc` clause. Requiring both
    // re-split the definition it was meant to unify: ADLC_TICKET_STORE may point
    // at an absolute external store, and resolveRailsInForce accepts that with
    // no local .adlc — so ANDing the directory left the rail guard enforcing
    // while the deny-set silently stood down. Contamination still cannot
    // self-authorize, because a directory holding only the old bug's
    // .deny-store and markers has no ticket store either way.
    if (!ticketStoreExists(root, storeOverride)) {
      return { decision: 'allow' };
    }
  }
  if (!handoffAppliesTo(tool)) return { decision: 'allow' };

  const shell = isShellTool(tool);
  const observed = {};
  if (tracker && typeof tracker.depth === 'function' && sessionID) {
    const depth = tracker.depth(sessionID);
    if (Number.isFinite(depth)) observed.depth = depth;
  }

  // An absent/blank sessionID is NOT an id: it must reach the gate as null so
  // the fail-closed-under-pressure path fires instead of silently passing.
  const sessionId = typeof sessionID === 'string' && sessionID !== '' ? sessionID : null;
  const manifestKey = env?.ADLC_MANIFEST_KEY;

  // Resolved here, past both guards, so the thunk form costs nothing on the
  // calls that never reach the gate. An unbound marker (ticket_id:null) is one
  // `adlc handoff repair`/`resume` refuses — the deny is written but the
  // operator has no way to clear it.
  const resolvedTicketId = typeof ticketId === 'function' ? ticketId() : ticketId;

  const result = evaluate({
    root,
    sessionId,
    observed,
    ticketId:
      typeof resolvedTicketId === 'string' && resolvedTicketId !== '' ? resolvedTicketId : null,
    editRelPaths: shell ? [] : handoffTargetsOf(args).map((p) => toRepoRelative(p, root)),
    isBash: shell,
    bashCommand: shell ? shellCommandOf(args) : '',
    host: 'opencode',
    manifestKey: typeof manifestKey === 'string' && manifestKey !== '' ? manifestKey : null,
    denyEverWritten: sticky ? sticky.has(sessionId) : false,
  });
  if (sticky) sticky.record(sessionId, result.denyEverWritten);

  if (!result.deny) return { decision: 'allow' };
  return {
    decision: 'deny',
    reasons: result.reasons,
    reason:
      `context-rot handoff deny (${result.reasons.join(', ')}). Resume via host ` +
      '`adlc handoff resume` / repair, or continue in a fresh session. Agent shell ' +
      `cannot clear the deny-set.\n\n${recoveryTail(sessionId, result.reasons, root)}`,
  };
}

export { isHandoffMutatingShell };
