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
// Cursor wire format onto that decision. It imports ONLY Node builtins, the
// sibling checker, and the plugin's own root normalizer (no third-party deps).
//
// Honesty about enforcement (ADR 0006): Cursor's `permission: "deny"` has open
// reliability reports, so this hook is BEST-EFFORT/ADVISORY. The unbypassable
// control is the commit-time CI gate (docs/ci/rails-guard.yml). To avoid bricking
// the editor on a hook bug, internal errors FAIL OPEN in-session (allow + stderr
// notice); the CI gate still catches the edit. The one deliberate fail-closed
// path is a conflicting active-ticket signal, which checkRail reports as a denial.

import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve, relative, dirname, basename, join } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { checkRail, classifyTool, isShellTool, railPreconditions } from '../rails-checker.mjs';
import { normalizeRootPath } from '../lib/workspace-resolve.mjs';
import { findInnermostCheckoutRoot, inspectGitCheckout, preferInnermostCheckout } from '@adlc/core';

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
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file', 'targetFile', 'target', 'target_path', 'targetPath'];
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

// Keys whose VALUE is a free-form patch / command string that names its target
// files inline (the apply_patch envelope), e.g. "*** Update File: test/a.mjs".
const PATCH_TEXT_KEYS = ['command', 'cmd', 'patch', 'input', 'content', 'text', 'diff'];
const PATCH_PREFIXES = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];

/** Pull every `*** <verb> File: <path>` target out of an apply_patch-style string. */
function collectPatchPaths(text, out) {
  for (const line of String(text).split(/\r?\n/)) {
    for (const pre of PATCH_PREFIXES) {
      if (line.startsWith(pre)) {
        const p = line.slice(pre.length).trim();
        if (p) out.add(p);
      }
    }
  }
}

/**
 * EVERY file path a structured edit would touch — the scalar path keys at the top
 * level and in each input bag, PLUS any per-item paths nested in `edits[]`/`files[]`
 * (MultiEdit / batch shapes). Returns a de-duplicated array; the gate checks every
 * one. Missing this is a bypass: a MultiEdit payload carries no top-level path.
 */
export function extractFilePaths(payload) {
  const out = new Set();
  // Collect EVERY path-key value on an object — not just the first. A rename/move
  // payload carries a source AND a destination (path + target_path); checking only
  // the first would miss a frozen rail hidden in the second slot.
  const addEveryPathKey = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of PATH_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) out.add(v);
      else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e.trim()) out.add(e);
    }
  };
  const addScalars = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    addEveryPathKey(obj);
    for (const bk of BATCH_KEYS) {
      const arr = obj[bk];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (typeof el === 'string' && el.trim()) out.add(el);
        else if (el && typeof el === 'object') addEveryPathKey(el);
      }
    }
    // apply_patch-style payloads name their targets inside a patch/command string.
    for (const tk of PATCH_TEXT_KEYS) {
      const v = obj[tk];
      if (typeof v === 'string' && v.includes('*** ')) collectPatchPaths(v, out);
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

/**
 * Collect every candidate workspace root (handles single-root keys and arrays).
 * Each is normalized, and a relative root is dropped: it would be read against
 * the hook process cwd, which is the plugin directory, not the workspace.
 */
export function candidateRoots(payload) {
  const raw = [];
  if (payload && typeof payload === 'object') {
    for (const k of ROOT_KEYS) {
      const v = payload[k];
      if (typeof v === 'string') raw.push(v);
      else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') raw.push(e);
    }
  }
  return raw.map(absoluteRoot).filter((r) => r != null);
}

/**
 * A normalized ABSOLUTE root, or null. normalizeRootPath alone would resolve an
 * existing relative path (".") against the process cwd, so absoluteness is
 * checked on the raw value first.
 */
export function absoluteRoot(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) return null;
  return normalizeRootPath(trimmed);
}

