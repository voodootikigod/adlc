// pretool.mjs — shared PreToolUse rail enforcement core.
// Consolidates enclosingAdlcRoot, symlink-resolved railHit (with ancestor-dir
// deletion protection), @adlc/core globMatch & shell classification, and active
// ticket rail resolution across all 7 ADLC harnesses.

import { isAbsolute, resolve } from 'node:path';
import {
  activeTickets,
  classifyShellCommand,
  collectPatchPaths,
  extractToolWorkdir,
  findInnermostCheckoutRoot,
  globMatch,
  hasConflictingToolWorkdirs,
  preferInnermostCheckout,
  resolveRailPath,
} from '@adlc/core';
import { detectTicketStore, resolveActiveTicketAgainst } from '@adlc/tickets';

const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'glob',
  'grep',
  'grep_search',
  'find_by_name',
  'list_dir',
  'ls',
  'search_web',
  'read_url_content',
  'web_search',
  'web_fetch',
  'todo_read',
  'ask_question',
  'list_resources',
  'read_resource',
]);

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'run_command',
  'execute_command',
  'terminal',
  'powershell',
  'exec',
  'command',
]);

const PATCH_TOOL_NAMES = new Set([
  'apply_patch',
  'patch',
]);

const FILE_MUTATION_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'write_file',
  'edit_file',
  'modify_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'delete_file',
  'remove_file',
  'rename_file',
  'move_file',
  'unlink',
]);

const DELETE_OR_MOVE_TOOL_NAMES = new Set([
  'delete_file',
  'remove_file',
  'rename_file',
  'move_file',
  'unlink',
]);

const DIR_DELETE_CMD_RE = /(?:^|[\s;&|()])(?:(?:command|env|sudo|busybox)\s+)*(?:[A-Za-z0-9_./-]+\/)?(?:(?:rm|rmdir|mv|unlink)\b|git\s+(?:rm|clean)\b|find\b[^\n;|&]*\s-delete\b)/;

