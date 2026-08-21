#!/usr/bin/env node
// ADLC hooks — one helper, five modes:
//   preflight  (SessionStart)  → environment readiness before fan-out  [advisory]
//   flail      (PostToolUse)    → flail-detection over the transcript    [advisory]
//   manifest   (Stop)           → gate-evidence chain integrity audit    [advisory]
//   review     (Stop)           → mechanical adversarial-review trigger  [advisory by
//                                  default; opt-in BLOCKING via
//                                  ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1 — see review()]
//   rails      (PreToolUse)     → block edits to frozen rail paths        [ENFORCING]
//   buildgate  (PreToolUse)     → fitness-to-build gate (issue #48)        [ENFORCING]
//   handoff    (PreToolUse)     → context-rot deny/handoff (D1–D3)         [ENFORCING]
//   handoffstart (SessionStart) → continuation context / operator one-liner [advisory]
//
// CONTRACT: preflight/flail/manifest must NEVER block and stay SILENT unless
// there is something to flag. `rails`, `buildgate`, and `handoff` are the
// unconditional enforcement hooks — each can DENY an Edit/Write/Bash (via a
// permissionDecision in its JSON output, not via exit code, though exit 2 is
// also set as a fail-closed belt-and-suspenders). `review` is advisory by
// default (systemMessage only) and only blocks (Stop `decision: "block"`,
// forcing the session to continue rather than end) when the operator has
// explicitly opted in — see review()'s own comment for the rationale. Advisory
// modes still ALWAYS exit 0 on the allow path and never surface their own
// errors; if the toolkit isn't installed or the repo isn't ADLC-initialized,
// every mode no-ops. Enforcing gates are themselves a no-op until a ticket
// declares `rails` paths / an active high-risk ticket / a handoff deny-store
// (or handoff band) applies — so installing the plugin can't brick a clean repo.
//
// `buildgate`'s core decision (risk-tier derivation, the depth/session-bytes
// context-fitness signal, and the allow/deny decision) is computed ENTIRELY
// LOCALLY in this file — it does not shell out to `adlc` for the decision,
// mirroring how `rails` never needs `adlc` for its own core decision either.
// `adlc` (via gate-manifest) is used ONLY to durably record an audited
// override, exactly like rails' ADLC_RAILS_BYPASS. The toolkit package
// @adlc/build-gate is the canonical source of this logic (reusable by other
// harnesses per issue #48's Path A); the copies here are verbatim ports
// marked "KEEP IN SYNC", the same convention already used for globMatch.
//
// Output: when there is something to say, print ONE JSON object using fields
// Claude Code recognizes (`systemMessage`; `hookSpecificOutput.additionalContext`
// for SessionStart; `hookSpecificOutput.permissionDecision` for PreToolUse;
// top-level `decision`/`reason` for Stop).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  lstatSync,
  chmodSync,
  rmSync,
  realpathSync,
  readlinkSync,
  statSync,
  opendirSync,
} from 'node:fs';
import { join, relative, resolve, dirname, basename, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';
import { loadContextHandoff, resolveContextHandoffEntry } from './handoff-resolve.mjs';
import {
  resolveSessionId,
  bashCommandFromInput,
  isBareInspectionPwd,
  matchRecoveryCommand,
  isSafeSessionId,
  formatRecoveryCommand,
  formatNoSessionIdMessage,
  readVerifiedBypassGrant,
  CAPTURE_INSTRUCTION,
} from './handoff-gate.mjs';

const MODE = process.argv[2];

/** Symlink-resolved form of a path, or the path itself when unresolvable.
 *  Used to compare a walked ancestor against `$HOME` when either side may be
 *  reached through a symlink (`/home/x` → `/mnt/users/x`). */
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** True when `child` IS `parent` or sits underneath it (symlink-resolved). */
function isInside(child, parent) {
  const rel = relative(realOrSelf(parent), realOrSelf(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The tool's invocation directory (where relative `file_path`s are anchored),
// captured BEFORE we walk up to the repo root. Relative edit targets must resolve
// against this, not the walked-up cwd, or `secret.js` from `src/` would resolve
// to repo-root `secret.js` and dodge the `src/**` rail.
let baseDir = null;

// Round-5 review: the top-level crash handler (below, wrapping `await main()`)
// cannot see `main()`'s local `input`, so an unexpected error before/around
// it previously denied with no recovery command at all — the same
// recovery-message-invariant gap failClosedHandoffEnter had. Set as early as
// possible inside main() (best-effort; never throws), so the crash handler
// can still append a real, session-bound recoveryDiagnostic when the crash
// happens after session identity was resolvable.
let lastKnownSessionId = null;

// Flail detection only needs the RECENT window of a session — flailing is a
// "looping right now" signal, not a whole-history property. Cap the scan so a
// long session's growing transcript can never turn this synchronous PostToolUse
// hook into a repeated full-history reparse.
const MAX_SCAN_BYTES = 256 * 1024;

/**
 * Read the hook payload from stdin (fd 0). The payload is a single JSON object
 * and must be read whole — byte-capping truncates it unparseable. `readFileSync`
 * is the right primitive: it reads to EOF without busy-spinning, and on a
 * nonblocking-fd EAGAIN it throws once (caught here → no-op) rather than looping.
 * Manual chunked reads were tried and rejected: a mid-stream byte cap regressed
 * JSON parsing, and an EAGAIN retry loop could spin. The payload is the user's
 * own session data (not an untrusted-size input); the bounding that matters —
 * the transcript scan — is handled by MAX_SCAN_BYTES. Never throws.
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Print one advisory JSON object. Caller then exits 0. */
function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch {
    /* ignore — advisory output is best-effort */
  }
}

/**
 * Run an ADLC toolkit command via the `adlc` umbrella dispatcher. `args` are
 * the subcommand and its arguments (e.g. ['preflight', '--json'],
 * ['gate-manifest', 'verify', '--json']). Routes through the single `adlc`
 * binary that `npm install -g @adlc/cli` provides, so individual package bins
 * do NOT need to be installed separately.
 *
 * Returns the spawn result, or null when `adlc` is not on PATH (ENOENT) —
 * the signal to no-op rather than error.
 */
function runAdlc(args) {
  const r = spawnSync('adlc', args, { encoding: 'utf8' });
  if (r.error) return null;
  return r;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const parsed = parseJson(readStdin());
  // The enforcing rails/buildgate hooks must FAIL CLOSED if they cannot even
  // read/parse their own input (empty stdin, malformed JSON) — they cannot
  // verify rails or the fitness-to-build gate. Advisory modes tolerate a
  // missing payload and no-op.
  if (MODE === 'rails' && parsed === null) {
    denyRail('rails hook received unreadable/malformed input — failing closed');
    return; // unreachable: denyRail exits 2
  }
  if (MODE === 'buildgate' && parsed === null) {
    denyBuildGate('build-gate hook received unreadable/malformed input — failing closed');
    return; // unreachable: denyBuildGate exits 2
  }
  if (MODE === 'handoff' && parsed === null) {
    denyHandoff('handoff hook received unreadable/malformed input — failing closed');
    return; // unreachable: denyHandoff exits non-zero
  }
  const input = parsed ?? {};
  try {
    lastKnownSessionId = resolveSessionId(input, { isSafeSessionId });
  } catch {
    /* best-effort only — see lastKnownSessionId's declaration comment */
  }

  // Recovery Exception & Inspection Bash Exception (spec §1.3) — attempted
  // HERE, before either of the two `chdir` calls below, using whatever
  // `process.cwd()` this process started with. See
  // tryRecoveryOrInspectionException's own comment for why: both chdirs can
  // fail closed via failClosedHandoffEnter, which would otherwise deny
  // `pwd`/recovery before `handoff()` (which re-attempts this same check)
  // ever runs. A no-match here is expected and harmless for every OTHER
  // mode/tool call — normal flow continues unchanged.
  if (MODE === 'handoff' && tryRecoveryOrInspectionException(input)) return;

  // The base for resolving RELATIVE edit targets is the TOOL's working directory
  // (`input.cwd`), captured BEFORE any chdir. It must NOT be CLAUDE_PROJECT_DIR:
  // the tool may run in a subdir while CLAUDE_PROJECT_DIR points at the repo root,
  // and `file_path: "secret.js"` is relative to the tool's cwd, not the root.
  baseDir = typeof input.cwd === 'string' && input.cwd.length > 0 ? resolve(input.cwd) : process.cwd();

  // Operate in the project root so the tools resolve `.adlc/` correctly.
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try {
    process.chdir(dir);
  } catch {
    // The enforcing rails/buildgate hooks must FAIL CLOSED if they can't even
    // enter the project dir (they cannot verify rails or the build gate).
    // Advisory modes just no-op.
    if (MODE === 'rails') {
      try {
        denyRail('rails hook could not enter the project directory — failing closed');
      } catch {
        /* deny emit failed; the exit 2 below still blocks */
      }
      process.exit(2);
    }
    if (MODE === 'buildgate') {
      try {
        denyBuildGate('build-gate hook could not enter the project directory — failing closed');
      } catch {
        /* deny emit failed; the exit 2 below still blocks */
      }
      process.exit(2);
    }
    if (['handoff'].includes(MODE)) {
      failClosedHandoffEnter('could not enter the project directory', input);
    }
    return;
  }

  // The starting dir may be a SUBDIRECTORY of the repo (CLAUDE_PROJECT_DIR unset,
  // cwd = src/). Find the ADLC root and operate there, so a frozen-rail edit can't
  // slip past just because the hook ran from a subdir (which would otherwise find
  // no store and no-op = fail open). Anchor to the GIT ROOT first so a nested
  // store in a subdirectory can't shadow the repo-wide config; only fall back
  // to the nearest-ancestor ADLC root when there is no enclosing git repo.
  //
  // TWO independent guards keep this walk inside the user's project.
  //
  // 1. The marker is a TICKET STORE, never a bare `.adlc/` directory. Plugins
  //    keep user-scoped state outside any repo, and installs predating that
  //    convention left a stale `~/.adlc/` behind. Accepting a bare directory
  //    meant an ordinary non-ADLC repo under `$HOME` found `gitRoot` (no store),
  //    fell through to the `$HOME` ancestor, and `chdir`'d THERE — escaping the
  //    user's repo and resolving every later rail path against `$HOME`.
  // 2. `$HOME` is examined only when it is plausibly a project in its own right.
  //    Guard 1 alone still lets a ticket store that lands at `~/.adlc/tickets.json`
  //    (e.g. a scaffolder run from the wrong directory) capture every repo below
  //    it. `$HOME` therefore counts only when it is where we STARTED (you are
  //    working in it directly) or when it is itself a git repo — i.e. a real
  //    dotfiles repo, which must keep enforcing its rails from its own
  //    subdirectories. A `$HOME` that merely CONTAINS a stray `.adlc` matches
  //    neither and is skipped. The walk never continues ABOVE `$HOME`.
  const homeDir = realOrSelf(homedir());
  const startDir = realOrSelf(process.cwd());
  let adlcRoot = null;
  let gitRoot = null;
  for (let cur = process.cwd(), i = 0; i < 256; i++) {
    const real = realOrSelf(cur);
    const atHome = real === homeDir;
    const examine = !atHome || real === startDir || existsSync(join(cur, '.git'));
    if (examine) {
      if (gitRoot === null && existsSync(join(cur, '.git'))) gitRoot = cur;
      if (adlcRoot === null && ticketStoreExists(cur, process.env)) adlcRoot = cur;
    }
    const parent = dirname(cur);
    if (parent === cur || atHome) break; // filesystem root, or never ascend above $HOME
    cur = parent;
  }
  // Prefer the store at the git root; else the nearest-ancestor ADLC root — but
  // NEVER one that sits OUTSIDE the enclosing git repo. The fallback previously
  // applied even when a gitRoot was found, so a store in any ancestor above a
  // non-ADLC repo (`~/work/.adlc` over `~/work/my-repo`) captured that repo and
  // chdir'd out of it. That is the same escape the $HOME guard blocks, one level
  // down, and it contradicted this walk's own contract ("only fall back … when
  // there is no enclosing git repo"). A store at or BELOW the git root is still
  // honored, so a package-level store in a monorepo keeps working.
  const root = gitRoot && ticketStoreExists(gitRoot, process.env)
    ? gitRoot
    : (adlcRoot && (!gitRoot || isInside(adlcRoot, gitRoot)) ? adlcRoot : null);
  if (root) {
    try {
      process.chdir(root);
    } catch {
      // Found the ADLC root but can't enter it → can't verify rails/build-gate → fail closed.
      if (MODE === 'rails') {
        try {
          denyRail('rails hook found the ADLC root but could not enter it — failing closed');
        } catch {
          /* exit 2 below still blocks */
        }
        process.exit(2);
      }
      if (MODE === 'buildgate') {
        try {
          denyBuildGate('build-gate hook found the ADLC root but could not enter it — failing closed');
        } catch {
          /* exit 2 below still blocks */
        }
        process.exit(2);
      }
      if (['handoff'].includes(MODE)) {
        failClosedHandoffEnter('found the ADLC root but could not enter it', input);
      }
      return;
    }
  }

  if (MODE === 'preflight') return preflight();
  if (MODE === 'context') return context(input);
  if (MODE === 'flail') return flail(input);
  if (MODE === 'manifest') return manifest();
  if (MODE === 'review') return review(input);
  if (MODE === 'rails') return rails(input);
  if (MODE === 'buildgate') return buildgate(input);
  if (MODE === 'handoff') return await handoff(input);
  if (MODE === 'handoffstart') return await handoffStart(input);
  // unknown mode → no-op
}

// SessionStart/PreCompact/PostCompact/SubagentStart/SubagentStop — re-inject the
// active-ticket summary so a compaction or subagent boundary doesn't silently
// drop rail-protection awareness. T52: mirrors plugins/adlc-codex/hooks/
// adlc-lifecycle.mjs's stateContext() — same summary shape, same "manifest is
// gate truth" reminder — adapted to this file's emit()/hookOutput conventions.
function context(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo → silent
  // Resolved through the canonical pointer contract (generated-active-ticket.mjs),
  // not a hand-parse — see resolveActiveTicketIdAdvisory()'s own doc comment for
  // why this degrades to "no active ticket" rather than failing closed here.
  const id = resolveActiveTicketIdAdvisory();
  if (!id) return;
  let ticket;
  try {
    ticket = loadTicketStoreReadOnly({ root: process.cwd(), env: process.env }).tickets.find((t) => t.id === id);
  } catch {
    return; // store unreadable → advisory, stay silent rather than error
  }
  const msg = ticket
    ? (() => {
        const rails = ticket.rails ?? [];
        const status = ticket.completed === true ? 'completed' : rails.length > 0 ? 'rail protection auto-active' : 'no rails declared';
        return `ADLC current ticket: ${id} — ${ticket.title}. Status: ${status}. Scope: ${(ticket.scope ?? []).join(', ') || '(none)'}. Treat .adlc/manifest.jsonl as gate truth; narration cannot pass a phase.`;
      })()
    : `ADLC current ticket ${id} is not present in the ticket store.`;
  const eventName = typeof input.hook_event_name === 'string' && input.hook_event_name ? input.hook_event_name : 'SessionStart';
  emit({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: msg },
    systemMessage: msg,
  });
}

// SessionStart — surface only genuine environment failures, stay silent when ready.
function preflight() {
  if (!existsSync('.adlc')) return; // not an ADLC repo
  const r = runAdlc(['preflight', '--json']);
  if (!r || !r.stdout) return; // toolkit absent / no output
  const res = parseJson(r.stdout);
  if (!res) return;
  const failed = res.failedNames ?? [];
  if (failed.length === 0) return; // ready → silent
  const msg =
    `ADLC preflight: ${failed.length} environment check(s) failing before fan-out: ` +
    `${failed.join(', ')}. Run \`adlc preflight\` for detail.`;
  emit({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
    systemMessage: msg,
  });
}

// PostToolUse — flag flailing over the transcript; dedupe so the same signal set
// is not re-reported on every subsequent tool call within a session.
/**
 * A private, user-owned 0700 directory under the temp dir for PERSISTENT hook
 * state (the flail dedupe marker, which must survive across PostToolUse
 * invocations). Predictable shared-/tmp filenames are a symlink-attack vector;
 * a 0700 dir owned by the current user blocks other users from planting
 * symlinks inside it. Returns null (→ skip persistence) if it can't be made
 * safely — e.g. the path is a symlink or owned by someone else.
 */
function privateStateDir() {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
    const dir = join(tmpdir(), `adlc-hooks-${uid}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    const st = lstatSync(dir); // lstat: a planted symlink is NOT a directory → rejected
    if (!st.isDirectory()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        return null;
      }
    }
    return dir;
  } catch {
    return null;
  }
}

/** File size in bytes, or -1 on error. Closes the fd. */
function fileSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    return fstatSync(fd).size;
  } catch {
    return -1;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read at most the last `maxBytes` of a file without loading the whole thing,
 * dropping a leading partial line so the result is clean JSONL/text. Returns
 * null on any error (caller then no-ops).
 */
function tailBytes(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      // Drop the partial leading line — but only if real content remains.
      // If the window lands inside one oversized record whose only newline is at
      // the very end, dropping would empty the window; keep the raw (truncated)
      // window instead so the scan stays bounded AND non-empty.
      if (nl >= 0 && nl + 1 < text.length) text = text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function flail(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo — same no-op guard as the other modes
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) return;

  // Bound the work: scan the original file when small, otherwise a recent-window
  // copy in the temp dir so cost stays O(MAX_SCAN_BYTES) no matter how long the
  // session runs.
  let scanPath = tp;
  let scanDir = null;
  if (fileSize(tp) > MAX_SCAN_BYTES) {
    // Keep this frequently-invoked hook strictly O(MAX_SCAN_BYTES): scan only a
    // bounded recent window, and NEVER fall back to parsing the full transcript.
    // tailBytes already preserves a non-empty window even for one oversized
    // record; if it still can't produce usable content, quietly no-op this
    // invocation rather than do unbounded work.
    const tail = tailBytes(tp, MAX_SCAN_BYTES);
    if (tail == null || !tail.trim()) return;
    try {
      // mkdtempSync makes a fresh 0700 dir with a random suffix — no predictable
      // path to pre-plant a symlink against.
      scanDir = mkdtempSync(join(tmpdir(), 'adlc-flail-'));
      const p = join(scanDir, 'scan.jsonl');
      writeFileSync(p, tail);
      scanPath = p;
    } catch {
      return; // cannot stage the bounded copy — no-op, never full-scan
    }
  }

  const r = runAdlc(['flail-detector', scanPath, '--json']);
  if (scanDir) {
    try {
      rmSync(scanDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  if (!r || !r.stdout) return;
  const res = parseJson(r.stdout);
  if (!res || res.verdict !== 'flail') return;

  const summary = (res.signals ?? []).map((s) => s.type).join(', ');
  // Dedupe on the FULL signal payload (paths, error signatures, counts), not just
  // the type names — otherwise churn on file A then file B (both `edit-churn`)
  // would be silently suppressed. Different evidence => different hash => surfaced.
  const payloadHash = createHash('sha1')
    .update(JSON.stringify(res.signals ?? []))
    .digest('hex');
  // Dedupe state lives in a private 0700 temp dir (NOT the worktree, so the hook
  // never dirties the tree; NOT a predictable shared-/tmp path, so it is not a
  // symlink target). Keyed by the per-session transcript path. If a safe dir
  // can't be made, skip dedupe rather than risk an unsafe write — the advisory
  // still fires, just without suppression.
  const base = privateStateDir();
  if (base) {
    const key = createHash('sha1').update(tp).digest('hex').slice(0, 16);
    const stateFile = join(base, `flail-${key}.state`);
    let prev = '';
    try {
      prev = readFileSync(stateFile, 'utf8');
    } catch {
      /* no prior state */
    }
    if (prev.trim() === payloadHash) return; // already reported this exact evidence
    try {
      writeFileSync(stateFile, payloadHash);
    } catch {
      /* state is best-effort; still surface the advisory */
    }
  }

  const msg =
    `ADLC flail-detector: possible flailing this session (${summary || 'signals detected'}). ` +
    `Consider stopping and banking the dead-ends rather than retrying.`;
  emit({ systemMessage: msg });
}

// Stop — audit the gate-evidence chain; warn only if it is broken.
// --allow-legacy-unsigned tolerates a repo's honest pre-signing history (entries
// recorded before ADLC_MANIFEST_KEY was ever adopted) without weakening detection
// of real tampering: a missing sig after the first signed entry, or any invalid
// sig, still trips this warning. See packages/gate-manifest/lib/verify.mjs.
function manifest() {
  if (!existsSync(join('.adlc', 'manifest.jsonl'))) return; // nothing recorded yet
  const r = runAdlc(['gate-manifest', 'verify', '--json', '--allow-legacy-unsigned']);
  if (!r || !r.stdout) return;
  const res = parseJson(r.stdout);
  if (!res || res.valid) return; // intact → silent
  const msg =
    `ADLC gate-manifest: evidence chain INVALID — ${res.message}. ` +
    `The gate ledger may have been tampered with or truncated.`;
  emit({ systemMessage: msg });
}

// ---------------------------------------------------------------------------
// review (Stop) — mechanical adversarial-review trigger for issue #59.
//
// ADR-0005/0007 both explicitly deferred MECHANICAL enforcement of the
// adversarial-review practice, contingent on operator-reliance "proving
// insufficient" (their own words) — issue #59 is that signal. This mode is the
// deterministic (no-LLM) trigger: it diffs the working tree/branch against the
// ADR-0007 §1 risk-tier path patterns and, if the change is risk-gated and no
// `adversarial-review` gate-manifest record exists for the active ticket,
// surfaces a notice.
//
// KEEP IN SYNC with packages/core/lib/risk-tier.mjs — RISK_TIER_PATTERNS,
// matchRiskTier, classifyRiskTier, filesOverlapOrUnscoped, and
// decideAdversarialReviewNotice below are ported VERBATIM from there (this
// hook can't resolve @adlc/core at runtime, same constraint documented on the
// ported `globMatch` just below).
// ---------------------------------------------------------------------------

const RISK_TIER_PATTERNS = Object.freeze({
  'auth-trust-boundary': Object.freeze([
    '**/auth/**', '**/authn/**', '**/authz/**', '**/oauth/**', '**/sso/**',
    '**/session/**', '**/login/**', '**/permissions/**', '**/rbac/**', '**/acl/**',
  ]),
  'security-control-deny-path': Object.freeze([
    '**/*guard*', '**/*validator*', '**/*validators*', '**/sandbox/**', '**/sandboxes/**',
    '**/middleware/**', '**/*deny-path*', '**/*policy*', '**/policies/**',
  ]),
  secrets: Object.freeze([
    '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
    '**/secrets/**', '**/secret/**', '**/*credentials*', '**/vault/**',
  ]),
  'data-loss-destructive': Object.freeze([
    '**/*delete*', '**/*destroy*', '**/*purge*', '**/*truncate*', '**/*wipe*',
    '**/*irreversible*',
  ]),
  'schema-migration': Object.freeze([
    '**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.*', '**/*.prisma',
  ]),
  'ci-cd-supply-chain': Object.freeze([
    '.github/workflows/**', '**/Dockerfile', '**/Dockerfile.*', '**/docker-compose*.yml',
    '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
    '**/requirements*.txt', '**/Gemfile*', '**/go.sum', '**/go.mod', '**/Cargo.lock',
    '.circleci/**', '.gitlab-ci.yml',
  ]),
});

/** Classify ONE repo-relative path against every risk tier. Pure. */
function matchRiskTier(path) {
  const norm = String(path).split('\\').join('/');
  for (const [tier, patterns] of Object.entries(RISK_TIER_PATTERNS)) {
    for (const pattern of patterns) {
      if (globMatch(pattern, norm)) return { tier, pattern };
    }
  }
  return null;
}

/** Classify a SET of changed paths. Pure. */
function classifyRiskTier(paths) {
  const matches = [];
  for (const path of paths ?? []) {
    const hit = matchRiskTier(path);
    if (hit) matches.push({ path, ...hit });
  }
  return { gated: matches.length > 0, matches };
}

/**
 * Does a manifest entry's recorded `files` map (from `gate-manifest record
 * ... --files a,b,c`) overlap the currently gated paths? An entry with no
 * `files` recorded is neither confirmed nor refuted (falls back to
 * ticket-only scoping); an entry that DOES record files but shares none with
 * the current gated matches was reviewing a different changeset and must not
 * silently satisfy this one. Ported verbatim from packages/core/lib/risk-tier.mjs.
 */
function filesOverlapOrUnscoped(entry, matches) {
  const files = entry && entry.files;
  if (!files || typeof files !== 'object') return true;
  const recorded = Object.keys(files);
  if (recorded.length === 0) return true;
  const gatedPaths = new Set(matches.map((m) => m.path));
  return recorded.some((p) => gatedPaths.has(p));
}

/**
 * The hook-mode decision, pure and unit-testable against a mocked manifest
 * state: given changed paths and already-loaded gate-manifest entries, is a
 * mechanical adversarial-review notice warranted?
 */
function decideAdversarialReviewNotice({ changedPaths = [], manifestEntries = [], ticketId = null } = {}) {
  const { gated, matches } = classifyRiskTier(changedPaths);
  if (!gated) return { needed: false, matches: [] };
  const hasRecord = (manifestEntries ?? []).some(
    (e) =>
      e &&
      e.gate === 'adversarial-review' &&
      (!ticketId || !e.ticket || e.ticket === ticketId) &&
      filesOverlapOrUnscoped(e, matches)
  );
  return { needed: !hasRecord, matches };
}

/**
 * Resolve the active ticket id through the canonical pointer contract
 * (generated-active-ticket.mjs, generated from packages/tickets/lib/pointer.mjs).
 *
 * Unlike the enforcing readers, a bad pointer here does NOT fail closed —
 * `review` is advisory, so any denial degrades to "no active ticket" (the notice
 * then checks for ANY adversarial-review record, unscoped) rather than blocking
 * on a bad pointer file. Only the ADVISORY DEGRADATION is local; the parse, the
 * accepted keys, and the conflict rule are the shared contract, so this no longer
 * disagrees with the enforcing readers about which ticket the pointer names.
 */
function resolveActiveTicketIdAdvisory() {
  const resolved = resolveActiveTicketIdCanonical({ root: '.', env: process.env });
  if (!resolved.ok) return null; // advisory: degrade rather than block
  return resolved.value?.id ?? null;
}

/**
 * Unquote a path token from `git status --porcelain` (non -z form). Git
 * C-quotes any path containing a space or other "unusual" character by
 * wrapping it in double quotes and backslash-escaping the contents (e.g.
 * ` M "secrets/api key.pem"`), unlike `git diff --name-only`/`git ls-files`,
 * which never quote. Left as-is, the literal surrounding `"` (and any `\\`
 * escapes) become part of the path string and silently defeat the `$`-anchored
 * risk-tier globs in matchRiskTier. Pass-through for the common (unquoted)
 * case; only unquotes tokens that are actually wrapped in `"..."`.
 * KEEP IN SYNC with plugins/adlc-opencode/lib/session-hooks.mjs's copy.
 */
function unquoteGitStatusPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[++i];
    if (next === undefined) break; // malformed trailing backslash — drop it
    switch (next) {
      case 'n': bytes.push(0x0a); break;
      case 't': bytes.push(0x09); break;
      case 'r': bytes.push(0x0d); break;
      case '"': bytes.push(0x22); break;
      case '\\': bytes.push(0x5c); break;
      case 'a': bytes.push(0x07); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'v': bytes.push(0x0b); break;
      default:
        if (next >= '0' && next <= '7') {
          let oct = next;
          while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
            oct += inner[++i];
          }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else {
          for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
        }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Repo-relative changed paths covering BOTH the working tree (uncommitted
 * modifications + untracked files) and the committed branch diff against the
 * first reachable trunk candidate — "diffs the working tree/branch" per the
 * issue. Best-effort: any git failure (not a repo, no candidate base reachable,
 * git missing) yields an empty set rather than throwing — `review` is advisory
 * and must never crash or fail closed on a git problem.
 */
function gitChangedPaths() {
  const paths = new Set();
  const runGit = (args) => spawnSync('git', args, { encoding: 'utf8' });

  const status = runGit(['status', '--porcelain', '--no-renames']);
  if (!status.error && status.status === 0 && status.stdout) {
    for (const line of status.stdout.split('\n')) {
      const p = unquoteGitStatusPath(line.slice(3).trim());
      if (p) paths.add(p);
    }
  }

  const untracked = runGit(['ls-files', '--others', '--exclude-standard']);
  if (!untracked.error && untracked.status === 0 && untracked.stdout) {
    for (const p of untracked.stdout.split('\n')) {
      if (p.trim()) paths.add(p.trim());
    }
  }

  // First reachable trunk candidate whose merge-base with HEAD actually
  // resolves — same candidate order AND same retry-on-merge-base-failure
  // behavior as @adlc/core's resolveBase (packages/core/lib/git.mjs), so this
  // hook's notion of "the branch" matches the rest of the toolkit's
  // freeze/diff gates. A candidate can exist as a ref yet share no common
  // history with HEAD (orphan branch, stale ref after a history rewrite,
  // shallow clone) — resolveBase() doesn't stop at the first *existing* ref,
  // it keeps trying candidates until one produces a real merge-base, so this
  // must too or it silently drops the committed-diff contribution to `changed`.
  // Overridable via ADLC_ADVERSARIAL_REVIEW_BASE for repos with a different trunk.
  const envBase = (process.env.ADLC_ADVERSARIAL_REVIEW_BASE ?? '').trim();
  const candidates = envBase ? [envBase] : ['main', 'master', 'origin/main', 'origin/master'];
  let diffBase = '';
  for (const c of candidates) {
    const exists = runGit(['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (exists.error || exists.status !== 0) continue;
    // Diff against the MERGE-BASE (fork point of `c` and HEAD), NOT `c`'s live
    // tip — resolveBase() itself resolves to `git merge-base <candidate>
    // HEAD`, and diffing straight against the tip would flag any file trunk
    // changed *after* this branch diverged as "changed" on this branch too,
    // producing false-positive risk-tier matches on stable code.
    const mergeBase = runGit(['merge-base', c, 'HEAD']);
    if (!mergeBase.error && mergeBase.status === 0 && mergeBase.stdout.trim()) {
      diffBase = mergeBase.stdout.trim();
      break;
    }
    // candidate exists but shares no history with HEAD — try the next one
  }
  if (diffBase) {
    const diff = runGit(['diff', '--name-only', diffBase, '--']);
    if (!diff.error && diff.status === 0 && diff.stdout) {
      for (const p of diff.stdout.split('\n')) {
        if (p.trim()) paths.add(p.trim());
      }
    }
  }

  return [...paths];
}

// Stop — mechanical adversarial-review trigger (issue #59). Advisory by
// default: never blocks unless ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT=1 is set, in
// which case a risk-gated, unreviewed change emits a Stop `decision: "block"`
// (Claude Code forces the session to continue, surfacing `reason` as context)
// rather than only a systemMessage. Defaulting to advisory matches this file's
// existing opt-in-enforcement posture (ADLC_P4_ENFORCEMENT / ADLC_RAILS_BYPASS
// elsewhere in the toolkit) — a NEW Stop-hook that silently started blocking
// sessions by default would be a much bigger behavior change than this bug fix
// warrants, and the manifest record it checks for can always be produced by
// running `npx adversarial-review` + `adlc gate-manifest record` directly.
//
// Loop guard: Claude Code sets `stop_hook_active: true` on the hook input when
// a PRIOR Stop hook in this same turn already returned `decision: "block"` and
// forced a continuation. review()'s block condition (git state + manifest
// state) is otherwise stable across re-invocations, so without this check a
// risk-gated change that never gets an `adversarial-review` gate-manifest
// record (model forgets, or the record command itself errors) would re-block
// every subsequent Stop forever — the session could never end short of an
// operator killing it or unsetting the enforcement env var. Once
// `stop_hook_active` is true we still surface the systemMessage (so the
// operator sees it) but never block again this turn.
function review(input = {}) {
  if (!existsSync('.adlc')) return; // not an ADLC repo

  const changed = gitChangedPaths();
  if (changed.length === 0) return; // nothing changed (or git unavailable) → silent

  const { gated, matches } = classifyRiskTier(changed);
  if (!gated) return; // not risk-gated → adversarial-review is not mechanically required

  const ticketId = resolveActiveTicketIdAdvisory();

  let manifestEntries = [];
  if (existsSync(join('.adlc', 'manifest.jsonl'))) {
    const r = runAdlc(['gate-manifest', 'show', '--json']);
    if (r && r.stdout) {
      const parsed = parseJson(r.stdout);
      if (parsed && Array.isArray(parsed.entries)) manifestEntries = parsed.entries;
    }
  }

  const decision = decideAdversarialReviewNotice({ changedPaths: changed, manifestEntries, ticketId });
  if (!decision.needed) return; // already satisfied (or nothing to satisfy) → silent

  const tiers = [...new Set(decision.matches.map((m) => m.tier))].join(', ');
  const sample = decision.matches.slice(0, 3).map((m) => m.path).join(', ');
  const msg =
    `ADLC adversarial-review: this change touches a risk-gated path (${tiers}: ${sample}` +
    `${decision.matches.length > 3 ? ', …' : ''}) with no adversarial-review gate-manifest ` +
    `record${ticketId ? ` for ticket ${ticketId}` : ''}. Run \`npx adversarial-review\` and record ` +
    `the verdict via \`adlc gate-manifest record adversarial-review --files '<paths>' ` +
    `--data '{"providers":"<a,b>","verdict":"<approve|needs-attention>","exitReason":"<clean|no-progress|ceiling>"}'\` ` +
    `before merging.`;

  if (process.env.ADLC_ADVERSARIAL_REVIEW_ENFORCEMENT === '1' && input.stop_hook_active !== true) {
    emit({ decision: 'block', reason: msg, systemMessage: msg });
    return;
  }
  emit({ systemMessage: msg });
}

// The rail/scope glob matcher is a GENERATED verbatim copy of
// packages/core/lib/glob.mjs: this file is installed without node_modules, so it
// cannot import @adlc/core, and a hand-kept copy is what drifted before.
import { globMatch } from './generated-glob-match.mjs';

/**
 * Every file path a structured edit tool would touch. Reads the top-level
 * `file_path`/`notebook_path`/`path`, AND any per-item paths nested in `edits`/
 * `files` arrays (MultiEdit and batch/multi-file edit shapes — robust across
 * harnesses). Returns a de-duplicated array; the rails gate checks every one.
 */
function targetFilePaths(input) {
  const ti = input.tool_input ?? input.parameters ?? {};
  const paths = [];
  const add = (v) => {
    if (typeof v === 'string' && v.length > 0) paths.push(v);
  };
  add(ti.file_path);
  add(ti.notebook_path);
  add(ti.path);
  for (const key of ['edits', 'files']) {
    if (Array.isArray(ti[key])) {
      for (const item of ti[key]) {
        if (item && typeof item === 'object') {
          add(item.file_path);
          add(item.path);
        } else {
          add(item); // a `files: ['a','b']` string array
        }
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Canonical repo-relative, forward-slashed path for glob matching. The tool
 * input is the trust boundary, so canonicalize it: `resolve` collapses `.`/`..`/
 * dup-separators and anchors relative input to the project root; `realpathSync`
 * then resolves SYMLINKS so an edit to a symlink that points at a rail cannot
 * dodge the glob. A brand-new file (Write) has no realpath, so we resolve its
 * existing parent dir and re-attach the basename. Both repo root and target are
 * realpath'd so a symlinked repo root still compares correctly.
 */
// Resolve symlinks even for not-yet-existing paths. Walk up toward the first
// EXISTING ancestor; at each unresolved component, if the component is itself a
// symlink (even a BROKEN one whose target does not exist yet), follow its target
// and keep resolving. Otherwise treat it as a non-existent tail segment. So both
// `link/new_sub/f` (link → existing rail dir) and a broken `link → rail_dir`
// (rail_dir not yet created) resolve INTO the rail and are caught.
function realResolve(abs) {
  let cur = abs;
  const tail = [];
  const seen = new Set();
  for (let guard = 0; guard < 64; guard++) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    } catch {
      // A revisited node means a symlink loop (a → b → a). Throw so the rails
      // hook's global handler FAILS CLOSED rather than resolving lexically.
      if (seen.has(cur)) throw new Error('symlink loop in rail path resolution');
      seen.add(cur);
      // Is `cur` itself a symlink (possibly broken)? Follow it.
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          cur = resolve(dirname(cur), readlinkSync(cur));
          continue;
        }
      } catch {
        /* cur does not exist at all → fall through to walk up */
      }
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the root, nothing resolved → lexical
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
  // Pathological depth — fail closed (throwing reaches the global rails handler).
  throw new Error('symlink resolution too deep in rail path');
}

function toRepoRelative(fp) {
  let root;
  try {
    root = realpathSync(process.cwd());
  } catch {
    root = process.cwd();
  }
  const real = realResolve(resolve(baseDir ?? process.cwd(), fp));
  return relative(root, real).split('\\').join('/');
}

/**
 * LEXICAL repo-relative form (resolves `.`/`..`/dup-separators but NOT symlinks).
 * Matching an edit target in BOTH this and the symlink-resolved `toRepoRelative`
 * form against the literal rail globs makes rail matching symmetric without
 * having to resolve the globs themselves: a symlinked RAIL is caught by the
 * lexical form, a symlinked TARGET by the resolved form.
 */
function toRepoRelativeLexical(fp) {
  return relative(process.cwd(), resolve(baseDir ?? process.cwd(), fp)).split('\\').join('/');
}

function repoRoot() {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
}

/**
 * A rail glob normalized to forward slashes AND with its literal portion
 * symlink-resolved (repo-relative). For a plain path the whole thing is resolved
 * (catches a file-level symlink); for a wildcard glob the literal directory
 * prefix is resolved. Edit targets are matched in both lexical and resolved
 * forms, and rails in both literal-normalized and this resolved form — so a
 * symlink on EITHER side, in EITHER spelling, is caught. Returns the normalized
 * glob unchanged when nothing resolves (or on error → literal-only).
 */
function canonRailGlob(glob) {
  const norm = glob.split('\\').join('/');
  const wild = norm.search(/[*?[]/);
  if (wild === -1) {
    try {
      return relative(repoRoot(), realResolve(resolve(process.cwd(), norm))).split('\\').join('/') || norm;
    } catch {
      return norm;
    }
  }
  const literal = norm.slice(0, wild);
  const lastSlash = literal.lastIndexOf('/');
  if (lastSlash < 0) return norm; // wildcard in the first segment → nothing to resolve
  const dirPart = literal.slice(0, lastSlash);
  const rest = norm.slice(dirPart.length); // includes the leading '/'
  let rd;
  try {
    rd = relative(repoRoot(), realResolve(resolve(process.cwd(), dirPart))).split('\\').join('/');
  } catch {
    return norm;
  }
  return rd === '' ? rest.replace(/^\//, '') : rd + rest; // rd '' ⇒ rail dir is the repo root
}

/**
 * Emit a PreToolUse DENY and exit 2. This is enforcing, so it fails closed two
 * ways: the structured `permissionDecision: deny` payload, AND a non-zero exit
 * (Claude Code blocks a PreToolUse hook that exits 2) — so even if the stdout
 * write is swallowed/blocked, the edit is still denied. Does not return.
 */
function denyRail(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: `ADLC rails-guard: ${reason}`,
  });
  process.exit(2);
}

/**
 * Audit an ADLC_RAILS_BYPASS override to the gate-manifest. Returns true ONLY if
 * the record was durably written (adlc present and `gate-manifest record` exited
 * 0). A bypass without a successful audit is not a valid override.
 */
function recordBypass(relPath, why) {
  const r = runAdlc([
    'gate-manifest',
    'record',
    'rails-bypass',
    '--data',
    JSON.stringify({ path: relPath, reason: why }),
  ]);
  return !!r && r.status === 0;
}

// PreToolUse (Edit/Write/MultiEdit) — the ONE enforcement hook: block edits to
// frozen rail paths. Asymmetric fail-closed contract (plan §4.4):
//   • no .adlc / no tickets file / no rails declared anywhere → ALLOW (no-op),
//     so installing into a repo that declares no rails can never brick editing;
//   • a structured edit (Edit/Write/MultiEdit) to a rail path → DENY;
//   • once any rail exists, `.adlc/tickets.json` is itself an implicit rail —
//     the trust root can't be edited away to disable enforcement;
//   • unparseable / schema-invalid tickets → rails can't be ruled out → DENY;
//   • ADLC_RAILS_BYPASS=1 → ALLOW, but ONLY if the override is durably recorded
//     to the manifest; an un-auditable bypass is refused (deny).
//
// SCOPE: this hook gates the STRUCTURED edit tools (Edit/Write/MultiEdit), which
// it can resolve precisely with zero shell parsing. Bash is intentionally NOT
// matched: a shell is Turing-complete and cannot be reliably parsed in-session
// (every guard leaks — wrappers, subshells, globs, cd, eval, …). Rail mutations
// via Bash are caught by the UNBYPASSABLE rails-guard CI diff gate at commit
// time (`scripts/rails-guard-ci.mjs`), which inspects the committed change
// regardless of how it was produced. See docs/adr/0002-adlc-command-reconciliation.md.
//
// Symlink note: rails and targets are matched in both lexical and symlink-
// resolved forms, and a rail's literal directory PREFIX is symlink-resolved. A
// rail with a LEADING wildcard whose later, wildcard-matched segments are
// symlinks (e.g. `*/auth/**` where `auth` is a symlink) is the one residual
// gap — declare rails with literal directory prefixes for symlink resolution to
// apply; the CI gate remains the commit-time backstop.
function rails(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo
  if (!ticketStoreExists(process.cwd(), process.env)) return; // no tickets → no rails declared
  let ticketSnapshot;
  const defaultDirectory = existsSync(join('.adlc', 'tickets', '.store.json'));
  const ticketsPath = process.env.ADLC_TICKET_STORE ?? process.env.ADLC_TICKETS ?? (defaultDirectory ? join('.adlc', 'tickets') : join('.adlc', 'tickets.json'));

  // TRUST THE MATCHER: hooks.json routes only mutating edit tools to this hook,
  // so any tool that arrives is one we chose to gate — no in-code tool allowlist
  // (which would drift from the matcher and fail OPEN for a newly-matched tool).
  // We gate by the target path; a tool that yields NO path while rails are
  // declared fails closed below (an edit we can't verify is not allowed).
  const fps = targetFilePaths(input);

  // ADLC_RAILS_BYPASS: an audited, deliberate override. `1` = session-wide,
  // UNSCOPED (backward compatible); any other non-empty value = a glob that
  // authorizes ONLY rail hits whose path matches it, so an override granted for
  // one area cannot silently authorize edits to another (#204 AC2). Unset/empty
  // = no bypass.
  const bypassRaw = process.env.ADLC_RAILS_BYPASS;
  // Only unset/empty or an explicitly-inert sentinel disables the bypass; every
  // other value is meaningful (`1` = session-wide, anything else = a path glob).
  // The prior boolean `=== '1'` treated `=0`/`=false` as OFF — keep that intuition
  // so those do not silently become a (no-op) active scoped bypass (#204 review).
  const INERT_BYPASS = new Set(['', '0', 'false', 'no', 'off']);
  const bypassActive = typeof bypassRaw === 'string' && !INERT_BYPASS.has(bypassRaw.trim().toLowerCase());
  const bypassUnscoped = bypassRaw === '1';
  // A pure-wildcard "scope" (`*`, `**`, `**/*`) authorizes EVERYTHING session-wide
  // yet would present as a narrow `scope "…"` and suppress the loud unscoped notice
  // — refuse it, so a session-wide bypass cannot be spelled around the AC3 honest
  // disclosure (#204 review). A deliberate session-wide override must use `=1`.
  const bypassWildcardOnly = bypassActive && !bypassUnscoped && /^[*/]+$/.test(bypassRaw.trim());
  const bypassScopeDesc = bypassUnscoped ? 'UNSCOPED, session-wide' : `scope "${bypassRaw}"`;
  const bypassAuthorizes = (relPath) => bypassActive && (bypassUnscoped || globMatch(bypassRaw, relPath));
  const subject = fps.length ? fps.join(', ') : `(unparsed ${input.tool_name ?? 'edit'} target)`;

  // An honored bypass is NOT silent (#204 AC3): every allowed override emits a
  // visible in-session notice, so a stale bypass is seen rather than inferred.
  // The bare `=1` notice states plainly that it is unscoped, session-lifetime,
  // and not revoked by deleting a settings file — the divergence #204 reported.
  const emitBypassNotice = (paths) => {
    emit({
      systemMessage:
        `ADLC_RAILS_BYPASS active (${bypassScopeDesc}) — allowed an otherwise-blocked edit to ` +
        `${paths.join(', ')} (recorded to the gate-manifest).` +
        (bypassUnscoped
          ? ` This is an UNSCOPED, session-wide override: it stays in effect for the rest of this ` +
            `session and deleting a settings file does NOT revoke it — unset ADLC_RAILS_BYPASS and ` +
            `restart the session, or scope it with ADLC_RAILS_BYPASS=<glob>.`
          : ``),
    });
  };

  // A bypass is only honored if it is IN SCOPE and can be AUDITED. Out of scope →
  // deny. If recording fails (adlc missing, .adlc unwritable, record errors), an
  // unaudited override is refused.
  const bypassOrDeny = (tag, denyReason) => {
    if (bypassActive) {
      if (bypassWildcardOnly) {
        return denyRail(
          `ADLC_RAILS_BYPASS="${bypassRaw}" is a wildcard-only scope that would authorize every rail. ` +
            `Use ADLC_RAILS_BYPASS=1 for a deliberate session-wide override, or a specific path glob. ${denyReason}`
        );
      }
      const targets = fps.length ? fps.map((fp) => toRepoRelative(fp)) : [subject];
      const inScope = bypassUnscoped || targets.every((t) => globMatch(bypassRaw, t));
      if (!inScope) {
        return denyRail(`ADLC_RAILS_BYPASS is ${bypassScopeDesc} and does not authorize ${subject}. ${denyReason}`);
      }
      if (recordBypass(subject, tag)) {
        emitBypassNotice(targets);
        return; // audited, in-scope override → allow
      }
      return denyRail(
        `ADLC_RAILS_BYPASS is set but the override could not be recorded to the gate-manifest ` +
          `(is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the edit is blocked.`
      );
    }
    return denyRail(denyReason);
  };

  // Fail closed on ANY state where rails cannot be trustworthily determined: an
  // unparseable file, an unexpected envelope, or a malformed rails field. Only a
  // schema-VALID, empty rail set is treated as "no rails declared → allow".
  const failClosed = (reason, tag) =>
    bypassOrDeny(
      tag,
      `${reason} rails cannot be verified, so edits are blocked. Fix .adlc/tickets.json, ` +
        `or set ADLC_RAILS_BYPASS=1 to override (the bypass is recorded).`
    );

  let parsed;
  try {
    ticketSnapshot = loadTicketStoreReadOnly({ root: process.cwd(), env: process.env });
    parsed = { tickets: ticketSnapshot.tickets };
  } catch (e) {
    return failClosed(`cannot read ticket store (${e.message});`, 'unparseable-tickets-bypass');
  }

  // Valid JSON but wrong shape (e.g. a bare array, or no `tickets` envelope) must
  // NOT be read as an empty rail set — that would fail open.
  const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject || !Array.isArray(parsed.tickets)) {
    return failClosed(
      `.adlc/tickets.json is not in the expected { "tickets": [...] } shape;`,
      'invalid-tickets-shape-bypass'
    );
  }

  // Validate EVERY entry before trusting it. Any malformed structure where a
  // rail could be hiding (non-object entry, non-array rails, non-string rail
  // element) fails closed — never silently read as "no rails".
  const railDecls = [];
  // Tracks whether ANY ticket declared a rail — including tickets whose rails
  // have since expired via completion. This is deliberately NOT the same as
  // `railDecls.length`: the trust-root freeze below keys off "this repo uses
  // rails at all", not "a rail is in force right now". Conflating the two would
  // unfreeze `.adlc/tickets.json` the moment the last railed ticket completed,
  // letting a single edit rewrite the rail config itself. See issue #162.
  let anyRailsDeclared = false;
  for (const t of parsed.tickets) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return failClosed(
        `.adlc/tickets.json has a ticket entry that is not an object;`,
        'invalid-ticket-entry-bypass'
      );
    }
    if (t.rails !== undefined && !Array.isArray(t.rails)) {
      return failClosed(
        `a ticket in .adlc/tickets.json has a non-array "rails" field;`,
        'invalid-rails-field-bypass'
      );
    }
    // T36 / issue #162 — completion expires a ticket's build-time rails. A
    // ticket's rails are a PER-BUILD freeze: they stop that build from editing
    // its own frozen foundation while it runs. Once the ticket is completed
    // there is no in-flight build left to protect, so continuing to freeze its
    // rails only blocks legitimate new work (a completed ticket that declared
    // `packages/**` otherwise freezes that subtree forever).
    //
    // This adopts the same completion rule as scripts/rails-guard-ci.mjs, the
    // unbypassable commit-time gate. The two are NOT unconditionally identical:
    // CI reads `completed` from the BASE ref (a deliberate trust anchor — see
    // its note at rails-guard-ci.mjs:317), whereas this hook reads the working
    // tree, because in-session there is no committed state to anchor to. They
    // agree whenever `.adlc/tickets.json` matches base. Where they diverge, a
    // working-tree edit that marks a live ticket completed expires its rails
    // in-session but is still DENIED by CI at commit time, so the gate holds.
    //
    // STRICT `=== true` only: a missing, truthy-ish, or tampered `completed`
    // value is NOT a completion and the rail keeps freezing (fail closed).
    //
    // Placement note: the expiry skip sits AFTER the shape checks above and
    // before the per-rail string check below, so a completed ticket carrying
    // malformed rail data is never skipped unvalidated. In practice those two
    // in-loop checks are unreachable — `loadTicketStoreReadOnly` validates the
    // store and throws first (see the failClosed above) — so they are
    // defense-in-depth against a regression in the reader's contract, not the
    // live rejection path. Tests assert the reader's message accordingly.
    const expired = t.completed === true;
    for (const r of t.rails ?? []) {
      if (typeof r !== 'string') {
        return failClosed(
          `a ticket in .adlc/tickets.json has a non-string rail entry;`,
          'invalid-rail-entry-bypass'
        );
      }
      anyRailsDeclared = true; // set BEFORE the expiry skip — see the note above
      if (expired) continue; // rails retired with the ticket; trust roots stay frozen
      const tid = typeof t.id === 'string' ? t.id : '?';
      const normGlob = r.split('\\').join('/'); // normalize Windows-style backslashes
      railDecls.push({ glob: normGlob, ticket: tid });
      const canon = canonRailGlob(r); // symlink-resolved form, for symmetry with resolved targets
      if (canon !== normGlob) railDecls.push({ glob: canon, ticket: tid });
    }
  }
  if (!anyRailsDeclared) return; // schema-valid, no rails declared → no-op

  // The rail config is its own trust root: once rails exist, editing
  // .adlc/tickets.json to remove them would silently disable enforcement, so
  // freeze it too (audited bypass still allowed for deliberate changes). Freeze
  // BOTH the literal path AND its resolved path — because edit targets are
  // symlink-resolved, a tickets.json that is itself a symlink (or its real
  // target) would otherwise dodge the literal glob.
  railDecls.push({ glob: ticketSnapshot.backend === 'directory' ? '.adlc/tickets/**' : '.adlc/tickets.json', ticket: '(rail trust root)' });
  const ticketsResolved = toRepoRelative(ticketsPath);
  if (ticketsResolved && !['.adlc/tickets.json', '.adlc/tickets'].includes(ticketsResolved)) {
    railDecls.push({ glob: ticketsResolved, ticket: '(rail trust root, resolved)' });
  }

  // .adlc/current-ticket.json is the OTHER half of the shared trust root (see
  // BUILD_GATE_TRUST_ROOT_PATHS below): build-gate's active-ticket resolution
  // trusts this pointer file, so once any rails exist, a structured edit
  // (Edit/Write/MultiEdit/NotebookEdit) that overwrites it to point away from
  // a high-risk ticket must be frozen exactly like tickets.json itself — an
  // unprotected pointer would otherwise let a single edit silently disable
  // build-gate for the rest of the session with no risk evaluation and no
  // manifest entry. This does not cover Bash (see this hook's matcher and
  // docs/integrations/claude-code.md's Gaps section for that documented,
  // unbackstopped limitation — current-ticket.json is gitignored local state,
  // so there is no commit-time diff for a CI gate to inspect either).
  const currentTicketPath = join('.adlc', 'current-ticket.json');
  railDecls.push({ glob: '.adlc/current-ticket.json', ticket: '(rail trust root)' });
  const currentTicketResolved = toRepoRelative(currentTicketPath);
  if (currentTicketResolved && currentTicketResolved !== '.adlc/current-ticket.json') {
    railDecls.push({ glob: currentTicketResolved, ticket: '(rail trust root, resolved)' });
  }

  // A structured edit whose target path we couldn't extract, while rails are
  // declared, can't be verified → fail closed.
  if (fps.length === 0) {
    return failClosed(`could not extract the target path from this ${input.tool_name ?? 'edit'} payload;`, 'unparsed-edit-target-bypass');
  }

  // Collect EVERY target path that hits a rail (a multi-file edit must be denied
  // if ANY path is a rail, and EACH hit must be audited on bypass).
  const hits = [];
  for (const fp of fps) {
    // Match BOTH the lexical and the symlink-resolved form so neither a symlinked
    // rail nor a symlinked target can dodge the literal globs. (realResolve may
    // throw on a symlink loop → propagates to the global handler → fail closed.)
    const relLex = toRepoRelativeLexical(fp);
    const relReal = toRepoRelative(fp);
    const hit = railDecls.find((r) => globMatch(r.glob, relLex) || globMatch(r.glob, relReal));
    if (hit) hits.push({ rel: relReal, glob: hit.glob, ticket: hit.ticket });
  }
  if (hits.length === 0) return; // no target path hit a rail → allow

  if (bypassActive) {
    if (bypassWildcardOnly) {
      return denyRail(
        `ADLC_RAILS_BYPASS="${bypassRaw}" is a wildcard-only scope that would authorize every frozen rail. ` +
          `Use ADLC_RAILS_BYPASS=1 for a deliberate session-wide override, or a specific path glob.`
      );
    }
    // A scoped bypass authorizes ONLY the hits it matches; any hit outside the
    // granted scope is still denied — a bypass must not silently authorize edits
    // outside the scope it was granted for (#204 AC2). (`=1` matches every hit.)
    const outOfScope = hits.filter((h) => !bypassAuthorizes(h.rel));
    if (outOfScope.length > 0) {
      return denyRail(
        `ADLC_RAILS_BYPASS is ${bypassScopeDesc} and does not authorize frozen rail(s) ` +
          `${outOfScope.map((h) => h.rel).join(', ')}. Widen the scope (ADLC_RAILS_BYPASS=<glob>) ` +
          `or override those paths separately.`
      );
    }
    // Honor the override only if EVERY hit is durably audited; otherwise refuse.
    let allRecorded = true;
    for (const h of hits) {
      if (!recordBypass(h.rel, `rail ${h.glob} (ticket ${h.ticket})`)) allRecorded = false;
    }
    if (!allRecorded) {
      return denyRail(
        `ADLC_RAILS_BYPASS is set but a rail override could not be recorded to the gate-manifest ` +
          `(is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the edit is blocked.`
      );
    }
    emitBypassNotice(hits.map((h) => h.rel)); // observable (#204 AC3)
    return; // every hit in scope + recorded → allow
  }

  const h = hits[0];
  return denyRail(
    `${h.rel} is a frozen rail declared by ticket ${h.ticket} (rails: "${h.glob}")` +
      `${hits.length > 1 ? ` (+${hits.length - 1} more rail path(s) in this edit)` : ''}. ` +
      `Edits to frozen rails are blocked during build. Scope: this in-session hook gates ` +
      `structured edits (Edit/Write/MultiEdit/NotebookEdit) only — it does not parse Bash, so a shell write ` +
      `(a redirect or in-place edit) to a frozen path is NOT blocked here. Do not route around ` +
      `the gate that way: the rails-guard CI diff gate catches only rails already on the base ` +
      `branch — not a rail this same change declares, nor the gitignored active-ticket pointer ` +
      `— so such a write is an unaudited change to a protected rail that may go undetected. To ` +
      `change this rail deliberately, set ADLC_RAILS_BYPASS=1 (audited, recorded to the ` +
      `gate-manifest).`
  );
}

// ---------------------------------------------------------------------------
// build-gate (issue #48) — machine-checkable fitness-to-build gate.
//
// PreToolUse (Edit/Write/MultiEdit/NotebookEdit, same matcher as rails): for
// the ACTIVE ticket (resolved the same way every other ADLC harness
// integration resolves it — ADLC_TICKET env var OR .adlc/current-ticket.json,
// conflict fails closed), deny the build when the ticket is HIGH RISK and
// this session's context-fitness signal (transcript depth/bytes) is past
// threshold, unless an audited override is recorded.
//
// Fail-safe contract, mirroring rails():
//   • no .adlc / no tickets.json / no active ticket resolved → ALLOW (no-op);
//     installing this hook cannot brick a session that hasn't opted into the
//     active-ticket convention.
//   • a conflicting active-ticket signal, an unloadable/malformed
//     tickets.json, or an active ticket id not found → DENY (fail closed —
//     the ticket's risk cannot be verified).
//   • active ticket resolved but risk tier is 'normal' → ALLOW (this gate
//     only guards high-risk tickets).
//   • high-risk ticket, session not degraded → ALLOW.
//   • high-risk ticket, session degraded, transcript_path unreadable → DENY
//     (the context-fitness signal cannot be computed for a ticket we already
//     know is high-risk).
//   • high-risk ticket, session degraded → DENY, unless
//     ADLC_BUILD_GATE_BYPASS=1 AND the override is durably recorded to the
//     gate-manifest; an unaudited override is refused.
// ---------------------------------------------------------------------------

/**
 * Active-ticket resolution through the canonical pointer contract
 * (generated-active-ticket.mjs, generated verbatim from
 * packages/tickets/lib/pointer.mjs by scripts/ticket-readers/generate.mjs).
 *
 * This was a hand-ported copy carrying a "KEEP IN SYNC" comment, and it did not
 * stay in sync: it accepted only `id`/`ticket` while the codex and pi copies also
 * accepted `ticketId`, so a pointer written with `ticketId` enforced there and
 * resolved to "no active ticket" HERE — silently disabling the build gate. The
 * copies are gone; packages/tickets/test/pointer.test.mjs runs every generated
 * reader over one vector table and fails if any of them disagree.
 *
 * `conflict: true` means fail closed: a conflicting signal, an unparseable
 * pointer, OR an object pointer whose id key is unrecognized.
 */
function resolveActiveTicketIdForBuildGate() {
  const resolved = resolveActiveTicketIdCanonical({ root: '.', env: process.env });
  if (!resolved.ok) return { id: null, conflict: true, code: resolved.code, message: resolved.message };
  return { id: resolved.value?.id ?? null, conflict: false };
}

/** Trust-root paths — KEEP IN SYNC with packages/build-gate/lib/risk.mjs's TRUST_ROOT_PATHS. */
const BUILD_GATE_TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/tickets/**', '.adlc/current-ticket.json'];
/** KEEP IN SYNC with packages/build-gate/lib/risk.mjs's MANIFEST_PATH. */
const BUILD_GATE_MANIFEST_PATH = '.adlc/manifest.jsonl';
/** KEEP IN SYNC with packages/build-gate/lib/risk.mjs's HIGH_RISK_CATEGORIES. */
const BUILD_GATE_HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

function buildGateTouchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
}

/**
 * Risk-tier derivation — KEEP IN SYNC with packages/build-gate/lib/risk.mjs's
 * deriveRiskSignals()/computeRiskTier(). A declared risk:'normal' can never
 * downgrade a derived-high signal (see that module's header comment for why).
 */
function computeRiskTierForBuildGate(ticket) {
  const t = ticket ?? {};
  const signals = [];
  if (t.risk === 'high') signals.push('declared-risk-high');
  if (t.external === true) signals.push('external-system-effect');
  if (t.mutatesIdentity === true) signals.push('mutates-identity');
  // A malformed (present but non-array) scope/rails field is ambiguous, not
  // proof of safety — it must fire a signal, not be silently ignored.
  if (t.scope !== undefined && !Array.isArray(t.scope)) signals.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) signals.push('malformed-rails');
  const combinedGlobs = [
    ...(Array.isArray(t.scope) ? t.scope : []),
    ...(Array.isArray(t.rails) ? t.rails : []),
  ];
  if (buildGateTouchesAny(combinedGlobs, [BUILD_GATE_MANIFEST_PATH])) signals.push('mutates-manifest');
  if (buildGateTouchesAny(combinedGlobs, BUILD_GATE_TRUST_ROOT_PATHS)) signals.push('touches-trust-root');
  if (BUILD_GATE_HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}

/** KEEP IN SYNC with packages/build-gate/lib/depth-signal.mjs's DEFAULT_DEPTH_THRESHOLD. */
const BUILD_GATE_DEPTH_THRESHOLD = 40;
/**
 * Transcript byte count at which a session is considered context-degraded.
 * A raw byte count alone does not indicate tool-call depth: system-prompt
 * and schema content contributes bytes independent of any tool call, so a
 * threshold near the low end of ordinary session sizes classifies sessions
 * with zero tool calls as degraded. 8 MiB is the SAME ceiling
 * MAX_ACTIVE_CONTEXT_BYTES uses for the handoff scan budget below.
 *
 * KEEP IN SYNC with packages/build-gate/lib/depth-signal.mjs, comparison
 * logic only — that package's own DEFAULT_BYTES_THRESHOLD currently equals
 * HARD_BYTES (256 KiB), not this value; see hooks/test/build-gate.test.mjs's
 * KEEP-IN-SYNC test.
 */
const BUILD_GATE_BYTES_THRESHOLD = 8 * 1024 * 1024;
/**
 * The tail window buildgate() scans (below) to compute tool-call depth.
 * Deliberately separate from MAX_SCAN_BYTES (used by flail() for an
 * unrelated purpose — recent-error-loop detection — with its own correct
 * window size). Must be at least BUILD_GATE_BYTES_THRESHOLD: a smaller
 * window can, for a transcript sized between this constant and
 * BUILD_GATE_BYTES_THRESHOLD, both (a) truncate away tool calls that
 * occurred earlier than the window and (b) leave the byte-based signal
 * below threshold — the two signals no longer jointly cover that size
 * range, and depth is undercounted.
 */
const BUILD_GATE_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Tool-call-count depth signal — KEEP IN SYNC with
 * packages/build-gate/lib/depth-signal.mjs's countToolCalls(). A plain
 * occurrence count over a (possibly windowed) transcript chunk.
 */
function countToolCallsForBuildGate(text) {
  if (!text) return 0;
  const toolUseBlocks = text.match(/"type"\s*:\s*"tool_use"/g) ?? [];
  const proseToolLines = text.match(/^(?:Writing|Editing|Created)\s+\S+/gim) ?? [];
  return toolUseBlocks.length + proseToolLines.length;
}

/**
 * Emit a PreToolUse DENY and exit 2 for the build-gate. Fails closed two ways,
 * exactly like denyRail: the structured `permissionDecision: deny` payload,
 * AND a non-zero exit.
 */
function denyBuildGate(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: `ADLC build-gate: ${reason}`,
  });
  process.exit(2);
}

/**
 * Audit an ADLC_BUILD_GATE_BYPASS override to the gate-manifest via the real
 * `adlc gate-manifest record` command (chain-linked, optionally HMAC-signed —
 * the same mechanism rails' recordBypass uses). Returns true ONLY if the
 * record was durably written.
 */
function recordBuildGateBypass(ticketId, signals, depth, sessionBytes) {
  const r = runAdlc([
    'gate-manifest',
    'record',
    'build-gate-bypass',
    '--ticket',
    ticketId,
    '--data',
    JSON.stringify({ signals, depth, sessionBytes }),
  ]);
  return !!r && r.status === 0;
}

function buildgate(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo → allow
  if (!ticketStoreExists(process.cwd(), process.env)) return; // no tickets → nothing to gate → allow

  const active = resolveActiveTicketIdForBuildGate();
  if (active.conflict) {
    // Report the canonical reason. Assuming an ADLC_TICKET-vs-pointer conflict
    // misreports every other fail-closed cause — most often a malformed pointer,
    // where ADLC_TICKET may not be set at all and the actual fix is in the message.
    return denyBuildGate(
      `${active.message ?? 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)'} — failing closed`
    );
  }
  if (!active.id) return; // no active ticket declared → allow (opt-in gate)

  let parsed;
  try {
    parsed = { tickets: loadTicketStoreReadOnly({ root: process.cwd(), env: process.env }).tickets };
  } catch (e) {
    return denyBuildGate(
      `cannot read .adlc/tickets.json (${e.message}) — active ticket ${active.id}'s risk cannot be verified, failing closed`
    );
  }
  const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject || !Array.isArray(parsed.tickets)) {
    return denyBuildGate(
      '.adlc/tickets.json is not in the expected { "tickets": [...] } shape — failing closed'
    );
  }
  const ticket = parsed.tickets.find((t) => t && typeof t === 'object' && t.id === active.id);
  if (!ticket) {
    return denyBuildGate(`active ticket ${active.id} not found in .adlc/tickets.json — failing closed`);
  }

  const { tier, signals } = computeRiskTierForBuildGate(ticket);
  if (tier !== 'high') return; // this gate only guards high-risk tickets → allow

  // Context-fitness signal: bounded transcript scan using
  // BUILD_GATE_SCAN_BYTES (see its own comment for why this is a dedicated
  // constant, not flail()'s MAX_SCAN_BYTES), so this stays
  // O(BUILD_GATE_SCAN_BYTES) regardless of how long the session runs.
  // `sessionBytes` reflects the WHOLE transcript file (fileSize), while the
  // tool-call count is over a bounded recent window — same split flail()
  // makes with its own window.
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) {
    // We already know the ticket is high-risk; without a readable transcript
    // we cannot compute the context-fitness signal at all — fail closed
    // rather than assume "shallow".
    return denyBuildGate(
      `active ticket ${active.id} is high-risk but no readable transcript_path was supplied — ` +
        `the context-fitness signal cannot be verified, failing closed`
    );
  }

  const sessionBytes = fileSize(tp);
  if (sessionBytes < 0) {
    // existsSync(tp) passed above, but the file could not be stat'd/opened
    // here — a permissions error, or a TOCTOU race where the file was
    // deleted/replaced/swapped for a directory between the two checks. Either
    // way the context-fitness signal cannot be computed for a ticket we
    // already know is high-risk, so this must fail closed rather than treat
    // the unreadable file as "zero bytes, not degraded".
    return denyBuildGate(
      `active ticket ${active.id} is high-risk but transcript_path could not be read after the ` +
        `existence check (permission error, or the file changed underneath us) — the context-fitness ` +
        `signal cannot be verified, failing closed`
    );
  }

  let windowText;
  if (sessionBytes > BUILD_GATE_SCAN_BYTES) {
    windowText = tailBytes(tp, BUILD_GATE_SCAN_BYTES);
  } else {
    try {
      windowText = readFileSync(tp, 'utf8');
    } catch {
      windowText = null;
    }
  }
  if (windowText == null) {
    // Same fail-closed reasoning as above: fileSize succeeded but the actual
    // read of the (possibly windowed) transcript failed. Silently treating
    // this as depth=0 would let an unverifiable session through, exactly the
    // bypass this gate exists to prevent.
    return denyBuildGate(
      `active ticket ${active.id} is high-risk but the transcript window could not be read — the ` +
        `context-fitness signal cannot be verified, failing closed`
    );
  }
  const depth = countToolCallsForBuildGate(windowText);

  // Inclusive >= — depth tracks HARD_DEPTH (see BUILD_GATE_DEPTH_THRESHOLD's
  // comment); bytes uses this file's own recalibrated BUILD_GATE_BYTES_THRESHOLD
  // (see its comment for why it deliberately no longer aliases HARD_BYTES).
  const degraded = depth >= BUILD_GATE_DEPTH_THRESHOLD || sessionBytes >= BUILD_GATE_BYTES_THRESHOLD;
  if (!degraded) return; // high-risk, but this session isn't deep yet → allow

  const bypass = process.env.ADLC_BUILD_GATE_BYPASS === '1';
  if (bypass) {
    if (recordBuildGateBypass(active.id, signals, depth, sessionBytes)) return; // audited → allow
    return denyBuildGate(
      `ADLC_BUILD_GATE_BYPASS is set but the override could not be recorded to the gate-manifest ` +
        `(is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the build is blocked.`
    );
  }

  return denyBuildGate(
    `active ticket ${active.id} is high-risk (${signals.join(', ') || 'declared'}) and this session's ` +
      `context-fitness signal is past threshold (depth=${depth}, sessionBytes=${sessionBytes}). Continuing a ` +
      `high-blast-radius build in a degraded/deep session risks context-rot bugs. Resume in a FRESH session ` +
      `(or an isolated subagent) rather than continuing here. To override deliberately, set ` +
      `ADLC_BUILD_GATE_BYPASS=1 (the bypass is recorded to the gate-manifest).`
  );
}


