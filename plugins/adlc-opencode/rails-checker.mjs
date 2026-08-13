// rails-checker.mjs — the ADLC rail-enforcement decision for OpenCode.
//
// This is a THIN adapter: every rail/glob/ticket primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0004 / integration-plan §6.6).
// It must NOT re-implement glob or ticket loading. The only non-core logic here
// is mapping OpenCode's hook arguments onto that core and the sibling-hook
// enforcement contract (active-ticket resolution, phase gating, trust-root
// freeze) that adlc-codex and adlc-pi already implement.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadTickets, globMatch, classifyShellCommand, collectPatchPaths, resolveRailPath, ticketStoreExists, TICKET_TRUST_ROOT_RAILS } from '@adlc/core';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

// Re-exported for API stability: sibling adapters and tests may import the
// symlink-aware resolver from this module even though @adlc/core owns it now.
export { resolveRailPath };

// The ticket file and the active-ticket pointer are the rail trust root: they are
// frozen whenever enforcement is active, even if no ticket declares them, so the
// rail set cannot be quietly edited away. Mirrors adlc-codex/hooks/adlc-rails-guard.mjs.
export const TRUST_ROOT_RAILS = [...TICKET_TRUST_ROOT_RAILS];

// OpenCode's known structured file-mutation tools.
export const MUTATING_TOOLS = ['edit', 'write', 'patch', 'multiedit', 'apply_patch'];

// Shell tools: gated in-session since Phase 2.2 via the @adlc/core shell
// classifier (codex-parity enforcement ladder). The CI diff gate remains the
// unbypassable backstop for anything the classifier cannot see.
export const SHELL_TOOLS = ['bash', 'shell'];

// Known read-only tools that may carry a file path but never mutate it. The gate
// fails CLOSED: only these are skipped; any other structured tool that reaches the
// checker — including unrecognized mutation tools — is checked against the rail
// set rather than silently allowed.
export const READONLY_TOOLS = ['read', 'grep', 'glob', 'list', 'ls', 'webfetch', 'websearch', 'codebase_search', 'lsp', 'todoread'];

// First-party tools with no single-file mutation semantics, deliberately not
// gated in-session (they don't write files). Anything NOT in this list,
// SHELL_TOOLS, or READONLY_TOOLS is treated as potentially mutating.
// `adlc_gate` is THIS plugin's own tool (Phase 4.2): it dispatches `adlc <gate>`
// and never edits files through OpenCode's edit tools, so it must be recognized
// here — otherwise the rail guard would treat it as an unknown mutator and deny
// the plugin's own tool before execute() runs. It is NOT a blanket allow: while
// rails are in force its nested gate argv gets its own policy (literal token
// scan, read-only allowlist, effective-target and mutation-flag checks) below.
// `adlc_prosecute` (T33) is likewise this plugin's own tool: it only reads the
// diff and spawns WRITE-DISABLED child sessions — it never mutates through
// OpenCode's edit tools, and its only arg is a git base ref (no file target),
// so the ungated spoof guard is a no-op for it.
export const UNGATED_TOOLS = ['task', 'skill', 'todowrite', 'question', 'adlc_gate', 'adlc_prosecute'];

// Gates that may run through adlc_gate while rails are FROZEN: read-only by
// default ("writers default to dry-run" is the repo-wide gate contract; the
// mutation opt-in flags are denied separately). Deliberately absent — gates
// that write with DERIVED or DEFAULTED targets an argv scan cannot vet:
//   hollow-test (expands its --rails file's globs and mutates the matches),
//   review-calibration (plants mutants into commit-derived files via
//     writeFileSync, then restores — same mutate/restore class as hollow-test),
//   consensus-fix (applies candidate repairs to --files),
//   behavior-diff (capture writes its output),
//   gate-fuzzing (executes adversary setup/witness code; CI-sandbox-only),
// and any unknown/future gate (fail closed). Command-executor flags (--*cmd)
// are denied for EVERY gate — they run an arbitrary program no argv scan can
// vet. Known fixed write targets are vetted instead of denied, because
// mid-build evidence recording is a legitimate railed-session write:
// gate-manifest's ledger (--dir or .adlc default), any gate's --record-verdict
// (writes the gate-manifest ledger), and preflight's self-cleaning scratch
// probes (.adlc/tmp/preflight-test, .worktrees/preflight-test).
export const RAILS_SAFE_GATES = new Set([
  'preflight', 'spec-lint', 'premortem', 'parallax', 'coldstart',
  'merge-forecast', 'model-router', 'rejection-mining',
  'lesson-foundry', 'skill-rot', 'model-ratchet', 'flail-detector', 'rails-guard',
]);

// Gates that may run through adlc_gate while the rail set cannot be RESOLVED —
// a conflicting active-ticket signal, an unloadable store, a missing ticket.
//
// A different question from RAILS_SAFE_GATES, which answers "may this run while
// rails are FROZEN": there a rail set exists, so a known write target can be
// vetted against it (that is what the --record-verdict and preflight-scratch
// checks below do). Under conflict there is nothing to vet against, so the only
// gate that is safe is one that writes NOTHING. `preflight` is the case that
// separates the two sets: it is rails-safe because its scratch writes are fixed
// and checkable (.adlc/tmp/preflight-test, .worktrees/preflight-test, the
// branch metadata its probes churn), and it is NOT conflict-safe for the same
// reason — those writes still happen and nothing can say whether they land on a
// frozen rail.
//
// Membership is a source property, not a judgement call: each package listed
// here contains no fs write and no child_process use outside its own tests, so
// a bare invocation (nested argv is denied under conflict) can only read.
// Deliberately absent, each with a write or exec path: preflight (scratch
// probes, spawns the suite), premortem (--out report), rejection-mining and
// lesson-foundry (emit plans/skills), skill-rot (rewrites skill headers),
// model-ratchet (findings ledger, review subprocess), rails-guard (CI bootstrap
// copies a runner to disk and executes it).
export const CONFLICT_SAFE_GATES = new Set([
  'spec-lint', 'parallax', 'coldstart', 'merge-forecast', 'model-router', 'flail-detector',
]);

