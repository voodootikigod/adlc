// Claude Code payload readers for the context-handoff PreToolUse mode.
//
// The gate itself — D1-D3, the deny-set, `evaluateHandoffPreToolUse` — lives in
// `@adlc/context-handoff` (lib/adapter.mjs) and is reached through the
// dynamically-loaded `api` namespace, never a static import: an unresolvable
// package must fail closed for the `handoff` mode alone, not crash every hook
// mode at module load.
//
// KEEP IN SYNC — `resolveSessionId` and `isProtectedHandoffPath` below are
// behavioural twins of the package's `resolveHandoffSessionId` /
// `isProtectedHandoffPath`. They stay here because this module cannot resolve
// the package synchronously (the plugin install dir has no workspace
// node_modules, and Node 18 cannot `require()` an ESM package), while the
// slice-4 contract test drives them synchronously off this module. The two
// implementations are pinned by
// packages/context-handoff/adapter-test/cc-helper-drift.test.mjs; the hook's
// real decisions run through the package copy, not these.
//
// KEEP IN SYNC (3) — `readVerifiedBypassGrant` below (with its sorted-key
// payload stringify standing in for `@adlc/core`'s `canonicalJson` and its
// local `BYPASS_GRANT_SCHEMA` / `BYPASS_GRANT_TTL_MS` constants) is a
// behavioural twin of `@adlc/context-handoff`'s `readBypassGrant`
// (lib/bypass-grant.mjs).
// It exists for the same trust-boundary reason as the pair above, sharpened:
// verifying a bypass grant requires ADLC_MANIFEST_KEY, and the key must NEVER
// reach the project-resolved package (a hostile repo shipping its own
// @adlc/context-handoff would gain the manifest trust anchor). So the HOOK
// verifies the grant here — trusted code, key read pre-scrub — and passes only
// the verdict (`verifiedBypassGrant`) into `evaluateHandoffPreToolUse`. One
// deliberate divergence: on an unsafe session id this returns null where the
// canonical asserts/throws (the hook must never crash on hostile input); the
// hook only calls it with `resolveSessionId` output, which is safe by
// construction. Pinned by
// packages/context-handoff/adapter-test/cc-helper-drift.test.mjs.
//
// KEEP IN SYNC (2) — `isBareInspectionPwd` / `matchRecoveryCommand` /
// `formatRecoveryCommand` / `formatNoSessionIdMessage` /
// `formatUnsafeInstallPathMessage` below are behavioural twins of
// `@adlc/context-handoff`'s `recovery-exception.mjs` exports of the same
// names. They stay here for a DIFFERENT, stronger reason than the pair
// above: these gate (and diagnose) the Recovery Exception & Inspection Bash
// Exception (spec §1.3, AC0) — the operator's own escape hatch out of a
// Hard-Degraded session, including a session where the package itself failed
// to load or is missing required exports (a stale/incompatible install, or a
// malicious project-resolved package). If that check — or the diagnostic
// text every Hard-Degraded/deny message must print (spec §1.3) — depended on
// `await loadContextHandoff()` succeeding, a broken/hostile package would
// deny `pwd` and the recovery CLI before ever reaching the exception, AND
// leave the operator with a diagnostic that names no real, copy-pasteable
// command (Round-5 review) — reproducing the exact total-lockout bug this
// hotfix exists to close, just triggered by package health instead of
// scan-threshold miscalibration. These copies MUST need nothing beyond what
// this file (or a pure, execution-free path resolution via
// `resolveContextHandoffEntry`) can already provide. Pinned by
// packages/context-handoff/adapter-test/cc-helper-drift.test.mjs.