/**
 * Emit a PreToolUse DENY and exit 2 for context-handoff. Fails closed two ways,
 * exactly like denyRail / denyBuildGate.
 */
function denyHandoff(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: `ADLC context-handoff: ${reason}`,
  });
  process.exit(2);
}

/**
 * Fail closed when handoff cannot operate in the project / ADLC root.
 *
 * Round-5 review: an ORDINARY (non-recovery, non-pwd) call that hits this
 * path — e.g. a stale CLAUDE_PROJECT_DIR — previously got only a bare
 * "could not enter the project directory" message, violating the
 * recovery-message invariant (spec §1.3: every Hard-Degraded/deny
 * diagnostic MUST print the literal, copy-pasteable recovery command).
 * `sessionId` is resolved from the raw hook `input` — cheap, execution-free,
 * and safe to compute even though `process.cwd()` may not yet be the
 * project root at this point in `main()`.
 */
function failClosedHandoffEnter(why, input) {
  const sessionId = resolveSessionId(input ?? {}, { isSafeSessionId });
  denyHandoff(`handoff hook ${why} — failing closed\n\n${recoveryDiagnostic(sessionId)}`);
}

/**
 * Observe depth for evaluateBands — thresholds come from @adlc/context-handoff
 * via evaluateBands / handoffDenyActive (no local HANDOFF_/HARD_ threshold
 * copies). `observed.bytes` is deliberately never populated (Phase 0 hotfix,
 * context-rot-threshold-calibration spec §1.2.1): WARN_BYTES/HANDOFF_BYTES/
 * HARD_BYTES were calibrated against nothing and were tripped on turn 0-2 by
 * system-prompt/MCP-schema/rules overhead alone. `evaluateBands` already
 * treats an absent signal as `{warn:false,...}` for that signal, so omitting
 * it is sufficient — no change to `evaluateBands` itself.
 *
 * The scan's only two budgets are `maxActiveContextBytes` (the package's
 * MAX_ACTIVE_CONTEXT_BYTES, 8 MiB) and `maxScanWallMs` (MAX_SCAN_WALL_MS) —
 * the OLD, separate 256 KiB MAX_SCAN_BYTES ceiling (equated to HARD_BYTES,
 * root cause of the production +Infinity lockout) is retired entirely and
 * MUST NOT be reintroduced under either name for this signal. A scan that
 * cannot complete within either budget before reaching start-of-file reports
 * the depth actually accumulated — a FINITE lower bound, never +Infinity —
 * and `truncated: true`, which the caller must use to restrict mutating
 * tools until a complete scan succeeds (spec §1.2.2's lower-bound rule; see
 * `evaluateHandoffPreToolUse`'s `scanTruncated` param).
 *
 * Phase 0 has no compaction-boundary authentication (no K_host/MAC), so this
 * scan never stops early at a boundary-looking record — it always reads
 * toward start-of-file (or the budgets), which the regex count over the raw
 * window already does by construction: it never looks for a compaction
 * marker at all.
 *
 * The read goes through `boundedHandoffRead` (a dedicated chunked reader for
 * THIS signal only — never `fileSize`/`tailBytes` above, which flail() and
 * buildgate() still use unchanged for their own, unrelated windows), which
 * reads in fixed-size chunks and checks `maxScanWallMs` BETWEEN chunks — so
 * the wall-clock budget is a real, enforced ceiling on this hook's own
 * blocking time, not merely a validated-but-inert parameter. (Same fix, same
 * reasoning, as the Codex adapter's `observeHandoffSignals`/
 * `boundedTailRead`, unit-tested there since this function isn't exported
 * for direct testing.)
 *
 * @param {object} input
 * @param {{ maxActiveContextBytes: number, maxScanWallMs: number, read?: Function }} opts
 * @returns {{ observed: { depth?: number }, truncated: boolean }}
 */
