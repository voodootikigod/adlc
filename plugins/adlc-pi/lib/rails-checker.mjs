// rails-checker.mjs — the ADLC rail-enforcement decision for pi.
//
// THIN adapter: every rail/glob/ticket/shell primitive is delegated to
// @adlc/core (the single source of truth, per ADR 0004). The only non-core
// logic here is mapping pi's extension events onto that core and the
// sibling-hook enforcement contract (active-ticket resolution, trust-root
// freeze) that adlc-codex and adlc-opencode implement. Unlike the siblings,
// pi's enforcement switch is the active ticket itself (no ADLC_P4_ENFORCEMENT)
// — documented in docs/integrations/pi.md.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  loadTickets,
  globMatch,
  inScope,
  classifyShellCommand,
  resolveRailPath,
  TICKET_TRUST_ROOT_RAILS,
  canonicalizePath as canonicalizeWorkspacePath,
  extractAllToolWorkdirs,
  findInnermostCheckoutRoot,
  hasConflictingToolWorkdirs,
  inspectGitCheckout,
  isPathInside,
  preferInnermostCheckout,
} from '@adlc/core';
import { resolveActiveTicketId as resolveActiveTicketIdCanonical } from './generated-active-ticket.mjs';

// The ticket file and the active-ticket pointer are the rail trust root: frozen
// whenever a ticket is active, even if the ticket declares no rails, so the
// rail set cannot be quietly edited away.
export const TRUST_ROOT_RAILS = [...TICKET_TRUST_ROOT_RAILS];

// Directories the framework itself writes evidence into; always in scope
// (except the trust roots, which are never writable by the agent).
const FRAMEWORK_DIRS = ['.adlc/', '.omo/'];

// Suppression markers the reactive gate scans added lines for. The strings
// are assembled by concatenation so this source file never carries an
// operative-looking marker literal — the ADLC text-scanning gates (rails-guard
// suppression scan included) must stay quiet on diffs of the gate itself.
const m = (a, b) => a + b;
export const SUPPRESSION_MARKERS = [
  m('@ts-', 'ignore'),
  m('@ts-', 'expect-error'),
  m('eslint-', 'disable'),
  m('eslint-', 'disable-next-line'),
  m('.sk', 'ip('),
  m('.on', 'ly('),
  m('xf', 'ail'),
  m('# no', 'qa'),
  m('#[ig', 'nore]'),
];

/** Canonicalize a path to a forward-slash path relative to the repo root (lexical). */
export function canonicalizePath(filePath, root) {
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  return relative(root, abs).split('\\').join('/');
}

/**
 * Resolve the active ticket for a repo root. The switch is the ticket itself:
 * ADLC_TICKET env or .adlc/current-ticket.json. Sibling-contract semantics:
 * if both are set and disagree, that is a tamper signal — fail closed.
 * Returns { ticketId, ticket, error }:
 *   ticketId null            → no enforcement (inert)
 *   ticketId + ticket        → enforce with this ticket
 *   ticketId + error string  → enforcement requested but broken → fail closed
 */
export function resolveActiveTicket(root, rawEnv = process.env) {
  const env = envForSecondaryCheckout(root, root, rawEnv ?? {});
  // The pointer parse, the accepted keys, and the conflict rule come from the
  // canonical contract (generated from packages/tickets/lib/pointer.mjs); only the
  // {ticketId, ticket, error} shape below is pi-specific. A denial keeps this
  // harness's "enforcement requested but broken" form: a non-null ticketId with an
  // error, so the caller fails closed rather than reading it as inert.
  const resolved = resolveActiveTicketIdCanonical({ root, env });
  if (!resolved.ok) {
    return { ticketId: '(unknown)', ticket: null, error: resolved.message };
  }
  const ticketId = resolved.value?.id ?? null;
  if (!ticketId) return { ticketId: null, ticket: null, error: null };

  const configured = env.ADLC_TICKET_STORE ?? env.ADLC_TICKETS;
  const ticketsPath = configured ? (isAbsolute(configured) ? configured : join(root, configured)) : join(root, '.adlc', 'tickets.json');
  const { tickets, errors } = loadTickets(ticketsPath);
  if (errors.length > 0) {
    return { ticketId, ticket: null, error: `ticket database failed to load: ${errors[0]}` };
  }
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return { ticketId, ticket: null, error: `active ticket "${ticketId}" not found in ${ticketsPath}` };
  }
  return { ticketId, ticket, error: null };
}