import { basename, extname, join } from 'node:path';
import { readFileSync, realpathSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session identity for deny markers / D2.
 *
 * Source order (first usable wins):
 * 1. `input.session_id` (Claude Code hook payload)
 * 2. `input.sessionId`
 * 3. basename of `transcript_path` without extension (uuid.jsonl → uuid)
 *
 * @param {object} input
 * @param {{ isSafeSessionId: (id: unknown) => boolean }} api
 * @returns {string|null}
 */
export function resolveSessionId(input, { isSafeSessionId }) {
  const candidates = [];
  if (input && typeof input === 'object') {
    candidates.push(input.session_id, input.sessionId);
    const tp = input.transcript_path;
    if (typeof tp === 'string') {
      if (tp !== '') {
        const base = basename(tp);
        const stem = base.slice(0, base.length - extname(base).length);
        candidates.push(stem);
      }
    }
  }
  for (const c of candidates) {
    if (isSafeSessionId(c)) return c;
  }
  return null;
}

/**
 * Repo-relative path is a handoff trust-root artifact agents must not Write.
 * @param {string} rel forward-slashed repo-relative path
 * @returns {boolean}
 */
export function isProtectedHandoffPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  // Collapse . / .. and separators; keep as repo-relative (no leading /).
  const norm = rel
    .replace(/\\/g, '/')
    .split('/')
    .reduce((acc, part) => {
      if (part === '' || part === '.') return acc;
      if (part === '..') {
        acc.pop();
        return acc;
      }
      acc.push(part);
      return acc;
    }, [])
    .join('/');
  if (norm === '.adlc/.deny-store' || norm === '.adlc/handoffs/.deny-store') return true;
  if (norm === '.adlc/handoffs/denies' || norm.startsWith('.adlc/handoffs/denies/')) return true;
  if (!norm.startsWith('.adlc/handoffs/')) return false;
  const leaf = basename(norm);
  return (
    leaf.endsWith('.resume-auth.json') ||
    leaf.endsWith('.model-ok') ||
    leaf.endsWith('.lock') ||
    leaf.endsWith('.bypass-grant.json')
  );
}

// Twin of `@adlc/context-handoff`'s BYPASS_GRANT_SCHEMA / BYPASS_GRANT_TTL_MS
// (lib/bypass-grant.mjs, lib/thresholds.mjs) — see "KEEP IN SYNC (3)".
const BYPASS_GRANT_SCHEMA = 2;
const BYPASS_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_BYPASS_GRANT_BYTES = 4096;

/**
 * Twin of `@adlc/context-handoff`'s `readBypassGrant` — see "KEEP IN SYNC (3)".
 * Reads and verifies `.adlc/handoffs/<sessionId>.bypass-grant.json` entirely
 * with this file's own trusted code. Returns the canonical read shape
 * (`verified` reflects the HMAC check under `key`), or null when the grant is
 * absent, malformed, schema-mismatched, session-mismatched, expired, or the
 * session id is unsafe.
 *
 * @param {string} root repo root
 * @param {string|null} sessionId
 * @param {{ key?: string|null, now?: () => number }} [opts]
 * @returns {{ session_id: string, unbound_reason: string|null, written_at: string, verified: boolean } | null}
 */
export function readVerifiedBypassGrant(root, sessionId, { key = null, now = () => Date.now() } = {}) {
  if (!isSafeSessionId(sessionId)) return null;
  const path = join(root, '.adlc', 'handoffs', `${sessionId}.bypass-grant.json`);
  // Round-17 review: a separate lstat-then-readFileSync(path) had a TOCTOU —
  // a concurrent writer could swap the checked regular file for a FIFO or
  // oversized file between the two path-based operations. Opening ONCE
  // (O_NOFOLLOW so a symlink at this exact path throws ELOOP rather than
  // being followed; O_NONBLOCK so a FIFO/device swapped in can't hang this
  // OPEN either) and doing every subsequent check/read against that SAME fd
  // closes the window entirely. See @adlc/context-handoff's readBypassGrant
  // (bypass-grant.mjs) for the canonical twin this mirrors.
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let doc;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYPASS_GRANT_BYTES) return null;
    doc = JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc.schema !== BYPASS_GRANT_SCHEMA) return null;
  const session_id = doc.session_id;
  const unbound_reason = doc.unbound_reason ?? null;
  const written_at = doc.written_at;
  if (typeof session_id !== 'string' || session_id !== sessionId) return null;
  if (unbound_reason !== null && typeof unbound_reason !== 'string') return null;
  if (typeof written_at !== 'string') return null;
  const writtenMs = Date.parse(written_at);
  if (!Number.isFinite(writtenMs)) return null;
  if (now() - writtenMs > BYPASS_GRANT_TTL_MS) return null;
  let verified = false;
  if (typeof key === 'string' && key.length > 0 && typeof doc.sig === 'string' && doc.sig.length > 0) {
    // Keys listed in canonical (sorted) order, so this plain stringify equals
    // `@adlc/core`'s canonicalJson for this flat, primitive-valued payload —
    // the payload shape is fixed by BYPASS_GRANT_SCHEMA, so the general
    // recursive canonicalizer would be dead generality here. The drift pin
    // (cc-helper-drift.test.mjs) catches any divergence from the canonical
    // signer, including a future payload change that breaks this equality.
    const expected = createHmac('sha256', key)
      .update(JSON.stringify({ schema: BYPASS_GRANT_SCHEMA, session_id, unbound_reason, written_at }))
      .digest('hex');
    const a = Buffer.from(doc.sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    verified = a.length === b.length && timingSafeEqual(a, b);
  }
  return { session_id, unbound_reason, written_at, verified };
}