/** Canonicalize a path to a forward-slash path relative to the repo root (lexical). */
export function canonicalizePath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  return relative(root, abs).split('\\').join('/');
}

/**
 * Resolve the active ticket id from process.env.ADLC_TICKET OR
 * .adlc/current-ticket.json. If both are set and disagree, that is a tamper
 * signal — return { conflict: true } so the caller fails closed.
 */
export function resolveActiveTicketId(root, env) {
  const resolved = resolveActiveTicketIdCanonical({ root, env });
  // conflict: true = fail closed. Beyond an ADLC_TICKET-vs-pointer disagreement it
  // now also covers an unparseable pointer AND an object pointer whose id key is
  // unrecognized — the latter used to read as "no active ticket" and ALLOW.
  if (!resolved.ok) return { id: null, conflict: true, code: resolved.code, message: resolved.message };
  return { id: resolved.value?.id ?? null, conflict: false };
}

/**
 * Resolve whether rails are currently IN FORCE and, if so, the effective rail
 * set. Shared by the single-path check and the whole-tool-call check so the
 * gating ladder (phase flag → initialized → active ticket → rails) exists once.
 * Returns one of:
 *   { active: false, reason }                          — nothing to enforce
 *   { active: true, conflict: true, reason }           — tamper signal, fail closed
 *   { active: true, conflict: false, ticketId, rails } — rails in force
 */
export function resolveRailsInForce(root, env) {
  if (env.ADLC_P4_ENFORCEMENT !== '1') {
    return { active: false, reason: 'enforcement inactive (ADLC_P4_ENFORCEMENT !== "1")' };
  }
  const override = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS ?? null;
  const ticketsPath = override ? (isAbsolute(override) ? override : join(root, override)) : join(root, '.adlc', 'tickets.json');
  if (!ticketStoreExists(root, override)) {
    return { active: false, reason: 'repo not ADLC-initialized (no supported ticket store)' };
  }
  const active = resolveActiveTicketId(root, env);
  if (active.conflict) {
    // Surface the canonical reason rather than assuming an env-vs-pointer conflict;
    // a malformed pointer is the more common fail-closed cause and it explains itself.
    return { active: true, conflict: true, reason: active.message ?? 'conflicting active-ticket signal (ADLC_TICKET vs .adlc/current-ticket.json)' };
  }
  if (!active.id) {
    return { active: false, reason: 'no active ticket resolved' };
  }
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors.length) return { active: true, conflict: true, reason: `ticket store failed to load: ${errors[0]}` };
  const ticket = tickets.find((t) => t.id === active.id);
  if (!ticket) return { active: true, conflict: true, reason: `active ticket ${active.id} not found in ticket store` };
  return { active: true, conflict: false, ticketId: active.id, ticket, rails: normalizeRails([...(ticket?.rails ?? []), ...TRUST_ROOT_RAILS]) };
}

/**
 * Sanitize a declared rail set before it drives enforcement: drop non-strings
 * and blanks (a `rails: ['']` in malformed-but-accepted ticket data must never
 * neutralize the guard), and normalize slash spelling (`./x`, `/x`, `x/` →
 * `x`) so exact/glob/ancestor matching all see one canonical form.
 */
export function normalizeRails(rails) {
  const out = [];
  for (const r of rails) {
    if (typeof r !== 'string') continue;
    const stripped = r.trim().replace(/^\.?\/+/, ''); // drop leading ./ or /
    const dirIntent = /\/+$/.test(stripped);          // a trailing slash means "this dir's contents"
    let norm = stripped.replace(/\/+$/, '');
    if (norm === '') continue;
    if (dirIntent) norm = `${norm}/**`;               // `test/` → `test/**`
    out.push(norm);
  }
  return out;
}

/**
 * Extract every candidate target path from a tool call's args. Tolerant across
 * the arg shapes the structured mutators use: a single `filePath`/`path`/`file`
 * string, a `files` array (strings or objects), or an `edits` array of objects.
 * Returns [] when nothing path-like is found — the caller decides whether that
 * fails closed (mutating/unknown tool while rails are in force) or is benign.
 */
export function extractTargets(args) {
  return extractTargetsKeyed(args).targets;
}

/**
 * extractTargets, plus the subset whose KEY asserts the target names a concrete
 * FILE rather than a directory.
 *
 * The provenance is per-key because these keys do not agree. `filePath`, `file`
 * and a `files[]` entry all say "file" outright; a patch envelope names the
 * files it updates. `path` says nothing — `{path: 'assets.bundle'}` is a
 * directory as readily as a file — and a bare string in `edits[]` names an edit,
 * not a file. Marking the whole extraction file-provenanced (what this used to
 * do) switched ancestor detection off for every `path` argument, so a rail's own
 * parent directory passed as `path` never hit the rail it contains.
 *
 * Ambiguity therefore stays out of the file set: see `namesAFile` for why that
 * is the safe direction. It is reported alongside rather than merely omitted,
 * because candidates are deduplicated by string and provenance must merge
 * CONSERVATIVELY when one path arrives under two keys. Otherwise adding a
 * second spelling weakens the check — `{target: 'x', filePath: 'x'}` would drop
 * the ambiguous half and turn ancestor detection off — and in the branch this
 * feeds, the arg shape is exactly what a spoofing caller controls.
 *
 * @param {object} args
 * @returns {{ targets: string[], files: Set<string>, ambiguous: Set<string> }}
 */
