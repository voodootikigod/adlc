#!/usr/bin/env node
// adlc-rails-guard.mjs — the Cursor `preToolUse` hook adapter.
//
// Cursor runs this script before the agent calls a tool, passing a JSON payload
// on stdin and reading a JSON verdict on stdout:
//   stdin :  { tool_name, tool_input: { file_path, ... }, workspace_roots, ... }
//   stdout:  { permission: "allow" | "deny" | "ask", user_message, agent_message }
//
// The rail DECISION is delegated entirely to checkRail() in ../rails-checker.mjs
// (which delegates glob/ticket primitives to @adlc/core). This file only maps the
// Cursor wire format onto that decision. It imports ONLY Node builtins + the
// sibling checker (no third-party deps).
//
// Honesty about enforcement (ADR 0006): Cursor's `permission: "deny"` has open
// reliability reports, so this hook is BEST-EFFORT/ADVISORY. The unbypassable
// control is the commit-time CI gate (docs/ci/rails-guard.yml). To avoid bricking
// the editor on a hook bug, internal errors FAIL OPEN in-session (allow + stderr
// notice); the CI gate still catches the edit. The one deliberate fail-closed
// path is a conflicting active-ticket signal, which checkRail reports as a denial.

import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve, relative, dirname, basename } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { checkRail } from '../rails-checker.mjs';

/** Best-effort realpath; falls back to the lexical path (a write may create it). */
function realOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Realpath the DEEPEST EXISTING ancestor of an absolute path, then re-append the
 * not-yet-existing tail. A plain realpath of the full path fails for a file being
 * CREATED, which would leave a symlinked parent (e.g. repoB/link -> repoA)
 * unresolved and mis-attribute the file to the wrong workspace root. Mirrors the
 * checker's resolveRailPath strategy.
 */
function realpathDeepest(absPath) {
  if (existsSync(absPath)) return realOr(absPath);
  const tail = [];
  let cur = absPath;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    tail.unshift(basename(cur));
    cur = parent;
  }
  return tail.length ? resolve(realOr(cur), ...tail) : realOr(cur);
}

// Field names Cursor (and sibling agents) have used for the tool name, the tool
// input bag, and the edited path. Read defensively — the exact preToolUse shape
// is pinned against a real payload in ADR 0006 (Unverified).
const TOOL_NAME_KEYS = ['tool_name', 'toolName', 'tool', 'name'];
const INPUT_BAG_KEYS = ['tool_input', 'toolInput', 'input', 'args', 'arguments', 'params', 'parameters'];
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'target', 'target_path', 'targetPath'];
const ROOT_KEYS = ['workspace_roots', 'workspaceRoots', 'workspace_root', 'workspaceRoot', 'project_root', 'projectRoot', 'cwd', 'root'];

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0];
  }
  return undefined;
}

export function extractToolName(payload) {
  return firstString(payload, TOOL_NAME_KEYS) ?? '';
}

// Keys whose VALUE is an array of per-item edits (MultiEdit) or a string/object
// list of files (batch edit). Mirrors the Claude sibling's targetFilePaths — a
// structured mutator can carry its paths ONLY here, with no top-level scalar.
const BATCH_KEYS = ['edits', 'files', 'changes', 'operations', 'fileEdits', 'file_edits'];

/**
 * EVERY file path a structured edit would touch — the scalar path keys at the top
 * level and in each input bag, PLUS any per-item paths nested in `edits[]`/`files[]`
 * (MultiEdit / batch shapes). Returns a de-duplicated array; the gate checks every
 * one. Missing this is a bypass: a MultiEdit payload carries no top-level path.
 */
export function extractFilePaths(payload) {
  const out = new Set();
  const addScalars = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const s = firstString(obj, PATH_KEYS);
    if (s) out.add(s);
    for (const bk of BATCH_KEYS) {
      const arr = obj[bk];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (typeof el === 'string' && el.trim()) out.add(el);
        else if (el && typeof el === 'object') { const es = firstString(el, PATH_KEYS); if (es) out.add(es); }
      }
    }
  };
  if (payload && typeof payload === 'object') {
    addScalars(payload);
    for (const bagKey of INPUT_BAG_KEYS) addScalars(payload[bagKey]);
  }
  return [...out];
}

/** The first target path (used by the observational audit hook). */
export function extractFilePath(payload) {
  return extractFilePaths(payload)[0];
}