function observeHandoffSignals(input, { maxActiveContextBytes, maxScanWallMs, read = boundedHandoffRead } = {}) {
  if (
    !Number.isFinite(maxActiveContextBytes) ||
    maxActiveContextBytes <= 0 ||
    !Number.isFinite(maxScanWallMs) ||
    maxScanWallMs <= 0
  ) {
    // No usable budget means the signal cannot be bounded — do not guess.
    return { observed: { depth: Number.NaN }, truncated: false };
  }
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) return { observed: {}, truncated: false };

  const result = read(tp, { maxBytes: maxActiveContextBytes, deadlineMs: maxScanWallMs });
  if (result == null) {
    // Present-but-unreadable → fail closed as hard via evaluateBands invalid
    // path by supplying a non-finite sentinel the classifier treats as invalid.
    return { observed: { depth: Number.NaN }, truncated: false };
  }
  const depth = countToolCallsForBuildGate(result.text);
  return { observed: { depth }, truncated: result.truncated };
}

const HANDOFF_TAIL_READ_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tail-read-worker.mjs');

/**
 * Read the tail `maxBytes` of `path`. Dedicated to the handoff scan signal
 * only — flail()/buildgate() keep using `fileSize`/`tailBytes` above
 * unchanged for their own windows. See `observeHandoffSignals`'s comment for
 * why this exists and the Codex adapter's identically-behaved
 * `boundedTailRead` for the unit-tested twin.
 *
 * Round-16 review (T-01M03J291182MXD1KEKM2PRKTS): the deadline used to be
 * checked only BETWEEN synchronous readSync calls inside this process — it
 * could never preempt a single openSync/readSync that itself blocks (a
 * stalled network mount, a FIFO with no writer, a hung device file at
 * transcript_path), leaving `deadlineMs` an unenforceable ceiling against
 * exactly the failure mode it exists to bound. The actual read now runs in
 * a SEPARATE PROCESS (tail-read-worker.mjs) via `spawnSync(...,
 * { timeout })` — the OS can forcibly kill that process if it does not
 * finish in time, real preemption nothing in-process can offer against a
 * blocking syscall. This keeps this function's own call signature, and
 * every existing caller, fully synchronous — no async refactor needed.
 * @param {string} path
 * @param {{ maxBytes: number, deadlineMs: number }} opts
 * @returns {{ size: number, text: string, truncated: boolean }|null}
 */