function isOutsideRoot(rel) {
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

/**
 * Resolve the authoritative ADLC checkout root enclosing `startPath`,
 * respecting nested linked git worktrees and preferring the innermost checkout.
 *
 * @param {string} startPath
 * @param {{ outerRoot?: string | null, storeOverride?: string | null, pluginDir?: string | null, requireStore?: boolean }} [opts]
 * @returns {string | null}
 */
export function enclosingAdlcRoot(startPath, opts = {}) {
  const {
    outerRoot = null,
    storeOverride = null,
    pluginDir = null,
    requireStore = true,
  } = opts;
  const searchOpts = { storeOverride, pluginDir, requireStore };
  if (outerRoot) {
    return preferInnermostCheckout(outerRoot, [startPath], searchOpts);
  }
  return findInnermostCheckoutRoot(startPath, searchOpts);
}

/**
 * True if deleting/moving `relPath` would remove or relocate a directory that
 * contains (or matches) a frozen `railGlob`.
 *
 * @param {string} relPath - repo-relative forward-slash path
 * @param {string} railGlob - frozen rail glob pattern
 * @returns {boolean}
 */
export function isAncestorDirOfRail(relPath, railGlob) {
  const dir = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const glob = String(railGlob ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob) return false;
  if (dir === '' || dir === '.') return true;
  if (isOutsideRoot(dir)) return false;
  if (glob === dir || glob.startsWith(`${dir}/`)) return true;
  if (glob.startsWith('**/') || glob.startsWith('*')) return true;
  if (globMatch(glob, dir)) return true;

  const dirSegs = dir.split('/');
  const globSegs = glob.split('/');
  if (dirSegs.length < globSegs.length) {
    const globPrefix = globSegs.slice(0, dirSegs.length).join('/');
    if (globMatch(globPrefix, dir)) return true;
  }
  return false;
}

/**
 * Check whether `filePath` (resolved through symlinks relative to `root`) hits
 * any frozen rail in `rails`. When `checkAncestorDir` is true, also blocks
 * ancestor directories containing any frozen rail.
 *
 * @param {string} filePath
 * @param {string} root
 * @param {string[]} rails
 * @param {{ checkAncestorDir?: boolean, baseDir?: string }} [opts]
 * @returns {{ hit: boolean, rail: string | null, resolvedPath: string, ancestorDir: boolean }}
 */
export function railHit(filePath, root, rails = [], opts = {}) {
  const { checkAncestorDir = false, baseDir = root } = opts;
  const raw = String(filePath ?? '').trim();
  if (!raw || !root || !Array.isArray(rails) || rails.length === 0) {
    return { hit: false, rail: null, resolvedPath: raw, ancestorDir: false };
  }
  const absCandidate = isAbsolute(raw) ? raw : resolve(baseDir, raw);
  const rel = resolveRailPath(absCandidate, root);
  if (isOutsideRoot(rel)) {
    return { hit: false, rail: null, resolvedPath: rel, ancestorDir: false };
  }

  for (const rail of rails) {
    if (typeof rail !== 'string' || !rail.trim()) continue;
    if (globMatch(rail, rel)) {
      return { hit: true, rail, resolvedPath: rel, ancestorDir: false };
    }
    if (checkAncestorDir && isAncestorDirOfRail(rel, rail)) {
      return { hit: true, rail, resolvedPath: rel, ancestorDir: true };
    }
  }
  return { hit: false, rail: null, resolvedPath: rel, ancestorDir: false };
}

/**
 * True if a shell command invokes a directory-deleting or directory-moving tool.
 * @param {string} command
 * @returns {boolean}
 */
export function isDirectoryDeletionCommand(command) {
  return DIR_DELETE_CMD_RE.test(String(command ?? ''));
}

/**
 * Read active ticket(s) and their merged frozen rails from `root`.
 * Returns `ok: false` with `error` when trust-state validation fails (corrupt
 * store, unreadable store, or invalid active-ticket pointer) so callers fail
 * closed instead of silently disabling enforcement.
 *
 * @param {string} root
 * @param {{ storeOverride?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, tickets: object[], activeTicket: object | null, rails: string[], error: string | null }}
 */
export function readActiveTicketRails(root, { storeOverride = null, env = process.env } = {}) {
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], error: null };
  let snapshot;
  try {
    const store = detectTicketStore({ root, ticketStore: storeOverride ?? undefined, allowRecovery: true, env });
    snapshot = store.load();
  } catch (err) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      error: `ticket store unreadable: ${err?.message ?? String(err)}`,
    };
  }

  const tickets = snapshot.tickets ?? [];
  const active = activeTickets(tickets);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env });
  if (!resolved.ok) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      error: `invalid active ticket selection: ${resolved.message ?? 'conflict'}`,
    };
  }

  if (resolved.value !== null) {
    const selected = resolved.value.ticket;
    if (selected.completed === true) {
      return {
        ok: false,
        tickets: [],
        activeTicket: null,
        rails: [],
        error: `active ticket "${selected.id}" is already completed`,
      };
    }
    const rails = Array.isArray(selected.rails)
      ? selected.rails.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : [];
    return { ok: true, tickets: active, activeTicket: selected, rails, error: null };
  }

  const activeTicket = active[0] ?? null;
  const railSet = new Set();
  for (const t of active) {
    if (Array.isArray(t.rails)) {
      for (const r of t.rails) {
        if (typeof r === 'string' && r.trim()) railSet.add(r.trim());
      }
    }
  }
  return { ok: true, tickets: active, activeTicket, rails: [...railSet], error: null };
}

function extractFilePathsFromInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = [];
  const keys = [
    'file_path', 'filePath', 'path', 'Path', 'TargetFile', 'target_file',
    'target_path', 'old_path', 'new_path', 'source', 'destination', 'dest',
  ];
  for (const k of keys) {
    if (typeof toolInput[k] === 'string' && toolInput[k].trim()) {
      out.push(toolInput[k].trim());
    }
  }
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) {
      if (typeof f === 'string' && f.trim()) out.push(f.trim());
      else if (f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim()) {
        out.push(f.path.trim());
      }
    }
  }
  return out;
}

/**
 * Evaluate a PreToolUse invocation against frozen rails (fail-closed).
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {object} [opts.toolInput]
 * @param {string} [opts.cwd]
 * @param {string | null} [opts.outerRoot]
 * @param {string[] | null} [opts.rails]
 * @param {string | null} [opts.storeOverride]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ decision: 'allow' | 'deny', reason: string | null, matchedRail: string | null, resolvedPath: string | null, root: string | null }}
 */