/** Collect every candidate workspace root (handles single-root keys and arrays). */
export function candidateRoots(payload) {
  const roots = [];
  if (payload && typeof payload === 'object') {
    for (const k of ROOT_KEYS) {
      const v = payload[k];
      if (typeof v === 'string' && v.trim()) roots.push(v.trim());
      else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) roots.push(e.trim());
    }
  }
  return roots;
}

/**
 * Resolve the repo root to check against. In a Cursor MULTI-ROOT workspace,
 * `workspace_roots` lists several roots and the edited file may belong to any of
 * them — picking the first one blindly can check an absolute rail path against the
 * wrong repo and miss a frozen-rail edit. So when the edited path is absolute, pick
 * the workspace root that actually CONTAINS it (longest match wins); otherwise fall
 * back to the first declared root, then the process cwd.
 *
 * Ownership is decided on NORMALIZED, symlink-resolved paths with a boundary-aware
 * containment check (`relative()` not starting with `..`) — never raw string
 * prefixes. A non-normalized payload path like `/repo-b/../repo-a/src/frozen.js`
 * (or a symlinked root alias) must be attributed to the repo it actually resolves
 * into, not the one whose name lexically prefixes it.
 */
export function resolveRoot(payload, filePath, fallback = process.cwd()) {
  const roots = candidateRoots(payload);
  if (filePath && isAbsolute(filePath)) {
    const absFile = realpathDeepest(resolve(filePath));
    const owning = roots
      .map((raw) => ({ raw, real: realpathDeepest(resolve(raw)) }))
      .filter(({ real }) => {
        const rel = relative(real, absFile);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      })
      .sort((a, b) => b.real.length - a.real.length)[0];
    if (owning) return owning.raw;
  }
  return roots[0] ?? fallback;
}

/**
 * Pure decision over a parsed Cursor preToolUse payload. Returns the exact stdout
 * object Cursor expects. Never throws: internal errors fail OPEN (advisory).
 */
export function decide(payload, { root, env = process.env } = {}) {
  try {
    const tool = extractToolName(payload);
    const filePaths = extractFilePaths(payload);
    // Nothing path-shaped to gate (e.g. a non-file tool slipped past the matcher):
    // allow. Bash/shell writes are intentionally not gated here.
    if (!filePaths.length) return { permission: 'allow' };

    // Check EVERY target path (a MultiEdit/batch payload touches several) and deny
    // if ANY is a frozen rail. Resolve the owning root per path (multi-root safe).
    for (const filePath of filePaths) {
      const verdict = checkRail({ filePath, tool, root: root ?? resolveRoot(payload, filePath), env });
      if (verdict.decision === 'deny') {
        return {
          permission: 'deny',
          user_message: `ADLC rails-guard: blocked edit to ${verdict.reason}`,
          agent_message:
            `This path is a FROZEN ADLC rail: ${verdict.reason}. ` +
            `Do not edit it during the active build. If the rail must change, update the ticket spec ` +
            `and re-freeze — do not work around the guard.`,
        };
      }
    }
    return { permission: 'allow' };
  } catch (err) {
    // Categorical fail-safe (closes the whole "exception → bypass" class):
    //  - when enforcement is ACTIVE, an unexpected error is more likely corruption
    //    or tamper than a benign bug, so fail CLOSED (deny) — never let a throw in
    //    the deny path become a silent allow on a frozen rail;
    //  - when enforcement is OFF the guard is a no-op anyway, so fail OPEN to avoid
    //    bricking the editor on a hook bug. The CI gate remains the real control.
    const enforcing = env?.ADLC_P4_ENFORCEMENT === '1';
    process.stderr.write(
      `adlc-rails-guard: internal error (failing ${enforcing ? 'CLOSED' : 'OPEN'}) — ${err?.message ?? err}\n`,
    );
    if (enforcing) {
      return {
        permission: 'deny',
        user_message: `ADLC rails-guard: internal error while enforcing — failing closed (${err?.message ?? err})`,
        agent_message:
          'The rail guard hit an unexpected error while enforcement is active and failed closed. ' +
          'Fix the rail/ticket state (e.g. a malformed .adlc/tickets.json) rather than working around the guard.',
      };
    }
    return { permission: 'allow' };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`adlc-rails-guard: malformed payload JSON (failing OPEN) — ${err.message}\n`);
      process.stdout.write(JSON.stringify({ permission: 'allow' }));
      return;
    }
  }
  // decide() resolves the owning workspace root from the payload + edited path.
  const verdict = decide(payload, { env: process.env });
  process.stdout.write(JSON.stringify(verdict));
}

// Run as a hook only when invoked directly (tests import `decide` instead).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