export function boundedHandoffRead(path, { maxBytes, deadlineMs }) {
  const result = spawnSync(process.execPath, [HANDOFF_TAIL_READ_WORKER_PATH, path, String(maxBytes)], {
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxBytes + 4096,
  });
  // A killed-on-timeout child never gets to report whether the path was even
  // openable. Safest interpretation, matching this function's own invariant
  // ("returns the depth actually accumulated — a FINITE lower bound, never
  // +Infinity"): treat it as a short read that recovered zero bytes, NOT as
  // the "couldn't open at all" null case below (observeHandoffSignals maps
  // null to NaN depth, a different and less restrictive failure path than
  // truncated:true's incomplete-scan restriction).
  if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    return { size: 0, text: '', truncated: true };
  }
  // Trust the worker's own exit code as the authoritative signal, not just
  // its self-reported `ok` header field — the exit code is set by the SAME
  // fail()/success call sites the header comes from, so this is redundant
  // with a correct header, but it means a corrupted or lying header (a
  // build defect, not an adversary — the worker is this repo's own trusted
  // code) can never be misread as success while exit status disagrees.
  if (result.status !== 0) return null;
  if (!Buffer.isBuffer(result.stdout)) return null;
  const newlineIdx = result.stdout.indexOf(0x0a);
  if (newlineIdx === -1) return null;
  let header;
  try {
    header = JSON.parse(result.stdout.subarray(0, newlineIdx).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.ok !== true) return null;
  const { size, postSize, readSoFar } = header;
  if (
    !Number.isFinite(size) ||
    !Number.isFinite(postSize) ||
    !Number.isFinite(readSoFar) ||
    size < 0 ||
    readSoFar < 0
  ) {
    return null;
  }
  const bytes = result.stdout.subarray(newlineIdx + 1);
  if (bytes.length !== readSoFar) return null; // truncated/garbled transport — do not trust a mismatched frame
  const length = Math.min(size, maxBytes);
  const truncatedByBytes = length < size;
  // Same three incompleteness signals as before, now sourced from the
  // worker's report instead of computed in-process.
  const shortRead = readSoFar < length;
  const grewOrShrank = postSize !== size;
  return {
    size,
    text: bytes.toString('utf8'),
    truncated: truncatedByBytes || shortRead || grewOrShrank,
  };
}