/**
 * Resolve the repo root to check against. In a Cursor MULTI-ROOT workspace,
 * `workspace_roots` lists several roots and the edited file may belong to any of
 * them — picking the first one blindly can check an absolute rail path against the
 * wrong repo and miss a frozen-rail edit. So when the edited path is absolute, pick
 * the workspace root that actually CONTAINS it (longest match wins); otherwise fall
 * back to the first declared root, then an explicit fallback, then the host's
 * CURSOR_PROJECT_DIR. Never the process cwd: Cursor runs the hook from the PLUGIN
 * directory, so a cwd fallback evaluated a repo with no ticket store and allowed
 * every edit. When nothing resolves, `root` is null and callers must treat the
 * workspace as unverifiable (see unresolvedRootVerdict).
 *
 * Ownership is decided on NORMALIZED, symlink-resolved paths with a boundary-aware
 * containment check (`relative()` not starting with `..`) — never raw string
 * prefixes. A non-normalized payload path like `/repo-b/../repo-a/src/frozen.js`
 * (or a symlinked root alias) must be attributed to the repo it actually resolves
 * into, not the one whose name lexically prefixes it.
 */
const EXPLICIT_WORKSPACE_KEYS = ['workspace_roots', 'workspaceRoots', 'workspace_root', 'workspaceRoot', 'project_root', 'projectRoot', 'root'];

function hasExplicitWorkspaceDeclaration(payload) {
  return Boolean(firstString(payload, EXPLICIT_WORKSPACE_KEYS));
}

function hasLocalDefaultTicketStore(dir) {
  return (
    existsSync(join(dir, '.adlc', 'tickets', '.store.json')) ||
    existsSync(join(dir, '.adlc', 'tickets.json'))
  );
}

function storeOverrideForNestedProbe(rawOverride, outerDir) {
  if (!rawOverride || typeof rawOverride !== 'string' || !rawOverride.trim()) return null;
  const trimmed = rawOverride.trim();
  if (!isAbsolute(trimmed)) {
    const resolvedRel = resolve(outerDir, trimmed);
    return contains(outerDir, resolvedRel) && existsSync(resolvedRel) ? trimmed : null;
  }
  return contains(outerDir, trimmed) ? null : trimmed;
}

function sanitizeDiscoveryStoreOverride(rawOverride, startDir, baseCwd = startDir) {
  if (typeof rawOverride !== 'string' || !rawOverride.trim()) return null;
  const trimmed = rawOverride.trim();
  const resolvedStart = resolve(startDir);
  const boundary = findInnermostCheckoutRoot(resolvedStart, {
    storeOverride: null,
    requireStore: false,
    allowFileStart: true,
    preserveSpelling: true,
  });
  const anchor = boundary ?? resolvedStart;
  const anchorInfo = inspectGitCheckout(realpathDeepest(resolve(anchor)));
  const anchorParent = dirname(resolve(anchor));
  const enclosing =
    anchorParent !== resolve(anchor)
      ? findInnermostCheckoutRoot(anchorParent, {
          storeOverride: null,
          requireStore: true,
          preserveSpelling: true,
        })
      : null;
  if (isAbsolute(trimmed)) {
    if (enclosing && contains(enclosing, trimmed) && !contains(anchor, trimmed)) {
      return null;
    }
    if ((anchorInfo?.kind === 'worktree' || enclosing) && hasLocalDefaultTicketStore(anchor) && !contains(anchor, trimmed)) {
      return null;
    }
    return trimmed;
  }
  const lexRel = relative('/anchor', resolve('/anchor', trimmed));
  const escapesLexically =
    lexRel === '..' || lexRel.startsWith('../') || lexRel.startsWith('..\\') || isAbsolute(lexRel);
  if (escapesLexically) {
    if (boundary && baseCwd) {
      const resolvedBase = resolve(baseCwd);
      if (contains(boundary, resolvedBase)) {
        const fromBase = resolve(resolvedBase, trimmed);
        if (contains(boundary, fromBase) && existsSync(fromBase)) {
          return fromBase;
        }
      }
    }
    return null;
  }
  if (boundary) {
    return contains(boundary, resolve(boundary, trimmed)) ? trimmed : null;
  }
  const atStart = resolve(resolvedStart, trimmed);
  if (existsSync(atStart) && !contains(resolvedStart, atStart)) return null;
  return trimmed;
}

