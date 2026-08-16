import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Recovery Exception & Inspection Bash Exception (context-rot-threshold-
// calibration spec §1.3, Phase 0, AC0). Before any other Hard-Degraded/deny
// check, an invocation of the operator's own recovery CLI
// (`handoff.mjs bypass|unlock|repair|write|resume`), or a bare `pwd`, must be
// allowed regardless of band state — the original incident denied both, which
// turned one false positive into a total, un-self-recoverable lockout.
//
// This module is a pure, host-agnostic command-line matcher. Tool-identity
// gating (which `tool_name`s are even eligible to be checked here) is
// host-specific and lives in each adapter's own hook — Claude Code and Codex
// have materially different wire shapes (see each hook's own comments) — this
// module only judges the command-line STRING once a host has already decided
// the invocation is tool-identity-eligible.

/**
 * PATH_GRAMMAR: unquoted `[A-Za-z0-9_./=-]+`, OR a single-quoted `'...'` form
 * whose content is any byte except a literal single-quote, NUL, or newline
 * (POSIX single-quote semantics — fully literal, no escapes). Applies only to
 * the interpreter and script tokens (positions 1 and 2) — both are always
 * adapter-controlled, never attacker-chosen, so widening only these two
 * positions does not reopen the injection surface VALUE_GRAMMAR exists to
 * close.
 */
const PATH_UNQUOTED_RE = /^[A-Za-z0-9_./=-]+$/;

/**
 * VALUE_GRAMMAR: unquoted `[A-Za-z0-9_./=:-]+`. Applies to the subcommand
 * token and every flag/value token (third token onward). The colon is
 * included specifically so `unlock --started-at` can reproduce an ISO 8601
 * timestamp byte-for-byte.
 */
const VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;

const SUBCOMMANDS = ['bypass', 'unlock', 'repair', 'write', 'resume'];

/** Per-subcommand whitelisted flags, taken directly from the real CLI. */
const SUBCOMMAND_FLAGS = {
  bypass: { '--session': 'value', '--ticket': 'value', '--write': 'boolean', '--json': 'boolean' },
  unlock: {
    '--session': 'value',
    '--pid': 'value',
    '--started-at': 'value',
    '--host': 'value',
    '--nonce': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  repair: {
    '--session': 'value',
    '--ticket': 'value',
    '--content-hash': 'value',
    '--host': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  write: {
    '--session': 'value',
    '--ticket': 'value',
    '--host': 'value',
    '--content-hash': 'value',
    '--write': 'boolean',
    '--json': 'boolean',
  },
  resume: { '--session': 'value', '--deny-session': 'value', '--write': 'boolean', '--json': 'boolean' },
};

/**
 * Tokenize a command-line string. A raw CR or LF anywhere in the string —
 * including between two otherwise-valid-looking tokens — is an immediate,
 * unconditional non-match: a newline is a command separator to the shell
 * that eventually executes an allowed string, equivalent to `;`. Checked
 * BEFORE any tokenization, not folded into the tokenizer's own separator
 * handling.
 *
 * The only recognized separator, once that check has passed, is a single
 * ASCII space (0x20) — never a tab or any other whitespace, and a run of
 * multiple spaces is never collapsed: each one is its own separator, so two
 * consecutive spaces produce an empty token between them, which then fails
 * every grammar (both PATH_GRAMMAR and VALUE_GRAMMAR require at least one
 * character).
 *
 * A `'` starts a single-quoted span that is kept as part of the SAME token
 * (quotes included, verbatim) until the next `'` — POSIX literal semantics,
 * no escapes recognized inside. This is what lets a quoted interpreter/script
 * token legally contain a space. An unterminated quote is a non-match.
 *
 * @param {string} raw
 * @returns {string[]|null}
 */
function tokenize(raw) {
  if (typeof raw !== 'string') return null;
  if (/[\r\n]/.test(raw)) return null;
  const tokens = [];
  let cur = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (ch === ' ') {
      tokens.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === "'") {
      cur += ch;
      i += 1;
      let closed = false;
      while (i < n) {
        cur += raw[i];
        if (raw[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) return null; // unterminated quote → non-match
      // A real POSIX shell concatenates adjacent quoted spans after removing
      // every quote ('/a''b' → /ab). This tokenizer keeps quoted content
      // together with the token it's part of by design (a quoted path may
      // legally contain a space), but the ONLY way that stays equivalent to
      // what the shell actually executes is if the closing quote is
      // immediately followed by a token separator or end-of-string — never
      // by more content, quoted or not. Anything else (a second quote span
      // glued on with no space, or trailing unquoted characters) means the
      // shell's real parse and this parser's parse would diverge — reject
      // the WHOLE command outright rather than guess which interpretation
      // is correct.
      if (i < n && raw[i] !== ' ') return null;
      continue;
    }
    cur += ch;
    i += 1;
  }
  tokens.push(cur);
  return tokens;
}

/**
 * Resolve a PATH_GRAMMAR token (position 1 or 2 only) to its literal path
 * value, or null if the token does not satisfy PATH_GRAMMAR at all.
 * @param {string} token
 * @returns {string|null}
 */
function parsePathToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
    const inner = token.slice(1, -1);
    if (inner.includes('\0') || /[\r\n]/.test(inner)) return null;
    return inner;
  }
  if (PATH_UNQUOTED_RE.test(token)) return token;
  return null;
}

/**
 * Realpath-resolve a candidate path (freshly, at match time — never cached
 * across evaluations, closing the symlink-swap/TOCTOU window) and compare it
 * against the expected canonical path (also freshly resolved).
 * @param {string} candidatePath already-unquoted literal path
 * @param {string} expectedPath unresolved reference path (e.g. process.execPath)
 * @returns {boolean}
 */
function identityMatches(candidatePath, expectedPath) {
  if (typeof candidatePath !== 'string' || !candidatePath.startsWith('/')) return false;
  try {
    return realpathSync(candidatePath) === realpathSync(expectedPath);
  } catch {
    return false;
  }
}

/**
 * Match a command-line string against the Recovery Exception grammar.
 *
 * @param {string} commandText raw shell command line
 * @param {object} opts
 * @param {string} opts.interpreterPath adapter's own process.execPath (unresolved OK)
 * @param {string} opts.scriptPath adapter's own bin/handoff.mjs path (unresolved OK)
 * @param {string|null} opts.sessionId this session's own resolved session id, or null
 * @returns {{ matched: true, subcommand: string } | { matched: false }}
 */
export function matchRecoveryCommand(commandText, { interpreterPath, scriptPath, sessionId } = {}) {
  const NO_MATCH = { matched: false };
  const tokens = tokenize(commandText);
  if (!tokens || tokens.length < 3) return NO_MATCH;

  const [interpreterTok, scriptTok, subcommandTok, ...rest] = tokens;

  const interpreterCandidate = parsePathToken(interpreterTok);
  if (interpreterCandidate === null || !interpreterCandidate.startsWith('/')) return NO_MATCH;
  if (!identityMatches(interpreterCandidate, interpreterPath)) return NO_MATCH;

  const scriptCandidate = parsePathToken(scriptTok);
  if (scriptCandidate === null || !scriptCandidate.startsWith('/')) return NO_MATCH;
  if (!identityMatches(scriptCandidate, scriptPath)) return NO_MATCH;

  if (!VALUE_RE.test(subcommandTok) || !SUBCOMMANDS.includes(subcommandTok)) return NO_MATCH;
  const subcommand = subcommandTok;
  const flagSpec = SUBCOMMAND_FLAGS[subcommand];

  const seenFlags = new Set();
  let i = 0;
  while (i < rest.length) {
    const flagTok = rest[i];
    if (!flagTok.startsWith('--') || !VALUE_RE.test(flagTok)) return NO_MATCH;
    const kind = flagSpec[flagTok];
    if (kind === undefined) return NO_MATCH; // unknown flag for this subcommand
    if (seenFlags.has(flagTok)) return NO_MATCH; // duplicate flag
    seenFlags.add(flagTok);

    if (kind === 'boolean') {
      i += 1;
      continue;
    }

    // value-taking flag: exactly one following VALUE_GRAMMAR token that is
    // not itself a flag name.
    const valueTok = rest[i + 1];
    if (valueTok === undefined || !VALUE_RE.test(valueTok) || valueTok.startsWith('--')) return NO_MATCH;

    if (flagTok === '--session') {
      // Same-session binding: --session (in EVERY subcommand, including
      // resume's consumer-side --session) must equal this session's own
      // resolved identity exactly. --deny-session (resume only) is exempt —
      // its whole purpose is naming a DIFFERENT, prior session.
      if (typeof sessionId !== 'string' || sessionId.length === 0) return NO_MATCH;
      if (valueTok !== sessionId) return NO_MATCH;
    }

    i += 2;
  }

  // Round-5 review: the per-flag check above only enforces same-session
  // binding WHEN --session is present — a command that omits --session
  // entirely (e.g. a bare `bypass`) matched unconditionally regardless of
  // sessionId, evading the binding it exists to enforce. Every subcommand's
  // flag spec allows --session, so requiring it here (unconditionally, not
  // just for the subcommands that happen to declare it) closes that gap
  // without special-casing any one subcommand.
  if (!seenFlags.has('--session')) return NO_MATCH;

  return { matched: true, subcommand };
}

/**
 * Inspection Bash Exception: the exact literal command `pwd`, nothing else —
 * no arguments, no shell metacharacters, no chaining, no trailing/leading
 * whitespace, no newline. Deliberately narrow: this is not a general
 * "safe commands" allowlist.
 * @param {unknown} commandText
 * @returns {boolean}
 */
export function isBareInspectionPwd(commandText) {
  if (typeof commandText !== 'string') return false;
  return commandText === 'pwd';
}

/**
 * Quote a path token exactly the way the matcher above requires it, iff
 * needed — or null when the path cannot be represented at all. A path
 * containing a literal single-quote cannot be quoted safely: the matcher's
 * own PATH_GRAMMAR excludes an embedded apostrophe from a quoted span's
 * content (recovery-exception.mjs's `parsePathToken`), so a path containing
 * one is already unusable by the matcher — printing `'` + path + `'` for
 * such a path would terminate the quote early and let everything after the
 * embedded apostrophe be interpreted as a second, attacker-influenced shell
 * command by anyone who copy-pastes the diagnostic. A CR/LF is rejected for
 * the same reason `matchRecoveryCommand`'s own tokenizer rejects one
 * anywhere in the command line.
 * @param {string} p
 * @returns {string|null}
 */
function quotePathForDisplay(p) {
  if (typeof p !== 'string' || p.includes("'") || /[\r\n]/.test(p)) return null;
  return PATH_UNQUOTED_RE.test(p) ? p : `'${p}'`;
}

/**
 * The diagnostic used when a resolved path cannot be safely represented in a
 * copy-pasteable shell command (see `quotePathForDisplay`). Plain descriptive
 * text, not a command — the raw paths are safe to include here precisely
 * because this string is never meant to be executed.
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string }} opts
 * @returns {string}
 */
export function formatUnsafeInstallPathMessage({ interpreterPath, scriptPath, sessionId }) {
  return (
    'The recovery command cannot be printed as a safe, copy-pasteable shell command: the resolved install ' +
    'path contains a character (a literal apostrophe or a newline) that cannot be represented in one. Run ' +
    `the operator recovery CLI manually — interpreter at ${interpreterPath}, script at ${scriptPath}, ` +
    `subcommand "bypass --session ${sessionId} --write". \`pwd\` remains usable in the interim.`
  );
}

/**
 * Build the literal, copy-pasteable, cwd-independent recovery command for a
 * diagnostic message. Both paths MUST already be the adapter's own
 * realpath-resolved absolute paths — this function only handles display
 * quoting, not resolution.
 *
 * `sessionId` is validated against VALUE_GRAMMAR before being interpolated —
 * deliberately NOT reusing `isSafeSessionId` (deny-marker.mjs), which guards
 * a DIFFERENT property (path-traversal safety for use as a filename
 * component under `.adlc/handoffs/denies/`) and accepts characters
 * VALUE_GRAMMAR does not, including `;`, spaces, and `#`. A session id can
 * pass `isSafeSessionId` and still be attacker-influenced host payload data
 * (unlike `interpreterPath`/`scriptPath`, which are always adapter-derived,
 * never host input) — interpolating it unquoted into a string an operator is
 * instructed to copy-paste into a real shell would let it inject an
 * arbitrary second command. When the session id fails VALUE_GRAMMAR, this
 * degrades to the same no-safe-session-id message as when no session id
 * resolved at all — matchRecoveryCommand's own same-session binding would
 * reject such an id anyway (no valid command-line token could equal it), so
 * the recovery command is already unusable for it; the diagnostic must not
 * pretend otherwise. When either path cannot be safely quoted (see
 * `quotePathForDisplay`), this degrades to `formatUnsafeInstallPathMessage`
 * instead of ever emitting a broken/injectable command string.
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string }} opts
 * @returns {string}
 */
export function formatRecoveryCommand({ interpreterPath, scriptPath, sessionId }) {
  if (typeof sessionId !== 'string' || !VALUE_RE.test(sessionId)) {
    return formatNoSessionIdMessage();
  }
  const interpreterDisplay = quotePathForDisplay(interpreterPath);
  const scriptDisplay = quotePathForDisplay(scriptPath);
  if (interpreterDisplay === null || scriptDisplay === null) {
    return formatUnsafeInstallPathMessage({ interpreterPath, scriptPath, sessionId });
  }
  return `${interpreterDisplay} ${scriptDisplay} bypass --session ${sessionId} --write`;
}

/**
 * The no-safe-session-id diagnostic (spec §1.3): when no candidate session id
 * resolves at all, no `--session`-bearing recovery command can be built for
 * ANY grammar. This message replaces the recovery-command contract entirely —
 * it must never be combined with `formatRecoveryCommand`'s output.
 * @returns {string}
 */
export function formatNoSessionIdMessage() {
  return (
    'No session id could be resolved for this session, so no session-specific recovery command can be ' +
    'printed. End this session and start a new one — the host will mint a fresh session id, unaffected by ' +
    'this resolution failure. In the interim, `pwd` remains usable.'
  );
}

export { SUBCOMMANDS, SUBCOMMAND_FLAGS };

/**
 * This package's own bin/handoff.mjs, resolved from THIS module's own
 * location (not from process.cwd() or any tool-supplied path) — so both
 * adapters can pass a single, package-owned value as `scriptPath` above
 * without each re-deriving it. Not realpath-resolved here; the matcher
 * resolves both sides freshly at match time.
 */
export const RECOVERY_CLI_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'handoff.mjs');