function railMatchesCandidate(rail, candidate) {
  if (candidate === '' || candidate === '.') return true;
  if (globMatch(rail, candidate)) return true;
  if (candidate === rail || rail.startsWith(`${candidate}/`)) return true;
  if (rail.endsWith('/**') && candidate === rail.slice(0, -3)) return true;
  return false;
}

/**
 * Does a target path hit the frozen rail set (trust roots + the active
 * ticket's rails)? Checks both the lexical path and the symlink-resolved path
 * so an alias can't slip past, and matches ancestor directories so deleting a
 * parent directory of a frozen rail is also blocked. Returns the matched rail
 * (string) or null.
 */
export function railHit(filePath, ticket, root) {
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const candidate of candidates) {
    for (const trustRoot of TRUST_ROOT_RAILS) if (railMatchesCandidate(trustRoot, candidate)) return trustRoot;
    for (const rail of ticket?.rails ?? []) {
      if (railMatchesCandidate(rail, candidate)) return rail;
    }
  }
  return null;
}

function hasLocalDefaultStore(dir) {
  return (
    existsSync(join(dir, '.adlc', 'tickets', '.store.json')) ||
    existsSync(join(dir, '.adlc', 'tickets.json'))
  );
}

export function sanitizeDiscoveryStoreOverride(rawOverride, startDir, baseCwd = startDir) {
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
  const anchorInfo = inspectGitCheckout(canonicalizeWorkspacePath(anchor));
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
    if (enclosing && isPathInside(trimmed, enclosing) && !isPathInside(trimmed, anchor)) {
      return null;
    }
    if ((anchorInfo?.kind === 'worktree' || enclosing) && hasLocalDefaultStore(anchor) && !isPathInside(trimmed, anchor)) {
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
      if (isPathInside(resolvedBase, boundary)) {
        const fromBase = resolve(resolvedBase, trimmed);
        if (isPathInside(fromBase, boundary) && existsSync(fromBase)) {
          return fromBase;
        }
      }
    }
    return null;
  }
  if (boundary) {
    return isPathInside(resolve(boundary, trimmed), boundary) ? trimmed : null;
  }
  const atStart = resolve(resolvedStart, trimmed);
  if (existsSync(atStart) && !isPathInside(atStart, resolvedStart)) return null;
  return trimmed;
}