export function envForCheckoutRoot(checkoutRoot, outerAnchor, env) {
  if (!checkoutRoot || !env) return env;
  const sameAsOuter =
    !outerAnchor || realpathDeepest(resolve(checkoutRoot)) === realpathDeepest(resolve(outerAnchor));
  const checkoutInfo = inspectGitCheckout(realpathDeepest(resolve(checkoutRoot)));
  const parentDir = dirname(resolve(checkoutRoot));
  const enclosingCheckout =
    parentDir !== resolve(checkoutRoot)
      ? findInnermostCheckoutRoot(parentDir, {
          storeOverride: null,
          requireStore: true,
          preserveSpelling: true,
        })
      : null;
  const isNestedWorktree = checkoutInfo?.kind === 'worktree' || enclosingCheckout !== null;
  const localStorePresent = hasLocalDefaultTicketStore(checkoutRoot);
  const next = { ...env };
  if (sameAsOuter && !isNestedWorktree) {
    for (const key of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
      const val = next[key];
      if (typeof val !== 'string' || !val.trim()) continue;
      const trimmed = val.trim();
      if (isAbsolute(trimmed)) continue;
      if (!contains(checkoutRoot, resolve(checkoutRoot, trimmed)) && localStorePresent) {
        delete next[key];
      }
    }
    return next;
  }
  if (
    !sameAsOuter &&
    (!contains(outerAnchor, checkoutRoot) ||
      existsSync(join(checkoutRoot, '.adlc', 'current-ticket.json')))
  ) {
    delete next.ADLC_TICKET;
  }
  for (const key of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
    const val = next[key];
    if (typeof val !== 'string' || !val.trim()) continue;
    const trimmed = val.trim();
    const resolvedRel = resolve(checkoutRoot, trimmed);
    const keepRelative =
      !isAbsolute(trimmed) && contains(checkoutRoot, resolvedRel) && existsSync(resolvedRel);
    const outsideOuter =
      (sameAsOuter || !contains(outerAnchor, trimmed)) &&
      (!enclosingCheckout || !contains(enclosingCheckout, trimmed) || contains(checkoutRoot, trimmed));
    const keepExternal =
      isAbsolute(trimmed) &&
      outsideOuter &&
      !localStorePresent;
    if (!keepRelative && !keepExternal) {
      delete next[key];
    }
  }
  return next;
}

export function resolveOwningInternal(payload, filePath, fallback, env = process.env) {
  const roots = candidateRoots(payload);
  const rawStoreOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
  const cwdOnlyRoot = roots.length > 0 && !hasExplicitWorkspaceDeclaration(payload);
  const base = roots[0] ?? fallback ?? hostProjectRoot(env);
  const absFile = !filePath
    ? undefined
    : isAbsolute(filePath) ? resolve(filePath) : (base != null ? resolve(base, filePath) : undefined);
  const climbIfCwdOnly = (chosen) => {
    if (!cwdOnlyRoot || !chosen) return chosen;
    const safeOverride = sanitizeDiscoveryStoreOverride(rawStoreOverride, chosen, chosen);
    return findInnermostCheckoutRoot(chosen, { storeOverride: safeOverride, preserveSpelling: true }) ?? chosen;
  };
  if (absFile) {
    const upgradeWorktree = (chosen) => {
      const climbed = climbIfCwdOnly(chosen);
      return (
        preferInnermostCheckout(climbed, [absFile], {
          storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbed),
          allowFileStart: true,
          preserveSpelling: true,
        }) ?? climbed
      );
    };
    const owning = roots
      .map((raw) => climbIfCwdOnly(raw))
      .filter((raw) => contains(raw, absFile))
      .map((raw) => ({ raw, real: realpathDeepest(resolve(raw)) }))
      .sort((a, b) => b.real.length - a.real.length)[0];
    if (owning) return { root: upgradeWorktree(owning.raw), absFile, outerRoot: owning.raw };
    const climbedBase = climbIfCwdOnly(base);
    if (fallback == null && climbedBase != null && !contains(climbedBase, absFile)) return { root: null, absFile, outerRoot: null };
    if (climbedBase != null) return { root: upgradeWorktree(climbedBase), absFile, outerRoot: climbedBase };
  }
  const climbedForBase = base != null ? climbIfCwdOnly(base) : null;
  const resolvedBase = climbedForBase != null
    ? (preferInnermostCheckout(climbedForBase, [payload?.cwd], {
        storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbedForBase),
        preserveSpelling: true,
      }) ?? climbedForBase)
    : null;
  return { root: resolvedBase, absFile, outerRoot: climbedForBase };
}

