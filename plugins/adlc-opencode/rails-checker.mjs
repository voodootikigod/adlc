// rails-checker.mjs — the ADLC rail-enforcement decision for OpenCode.
//
// This is a THIN adapter: every rail/glob/ticket primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0004 / integration-plan §6.6).
// It must NOT re-implement glob or ticket loading. The only non-core logic here
// is mapping OpenCode's hook arguments onto that core and the sibling-hook
// enforcement contract (active-ticket resolution, phase gating, trust-root
// freeze) that adlc-codex and adlc-pi already implement.

import { existsSync } from 'node:fs';
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
  if (!args || typeof args !== 'object') return [];
  const targets = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) targets.push(v); };
  push(args.filePath); push(args.path); push(args.file);
  for (const list of [args.files, args.edits]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') { push(entry.filePath); push(entry.path); push(entry.file); }
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
      for (const p of out) push(p);
    }
  }
  return targets;
}

const railSegments = (s) => s.split('/').filter((x) => x !== '');

// True if directory `target` is a proper ANCESTOR of the concrete paths a rail
// glob can match — i.e. deleting/moving target destroys the frozen rail even
// though target never matches the glob directly. Walks segments in lockstep,
// honoring interior wildcards and `**`:
//   `test`            covers `test/**`            (ancestor)
//   `packages/foo/test` covers `packages/*/test/**` (interior-wildcard ancestor)
//   `packages/foo/src`  does NOT cover it          (literal mismatch)
//   `test2`           does NOT cover `test/**`     (sibling, no over-block)
//   `test/x.txt`      does NOT cover `test/*.mjs`  (same depth → globMatch's job)
export function targetIsRailAncestor(target, rail) {
  const T = railSegments(target);
  const R = railSegments(rail);
  for (let i = 0; ; i++) {
    if (i === T.length) return R.length > T.length; // target is a proper prefix of the rail pattern
    if (i === R.length) return false;               // target deeper than the rail, no ** seen
    const seg = R[i];
    if (seg === '**') {
      // A `**` here can absorb the target's remaining segments — but ONLY if
      // some literal/wildcard prefix already ANCHORED the match. A LEADING `**`
      // (i === 0) anchors nothing: it would make every path an ancestor of e.g.
      // `**/*.test.mjs`, denying all edits. Such a floating rail has no fixed
      // root directory, so ancestor-destruction isn't well-defined — rely on
      // globMatch (direct hits), the repo-root check, and the file.edited
      // backstop instead. Anchored `**` (a/**) legitimately covers the subtree.
      return i > 0;
    }
    if (/[*?[]/.test(seg)) continue;                // wildcard segment matches this target segment
    if (seg !== T[i]) return false;                 // literal mismatch → not an ancestor
  }
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
export function railHit(target, rails, root, { ancestors = true } = {}) {
  const candidates = new Set([canonicalizePath(target, root), resolveRailPath(target, root)]);
  for (const path of candidates) {
    // A mutation targeting the repo ROOT (e.g. `rm -rf .`) destroys every rail.
    // Return a guaranteed-truthy token even if the rail set is somehow blank.
    if (ancestors && (path === '' || path === '.')) return rails.find(Boolean) ?? '(repo root)';
    for (const rail of rails) {
      // (a) target is the rail or inside it (normal case).
      if (rail === path || globMatch(rail, path)) return rail;
      // (b) target is an ANCESTOR directory of the rail — deleting/moving it
      // destroys the frozen rail without ever matching the glob.
      if (ancestors && targetIsRailAncestor(path, rail)) return rail;
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
    if (force.active && !force.conflict) {
      for (const target of extractTargets(args)) {
        const hit = railHit(target, force.rails, root);
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