/**
 * PreToolUse context-rot handoff gate (slice 4). Loads `@adlc/context-handoff`
 * and evaluates D1–D3 via evaluateMutationGate / mutationGateInputFromLoad /
 * loadDenyRecords. Also protects deny-store paths and fail-closes Bash under
 * an active deny-set.
 */
/**
 * Credentials this hook must not expose to imported code.
 *
 * KEEP IN SYNC with `HOOK_SECRET_ENV_VARS` in
 * packages/context-handoff/lib/secret-scrub.mjs, pinned by
 * hooks/test/handoff-secret-scrub.test.mjs. Inlined rather than imported
 * because it must run BEFORE the package is loaded — loading the package is
 * precisely the step it protects.
 */
const HOOK_SECRET_ENV_VARS = ['ADLC_MANIFEST_KEY', 'ADLC_ADMIN_KEY'];

/**
 * The only environment variables forwarded to the `recordRecoveryUnderBand`
 * child. `resolveTrustedBinary`'s PATH search cannot fully verify the
 * resolved executable's provenance (see that function's comment), so this
 * spawn must assume the resolved binary could be attacker-controlled and
 * bound what it can read from the environment accordingly — a denylist of
 * just the two manifest/admin keys still forwards everything else the
 * operator's shell happens to export (cloud credentials, other tool tokens,
 * an SSH agent socket). An allowlist scoped to what `adlc gate-manifest
 * record` and the `git` probe it shells out to actually need bounds that
 * exposure instead. Because this record is explicitly best-effort and never
 * gates the recovery allow decision, an audit failure caused by a missing
 * environment variable is an acceptable, disclosed degradation — the same
 * class of residual as any other recording failure this path already
 * tolerates.
 */