export function resolveOwning(payload, filePath, fallback, env = process.env) {
  const { root, absFile } = resolveOwningInternal(payload, filePath, fallback, env);
  return { root, absFile };
}

/** Symlink-aware, boundary-aware containment of an absolute path in a root. */
function contains(root, absFile) {
  const rel = relative(realpathDeepest(resolve(root)), realpathDeepest(absFile));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The owning workspace root for an edited path (back-compat wrapper). */
export function resolveRoot(payload, filePath, fallback, env = process.env) {
  return resolveOwning(payload, filePath, fallback, env).root;
}

/** The host-supplied project dir (CURSOR_PROJECT_DIR), normalized; null when unset or relative. */
export function hostProjectRoot(env = process.env) {
  return absoluteRoot(env?.CURSOR_PROJECT_DIR);
}

const UNRESOLVED_CAUSE =
  'the workspace root could not be resolved from the hook payload (workspace_roots/cwd/root) or CURSOR_PROJECT_DIR';

/**
 * The verdict when no workspace root resolves. Under ADLC_P4_ENFORCEMENT=1 the
 * edit cannot be checked against any ticket's rails, so it is denied; otherwise
 * the guard is a no-op and allows, with one stderr notice naming the cause.
 */
export function unresolvedRootVerdict(tool, env = process.env) {
  if (env?.ADLC_P4_ENFORCEMENT !== '0') {
    return {
      permission: 'deny',
      user_message: `ADLC rails-guard: blocked "${tool || 'unknown'}" — ${UNRESOLVED_CAUSE}`,
      agent_message:
        `Rail enforcement is active but ${UNRESOLVED_CAUSE}, so the edit cannot be verified against the ` +
        'frozen rails and is denied. The host must supply workspace_roots or set CURSOR_PROJECT_DIR.',
    };
  }
  process.stderr.write(`adlc-rails-guard: ${UNRESOLVED_CAUSE}; rails not checked (enforcement inactive)\n`);
  return { permission: 'allow' };
}

/**
 * Pure decision over a parsed Cursor preToolUse payload. Returns the exact stdout
 * object Cursor expects. Never throws: internal errors fail OPEN (advisory).
 */
export function decide(payload, { root, env = process.env } = {}) {
  try {
    const tool = extractToolName(payload);
    const filePaths = extractFilePaths(payload);
    if (!filePaths.length) {
      // No path we could see. Allow read-only tools AND shell/terminal tools — the
      // latter run a Turing-complete command (e.g. `npm test`) and are intentionally
      // not rail-gated in-session; their writes fall to the CI gate. Denying them
      // would break the normal P4 build/test workflow. But a structured MUTATING (or
      // unrecognized) tool that reached the guard with an unparseable target under
      // active enforcement is opaque: fail CLOSED rather than wave it through (e.g. a
      // patch format we don't parse).
      // Classify FIRST. Read-only tools and genuine shell/terminal tools are NEVER
      // rail-gated in-session and must be exempt unconditionally — a no-path shell
      // command (`npm test`) or a read-only search has to run even if some *other*
      // workspace root has a broken/conflicting ticket state. Only a structured
      // mutator (mutating classification ALWAYS wins, so `terminal_edit` can't
      // masquerade as shell) or an unrecognized non-shell tool is "opaque".
      const cls = classifyTool(tool);
      const opaque = cls === 'mutating' || (cls === 'other' && !isShellTool(tool));
      if (!opaque) return { permission: 'allow' };

      // Opaque mutator with no inspectable path. It gives NO ownership signal, so in
      // a multi-root workspace we can't tell which root it targets: evaluate EVERY
      // candidate root via the shared railPreconditions and take the strictest
      // outcome — any 'deny' (conflict/corrupt) → deny; else any 'active' root → deny
      // (can't verify it against that root's frozen rails); else (all inactive) allow.
      const declared = candidateRoots(payload);
      const rawStoreOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
      const cwdOnly = declared.length > 0 && !hasExplicitWorkspaceDeclaration(payload);
      const host = hostProjectRoot(env);
      const rawRoots = root != null ? [root] : declared.length ? declared : host != null ? [host] : [];
      if (!rawRoots.length) return unresolvedRootVerdict(tool, env);
      const rootPairs = rawRoots.map((r) => {
        const climbed =
          root == null && cwdOnly
            ? (findInnermostCheckoutRoot(r, {
                storeOverride: sanitizeDiscoveryStoreOverride(rawStoreOverride, r, r),
                preserveSpelling: true,
              }) ?? r)
            : r;
        const chosen =
          preferInnermostCheckout(climbed, [payload?.cwd], {
            storeOverride: storeOverrideForNestedProbe(rawStoreOverride, climbed),
            preserveSpelling: true,
          }) ?? climbed;
        return { root: chosen, outerRoot: climbed };
      });
      const states = rootPairs.map(({ root: r, outerRoot }) =>
        railPreconditions({ root: r, env: envForCheckoutRoot(r, outerRoot, env) })
      );
      const denied = states.find((s) => s.state === 'deny');
      if (denied) {
        return {
          permission: 'deny',
          user_message: `ADLC rails-guard: blocked "${tool || 'unknown'}" — ${denied.reason}`,
          agent_message: `The rail trust state failed closed: ${denied.reason}. Fix the ticket/rail state rather than working around the guard.`,
        };
      }
      if (states.some((s) => s.state === 'active')) {
        return {
          permission: 'deny',
          user_message: `ADLC rails-guard: blocked "${tool || 'unknown'}" — a structured mutating tool with no verifiable target path while enforcement is active`,
          agent_message:
            `A structured mutating tool reached the rail guard during an active build but exposed no ` +
            `inspectable file path, so it cannot be verified against the frozen rails and is denied. Use a ` +
            `structured edit/write with an explicit path rather than an opaque patch payload. ` +
            `(Shell commands are allowed in-session and gated by the CI rail-freeze check instead.)`,
        };
      }
      return { permission: 'allow' };
    }

    // Check EVERY target path (a MultiEdit/batch payload touches several) and deny
    // if ANY is a frozen rail. Resolve the owning root AND the absolute path per
    // path (multi-root safe) — pass the ABSOLUTE path to checkRail so it never
    // re-joins a primary-root-relative path against a different owning root.
    // A read-only tool is never rail-gated, so it needs no root.
    if (classifyTool(tool) === 'readonly') return { permission: 'allow' };
    const owners = filePaths.map((filePath) => ({
      filePath,
      owned: root != null ? { root, absFile: undefined, outerRoot: root } : resolveOwningInternal(payload, filePath, undefined, env),
    }));
    if (owners.some(({ owned }) => owned.root == null)) return unresolvedRootVerdict(tool, env);
    for (const { filePath, owned } of owners) {
      const targetEnv = envForCheckoutRoot(owned.root, owned.outerRoot, env);
      const verdict = checkRail({ filePath: owned.absFile ?? filePath, tool, root: owned.root, env: targetEnv });
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
    const enforcing = env?.ADLC_P4_ENFORCEMENT !== '0';
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
      // Enforcement-aware (consistent with decide()'s categorical fail-safe): an
      // unparseable payload while enforcement is active cannot be verified, so fail
      // CLOSED; otherwise the guard is a no-op, so fail open to avoid bricking the editor.
      const enforcing = process.env.ADLC_P4_ENFORCEMENT !== '0';
      process.stderr.write(`adlc-rails-guard: malformed payload JSON (failing ${enforcing ? 'CLOSED' : 'OPEN'}) — ${err.message}\n`);
      process.stdout.write(JSON.stringify(enforcing
        ? {
            permission: 'deny',
            user_message: 'ADLC rails-guard: unparseable tool payload while enforcement is active — failing closed',
            agent_message: 'The rail guard received a tool payload it could not parse during an active build, so the edit cannot be verified against the frozen rails and is denied. Retry with a well-formed structured edit.',
          }
        : { permission: 'allow' }));
      return;
    }
  }
  // decide() resolves the owning workspace root from the payload + edited path.
  const verdict = decide(payload, { env: process.env });
  process.stdout.write(JSON.stringify(verdict));
}

// Run as a hook only when invoked directly (tests import `decide` instead, and
// bundled hooks inline this module without invoking its standalone entrypoint).
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  process.argv[1].endsWith('adlc-rails-guard.mjs')
) {
  main();
}