export function envForSecondaryCheckout(checkoutRoot, primaryRoot, env = process.env, baseCwd = null) {
  if (!checkoutRoot || !env) return env;
  const sameAsPrimary =
    !primaryRoot ||
    canonicalizeWorkspacePath(resolve(checkoutRoot)) === canonicalizeWorkspacePath(resolve(primaryRoot));
  const checkoutInfo = inspectGitCheckout(canonicalizeWorkspacePath(resolve(checkoutRoot)));
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
  const localStorePresent = hasLocalDefaultStore(checkoutRoot);
  const next = { ...env };
  if (sameAsPrimary && !isNestedWorktree) {
    for (const key of ['ADLC_TICKET_STORE', 'ADLC_TICKETS']) {
      const val = next[key];
      if (typeof val !== 'string' || !val.trim()) continue;
      const trimmed = val.trim();
      if (isAbsolute(trimmed)) continue;
      const fromCheckout = resolve(checkoutRoot, trimmed);
      if (isPathInside(fromCheckout, checkoutRoot)) {
        if (
          !existsSync(fromCheckout) &&
          baseCwd &&
          isPathInside(resolve(baseCwd), checkoutRoot) &&
          isPathInside(resolve(baseCwd, trimmed), checkoutRoot) &&
          existsSync(resolve(baseCwd, trimmed))
        ) {
          next[key] = resolve(baseCwd, trimmed);
        }
        continue;
      }
      if (
        baseCwd &&
        isPathInside(resolve(baseCwd), checkoutRoot) &&
        isPathInside(resolve(baseCwd, trimmed), checkoutRoot) &&
        existsSync(resolve(baseCwd, trimmed))
      ) {
        next[key] = resolve(baseCwd, trimmed);
      } else if (localStorePresent) {
        delete next[key];
      }
    }
    return next;
  }
  if (
    !sameAsPrimary &&
    (!isPathInside(checkoutRoot, primaryRoot) ||
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
      !isAbsolute(trimmed) && isPathInside(resolvedRel, checkoutRoot) && existsSync(resolvedRel);
    const fromBaseCwd =
      sameAsPrimary &&
      baseCwd &&
      !isAbsolute(trimmed) &&
      isPathInside(resolve(baseCwd), checkoutRoot) &&
      isPathInside(resolve(baseCwd, trimmed), checkoutRoot) &&
      existsSync(resolve(baseCwd, trimmed))
        ? resolve(baseCwd, trimmed)
        : null;
    if (fromBaseCwd) {
      next[key] = fromBaseCwd;
      continue;
    }
    const outsideOuter =
      (sameAsPrimary || !isPathInside(trimmed, primaryRoot)) &&
      (!enclosingCheckout || !isPathInside(trimmed, enclosingCheckout) || isPathInside(trimmed, checkoutRoot));
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

export function resolveOwningCheckoutRoot(absTarget, primaryRoot, env = process.env) {
  const storeOverride = env?.ADLC_TICKET_STORE ?? env?.ADLC_TICKETS ?? null;
  if (isPathInside(absTarget, primaryRoot)) {
    const innerOverride =
      storeOverride &&
      ((!isAbsolute(storeOverride) &&
        (!isPathInside(resolve(primaryRoot, storeOverride), primaryRoot) ||
          !existsSync(resolve(primaryRoot, storeOverride)))) ||
        (isAbsolute(storeOverride) && isPathInside(storeOverride, primaryRoot)))
        ? null
        : storeOverride;
    return (
      preferInnermostCheckout(primaryRoot, [absTarget], {
        storeOverride: innerOverride,
        allowFileStart: true,
        preserveSpelling: true,
      }) ?? primaryRoot
    );
  }
  const foreignStoreOverride =
    storeOverride && isAbsolute(storeOverride) && !isPathInside(storeOverride, primaryRoot)
      ? storeOverride
      : null;
  return findInnermostCheckoutRoot(absTarget, {
    storeOverride: foreignStoreOverride,
    allowFileStart: true,
    requireStore: true,
    preserveSpelling: true,
  });
}

/** Is a path within the ticket's declared scope? Empty scope = unrestricted within root. */
export function pathInScope(filePath, ticket, root) {
  const absTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (!isPathInside(absTarget, root)) return false;
  const candidates = new Set([canonicalizePath(filePath, root), resolveRailPath(filePath, root)]);
  for (const candidate of candidates) {
    if (candidate === '..' || candidate.startsWith('../') || isAbsolute(candidate)) return false;
    // The trust roots are NEVER in scope for agent modification.
    if (TRUST_ROOT_RAILS.some((trustRoot) => railMatchesCandidate(trustRoot, candidate))) return false;
    if (ticket?.scope && ticket.scope.length > 0) {
      // Framework evidence dirs stay writable under any scope.
      const inFrameworkDir = FRAMEWORK_DIRS.some((dir) => candidate.startsWith(dir));
      if (!inFrameworkDir && !inScope(ticket, candidate)) return false;
    }
  }
  return true;
}

/**
 * Decision for a structured file mutation (pi `write`/`edit` — input.path per
 * the pinned v0.80.3 tool schemas). Rails first (symlink-aware), then scope.
 */
export function checkStructuredWrite(filePath, ticket, root, { env = process.env } = {}) {
  const absTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const owning = resolveOwningCheckoutRoot(absTarget, root, env);
  if (
    owning &&
    canonicalizeWorkspacePath(resolve(owning)) !== canonicalizeWorkspacePath(resolve(root))
  ) {
    const owningActive = resolveActiveTicket(owning, envForSecondaryCheckout(owning, root, env));
    if (owningActive.error) {
      return { decision: 'deny', reason: owningActive.error };
    }
    if (owningActive.ticket) {
      const foreignHit = railHit(absTarget, owningActive.ticket, owning);
      if (foreignHit) {
        return { decision: 'deny', reason: `"${filePath}" matches frozen rail "${foreignHit}"` };
      }
      if (!pathInScope(absTarget, owningActive.ticket, owning)) {
        return { decision: 'deny', reason: `"${filePath}" is out of the ticket's declared scope` };
      }
      if (isPathInside(owning, root) || !ticket) {
        return { decision: 'allow', reason: 'target is neither a frozen rail nor out of scope' };
      }
    }
  }
  if (!ticket) {
    return { decision: 'allow', reason: 'target is neither a frozen rail nor out of scope' };
  }
  const hit = railHit(filePath, ticket, root);
  if (hit) {
    return { decision: 'deny', reason: `"${filePath}" matches frozen rail "${hit}"` };
  }
  if (!pathInScope(filePath, ticket, root)) {
    return { decision: 'deny', reason: `"${filePath}" is out of the ticket's declared scope` };
  }
  return { decision: 'allow', reason: 'target is neither a frozen rail nor out of scope' };
}

/**
 * Pure branch creation cannot touch a rail: `git checkout -b <name>` /
 * `git switch -c <name>` with nothing else on the line. The character class
 * excludes separators (;&|) and whitespace, so nothing can be smuggled after
 * the branch name. Everything else falls through to the codex ladder (where
 * bare `git checkout` is opaque and denied).
 */
export function isSafeBranchCreation(command) {
  return /^\s*git\s+(?:checkout\s+-b|switch\s+-c)\s+[A-Za-z0-9._/-]+\s*$/.test(String(command ?? ''));
}

/**
 * Decision for a shell command — the codex-parity enforcement ladder over
 * @adlc/core's classifier. Shell paths are checked against RAILS only (scope
 * enforcement is a structured-edit concern; the reactive diff gate and the CI
 * rails-guard remain the backstop for anything the classifier cannot see):
 *   safe branch creation                    → allow
 *   positively read-only                    → allow (unless output-option smuggle)
 *   neither read-only nor visibly mutating  → deny (unverifiable → fail closed)
 *   opaque mutation (git checkout/apply/…)  → deny
 *   changes cwd / uses expansion            → deny (targets unverifiable)
 *   mutation with no literal targets        → deny (fail closed)
 *   literal targets                         → deny only on a frozen-rail hit
 */
export function checkShellCommand(command, ticket, root, { workdir = null, workdirs = null, env = process.env } = {}) {
  if (isSafeBranchCreation(command)) {
    return { decision: 'allow', mutating: false, reason: 'pure branch creation cannot touch a rail' };
  }
  const c = classifyShellCommand(command);
  // Every verdict carries `mutating` so advisory consumers (user_bash) can key
  // on the mutation CLASS instead of parsing reason strings (P5 finding F2).
  if (c.readOnly) {
    if (c.writeOption) {
      return { decision: 'deny', mutating: true, reason: 'read-only shell command uses an output option; use a structured edit tool or a literal path-transparent mutation' };
    }
    return { decision: 'allow', mutating: false, reason: 'shell command is positively read-only' };
  }
  if (!c.mutating) {
    return { decision: 'deny', mutating: false, reason: 'shell command is neither positively read-only nor a path-transparent mutation — unverifiable while a ticket is active (the CI diff gate remains the backstop)' };
  }
  if (c.opaque) {
    return { decision: 'deny', mutating: true, reason: 'mutating shell command uses an opaque form (git apply/checkout/patch/tar…); use a structured edit tool or a literal path-transparent mutation' };
  }
  const canonicalRoot = canonicalizeWorkspacePath(resolve(root));
  const candidateDirs = Array.isArray(workdirs)
    ? workdirs
    : typeof workdir === 'string' && workdir.trim() !== ''
      ? [workdir]
      : [];
  const movesWorkdir = candidateDirs.some(
    (w) =>
      typeof w === 'string' &&
      w.trim() !== '' &&
      canonicalizeWorkspacePath(resolve(root, w.trim())) !== canonicalRoot
  );
  if (c.changesCwd || movesWorkdir) {
    return { decision: 'deny', mutating: true, reason: 'mutating shell command changes cwd; target paths cannot be verified against the frozen rails' };
  }
  if (c.expands) {
    return { decision: 'deny', mutating: true, reason: 'mutating shell command uses shell expansion ($VAR, $(…), backticks, globs); target paths cannot be verified against the frozen rails' };
  }
  if (c.paths.length === 0) {
    return { decision: 'deny', mutating: true, reason: 'mutating shell command carries no literal target paths — failing closed while a ticket is active' };
  }
  for (const target of c.paths) {
    const absTarget = isAbsolute(target) ? resolve(target) : resolve(root, target);
    if (absTarget !== '/dev/null') {
      const owning = resolveOwningCheckoutRoot(absTarget, root, env);
      if (owning && canonicalizeWorkspacePath(resolve(owning)) !== canonicalRoot) {
        const owningActive = resolveActiveTicket(owning, envForSecondaryCheckout(owning, root, env));
        if (owningActive.error) {
          return { decision: 'deny', mutating: true, reason: owningActive.error };
        }
        if (owningActive.ticket) {
          const secondaryHit = railHit(absTarget, owningActive.ticket, owning);
          if (secondaryHit) {
            return { decision: 'deny', mutating: true, reason: `shell mutation targets frozen rail "${secondaryHit}"` };
          }
          if (isPathInside(owning, root) || !ticket) {
            continue;
          }
        }
      }
      if (ticket && !isPathInside(absTarget, root)) {
        return {
          decision: 'deny',
          mutating: true,
          reason: `shell mutation target "${target}" resolves outside the repository root; target paths cannot be verified against the frozen rails`,
        };
      }
    }
    if (ticket) {
      const hit = railHit(target, ticket, root);
      if (hit) {
        return { decision: 'deny', mutating: true, reason: `shell mutation targets frozen rail "${hit}"` };
      }
    }
  }
  return { decision: 'allow', mutating: true, reason: 'shell mutation targets no frozen rail' };
}

// pi built-in tools that carry paths but never mutate them (they arrive as
// their own typed events, not CustomToolCallEvent, but are listed for the
// name-keyed check). Kept minimal: every entry is bypass surface.
export const READONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

// Input keys that name a file target on third-party tools.
const PATH_KEY = /^(?:path|file|file_?path|filepath|target)$/i;

/**
 * Extract path-like targets from a custom tool's input (spec 2.5): values of
 * path-named keys (string or string[], including ONE level of object
 * nesting — {opts:{path:…}} is a common tool-arg shape), plus any other
 * top-level string that looks path-like AND resolves to an existing file
 * inside the repo.
 */
export function extractToolPaths(input, root, depth = 0) {
  const out = new Set();
  for (const [key, value] of Object.entries(input ?? {})) {
    if (depth === 0 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of extractToolPaths(value, root, 1)) out.add(nested);
      continue;
    }
    const candidates = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    for (const candidate of candidates) {
      if (candidate === '') continue;
      if (PATH_KEY.test(key)) {
        out.add(candidate);
      } else if (/[/\\]|\.[A-Za-z0-9]+$/.test(candidate) && existsSync(join(root, candidate))) {
        out.add(candidate);
      }
    }
  }
  return [...out];
}

/**
 * Gate decision for a third-party (custom) tool call. Layered posture
 * (spec 2.5): extractable targets are rail-checked (symlink-aware, via
 * railHit); a no-target unknown tool is allowed but marked unvetted so the
 * evidence rail records it. Custom tools are NOT snapshotted by the reactive
 * gate — for anything this extraction cannot see (deeper nesting, spoofed
 * read-only names), the CI rails-guard diff gate is the backstop.
 */
export function checkCustomTool(toolName, input, ticket, root, { cwd = root, env = process.env } = {}) {
  const name = String(toolName ?? '').toLowerCase();
  if (READONLY_TOOLS.includes(name)) {
    return { decision: 'allow', reason: 'known read-only tool' };
  }
  const baseCwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : root;
  if (hasConflictingToolWorkdirs(input, baseCwd)) {
    return {
      decision: 'deny',
      reason: `custom tool "${toolName}" specifies conflicting working directories`,
    };
  }
  const explicitWorkdirs = extractAllToolWorkdirs(input);
  const effectiveCwd = explicitWorkdirs.length > 0 ? resolve(baseCwd, explicitWorkdirs[0]) : baseCwd;
  const paths = new Set([
    ...extractToolPaths(input, root),
    ...(effectiveCwd !== root
      ? extractToolPaths(input, effectiveCwd).map((p) => (isAbsolute(p) ? p : resolve(effectiveCwd, p)))
      : []),
  ]);
  for (const path of paths) {
    const absPath = isAbsolute(path) ? resolve(path) : resolve(effectiveCwd, path);
    const owning = resolveOwningCheckoutRoot(absPath, root, env);
    if (
      owning &&
      canonicalizeWorkspacePath(resolve(owning)) !== canonicalizeWorkspacePath(resolve(root))
    ) {
      const owningActive = resolveActiveTicket(owning, envForSecondaryCheckout(owning, root, env));
      if (owningActive.error) return { decision: 'deny', reason: owningActive.error };
      if (owningActive.ticket) {
        const foreignHit = railHit(absPath, owningActive.ticket, owning);
        if (foreignHit) {
          return { decision: 'deny', reason: `custom tool "${toolName}" targets frozen rail "${foreignHit}" via "${path}"` };
        }
      }
    }
    if (ticket) {
      if (!isPathInside(absPath, root)) {
        return {
          decision: 'deny',
          reason: `custom tool "${toolName}" targets path outside repository root via "${path}"`,
        };
      }
      const hit = railHit(path, ticket, root) ?? railHit(absPath, ticket, root);
      if (hit) {
        return { decision: 'deny', reason: `custom tool "${toolName}" targets frozen rail "${hit}" via "${path}"` };
      }
    }
  }
  if (paths.size === 0) {
    if (ticket && Array.isArray(ticket.rails) && ticket.rails.length > 0) {
      return {
        decision: 'deny',
        reason: `custom tool "${toolName}" has no extractable file targets — failing closed while a railed ticket is active`,
        unvetted: true,
      };
    }
    return { decision: 'allow', reason: 'no extractable file target', unvetted: true };
  }
  return { decision: 'allow', reason: 'targets hit no frozen rail' };
}

/** Suppressions allowed by the ticket: structured field + `allow-suppression:` body lines. */
export function getAllowedSuppressions(ticket) {
  const allowed = new Set(ticket?.allowedSuppressions ?? []);
  for (const line of (ticket?.body ?? '').split(/\r?\n/)) {
    const match = line.match(/^allow-suppression:\s*(\S+)/);
    if (match) allowed.add(match[1]);
  }
  return Array.from(allowed);
}