function extractTargetsKeyed(args) {
  const targets = [];
  const files = new Set();
  const ambiguous = new Set();
  if (!args || typeof args !== 'object') return { targets, files, ambiguous };
  const push = (v, fileKeyed) => {
    if (typeof v !== 'string' || !v.trim()) return;
    targets.push(v);
    if (fileKeyed) files.add(v);
    else ambiguous.add(v);
  };
  push(args.filePath, true); push(args.path, false); push(args.file, true);
  for (const [list, entriesNameFiles] of [[args.files, true], [args.edits, false]]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') push(entry, entriesNameFiles);
      else if (entry && typeof entry === 'object') { push(entry.filePath, true); push(entry.path, false); push(entry.file, true); }
    }
  }
  // apply_patch-style envelope bodies declare their targets in-band
  // ("*** Update File: x"). Parse them so apply_patch — the ONLY file mutator
  // OpenCode enables for GPT-5-class models — is path-transparent rather than
  // blanket-denied. A body with no parseable targets still fails closed.
  for (const body of [args.patch, args.input]) {
    if (typeof body === 'string' && body.includes('*** ')) {
      const out = new Set();
      collectPatchPaths(body, out);
      // A patch envelope names the FILES it adds/updates/deletes.
      for (const p of out) push(p, true);
    }
  }
  return { targets, files, ambiguous };
}

/**
 * Targets to test when deciding whether an UNGATED tool name is being spoofed.
 *
 * Deliberately broader than `extractTargets`, and deliberately used only by the
 * ungated branch. The two branches allow on zero targets in opposite ways:
 *
 * - The mutating/unknown branch DENIES when nothing is extractable, so breadth
 *   there buys no safety — and would cost it. Teaching `extractTargets` to read
 *   `target` would turn `{target: 'src/in-scope.mjs'}` from a fail-closed deny
 *   into an extractable non-rail ALLOW, loosening the gate for exactly the tool
 *   class it can vouch for least.
 * - The ungated branch ALLOWS when nothing is extractable, because `task`,
 *   `skill`, and `todowrite` legitimately carry no path on nearly every call.
 *   A spelling it cannot see is therefore a hole, not a fail-closed default —
 *   `{target: <frozen rail>}` walked straight through it.
 *
 * So breadth belongs here and narrowness belongs in `extractTargets`.
 *
 * @param {object} args tool args
 * @returns {string[]}
 */
export function spoofCandidateTargets(args) {
  return spoofCandidates(args).targets;
}

/** Keys that name a DIRECTORY outright, so ancestor detection must stay on. */
const DIR_KEY = /^target_?(?:dir|directory)$/i;

/**
 * Keys that name a FILE outright, licensing the extension heuristic.
 *
 * `path` is deliberately absent even though PATH_FIELD accepts it as a target
 * spelling: naming a target is a different question from asserting it is a
 * file. `{target: {path: 'assets.bundle'}}` names a directory, and treating the
 * key as file-specific would switch ancestor detection off for a rail's parent.
 */
const FILE_KEY = /^(?:target_?file|file_?path|file)$/i;

/**
 * Spoof candidates, plus the subsets a directory-named and a file-named key
 * produced. A candidate in neither subset is AMBIGUOUS and gets directory
 * treatment.
 *
 * Provenance matters because `namesAFile` can only guess for a path that does
 * not exist yet, and it guesses "file" for any dotted leaf. `{targetDir:
 * 'assets.bundle'}` says directory outright; discarding that and guessing would
 * switch off the ancestor check for the rail's own parent. The file subset is
 * the same statement in the other direction, and it is why membership is
 * decided per key rather than per source function.
 *
 * @param {object} args
 * @returns {{ targets: string[], directories: Set<string>, files: Set<string> }}
 */
export function spoofCandidates(args) {
  // Per-key, not bulk: extractTargets reads the generic `path` alongside the
  // file-specific keys, so its output is a mix of both provenances.
  const { targets: fromExtract, files, ambiguous } = extractTargetsKeyed(args);
  const out = new Set(fromExtract);
  const directories = new Set();
  collectTargetKeyed(args, out, directories, files, ambiguous);
  // Conservative merge over the deduplicated candidates: one ambiguous spelling
  // of a path revokes the file assertion another key made about it, so a caller
  // cannot switch ancestor detection off by ADDING an alias. `directories` needs
  // no such pass — the consumer already lets it override.
  for (const target of ambiguous) files.delete(target);
  return { targets: [...out], directories, files };
}

/** Target-ish argument names. Narrower than a path heuristic, broader than one spelling. */
const TARGET_KEY = /^target(?:_?(?:path|file|dir|directory))?$/i;

/** Path fields that name the file once we are already inside a target subtree. */
const PATH_FIELD = /^(?:path|file|file_?path)$/i;

/**
 * True when a candidate is KNOWN to name a concrete file.
 *
 * Ambiguity resolves to DIRECTORY, not file, because "file" is what switches
 * ancestor detection off. Guessing "file" from a dotted leaf is what rounds of
 * review kept finding holes in: `assets.bundle`, `.adlc`, and `.github` are all
 * directories that read as files under that guess, and each miss disabled the
 * check for the rail's own parent.
 *
 * So a stat decides whenever the path exists. For an absent path the key and
 * the name must BOTH say file: a file-specific key licenses the extension
 * heuristic, and it is not authoritative on its own, because `filePath` is a
 * key plenty of tools hand a directory. An absent `{filePath: 'src/Makefile'}`
 * therefore keeps ancestor detection and can be over-denied under an
 * interior-wildcard rail — deliberate, since this predicate only gates tools
 * that do not write files (the structured mutators take the `singleFile` path),
 * and over-denial there is a visible, explained refusal rather than a miss.
 *
 * The extension heuristic is NOT used at all for an ambiguous key, which costs
 * the same over-denial on an absent file named through a bare `target`.
 *
 * @param {string} target repo-relative or absolute path text
 * @param {string} [root] repo root for a relative path
 * @param {{ fileKeyed?: boolean }} [opts] the key that produced this candidate
 *        was file-specific (filePath/targetFile/file), so an absent path may be
 *        inferred a file from its name
 * @returns {boolean}
 */
