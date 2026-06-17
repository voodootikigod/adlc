#!/usr/bin/env node
// ADLC hooks — one helper, four modes:
//   preflight  (SessionStart)  → environment readiness before fan-out  [advisory]
//   flail      (PostToolUse)    → flail-detection over the transcript    [advisory]
//   manifest   (Stop)           → gate-evidence chain integrity audit    [advisory]
//   rails      (PreToolUse)     → block edits to frozen rail paths        [ENFORCING]
//
// CONTRACT: the three advisory modes must NEVER block and stay SILENT unless
// there is something to flag. The `rails` mode is the ONE enforcement hook — it
// can DENY an Edit/Write (via a permissionDecision in its JSON output, not via
// exit code). All four modes still ALWAYS exit 0 and never surface their own
// errors; if the toolkit isn't installed or the repo isn't ADLC-initialized,
// every mode no-ops. The rails enforcement is itself a no-op until a ticket
// declares `rails` paths, so installing the plugin can't brick a clean repo.
//
// Output: when there is something to say, print ONE JSON object using fields
// Claude Code recognizes (`systemMessage`; `hookSpecificOutput.additionalContext`
// for SessionStart; `hookSpecificOutput.permissionDecision` for PreToolUse).

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

const MODE = process.argv[2];

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
 * Run an `adlc` subcommand. Returns the spawn result, or null when the toolkit
 * is not on PATH (ENOENT) — the signal to no-op rather than error.
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
  // The enforcing rails hook must FAIL CLOSED if it cannot even read/parse its own
  // input (empty stdin, malformed JSON) — it cannot verify rails. Advisory modes
  // tolerate a missing payload and no-op.
  if (MODE === 'rails' && parsed === null) {
    denyRail('rails hook received unreadable/malformed input — failing closed');
    return; // unreachable: denyRail exits 2
  }
  const input = parsed ?? {};

  // Operate in the project root so the tools resolve `.adlc/` correctly.
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try {
    process.chdir(dir);
  } catch {
    // The enforcing rails hook must FAIL CLOSED if it can't even enter the project
    // dir (it cannot verify rails). Advisory modes just no-op.
    if (MODE === 'rails') {
      try {
        denyRail('rails hook could not enter the project directory — failing closed');
      } catch {
        /* deny emit failed; the exit 2 below still blocks */
      }
      process.exit(2);
    }
    return;
  }

  if (MODE === 'preflight') return preflight();
  if (MODE === 'flail') return flail(input);
  if (MODE === 'manifest') return manifest();
  if (MODE === 'rails') return rails(input);
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
  for (let guard = 0; guard < 4096; guard++) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    } catch {
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
  return abs; // pathological depth → lexical fallback
}

function toRepoRelative(fp) {
  let root;
  try {
    root = realpathSync(process.cwd());
  } catch {
    root = process.cwd();
  }
  const real = realResolve(resolve(process.cwd(), fp));
  return relative(root, real).split('\\').join('/');
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
// regardless of how it was produced. See docs/adr-adlc-command-reconciliation.md.
function rails(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo
  const ticketsPath = join('.adlc', 'tickets.json');
  if (!existsSync(ticketsPath)) return; // no tickets → no rails declared

  const fps = targetFilePaths(input);
  // A non-structured-edit tool (e.g. Bash) reaching here has no path to gate →
  // CI-gate territory, allow. But a STRUCTURED edit tool that yields NO path is
  // an unrecognized payload shape we can't verify — fail closed below (after we
  // confirm rails are actually declared, so a no-rails repo still can't brick).
  const STRUCTURED_EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const isStructuredEdit = STRUCTURED_EDIT.has(input.tool_name);
  // If a tool_name is present and it is NOT a structured edit, this is a non-edit
  // tool (e.g. a reader) that carries a path — not ours to gate; allow. When
  // tool_name is absent we trust the matcher (which only routes edit tools here)
  // and gate by the path. Either way a non-edit tool with no path no-ops.
  if (input.tool_name && !isStructuredEdit) return;
  if (fps.length === 0 && !isStructuredEdit) return;

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
    parsed = JSON.parse(readFileSync(ticketsPath, 'utf8'));
  } catch (e) {
    return failClosed(`cannot read .adlc/tickets.json (${e.message});`, 'unparseable-tickets-bypass');
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
      railDecls.push({ glob: r, ticket: typeof t.id === 'string' ? t.id : '?' });
    }
  }
  if (railDecls.length === 0) return; // schema-valid, no rails declared → no-op

  // The rail config is its own trust root: once rails exist, editing
  // .adlc/tickets.json to remove them would silently disable enforcement, so
  // freeze it too (audited bypass still allowed for deliberate changes).
  railDecls.push({ glob: '.adlc/tickets.json', ticket: '(rail trust root)' });

  // A structured edit whose target path we couldn't extract, while rails are
  // declared, can't be verified → fail closed.
  if (fps.length === 0) {
    return failClosed(`could not extract the target path from this ${input.tool_name} payload;`, 'unparsed-edit-target-bypass');
  }

  // Collect EVERY target path that hits a rail (a multi-file edit must be denied
  // if ANY path is a rail, and EACH hit must be audited on bypass).
  const hits = [];
  for (const fp of fps) {
    const rel = toRepoRelative(fp);
    const hit = railDecls.find((r) => globMatch(r.glob, rel));
    if (hit) hits.push({ rel, glob: hit.glob, ticket: hit.ticket });
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

try {
  main();
} catch (err) {
  // The `rails` mode is ENFORCING — a crash must FAIL CLOSED, never fall through
  // to exit 0 (which the harness reads as "allow"). Emit a deny and exit 2 so the
  // PreToolUse call is blocked even if the deny payload is missed. The advisory
  // modes (preflight/flail/manifest) legitimately swallow their own errors.
  if (MODE === 'rails') {
    try {
      denyRail(`rails hook errored (${err?.message ?? 'unknown'}) — failing closed`);
    } catch {
      /* even emit failed — the non-zero exit below still blocks */
    }
    process.exit(2);
  }
}
process.exit(0);