/**
 * Bash tool command string from a PreToolUse payload.
 * @param {object} input
 * @returns {string}
 */
export function bashCommandFromInput(input) {
  const ti = input?.tool_input ?? input?.parameters ?? {};
  if (typeof ti.command === 'string') return ti.command;
  if (typeof ti.cmd === 'string') return ti.cmd;
  return '';
}

// --- Recovery Exception & Inspection Bash Exception (trusted local copy) ---
// Verbatim twin of packages/context-handoff/lib/recovery-exception.mjs — see
// the file-header "KEEP IN SYNC (2)" note for why this copy exists. Any
// change there must be mirrored here (and in the Codex hook's own copy).

const PATH_UNQUOTED_RE = /^[A-Za-z0-9_./=-]+$/;
const VALUE_RE = /^[A-Za-z0-9_./=:-]+$/;
const SUBCOMMANDS = ['bypass', 'unlock', 'repair', 'write', 'resume'];
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
      if (!closed) return null;
      // A real POSIX shell concatenates adjacent quoted spans after removing
      // every quote ('/a''b' → /ab). The only way this parser stays
      // equivalent to what the shell actually executes is if the closing
      // quote is immediately followed by a separator or end-of-string —
      // never by more content, quoted or not. Reject the WHOLE command
      // outright rather than guess which interpretation is correct.
      if (i < n && raw[i] !== ' ') return null;
      continue;
    }
    cur += ch;
    i += 1;
  }
  tokens.push(cur);
  return tokens;
}

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

function identityMatches(candidatePath, expectedPath) {
  if (typeof candidatePath !== 'string' || !candidatePath.startsWith('/')) return false;
  try {
    return realpathSync(candidatePath) === realpathSync(expectedPath);
  } catch {
    return false;
  }
}

/**
 * @param {string} commandText
 * @param {{ interpreterPath: string, scriptPath: string, sessionId: string|null }} opts
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
    if (kind === undefined) return NO_MATCH;
    if (seenFlags.has(flagTok)) return NO_MATCH;
    seenFlags.add(flagTok);

    if (kind === 'boolean') {
      i += 1;
      continue;
    }

    const valueTok = rest[i + 1];
    if (valueTok === undefined || !VALUE_RE.test(valueTok) || valueTok.startsWith('--')) return NO_MATCH;

    if (flagTok === '--session') {
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
 * @param {unknown} commandText
 * @returns {boolean}
 */
export function isBareInspectionPwd(commandText) {
  if (typeof commandText !== 'string') return false;
  return commandText === 'pwd';
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `quotePathForDisplay` — see
 * that function's comment (recovery-exception.mjs) for why a literal
 * apostrophe or CR/LF cannot be safely represented.
 * @param {string} p
 * @returns {string|null}
 */
function quotePathForDisplay(p) {
  if (typeof p !== 'string' || p.includes("'") || /[\r\n]/.test(p)) return null;
  return PATH_UNQUOTED_RE.test(p) ? p : `'${p}'`;
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `formatUnsafeInstallPathMessage`.
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
 * Trusted local twin of `@adlc/context-handoff`'s `formatNoSessionIdMessage`.
 * @returns {string}
 */
export function formatNoSessionIdMessage() {
  return (
    'No session id could be resolved for this session, so no session-specific recovery command can be ' +
    'printed. End this session and start a new one — the host will mint a fresh session id, unaffected by ' +
    'this resolution failure. In the interim, `pwd` remains usable.'
  );
}

/**
 * Trusted local twin of `@adlc/context-handoff`'s `formatRecoveryCommand` —
 * see that function's comment (recovery-exception.mjs) for the full
 * injection-safety rationale (session-id VALUE_GRAMMAR validation, per-path
 * quoting, degrade-don't-break on an unsafe install path).
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
 * Trusted local twin of `@adlc/context-handoff`'s `isSafeSessionId`
 * (deny-marker.mjs) — needed so `resolveSessionId` above can run before the
 * package is loaded, which the Recovery/Inspection Exception check requires
 * (see the "KEEP IN SYNC (2)" note). Same rules: non-empty, no leading/
 * trailing whitespace, no path separators or `..`, and `basename(id) === id`
 * so a session id can never escape `.adlc/handoffs/denies/`.
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (sessionId.trim().length === 0 || sessionId.trim() !== sessionId) return false;
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return false;
  if (basename(sessionId) !== sessionId) return false;
  return true;
}