export function namesAFile(target, root = process.cwd(), { fileKeyed = false } = {}) {
  const raw = String(target ?? '').replace(/\\/g, '/');
  // A trailing slash is the caller SAYING directory; never second-guess it.
  if (/\/$/.test(raw)) return false;
  const rel = raw.replace(/\/+$/, '');
  if (rel === '') return false;
  try {
    const abs = isAbsolute(rel) ? rel : join(root, rel);
    if (existsSync(abs)) return !statSync(abs).isDirectory();
  } catch {
    // Unreadable — fall through to the name heuristic rather than guessing file.
  }
  // Absent path: only a file-specific KEY licenses inferring a file from the
  // name. A bare `target` stays a directory so ancestor detection stays on.
  if (!fileKeyed) return false;
  const leaf = rel.split('/').pop() ?? '';
  // A LEADING dot is a hidden name, not an extension: `.adlc`, `.github`, and
  // `.claude` are directories, and reading them as files would switch off
  // ancestor detection for exactly the trees most likely to hold rails.
  return /.\.[A-Za-z0-9]+$/.test(leaf);
}

/**
 * Collect strings under a target-ish key at any reachable depth.
 *
 * Depth matters: `extractTargets` walks `files[]`/`edits[]` but reads only
 * `filePath`/`path`/`file` inside their entries, so a first pass that checked
 * the new keys on the top level alone still let `{edits:[{target: <rail>}]}`,
 * `{files:[{target: <rail>}]}`, and `{target: [<rail>]}` through. Enumerating
 * spellings without covering the SHAPES they arrive in is the same defect one
 * level down.
 *
 * Walked iteratively with no depth ceiling. A numeric cap would BE a bypass of
 * the same shape this helper exists to close — nest one level past it and the
 * scan stops looking — and an explicit stack also removes the recursion depth
 * a hostile payload could otherwise exhaust. `seen` keeps a self-referencing
 * object from looping forever, tracked per (object, inTarget, dirKeyed) — not
 * per object alone. What a visit collects depends on that context, so an
 * object aliased under both a non-target and a target key must be walked once
 * per context: identity-only tracking let whichever alias popped first (the
 * non-target one, under LIFO order) suppress the target-context visit
 * entirely, and the rail target was never collected. Termination holds — each
 * object is visited at most once per context, and there are only four.
 *
 * Provenance is recorded per occurrence, not per candidate: `directories` and
 * `files` are the keys that said so outright, `ambiguous` is every other
 * occurrence. The caller merges them (see `spoofCandidates`); recording only
 * the assertions would let an added alias erase an ambiguous one.
 *
 * @param {unknown} root
 * @param {Set<string>} out
 */
function collectTargetKeyed(root, out, directories = new Set(), files = new Set(), ambiguous = new Set()) {
  const stack = [{ value: root, inTarget: false, dirKeyed: false }];
  const seen = new Map(); // object → bitmask of (inTarget, dirKeyed) contexts already walked
  while (stack.length > 0) {
    const { value, inTarget, dirKeyed } = stack.pop();
    // Split from the cycle check on purpose: folded into one condition, a
    // swapped operator turns the loop-termination guard into an infinite loop
    // on self-referencing args, which a test can only hang on rather than fail.
    if (!value || typeof value !== 'object') continue;
    const ctxBit = 1 << ((inTarget ? 1 : 0) | (dirKeyed ? 2 : 0));
    const seenCtx = seen.get(value) ?? 0;
    if ((seenCtx & ctxBit) !== 0) continue;
    seen.set(value, seenCtx | ctxBit);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (inTarget && typeof item === 'string' && item.trim() !== '') {
          out.add(item);
          // An array under a target key states no file-ness of its own.
          if (dirKeyed) directories.add(item);
          else ambiguous.add(item);
        } else stack.push({ value: item, inTarget, dirKeyed });
      }
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const targetKey = TARGET_KEY.test(key);
      // Inside a target-valued subtree a conventional path field IS the target:
      // `{target: {path: '…'}}` names a file just as plainly as `{target: '…'}`.
      // Descending without carrying that context loses the whole shape.
      const names = targetKey || (inTarget && PATH_FIELD.test(key));
      const dirNamed = dirKeyed || DIR_KEY.test(key);
      if (names && typeof child === 'string' && child.trim() !== '') {
        out.add(child);
        if (dirNamed) directories.add(child);
        else if (FILE_KEY.test(key)) files.add(child);
        else ambiguous.add(child);
        continue;
      }
      stack.push({ value: child, inTarget: inTarget || targetKey, dirKeyed: dirNamed });
    }
  }
}

const railSegments = (s) => s.split('/').filter((x) => x !== '');

/**
 * Every spelling of a target that a decision must account for: the raw one and,
 * when it differs, the trimmed one. A padded ` test/x.mjs ` is a different
 * lexical path here while any tool that normalizes its input acts on the frozen
 * one, so a check that reads a single form is a spelling bypass — and the
 * classification and the matching must read the SAME list, or the two disagree
 * about which path they are talking about.
 *
 * @param {unknown} target
 * @returns {string[]}
 */
export function matchableSpellings(target) {
  const raw = String(target ?? '');
  return raw === raw.trim() ? [raw] : [raw, raw.trim()];
}

// True if directory `target` is a proper ANCESTOR of the concrete paths a rail
// glob can match — i.e. deleting/moving target destroys the frozen rail even
// though target never matches the glob directly. Walks segments in lockstep,
// honoring interior wildcards and `**`:
//   `test`            covers `test/**`            (ancestor)
//   `packages/foo/test` covers `packages/*/test/**` (interior-wildcard ancestor)
//   `packages/foo/src`  does NOT cover it          (literal mismatch)
//   `test2`           does NOT cover `test/**`     (sibling, no over-block)
//   `test/x.txt`      does NOT cover `test/*.mjs`  (same depth → globMatch's job)
//
// `opts.throughDoubleStar` (default true) allows the second form: an anchored
// `**` absorbing the target's remaining segments. A caller that has been told
// the target is a FILE turns it off — see railHit's `ancestors: 'literal'`.
//
// Narrowed, the question becomes: does the rail NAME this target as a directory?
// It does when the target's LAST segment lines up with a real rail segment that
// has more rail after it. How the earlier segments lined up does not matter, so
// a `**` may still absorb them:
//   `src/cache.bundle`     covers `src/**/cache.bundle/**`  (named, ** took none)
//   `src/foo/cache.bundle` covers `src/**/cache.bundle/**`  (named, ** took foo)
//   `src/index.mjs` does NOT cover `src/**/test/*.mjs`      (only the ** could
//                                                            hold the last
//                                                            segment — the rail
//                                                            says nothing about
//                                                            this name)
export function targetIsRailAncestor(target, rail, { throughDoubleStar = true } = {}) {
  return ancestorWalk(railSegments(target), railSegments(rail), throughDoubleStar);
}