export function evaluatePreTool({
  toolName = '',
  toolInput = {},
  cwd = process.cwd(),
  outerRoot = null,
  rails = null,
  storeOverride = null,
  env = process.env,
} = {}) {
  const effectiveBase = typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
  const root = enclosingAdlcRoot(effectiveBase, { outerRoot, storeOverride });
  const normalizedTool = String(toolName ?? '').trim().toLowerCase();

  if (hasConflictingToolWorkdirs(toolInput, effectiveBase)) {
    return {
      decision: 'deny',
      reason: 'conflicting working directory arguments in tool input',
      matchedRail: null,
      resolvedPath: null,
      root,
    };
  }

  let effectiveRails;
  if (Array.isArray(rails)) {
    effectiveRails = rails;
  } else if (root) {
    const loaded = readActiveTicketRails(root, { storeOverride, env });
    if (!loaded.ok) {
      if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
        return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
      }
      return {
        decision: 'deny',
        reason: `ADLC trust-state error (failing closed): ${loaded.error}`,
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }
    effectiveRails = loaded.rails;
  } else {
    effectiveRails = [];
  }

  if (effectiveRails.length === 0) {
    return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
  }

  if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
    return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
  }

  if (toolInput?.__unparseable === true) {
    return {
      decision: 'deny',
      reason: 'unparseable tool payload while frozen rails are active — failing closed',
      matchedRail: null,
      resolvedPath: null,
      root,
    };
  }

  const checkRoot = root ?? effectiveBase;
  const toolWorkdir = extractToolWorkdir(toolInput);
  const pathBase = toolWorkdir
    ? (isAbsolute(toolWorkdir) ? toolWorkdir : resolve(effectiveBase, toolWorkdir))
    : effectiveBase;

  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    const cmd = String(
      toolInput?.command ?? toolInput?.CommandLine ?? toolInput?.cmd ?? ''
    );
    const cls = classifyShellCommand(cmd);
    if (cls.readOnly && cls.writeOption) {
      return {
        decision: 'deny',
        reason: 'shell command uses a file-writing output option while frozen rails are active',
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }
    if (cls.readOnly) {
      return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
    }
    if (!cls.mutating) {
      return {
        decision: 'deny',
        reason: 'shell command is neither positively read-only nor a transparent file mutation while frozen rails are active',
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }
    if (cls.opaque || cls.changesCwd || cls.expands || cls.paths.length === 0) {
      return {
        decision: 'deny',
        reason: 'shell mutation cannot be verified against frozen rails (opaque, cwd-changing, expanding, or targetless)',
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }

    const checkAncestorDir = isDirectoryDeletionCommand(cmd);
    for (const p of cls.paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? 'ancestor directory of frozen rail' : 'frozen rail';
        return {
          decision: 'deny',
          reason: `shell command targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root,
        };
      }
    }
    return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
  }

  if (PATCH_TOOL_NAMES.has(normalizedTool)) {
    const patchText = String(toolInput?.patch ?? toolInput?.input ?? toolInput?.diff ?? '');
    const patchPaths = new Set();
    collectPatchPaths(patchText, patchPaths);
    if (patchPaths.size === 0) {
      return {
        decision: 'deny',
        reason: 'patch payload exposes no verifiable target paths while frozen rails are active',
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }
    for (const p of patchPaths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir: false, baseDir: pathBase });
      if (hit.hit) {
        return {
          decision: 'deny',
          reason: `patch targets frozen rail "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root,
        };
      }
    }
    return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
  }

  if (FILE_MUTATION_TOOL_NAMES.has(normalizedTool)) {
    const paths = extractFilePathsFromInput(toolInput);
    if (paths.length === 0) {
      return {
        decision: 'deny',
        reason: `${toolName} exposes no verifiable target path while frozen rails are active`,
        matchedRail: null,
        resolvedPath: null,
        root,
      };
    }
    const checkAncestorDir = DELETE_OR_MOVE_TOOL_NAMES.has(normalizedTool);
    for (const p of paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? 'ancestor directory of frozen rail' : 'frozen rail';
        return {
          decision: 'deny',
          reason: `${toolName} targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`,
          matchedRail: hit.rail,
          resolvedPath: hit.resolvedPath,
          root,
        };
      }
    }
    return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
  }

  // Fail closed on unrecognized non-read-only tools when frozen rails are active.
  return {
    decision: 'deny',
    reason: `unrecognized tool "${toolName || '<empty>'}" cannot be verified as read-only while frozen rails are active`,
    matchedRail: null,
    resolvedPath: null,
    root,
  };
}