const RECOVERY_AUDIT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'NODE_PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
];

/**
 * Delete credentials from this process's environment.
 *
 * handoff-resolve.mjs resolves the gate implementation from the PROJECT's
 * node_modules, so the module imported below is project-controlled code running
 * in this process and can read `process.env` directly. Scrubbing is scoped to
 * the `handoff` mode: the buildgate mode spawns `adlc gate-manifest record` as a
 * CHILD process that legitimately needs the key, and those modes never import
 * project-resolved code.
 */
function scrubHandoffSecrets(env = process.env) {
  const removed = [];
  for (const name of HOOK_SECRET_ENV_VARS) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/**
 * Resolve the absolute path of `name` on PATH, using an environment captured
 * BEFORE any project-controlled code has run. `loadContextHandoff` executes
 * a project-resolved package's top-level module code, which — as this
 * file's own secret-scrubbing comments already establish — must not be
 * trusted. A bare `spawnSync('adlc', ...)` issued AFTER that import does a
 * fresh PATH lookup against whatever `process.env.PATH` is AT THAT TIME; if
 * the imported package mutated it (prepending a directory with a malicious
 * `adlc`), the spawn in `recordRecoveryUnderBand` would run that
 * attacker-controlled binary instead of the real one. Binding the
 * executable's identity to the PRE-import PATH closes that specific window
 * (a runtime PATH mutation via the untrusted import).
 *
 * A separate exposure exists independent of runtime mutation: an ordinary
 * (never-mutated) PATH can already contain a project-local
 * `node_modules/.bin/adlc` shim ahead of a real global install — a
 * repository can ship that shim itself. Every PATH entry that resolves
 * inside a `node_modules` directory is skipped for that reason (a genuine
 * global install is never itself inside `node_modules`), and every
 * remaining candidate must also be owned by the CURRENT process's uid
 * (skipped otherwise, platforms where `process.getuid` exists) — a
 * project-writable or shared directory earlier on PATH can still contain a
 * file owned by this same user, which this check cannot distinguish from a
 * genuine install, but it does rule out a candidate owned by a different
 * (or root/system) account landing on PATH ahead of the real binary. Given
 * that, this function still cannot verify a same-uid candidate's symlink
 * target or content. `recordRecoveryUnderBand` does not hand this spawn the
 * manifest signing key or the admin key regardless of what runs here, and
 * `repoManifestChainIsSigned` refuses to spawn it at all once the manifest
 * has adopted signing, so the exposure this function cannot close is
 * limited to arbitrary code execution under the hook's own privileges by an
 * attacker who can already write same-uid files onto PATH, not credential
 * exfiltration through this path. Never throws; returns null (audit logging
 * is then skipped, best-effort) rather than guess.
 */
export function resolveTrustedBinary(name, pathEnv) {
  if (typeof pathEnv !== 'string' || pathEnv.length === 0) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    if (dir.includes('node_modules')) continue; // see the function comment
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      if (!st.isFile()) continue;
      if (selfUid !== null && st.uid !== selfUid) continue; // see the function comment
      return candidate;
    } catch {
      /* try next PATH entry */
    }
  }
  return null;
}

/** Bounds for `repoManifestChainIsSigned` — see that function's comment for why. */
const MANIFEST_SCAN_MAX_FILES = 500;
const MANIFEST_SCAN_MAX_BYTES_PER_FILE = 1 * 1024 * 1024;
const MANIFEST_SCAN_DEADLINE_MS = 1000;

/**
 * Whether ANY manifest entry reachable from `repoRoot` (root `.adlc/manifest.jsonl`
 * or any segment under `.adlc/manifest.d/`) carries a signature. Deliberately
 * fail-CLOSED (returns true — "treat as signed") whenever this cannot
 * positively prove otherwise: an unreadable file, a malformed JSONL line, or
 * an unexpected directory-listing failure all return true. `gate-manifest
 * record` does NOT fail closed on a missing key the way an earlier version of
 * this file's own comment claimed — `key: null` is a legal, silently-unsigned
 * append (see packages/tickets/lib/key-contract.mjs's `validateKeyParam` and
 * packages/gate-manifest/lib/record.mjs's `if (signingKey)` guard), and the
 * chain-integrity check it runs first only verifies the EXISTING prefix, not
 * whether the entry it is about to add would break an already-signed chain.
 * Appending an unsigned entry directly after a signed one silently corrupts
 * the chain for every later key-aware verification/preflight/tier-check.
 * `recordRecoveryUnderBand` never has a signing key to offer (see its own
 * comment), so it must refuse to append at all once the chain has adopted
 * signing — this is the check that makes "skip the append when no safe
 * signer exists" concrete.
 *
 * BOUNDED (Round-5 review): this runs SYNCHRONOUSLY, INLINE, before the
 * "unconditional" recovery allow decision returns — an earlier version read
 * every reachable file to completion with no byte, file-count, symlink, or
 * time bound. A huge or hostile `.adlc/manifest.d/` (a giant file, hundreds
 * of segments, or a symlink to an unbounded/blocking source such as a FIFO)
 * could hang or exhaust memory HERE, reproducing the exact "even the
 * recovery command itself is denied" total-lockout class of bug this ticket
 * exists to close — just triggered by manifest size instead of a threshold.
 * Every one of these limits degrades the SAME direction as every other
 * check in this function: hitting any of them proves nothing about
 * "unsigned", so the answer is "treat as signed" (skip the audit record),
 * never a hang and never a false "safe to append".
 * - `MANIFEST_SCAN_MAX_FILES`: caps directory fan-out.
 * - `MANIFEST_SCAN_MAX_BYTES_PER_FILE` + `boundedHandoffRead`: caps any
 *   single file's read, chunked with a deadline check between chunks (the
 *   same reader `observeHandoffSignals` already uses for the transcript
 *   scan) — a `truncated` result is treated as inconclusive, not partially
 *   parsed.
 * - `lstatSync(...).isFile()`, checked WITHOUT following symlinks: rejects
 *   symlinks, FIFOs, device files, and directories outright, before ever
 *   attempting to open them. `boundedHandoffRead`'s own `openSync` can still
 *   block on a genuine blocking special file it wasn't given a chance to
 *   reject — this check is what prevents that file from ever reaching it.
 * - `MANIFEST_SCAN_DEADLINE_MS`: an OVERALL wall-clock budget checked
 *   between files (not just within one), so many small files cannot
 *   collectively exceed it either.
 */
