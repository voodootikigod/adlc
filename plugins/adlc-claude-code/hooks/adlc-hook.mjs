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
//
// CONTRACT: preflight/flail/manifest must NEVER block and stay SILENT unless
// there is something to flag. `rails` and `buildgate` are the two unconditional
// enforcement hooks — either can DENY an Edit/Write (via a permissionDecision in
// its JSON output, not via exit code, though exit 2 is also set as a fail-closed
// belt-and-suspenders). `review` is advisory by default (systemMessage only) and
// only blocks (Stop `decision: "block"`, forcing the session to continue rather
// than end) when the operator has explicitly opted in — see review()'s own
// comment for the rationale. All five modes still ALWAYS exit 0 on the allow
// path and never surface their own errors; if the toolkit isn't installed or the
// repo isn't ADLC-initialized, every mode no-ops. Both enforcing gates are
// themselves a no-op until a ticket declares `rails` paths / an active ticket is
// resolved, so installing the plugin can't brick a clean repo.
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
} from 'node:fs';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadTicketStoreReadOnly, ticketStoreExists } from './generated-ticket-reader.mjs';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

const MODE = process.argv[2];

// The tool's invocation directory (where relative `file_path`s are anchored),
// captured BEFORE we walk up to the repo root. Relative edit targets must resolve
// against this, not the walked-up cwd, or `secret.js` from `src/` would resolve
// to repo-root `secret.js` and dodge the `src/**` rail.
let baseDir = null;

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

function main() {
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
  const input = parsed ?? {};

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
    return;
  }

  // The starting dir may be a SUBDIRECTORY of the repo (CLAUDE_PROJECT_DIR unset,
  // cwd = src/). Find the ADLC root and operate there, so a frozen-rail edit can't
  // slip past just because the hook ran from a subdir (which would otherwise find
  // no `.adlc/` and no-op = fail open). Anchor to the GIT ROOT first so a nested
  // `.adlc/` in a subdirectory can't shadow the repo-wide config; only fall back
  // to the nearest-ancestor `.adlc/` when there is no enclosing git repo.
  let adlcRoot = null;
  let gitRoot = null;
  for (let cur = process.cwd(), i = 0; i < 256; i++) {
    if (gitRoot === null && existsSync(join(cur, '.git'))) gitRoot = cur;
    if (adlcRoot === null && existsSync(join(cur, '.adlc'))) adlcRoot = cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Prefer the .adlc at the git root; else the nearest-ancestor .adlc.
  const root = gitRoot && existsSync(join(gitRoot, '.adlc')) ? gitRoot : adlcRoot;
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
      return;
    }
  }

  if (MODE === 'preflight') return preflight();
  if (MODE === 'flail') return flail(input);
  if (MODE === 'manifest') return manifest();
  if (MODE === 'review') return review(input);
  if (MODE === 'rails') return rails(input);
  if (MODE === 'buildgate') return buildgate(input);
  // unknown mode → no-op
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
function manifest() {
  if (!existsSync(join('.adlc', 'manifest.jsonl'))) return; // nothing recorded yet
  const r = runAdlc(['gate-manifest', 'verify', '--json']);
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

// Minimal glob matcher — ported VERBATIM from @adlc/core lib/tickets.mjs
// `globMatch` (the hook can't resolve @adlc/core at runtime). Supports `*`
// within a segment and `**` across segments. KEEP IN SYNC with core.
function globMatch(pattern, path) {
  const regex = new RegExp(
    '^' +
      pattern
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) => {
          if (part === '**/') return '(?:.*/)?';
          if (part === '**') return '.*';
          if (part === '*') return '[^/]*';
          return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('') +
      '$'
  );
  return regex.test(path);
}

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

  const bypass = process.env.ADLC_RAILS_BYPASS === '1';
  const subject = fps.length ? fps.join(', ') : `(unparsed ${input.tool_name ?? 'edit'} target)`;

  // A bypass is only honored if it can be AUDITED. If recording fails (adlc
  // missing, .adlc unwritable, record errors), an unaudited override is refused.
  const bypassOrDeny = (tag, denyReason) => {
    if (bypass) {
      if (recordBypass(subject, tag)) return; // audited override → allow
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
    for (const r of t.rails ?? []) {
      if (typeof r !== 'string') {
        return failClosed(
          `a ticket in .adlc/tickets.json has a non-string rail entry;`,
          'invalid-rail-entry-bypass'
        );
      }
      const tid = typeof t.id === 'string' ? t.id : '?';
      const normGlob = r.split('\\').join('/'); // normalize Windows-style backslashes
      railDecls.push({ glob: normGlob, ticket: tid });
      const canon = canonRailGlob(r); // symlink-resolved form, for symmetry with resolved targets
      if (canon !== normGlob) railDecls.push({ glob: canon, ticket: tid });
    }
  }
  if (railDecls.length === 0) return; // schema-valid, no rails declared → no-op

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

  if (bypass) {
    // Honor the override only if EVERY hit is durably audited; otherwise refuse.
    let allRecorded = true;
    for (const h of hits) {
      if (!recordBypass(h.rel, `rail ${h.glob} (ticket ${h.ticket})`)) allRecorded = false;
    }
    if (allRecorded) return; // every bypass recorded → allow
    return denyRail(
      `ADLC_RAILS_BYPASS is set but a rail override could not be recorded to the gate-manifest ` +
        `(is @adlc/cli installed and .adlc writable?). An unaudited bypass is refused — the edit is blocked.`
    );
  }

  const h = hits[0];
  return denyRail(
    `${h.rel} is a frozen rail declared by ticket ${h.ticket} (rails: "${h.glob}")` +
      `${hits.length > 1 ? ` (+${hits.length - 1} more rail path(s) in this edit)` : ''}. ` +
      `Edits to frozen rails are blocked during build. To override deliberately, set ` +
      `ADLC_RAILS_BYPASS=1 (the bypass is recorded to the gate-manifest).`
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
/** KEEP IN SYNC with packages/build-gate/lib/depth-signal.mjs's DEFAULT_BYTES_THRESHOLD. */
const BUILD_GATE_BYTES_THRESHOLD = 256 * 1024;

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

  // Context-fitness signal: bounded transcript scan, mirroring flail()'s own
  // MAX_SCAN_BYTES windowing so this stays O(MAX_SCAN_BYTES) regardless of how
  // long the session runs. `sessionBytes` reflects the WHOLE transcript file
  // (fileSize), while the tool-call count is over a bounded recent window —
  // same split flail() already makes.
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
  if (sessionBytes > MAX_SCAN_BYTES) {
    windowText = tailBytes(tp, MAX_SCAN_BYTES);
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

  const degraded = depth > BUILD_GATE_DEPTH_THRESHOLD || sessionBytes > BUILD_GATE_BYTES_THRESHOLD;
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

try {
  main();
} catch (err) {
  // The `rails`/`buildgate` modes are ENFORCING — a crash must FAIL CLOSED,
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
}
process.exit(0);