// One rail segment against one target segment, with the SAME semantics as the
// direct hit check — `foo-*` must not read as matching `bar`, or ancestor
// detection denies paths the rail could never match. A single `*` stays inside
// its segment in @adlc/core, so segment-by-segment is the right shape for it.
//
// Three spellings are NOT decidable one segment at a time, and each keeps the
// older permissive reading so the ancestor check never matches LESS than the
// glob: `?` and character classes, which core does not implement at all, and an
// EMBEDDED `**` (`foo**bar`), which core lets span `/` — `a/foo**bar/**` really
// does cover `a/foo/x/bar/frozen.mjs`, so `a/foo` is an ancestor of it and one
// segment cannot see that. A segment that IS `**` never reaches here.
const segmentMatches = (pattern, segment) => (
  globMatch(pattern, segment) || /[?[]/.test(pattern) || pattern.includes('**')
);

// `seen` holds the (target index, rail index) pairs already explored. The
// answer depends on nothing else, so a state reached twice cannot answer
// differently. With the constant-work `**` transitions below, that bounds the
// whole walk at one visit per state — target segments × rail segments — for a
// path length the CALLER chooses, in a synchronous pre-execution hook. Both
// halves are needed: memo without constant-work transitions still scans the
// remaining segments at every `**` state and stays quadratic in path length.
// Deliberately NOT solved with a segment-count cap: a numeric ceiling on a path
// is itself a bypass, and there is nothing left to cap once the bound holds.
//
// Walked with an explicit worklist, not recursion. The skip branch would cost
// one stack frame per rail segment, and a rail is a string in the ticket store:
// a few thousand `**` segments is syntactically valid and would raise a
// RangeError out of the hook instead of a rail decision. Nothing here needs the
// call stack, so it does not use it.
function ancestorWalk(T, R, throughDoubleStar) {
  const seen = new Set();
  // Each entry is a (target index, rail index) branch still to explore. A `**`
  // forks; the fork is queued here instead of taking a stack frame.
  const pending = [[0, 0]];
  while (pending.length > 0) {
    let [ti, ri] = pending.pop();
    for (;;) {
      // Keyed as text rather than packed into one number: any multiplier larger
      // than the rail length encodes the pair just as well, so the arithmetic
      // form has a free constant in it that no behaviour depends on.
      const state = `${ti}:${ri}`;
      if (seen.has(state)) break;                   // already explored; it did not pan out
      seen.add(state);
      if (ti === T.length) {                        // target is a proper prefix of the rail pattern
        if (ri < R.length) return true;
        break;
      }
      if (ri === R.length) break;                   // target deeper than the rail, no ** seen
      const seg = R[ri];
      if (seg === '**') {
        // A `**` here can absorb target segments — but ONLY if some
        // literal/wildcard prefix already ANCHORED the match. A LEADING `**`
        // anchors nothing: it would make every path an ancestor of e.g.
        // `**/*.test.mjs`, denying all edits. Such a floating rail has no fixed
        // root directory, so ancestor-destruction isn't well-defined — rely on
        // globMatch (direct hits), the repo-root check, and the file.edited
        // backstop instead. Anchored `**` (a/**) legitimately covers the subtree.
        if (ri === 0) break;
        if (throughDoubleStar) return true;
        // Narrowed: two constant-work moves, never a scan of the remaining
        // segments. Either the `**` takes nothing more and the rail advances, or
        // it eats one segment and the rail stays put — repeated, that reaches
        // every split. The one split it must not reach is the `**` swallowing the
        // target's LAST segment: that segment is the one whose directory-ness is
        // in question, and a `**` matches any name at all, so it is not evidence.
        pending.push([ti, ri + 1]);
        if (ti >= T.length - 1) break;
        ti += 1;
        continue;
      }
      // An embedded `**` spans `/`, so the rail keeps going INSIDE this segment
      // and can cover any number of the target's remaining segments: `a**b`
      // matches `a/b`, and `a/foo**bar/**` matches `a/foo/x/bar/frozen.mjs`.
      // Nothing past the `**` is decidable one segment at a time, so all that
      // is checked is the literal text before it, which the target's segment
      // must still begin with — enough to keep `b` from reading as an ancestor
      // of `a**b` while never claiming less than the glob does.
      const span = seg.indexOf('**');
      if (span !== -1) {
        if (T[ti].startsWith(seg.slice(0, span).replace(/[*?[][\s\S]*$/, ''))) return true;
        break;
      }
      if (!segmentMatches(seg, T[ti])) break;       // mismatch → not an ancestor
      ti += 1; ri += 1;
    }
  }
  return false;
}

// Does `target` hit a frozen rail? Matches the lexical path AND the
// symlink-resolved real path.
//
// `opts.ancestors` (default true) enables ANCESTOR-directory detection — a
// mutation to a rail's parent dir (`rm -rf test` vs a `test` glob rail). That
// is correct for DIRECTORY-affecting operations (shell rm/mv, unknown tools ->
// fail closed) but WRONG for a single-file write: writing `src/index.mjs` must
// not be denied just because an interior-`**` rail could nest a match under a
// same-named dir. Callers that know the op targets one concrete file
// (edit/write/apply_patch, the file.edited watcher) pass `{ ancestors: false }`.
//
// `'literal'` is the middle setting, for a target something UNTRUSTED called a
// file — an arg key, not a stat. It keeps every ancestor form except the one an
// anchored `**` creates. The distinction is the rail set's own evidence: a rail
// `assets.bundle/**` states that `assets.bundle` is a DIRECTORY, so a caller
// naming it as a file contradicts the frozen rails, and the rails are the
// trusted side. But `src/**/test/*.mjs` states nothing about `src/index.mjs` —
// only the `**` relates them — so a file there is left alone. That is the
// over-block requirement 3 exists to prevent, and the bypass a caller would get
// by spelling a rail's parent directory as `filePath`.
export function railHit(target, rails, root, { ancestors = true } = {}) {
  const ancestorsOn = ancestors !== false;
  const throughDoubleStar = ancestors !== 'literal';
  const candidates = new Set();
  for (const form of matchableSpellings(target)) {
    candidates.add(canonicalizePath(form, root));
    candidates.add(resolveRailPath(form, root));
  }
  for (const path of candidates) {
    // A mutation targeting the repo ROOT (e.g. `rm -rf .`) destroys every rail.
    // Return a guaranteed-truthy token even if the rail set is somehow blank.
    if (ancestorsOn && (path === '' || path === '.')) return rails.find(Boolean) ?? '(repo root)';
    for (const rail of rails) {
      // (a) target is the rail or inside it (normal case).
      if (rail === path || globMatch(rail, path)) return rail;
      // (b) target is an ANCESTOR directory of the rail — deleting/moving it
      // destroys the frozen rail without ever matching the glob.
      if (ancestorsOn && targetIsRailAncestor(path, rail, { throughDoubleStar })) return rail;
    }
  }
  return null;
}

/**
 * Decide whether a whole tool call should be allowed or denied. This is the
 * hook-facing entry point. Pure and fail-safe: returns
 * { decision: 'allow' | 'deny', reason }.
 *
 * Enforcement contract (identical to the sibling hooks):
 *  - tool names are normalized (lowercased) before classification;
 *  - known read-only tools and the deliberately-ungated first-party tools
 *    (bash et al — CI diff gate covers them) are allowed;
 *  - enforcement is phase-scoped to ADLC_P4_ENFORCEMENT === '1';
 *  - no-op when the repo is not ADLC-initialized or no active ticket resolves;
 *  - a conflicting active-ticket signal fails closed;
 *  - rails in force = active ticket's declared rails PLUS the trust-root rails;
 *  - EVERY extractable target path is checked; a mutating or UNKNOWN tool whose
 *    target cannot be extracted is DENIED while rails are in force (fail closed —
 *    an unrecognized third-party write tool must not slip past on arg shape).
 */
export function checkToolCall({ tool, args, root = process.cwd(), env = process.env }) {
  const name = String(tool ?? '').toLowerCase();
  if (READONLY_TOOLS.includes(name)) {
    // Reading a rail is legitimate; allow by name. Residual risk: a hostile
    // co-installed plugin could register a WRITING tool under a read-only name —
    // that class is closed by the tool-name-independent file.edited backstop
    // (opencode-native-flush plan Phase 2.5) and, at commit time, the CI gate.
    return { decision: 'allow', reason: `tool "${name}" is read-only` };
  }
  if (SHELL_TOOLS.includes(name)) {
    return checkShellCall({ command: args?.command, root, env });
  }
  // Operators can extend the ungated list for benign third-party tools that a
  // railed build legitimately needs (e.g. ADLC_UNGATED_TOOLS="symbols_index").
  // An explicit opt-out per tool keeps the DEFAULT fail-closed for unknown
  // tools (an unrecognized write tool must not slip past on arg shape) without
  // hard-blocking benign no-target tools forever. Extended entries get the same
  // spoof guard as the built-in ungated list.
  const ungated = UNGATED_TOOLS.concat(
    String(env.ADLC_UNGATED_TOOLS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  if (ungated.includes(name)) {
    // Not gated by design (bash et al fall to the CI diff gate) — BUT a benign
    // ungated tool never carries a file-path arg, so if this call DOES carry an
    // extractable target that resolves to a frozen rail, treat the name as
    // spoofed/abused and deny rather than allow purely by name.
    const force = resolveRailsInForce(root, env);
    // Conflicted ticket state: the rail set is unresolved, so a target cannot be
    // vetted. Previously the whole block was skipped and the branch fell through
    // to allow — the ONE branch that allows by default also failing open exactly
    // when rail state is broken.
    //
    // Deny only a call that actually carries a target. A no-target ungated call
    // is the normal case (that is why these names are ungated at all), and
    // blanket-denying would take `adlc_gate` and `adlc_prosecute` down with it —
    // the tools an operator needs to diagnose and repair the broken store.
    if (force.conflict) {
      const { targets } = spoofCandidates(args);
      if (targets.length > 0) {
        return {
          decision: 'deny',
          reason: `ungated tool "${name}" carries a target that cannot be vetted — ${force.reason}`,
        };
      }
      // adlc_gate forwards a NESTED argv that carries no extractable target, so
      // the check above cannot see it. Under conflict the rail-dependent halves
      // of the gate policy below cannot run at all, and its rail-INDEPENDENT
      // halves are the ones that matter here: a command-executor flag runs an
      // arbitrary program, and a writing gate writes targets nothing can vet
      // while the rail set is unresolved. Allow only a bare NON-WRITING gate —
      // enough to diagnose the broken store, and nothing that executes or
      // writes while it is broken.
      if (name === 'adlc_gate') {
        const gate = String(args?.gate ?? '').trim().toLowerCase();
        const nested = (Array.isArray(args?.args) ? args.args : []).filter((t) => typeof t === 'string');
        if (nested.length > 0) {
          return {
            decision: 'deny',
            reason: `adlc_gate(${gate || '?'}): arguments cannot be vetted — ${force.reason} — run it via the adlc CLI, where the CI diff gate backstops it`,
          };
        }
        // CONFLICT_SAFE_GATES, not RAILS_SAFE_GATES: the rails-safe set permits
        // gates whose writes are fixed and vettable against a KNOWN rail set,
        // and there is no known rail set here.
        if (!CONFLICT_SAFE_GATES.has(gate)) {
          return {
            decision: 'deny',
            reason: `adlc_gate(${gate || '?'}): only a non-writing gate may run — ${force.reason}`,
          };
        }
      }
      return { decision: 'allow', reason: `tool "${name}" is not gated in-session (CI diff gate covers it)` };
    }
    if (force.active) {
      const { targets, directories, files } = spoofCandidates(args);
      for (const target of targets) {
        // Same file-vs-directory distinction MUTATING_TOOLS already gets below:
        // ancestor detection asks "would acting on this directory destroy a
        // rail", which is the wrong question for a concrete file and over-blocks
        // under an interior-wildcard rail (`src/index.mjs` reads as an ancestor
        // of `src/**/test/*.mjs`).
        //
        // But "file" here is at best a claim by the caller, and this is the
        // branch whose whole job is not to trust that caller — so a claimed file
        // gets `'literal'`, not `false`. It stops the `**`-absorbed ancestor
        // form (the over-block) while keeping the form where the rail set itself
        // says the target is a directory, which is the spelling a spoofing call
        // would otherwise use to shed the check.
        //
        // Classified on every spelling railHit will match, and conservatively:
        // one spelling that is not a file keeps full ancestor detection. A
        // padded ` src/cache.bundle` misses the stat that would find the real
        // directory and reads as an absent dotted file, while railHit goes on
        // to match the trimmed spelling — so classifying the raw form alone
        // handed the narrowed mode a directory.
        const claimedFile = !directories.has(target)
          && matchableSpellings(target).every((spelling) => namesAFile(spelling, root, { fileKeyed: files.has(target) }));
        const hit = railHit(target, force.rails, root, { ancestors: claimedFile ? 'literal' : true });
        if (hit) {
          return { decision: 'deny', reason: `ungated tool "${name}" carries a frozen-rail target — frozen rail "${hit}" (active ticket ${force.ticketId})` };
        }
      }
      // adlc_gate (our own Phase 4.2 tool) forwards a NESTED CLI argv in
      // args.args that extractTargets never sees, and several gates DERIVE or
      // DEFAULT their write targets internally (hollow-test expands the rails
      // globs of whatever --rails file it is handed and mutates the matches;
      // gate-manifest with no --dir writes the default .adlc ledger) — so a
      // literal argv scan alone cannot vet what a gate will write. Close the
      // CLASS, not the instance:
      //   (1) literal token scan (incl. --flag=value payloads and comma-lists)
      //       against the rails;
      //   (2) only read-only-by-default gates may run through adlc_gate while
      //       rails are in force ("writers default to dry-run" is the repo-wide
      //       gate contract); derived-write gates are denied here — the CLI
      //       remains their path, where the CI diff gate is the backstop;
      //   (3) gate-manifest (legit mid-build evidence writer) is vetted by its
      //       EFFECTIVE target: the --dir value or the .adlc default;
      //   (4) mutation opt-in flags (--write/--record/--append/--apply/--fix)
      //       turn dry-run gates into writers with derived targets → deny.
      if (name === 'adlc_gate') {
        const gate = String(args?.gate ?? '').trim().toLowerCase();
        const nested = (Array.isArray(args?.args) ? args.args : []).filter((t) => typeof t === 'string');
        const deny = (why) => ({ decision: 'deny', reason: `adlc_gate(${gate || '?'}): ${why} (active ticket ${force.ticketId}) — run the gate via the adlc CLI instead, where the CI diff gate backstops it` });
        // (1) literal tokens — flags' inline values and comma-separated lists included
        for (const raw of nested) {
          let token = raw.trim();
          if (!token) continue;
          if (token.startsWith('-')) {
            const eq = token.indexOf('=');
            if (eq === -1) continue; // bare flag; its value arrives as the next token
            token = token.slice(eq + 1).trim();
            if (!token) continue;
          }
          for (const part of token.split(',')) {
            const p = part.trim();
            if (!p) continue;
            const hit = railHit(p, force.rails, root);
            if (hit) return deny(`nested argument "${raw}" resolves to frozen rail "${hit}"`);
          }
        }
        // (4) mutation opt-ins — a dry-run gate becomes a writer whose target we can't vet
        const MUTATION_FLAGS = new Set(['--write', '--record', '--append', '--apply', '--fix']);
        for (const raw of nested) {
          const flag = raw.trim().split('=')[0];
          if (MUTATION_FLAGS.has(flag)) return deny(`mutation flag "${flag}" requests a write with a gate-derived target`);
          // (5) command-executor flags (--review-cmd, --test-cmd, and any future
          // --*cmd) hand the gate an ARBITRARY PROGRAM to run — spawnSync with
          // shell:false stops metachar injection but not the program itself,
          // which can write any path including the tickets.json trust root.
          // No argv scan can vet a command string, so fail closed for every
          // gate; the read-only DEFAULT invocations stay legal.
          if (/^--[a-z][a-z-]*cmd$/.test(flag)) return deny(`command-executor flag "${flag}" runs an arbitrary program, which an in-session guard cannot vet`);
        }
        // (3) ledger writes are vetted on the EFFECTIVE ledger FILE (not the
        // directory — the directory always ancestor-hits the implicit
        // tickets.json trust-root rail, which would outlaw legitimate mid-build
        // evidence recording). Three surfaces write a ledger:
        //   gate-manifest            → <--dir | .adlc>/manifest.jsonl
        //   <any gate> --record-verdict → .adlc/manifest.jsonl (via gate-manifest)
        //   model-ratchet --review-cmd  → .adlc/findings.jsonl (appendEntry)
        const hasFlag = (flag) => nested.some((t) => { const s = t.trim(); return s === flag || s.startsWith(`${flag}=`); });
        const vetLedger = (path) => {
          const hit = railHit(path, force.rails, root);
          return hit ? deny(`gate write target "${path}" resolves to frozen rail "${hit}"`) : null;
        };
        if (gate === 'gate-manifest') {
          let effectiveDir = '.adlc';
          for (let i = 0; i < nested.length; i++) {
            const t = nested[i].trim();
            if (t === '--dir' && typeof nested[i + 1] === 'string') effectiveDir = nested[i + 1].trim();
            else if (t.startsWith('--dir=')) effectiveDir = t.slice('--dir='.length).trim();
          }
          const denied = vetLedger(`${effectiveDir.replace(/\/+$/, '')}/manifest.jsonl`);
          if (denied) return denied;
        } else if (!RAILS_SAFE_GATES.has(gate)) {
          // (2) not proven read-only-by-default (hollow-test, review-calibration,
          // consensus-fix, behavior-diff, gate-fuzzing, unknown/future gates)
          // → fail closed
          return deny('this gate derives or defaults its write targets, which an in-session argv scan cannot vet while rails are frozen');
        } else {
          if (hasFlag('--record-verdict')) {
            const denied = vetLedger('.adlc/manifest.jsonl');
            if (denied) return denied;
          }
          // preflight's DEFAULT run probes writability with fixed, self-cleaning
          // scratch writes: .adlc/tmp/preflight-test, the .worktrees/preflight-test
          // worktree, and the git metadata its branch/worktree probes churn
          // (refs + .git/worktrees). Vet those known paths instead of denying
          // the gate — they only conflict when explicitly railed.
          if (gate === 'preflight') {
            for (const scratch of [
              '.adlc/tmp/preflight-test',
              '.worktrees/preflight-test',
              '.git/refs/heads/preflight-test-branch',
              '.git/worktrees/preflight-test',
            ]) {
              const denied = vetLedger(scratch);
              if (denied) return denied;
            }
          }
        }
      }
    }
    return { decision: 'allow', reason: `tool "${name}" is not gated in-session (CI diff gate covers it)` };
  }
  const force = resolveRailsInForce(root, env);
  if (!force.active) return { decision: 'allow', reason: force.reason };
  if (force.conflict) return { decision: 'deny', reason: force.reason };

  const targets = extractTargets(args);
  if (targets.length === 0) {
    return {
      decision: 'deny',
      reason: `mutating/unknown tool "${name}" carries no extractable target path — failing closed while rails are in force (active ticket ${force.ticketId})`,
    };
  }
  // Known structured mutators write a single concrete file — ancestor-directory
  // detection would over-block (e.g. `write src/index.mjs` under an interior-**
  // rail). Unknown tools stay fail-closed with ancestor detection on.
  const singleFile = MUTATING_TOOLS.includes(name);
  for (const target of targets) {
    const hit = railHit(target, force.rails, root, { ancestors: !singleFile });
    if (hit) {
      return { decision: 'deny', reason: `frozen rail "${hit}" (active ticket ${force.ticketId})` };
    }
  }
  return { decision: 'allow', reason: 'no target is a frozen rail' };
}

/**
 * Shell-command gate (Phase 2.2) — the codex-parity enforcement ladder over
 * @adlc/core's shell classifier. Applied only while rails are in force:
 *   read-only (no write option)            → allow
 *   read-only + output-option smuggle      → deny
 *   neither read-only nor known mutation   → deny (unverifiable)
 *   opaque mutation (git apply/patch/tar…) → deny (targets unreadable)
 *   mutation that changes cwd / expands    → deny (path resolution unverifiable)
 *   mutation with no literal paths         → deny (fail closed)
 *   literal paths → deny only on a frozen-rail hit, else allow
 * The CI diff gate remains the unbypassable backstop.
 */
export function checkShellCall({ command, root = process.cwd(), env = process.env }) {
  const force = resolveRailsInForce(root, env);
  if (!force.active) return { decision: 'allow', reason: force.reason };
  if (force.conflict) return { decision: 'deny', reason: force.reason };

  const c = classifyShellCommand(command);
  if (c.readOnly) {
    if (c.writeOption) {
      return { decision: 'deny', reason: 'read-only shell command uses an output option; use a structured edit tool or a literal path-transparent mutation' };
    }
    return { decision: 'allow', reason: 'shell command is positively read-only' };
  }
  if (!c.mutating) {
    return { decision: 'deny', reason: 'shell command is neither positively read-only nor a path-transparent mutation — unverifiable while rails are in force (CI diff gate remains the backstop)' };
  }
  if (c.opaque) {
    return { decision: 'deny', reason: 'mutating shell command uses an opaque form (git apply/checkout/patch/tar…); use a structured edit tool or a literal path-transparent mutation' };
  }
  if (c.changesCwd) {
    return { decision: 'deny', reason: 'mutating shell command changes cwd; target paths cannot be verified against the frozen rails' };
  }
  if (c.expands) {
    return { decision: 'deny', reason: 'mutating shell command uses shell expansion ($VAR, $(…), backticks, globs); target paths cannot be verified against the frozen rails' };
  }
  if (c.paths.length === 0) {
    return { decision: 'deny', reason: 'mutating shell command carries no literal target paths — failing closed while rails are in force' };
  }
  for (const target of c.paths) {
    const hit = railHit(target, force.rails, root);
    if (hit) {
      return { decision: 'deny', reason: `shell mutation targets frozen rail "${hit}" (active ticket ${force.ticketId})` };
    }
  }
  return { decision: 'allow', reason: 'shell mutation targets no frozen rail' };
}

/**
 * Single-path convenience used by tests and sibling callers: the same contract
 * as checkToolCall for a tool call whose one target is `filePath`.
 */
export function checkRail({ filePath, tool, root = process.cwd(), env = process.env }) {
  return checkToolCall({ tool, args: { filePath }, root, env });
}