export function repoManifestChainIsSigned(repoRoot) {
  const startMs = Date.now();
  const files = [];
  try {
    const root = join(repoRoot, '.adlc', 'manifest.jsonl');
    if (existsSync(root)) files.push(root);
    const segDir = join(repoRoot, '.adlc', 'manifest.d');
    if (existsSync(segDir)) {
      // lstat the DIRECTORY itself, not following symlinks — a symlinked
      // manifest.d pointing at an unbounded/hostile directory must be
      // rejected before ever listing it (Round-5 review).
      let segDirStat;
      try {
        segDirStat = lstatSync(segDir);
      } catch {
        return true; // can't stat -> can't prove unsigned -> treat as signed
      }
      if (!segDirStat.isDirectory()) return true;
      // opendirSync + iterative reads, not readdirSync: readdirSync
      // materializes the ENTIRE directory listing into memory in one call
      // before this function ever gets a chance to check the file-count
      // cap — a directory with a huge number of entries would be fully
      // read regardless. Iterating lets the cap stop enumeration early.
      let dir;
      try {
        dir = opendirSync(segDir);
      } catch {
        return true; // can't enumerate -> can't prove unsigned -> treat as signed
      }
      try {
        let dirent;
        // Bound on EVERY entry examined, not just ones matching `.jsonl` —
        // files.length alone would never trip on a directory dominated by
        // non-.jsonl entries. Deadline checked here too, not only in the
        // later per-file loop below: enumeration itself is unbounded work.
        let examined = 0;
        while ((dirent = dir.readSync()) !== null) {
          examined += 1;
          if (examined > MANIFEST_SCAN_MAX_FILES) return true; // too much fan-out to bound -> treat as signed
          if (Date.now() - startMs > MANIFEST_SCAN_DEADLINE_MS) return true; // overall budget exceeded
          if (dirent.name.endsWith('.jsonl')) files.push(join(segDir, dirent.name));
        }
      } finally {
        try {
          dir.closeSync();
        } catch {
          /* best-effort close */
        }
      }
    }
  } catch {
    return true; // can't enumerate -> can't prove unsigned -> treat as signed
  }
  if (files.length > MANIFEST_SCAN_MAX_FILES) return true; // too much fan-out to bound -> treat as signed
  for (const file of files) {
    if (Date.now() - startMs > MANIFEST_SCAN_DEADLINE_MS) return true; // overall budget exceeded
    let st;
    try {
      st = lstatSync(file); // NOT following symlinks — see this function's comment
    } catch {
      return true; // can't stat -> can't prove unsigned -> treat as signed
    }
    if (!st.isFile()) return true; // symlink/FIFO/device/etc. -> can't safely bound a read -> treat as signed
    const result = boundedHandoffRead(file, {
      maxBytes: MANIFEST_SCAN_MAX_BYTES_PER_FILE,
      deadlineMs: Math.max(1, MANIFEST_SCAN_DEADLINE_MS - (Date.now() - startMs)),
    });
    if (result == null || result.truncated) return true; // unreadable or incomplete -> can't prove unsigned -> treat as signed
    for (const line of result.text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return true; // malformed line -> can't prove unsigned -> treat as signed
      }
      if (entry && typeof entry.sig === 'string' && entry.sig.length > 0) return true;
    }
  }
  return false; // every reachable entry examined and none carried a signature
}

/**
 * Best-effort audit record for an allowed Recovery Exception invocation
 * (spec §1.3). Attempted AFTER the allow decision is already final — this
 * function's own success or failure MUST NEVER affect that decision, and
 * MUST NEVER be allowed to block it either: a bounded `timeout` ensures a
 * stuck recorder cannot consume the hook's own execution budget and prevent
 * the "unconditional" recovery exception from actually completing.
 *
 * `trustedEnv` MUST be a snapshot of `process.env` captured BEFORE any
 * project-controlled code ran (see `handoff`'s capture, before
 * `scrubHandoffSecrets`/`loadContextHandoff`) — never the LIVE
 * `process.env` at call time. Resolving only the `adlc` executable's own
 * path from the pre-import PATH is not sufficient by itself: `adlc` is
 * itself a `#!/usr/bin/env node` script, and Node reads `NODE_OPTIONS` (and
 * other loader-affecting variables) from whatever environment the CHILD
 * process is spawned with. If that environment were rebuilt from the LIVE
 * `process.env` after importing a hostile project-resolved package, the
 * package could set `NODE_OPTIONS=--require=/malicious/preload.js` (or
 * otherwise poison the environment) and have it inherited by this spawn —
 * defeating the secret scrub via the child's own startup, not via `adlc`'s
 * resolved path at all. Using the frozen pre-import snapshot for the ENTIRE
 * child environment (not just PATH) closes that window for every OTHER
 * variable, but `resolveTrustedBinary`'s PATH search cannot fully verify the
 * resolved executable's provenance (ownership, symlink target, or content) —
 * a project-local PATH entry outside `node_modules` is still a possible
 * candidate. Given that, this function does NOT forward `ADLC_MANIFEST_KEY`
 * or `ADLC_ADMIN_KEY` to the child AT ALL, regardless of what `trustedEnv`
 * contains: the audit record this spawns is explicitly best-effort and never
 * gates the recovery allow decision, so it is not worth risking the
 * permanent manifest signing key to attempt it. Because there is never a key
 * to offer, `repoManifestChainIsSigned` is checked FIRST and the record is
 * skipped entirely once the chain has adopted signing — see that function's
 * comment for why a keyless append is not merely unsigned but actively
 * corrupting in that case.
 * `adlcBinPath` MUST be the pre-import-resolved absolute path from
 * `resolveTrustedBinary` — never a bare `'adlc'` string (see that function's
 * comment) — so this never runs against a null path.
 */
export function recordRecoveryUnderBand({ subcommand, sessionId, trustedEnv, adlcBinPath }) {
  if (repoManifestChainIsSigned(process.cwd())) {
    console.error(
      'ADLC context-handoff: recovery audit record skipped — the manifest chain already contains a signed entry and this hook has no signing key to offer; appending unsigned would corrupt the chain'
    );
    return;
  }
  if (!adlcBinPath) {
    console.error('ADLC context-handoff: recovery audit record skipped — adlc binary not found on PATH');
    return;
  }
  try {
    // Build the child's environment from RECOVERY_AUDIT_ENV_ALLOWLIST only —
    // never from trustedEnv wholesale minus a denylist — because
    // resolveTrustedBinary's PATH search cannot fully verify the resolved
    // executable's provenance (ownership, symlink target, content); see this
    // function's own doc comment and RECOVERY_AUDIT_ENV_ALLOWLIST's comment.
    const env = {};
    for (const name of RECOVERY_AUDIT_ENV_ALLOWLIST) {
      if (trustedEnv[name] !== undefined) env[name] = trustedEnv[name];
    }
    // Invoke via THIS process's own already-running interpreter
    // (process.execPath), never by executing adlcBinPath directly. `adlc` is
    // itself a `#!/usr/bin/env node` script — spawnSync(adlcBinPath, ...)
    // would let the OS's shebang handling hand off to `/usr/bin/env`, which
    // does its OWN, SEPARATE PATH lookup for `node` using this child's PATH
    // (Round-5 review). That second lookup is not filtered by
    // resolveTrustedBinary's node_modules exclusion — a repository dependency
    // that plants `node_modules/.bin/node` ahead of the real Node install on
    // PATH would have it picked up here, defeating that exclusion entirely.
    // Passing adlcBinPath as an argument to the CURRENT interpreter bypasses
    // the shebang/env indirection altogether: no second PATH lookup happens.
    const args = ['gate-manifest', 'record', 'context-handoff-recovery-under-band', '--data', JSON.stringify({ subcommand, sessionId, host: 'claude-code' })];
    const r = spawnSync(process.execPath, [adlcBinPath, ...args], { encoding: 'utf8', env, timeout: 5000 });
    if (r.error || (typeof r.status === 'number' && r.status !== 0) || r.signal) {
      console.error(
        `ADLC context-handoff: recovery audit record failed (${r.error?.message ?? `status=${r.status} signal=${r.signal}`}) — recovery command was still allowed`
      );
    }
  } catch (err) {
    console.error(`ADLC context-handoff: recovery audit record errored (${err?.message ?? 'unknown'}) — recovery command was still allowed`);
  }
}

/**
 * Recovery Exception & Inspection Bash Exception (spec §1.3), using ONLY
 * trusted local code and the raw hook input — no dependency on `.adlc`
 * existing at the current directory, on `chdir`/ADLC-root discovery having
 * succeeded, or on `@adlc/context-handoff` having loaded. Two independent
 * lockout causes were found and fixed here in sequence: (1) if this check
 * depended on the project-resolved package loading successfully, a
 * stale/incompatible install or a hostile package could deny `pwd` and the
 * recovery CLI before ever reaching it; (2) even after this was made
 * package-independent, `main()`'s dispatcher still performed TWO `chdir`
 * calls (into the tool's project dir, then into the discovered ADLC root)
 * BEFORE ever invoking `handoff()` at all — a stale/inaccessible
 * `CLAUDE_PROJECT_DIR`, or a discovered root the process couldn't enter,
 * failed closed via `failClosedHandoffEnter` in `main()` itself, denying
 * `pwd` and recovery without this function ever running. `main()` now calls
 * this BEFORE either `chdir`, using whatever `process.cwd()` the hook
 * process started with; `handoff()` calls it again after both `chdir`s
 * succeed, since a different `process.cwd()` can change what
 * `resolveContextHandoffEntry` finds. Tool-identity gate reuses the SAME
 * `isBash` check used elsewhere in this file: Claude Code's wire shape has
 * one unambiguous `tool_name` field, so there is nothing narrower to gate on
 * here (unlike Codex — see adlc-handoff-gate.mjs's own comment). MUST allow
 * regardless of band state, and regardless of any Hard-Degraded/deny check.
 *
 * @param {object} input hook payload
 * @returns {boolean} true when matched and allowed (caller must return
 *   immediately, no further output); false when nothing matched (caller
 *   continues its normal flow).
 */
function tryRecoveryOrInspectionException(input) {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const isBash = toolName === 'Bash' || toolName === 'Shell';
  if (!isBash) return false;
  const bashCommand = bashCommandFromInput(input);
  if (isBareInspectionPwd(bashCommand)) return true; // unconditional allow, no audit record

  // A full snapshot of process.env captured BEFORE any project-controlled
  // code has run — see recordRecoveryUnderBand's comment for why the
  // audit-record spawn must use this frozen copy rather than ever re-reading
  // the live process.env once loadContextHandoff has executed untrusted
  // code. recordRecoveryUnderBand itself strips ADLC_MANIFEST_KEY/
  // ADLC_ADMIN_KEY from this snapshot before spawning — see its comment.
  const trustedEnvSnapshot = { ...process.env };
  // Resolved from the PRE-import PATH — see resolveTrustedBinary's comment
  // for why this must happen before loadContextHandoff runs project code.
  const trustedAdlcBinPath = resolveTrustedBinary('adlc', trustedEnvSnapshot.PATH);
  const sessionId = resolveSessionId(input, { isSafeSessionId });

  // resolveContextHandoffEntry only resolves the package's on-disk location
  // (a filesystem/module-resolution lookup) — it does NOT `import()`/execute
  // the package, so THIS RESOLUTION STEP stays safe even when the package's
  // own code is broken or hostile: nothing here runs untrusted code to
  // compute trustedRecoveryCliPath. Resolution itself, however, walks the
  // PROJECT's own node_modules the same way loadContextHandoff does
  // elsewhere in this file — a repository that ships its own
  // @adlc/context-handoff package controls what path this resolves to, and
  // therefore what script the matcher below treats as "the" recovery CLI.
  // matchRecoveryCommand proves the invoked command targets that resolved
  // path (by realpath identity); it does not independently prove that path
  // is the genuine, unmodified package this repository was built against
  // (same residual as the Codex adapter's identical comment in
  // adlc-handoff-gate.mjs).
  const entry = resolveContextHandoffEntry({ projectRoot: process.cwd() });
  const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
  if (!trustedRecoveryCliPath) return false;

  const recoveryMatch = matchRecoveryCommand(bashCommand, {
    interpreterPath: process.execPath,
    scriptPath: trustedRecoveryCliPath,
    sessionId,
  });
  if (!recoveryMatch.matched) return false;

  recordRecoveryUnderBand({
    subcommand: recoveryMatch.subcommand,
    sessionId,
    trustedEnv: trustedEnvSnapshot,
    adlcBinPath: trustedAdlcBinPath,
  });
  return true; // allow — never gated on the audit record above succeeding
}

async function handoff(input) {
  if (tryRecoveryOrInspectionException(input)) return;
  if (!existsSync('.adlc')) return; // not an ADLC repo → allow

  const sessionId = resolveSessionId(input, { isSafeSessionId });

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const isBash = toolName === 'Bash' || toolName === 'Shell';
  const bashCommand = isBash ? bashCommandFromInput(input) : '';

  // Host-side bypass-grant verification — MUST run here, after session
  // resolution but BEFORE the secret scrub below and before the
  // project-resolved package is imported: it is the only point where trusted
  // code holds ADLC_MANIFEST_KEY and no
  // project-controlled code has executed. The key is used to verify the
  // grant with this plugin's own trusted twin (readVerifiedBypassGrant,
  // handoff-gate.mjs "KEEP IN SYNC (3)") and never crosses into the
  // project-resolved package — only the three-state verdict below does.
  //   undefined = no key in this environment (or no session): the host makes
  //               no claim, the adapter behaves exactly as before.
  //   null      = key present, no valid grant: authoritative "no grant".
  //   object    = key present, grant verified: authorizes one mutation.
  let verifiedBypassGrant;
  const manifestKeyPreScrub = process.env.ADLC_MANIFEST_KEY;
  if (typeof manifestKeyPreScrub === 'string' && manifestKeyPreScrub.length > 0 && sessionId) {
    const grant = readVerifiedBypassGrant(process.cwd(), sessionId, { key: manifestKeyPreScrub });
    verifiedBypassGrant = grant && grant.verified === true ? grant : null;
  }

  // Before anything project-controlled can be imported.
  scrubHandoffSecrets();

  const api = await loadContextHandoff({ projectRoot: process.cwd() });
  if (!api) {
    return denyHandoff(
      `cannot load @adlc/context-handoff — install @adlc/cli (or the workspace package) so D1–D3 can be evaluated; failing closed\n\n${recoveryDiagnostic(sessionId)}`
    );
  }

  const required = [
    'evaluateHandoffPreToolUse',
    'resolveHandoffSessionId',
    'isProtectedHandoffPath',
    'isHandoffMutatingShell',
    'isSafeSessionId',
  ];
  for (const method of required) {
    if (typeof api[method] !== 'function') {
      return denyHandoff(
        `@adlc/context-handoff missing export: ${method} — the resolved install is too old for this plugin; upgrade it (npm install -g @adlc/cli@latest) — failing closed\n\n${recoveryDiagnostic(sessionId)}`
      );
    }
  }
  if (!Number.isFinite(api.MAX_ACTIVE_CONTEXT_BYTES) || !Number.isFinite(api.MAX_SCAN_WALL_MS)) {
    return denyHandoff(`@adlc/context-handoff missing scan-budget exports — failing closed\n\n${recoveryDiagnostic(sessionId)}`);
  }

  const { observed, truncated: scanTruncated } = observeHandoffSignals(input, {
    maxActiveContextBytes: api.MAX_ACTIVE_CONTEXT_BYTES,
    maxScanWallMs: api.MAX_SCAN_WALL_MS,
  });

  let ticketId = null;
  try {
    const active = resolveActiveTicketIdForBuildGate();
    if (!active.conflict && active.id) ticketId = active.id;
  } catch {
    /* unbound marker is fine */
  }

  let editRelPaths = [];
  if (!isBash) {
    try {
      editRelPaths = targetFilePaths(input).map((fp) => toRepoRelative(fp));
    } catch (err) {
      return denyHandoff(
        `could not resolve edit target for handoff path protection (${err?.message ?? 'unknown'}) — failing closed\n\n${recoveryDiagnostic(sessionId)}`
      );
    }
  }

  const result = api.evaluateHandoffPreToolUse({
    root: process.cwd(),
    sessionId,
    observed,
    ticketId,
    editRelPaths,
    isBash,
    bashCommand,
    host: 'claude-code',
    // NO manifest key here, deliberately — see the same note in
    // plugins/adlc-codex/hooks/adlc-handoff-gate.mjs. handoff-resolve.mjs
    // resolves the package from the PROJECT's node_modules, so that module is
    // project-controlled code and must never be handed the manifest signing
    // key. The cost is that a signed resume-auth cannot be verified in-session.
    // A bypass grant CAN be: this hook verified it above with its own trusted
    // twin before the scrub, and passes only the verdict — never the key.
    manifestKey: null,
    verifiedBypassGrant,
    // A hook is a fresh process per call, so there is no in-memory D1 fact to
    // carry. When a marker write SUCCEEDS the sentinel records the session and
    // mutationGateInputFromLoad reconstructs stickiness from registeredSessions.
    // When the write FAILS there is nothing durable to reconstruct from, so a
    // later call whose band has cooled will not know — a residual gap that needs
    // host-owned storage surviving the subprocess, not a flag here.
    denyEverWritten: false,
    scanTruncated,
  });

  if (!result.deny) return;

  return denyHandoff(
    `mutation denied (${result.reasons.join(', ')}). Resume via host \`adlc handoff resume\` / repair, ` +
      `or continue in a fresh session. Agent Shell cannot clear deny-set.\n\n` +
      `${CAPTURE_INSTRUCTION}\n\n${recoveryDiagnostic(sessionId)}`
  );
}

/**
 * Set by `adlc handoff supervise` on every harness child it spawns (twin of the
 * package's `SUPERVISOR_ENV_MARKER`, lib/supervise.mjs; pinned by
 * adapter-test/cc-helper-drift.test.mjs).
 *
 * Read for SUPPRESSION only. Under the wrapper the successor already receives
 * the capture as its bootstrap prompt, so injecting it again here would hand
 * the model the same handoff twice. A forged value costs an operator one
 * advisory injection and can never clear, weaken, or grant anything — which is
 * why an unverified environment variable is enough for this decision and would
 * not be for any other in this file.
 */
const SUPERVISOR_ENV_MARKER = 'ADLC_HANDOFF_SUPERVISED';

/**
 * The open deny an operator most likely needs to act on.
 *
 * `since` is an ISO timestamp written by `ensureDenyMarker`. A record whose
 * timestamp is missing or unparseable still counts as a candidate — it is an
 * open deny either way — it just sorts oldest, because an unknown time is not
 * evidence of being recent.
 *
 * @param {unknown[]} records
 * @returns {object|null}
 */
export function newestOpenDeny(records) {
  if (!Array.isArray(records)) return null;
  let best = null;
  let bestAt = -Infinity;
  for (const record of records) {
    if (!record || typeof record !== 'object' || record.status !== 'open') continue;
    const at = Date.parse(record.since);
    const rank = Number.isFinite(at) ? at : -Infinity;
    if (best === null || rank > bestAt) {
      best = record;
      bestAt = rank;
    }
  }
  return best;
}

/**
 * SessionStart continuation notice — the keyless, near-automatic half of the
 * handoff continuation (spec §Continue, §Supervised-only auto-consume).
 *
 * ADVISORY, and keyless by construction. Two branches:
 *
 *   (a) This session already holds a resume-auth — a host (`handoff continue`,
 *       usually driven by `handoff supervise`) consumed a deny FOR it. The
 *       capture it was authorized against is injected as context, re-verified
 *       against the bytes on disk first. Note the condition is the resume-auth
 *       alone, NOT an open deny: a completed continuation leaves the denier's
 *       record `consumed`, so gating this on an open deny would skip exactly
 *       the successor it exists for.
 *
 *   (b) There is no auth for this session but the store holds open denies —
 *       this session cannot mutate anything until an operator continues one.
 *       It gets the exact command, and nothing else happens.
 *
 * What this NEVER does is consume. Hooks are key-scrubbed (see
 * `scrubHandoffSecrets`), consume requires the manifest key to sign a
 * resume-auth, and the spec's supervised-only rule exists precisely so a fresh
 * session cannot authorize itself out of somebody else's deny. Reading a
 * capture is not a mutation and needs no key: `readVerifiedCapture` re-derives
 * a plain sha256, so an edited capture fails here exactly as it does in the
 * mutation gate.
 */
async function handoffStart(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo → silent
  const sessionId = resolveSessionId(input, { isSafeSessionId });

  // This path never reads ADLC_MANIFEST_KEY — but it does import a
  // project-resolved package below, and an operator's shell holds the key at
  // session start, so the scrub still has to happen first.
  scrubHandoffSecrets();

  const api = await loadContextHandoff({ projectRoot: process.cwd() });
  // Advisory: an unresolvable or stale package means no notice, never a block.
  if (!api || typeof api.loadDenyRecords !== 'function') return;

  const root = process.cwd();
  const eventName =
    typeof input?.hook_event_name === 'string' && input.hook_event_name
      ? input.hook_event_name
      : 'SessionStart';

  // (a) — a resume-auth document names THIS session.
  //
  // TRUST BOUNDARY (ruled 2026-08-20). This branch is ADVISORY CONTEXT
  // SURFACING, not an authorization decision, and it must never present itself
  // as one. The hook scrubs ADLC_MANIFEST_KEY before it imports anything (see
  // `scrubHandoffSecrets`), so it structurally CANNOT verify the resume-auth's
  // HMAC — that seam is deliberately closed, and re-opening it to make this
  // check "real" would hand the manifest trust anchor to project-resolved code.
  //
  // What still holds without a key: `readVerifiedCapture` re-derives the
  // capture's sha256 from disk, so altered or missing content is refused here
  // exactly as it is in the mutation gate, and `buildBootstrapPrompt` fences the
  // body so a previous session's words cannot read as instructions. What does
  // NOT hold: that this session is an authorized continuation. Enforcement of
  // that lives where a key exists — the supervised wrapper, the mutation gate's
  // own capture-hash re-derivation on every mutation, and CI. The message below
  // says so rather than asserting a continuation this code cannot establish.
  const auth =
    sessionId && typeof api.readResumeAuth === 'function' ? api.readResumeAuth(root, sessionId) : null;
  if (auth && typeof api.readVerifiedCapture === 'function') {
    if (process.env[SUPERVISOR_ENV_MARKER] === '1') return; // wrapper already injected it
    if (typeof api.isSafeSessionId !== 'function' || !api.isSafeSessionId(auth.deny_session_id)) return;
    let capture;
    try {
      capture = api.readVerifiedCapture(root, auth.deny_session_id, auth.content_hash);
    } catch {
      return; // a capture that cannot be read is a capture that is not injected
    }
    if (!capture?.ok || typeof api.buildBootstrapPrompt !== 'function') return;
    // The package's own composition — preamble, fences, and the closing
    // reminder that everything between them is data. Rebuilding it here would
    // be a second copy of the one text whose job is to keep a previous
    // session's words from reading as instructions.
    const built = api.buildBootstrapPrompt({
      denySessionId: auth.deny_session_id,
      ticketId: auth.ticket_id,
      body: capture.body,
      // The MODEL-facing half of the same honesty the systemMessage carries.
      // The assertive composition tells the reader "this is the continuation,
      // continue the work" — true when a host with the key composed it, and a
      // claim this hook cannot make. Passing the hedge is what keeps the two
      // audiences (operator and model) being told the same thing.
      verified: false,
    });
    if (!built?.ok) return;
    emit({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: built.prompt },
      systemMessage:
        `ADLC context-handoff: surfacing an UNVERIFIED handoff capture from session ${auth.deny_session_id} ` +
        `(ticket ${auth.ticket_id}) as context. This hook is keyless by design and cannot verify the ` +
        'resume-auth signature, so nothing here establishes that this session may continue that work — ' +
        'that is decided by `adlc handoff supervise` or a host holding the manifest key.',
    });
    return;
  }

  // (b) — no auth for this session; name the deny that is blocking mutations.
  const loaded = api.loadDenyRecords(root);
  const newest = newestOpenDeny(loaded?.records);
  if (!newest) return;
  const command =
    typeof api.formatContinueCommand === 'function' ? api.formatContinueCommand(newest.session_id) : null;
  const msg =
    'ADLC context-handoff: an open handoff deny is blocking mutations in this repo. This session cannot ' +
    'clear it — a host must continue the denied session, which consumes the deny for ONE successor. Run:\n  ' +
    (command ?? 'ADLC_MANIFEST_KEY=… adlc handoff continue --deny-session <id> --write   (read <id> from .adlc/handoffs/denies/)');
  emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext: msg }, systemMessage: msg });
}

/**
 * The recovery-command (or no-safe-session-id) tail every Hard-Degraded/deny
 * diagnostic message MUST include (spec §1.3) — not just a description of
 * why telemetry degraded, but the literal, copy-pasteable command itself.
 *
 * Round-5 review: this used to format via `api.formatRecoveryCommand` /
 * `api.RECOVERY_CLI_PATH` — the SAME dynamically-loaded, project-resolved
 * package whose failure to load or export what's expected is exactly what
 * every early denyHandoff() in `handoff()` is reporting when it appends this
 * diagnostic. A stale/incompatible install left the operator with a generic,
 * repo-relative "run the CLI manually" message that named no absolute path
 * `matchRecoveryCommand` would actually accept — stranding them with only
 * `pwd`. This now builds the diagnostic ENTIRELY from trusted local code —
 * `formatRecoveryCommand`/`formatNoSessionIdMessage` (this file's own
 * imports from handoff-gate.mjs, twins of the package's, see the "KEEP IN
 * SYNC (2)" note there) and `resolveContextHandoffEntry` (a pure,
 * execution-free module-resolution lookup, not an `import()` of the
 * package) — the same trusted resolution `tryRecoveryOrInspectionException`
 * already uses for the matcher itself, so the diagnostic and the exception
 * it describes can never disagree about where the CLI lives.
 */
export function recoveryDiagnostic(sessionId, { resolveEntry = resolveContextHandoffEntry } = {}) {
  // `resolveEntry` is injectable for one reason: the unresolved branch below
  // is unreachable in a test that runs on a machine where @adlc/cli happens
  // to be installed, and that branch is precisely the message issue #526
  // found stranding operators.
  const entry = resolveEntry({ projectRoot: process.cwd() });
  const trustedRecoveryCliPath = entry ? join(dirname(dirname(entry)), 'bin', 'handoff.mjs') : null;
  if (!trustedRecoveryCliPath) {
    return 'Recovery command unavailable: @adlc/context-handoff could not be resolved from this project, from this plugin, or from a global @adlc/cli install. Install it (npm install -g @adlc/cli) and re-run, then drive the operator recovery CLI with its own bin: handoff bypass|unlock|repair|write|resume. `pwd` remains usable regardless.';
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    let interpreterPath = process.execPath;
    let scriptPath = trustedRecoveryCliPath;
    try {
      interpreterPath = realpathSync(interpreterPath);
    } catch {
      /* fall back to the unresolved path rather than throw from a diagnostic */
    }
    try {
      scriptPath = realpathSync(scriptPath);
    } catch {
      /* fall back to the unresolved path rather than throw from a diagnostic */
    }
    return formatRecoveryCommand({ interpreterPath, scriptPath, sessionId });
  }
  return formatNoSessionIdMessage();
}

// Only run as a hook when executed directly — tests import this module for
// its pure exports (recordRecoveryUnderBand, recoveryDiagnostic,
// resolveTrustedBinary, tryRecoveryOrInspectionException, ...) and must not
// trigger a live stdin read + process.exit as a side effect of the import.
// Mirrors the equivalent guard in plugins/adlc-codex/hooks/adlc-handoff-gate.mjs.
//
// pathToFileURL, never `file://${argv[1]}`: a path containing a space (or any
// character a file URL percent-encodes, and every Windows path) would not match
// import.meta.url, so main() would silently never run and the hook would exit 0
// — reading as ALLOW. An enforcing gate that no-ops on an install path is worse
// than one that errors.
const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await main();
  } catch (err) {
    // The `rails`/`buildgate`/`handoff` modes are ENFORCING — a crash must FAIL CLOSED,
    // never fall through to exit 0 (which the harness reads as "allow"). Emit a
    // deny and exit 2 so the PreToolUse call is blocked even if the deny
    // payload is missed. The advisory modes (preflight/flail/manifest/review)
    // legitimately swallow their own errors.
    if (MODE === 'rails') {
      try {
        denyRail(`rails hook errored (${err?.message ?? 'unknown'}) — failing closed`);
      } catch {
        /* even emit failed — the non-zero exit below still blocks */
      }
      process.exit(2);
    }
    if (MODE === 'buildgate') {
      try {
        denyBuildGate(`build-gate hook errored (${err?.message ?? 'unknown'}) — failing closed`);
      } catch {
        /* even emit failed — the non-zero exit below still blocks */
      }
      process.exit(2);
    }
    if (MODE === 'handoff') {
      try {
        denyHandoff(`handoff hook errored (${err?.message ?? 'unknown'}) — failing closed\n\n${recoveryDiagnostic(lastKnownSessionId)}`);
      } catch {
        /* even emit failed — the non-zero exit below still blocks */
      }
      process.exit(2);
    }
  }
  process.exit(0);
}
