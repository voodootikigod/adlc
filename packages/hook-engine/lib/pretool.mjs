// pretool.mjs — shared PreToolUse rail enforcement core.
// Consolidates enclosingAdlcRoot, symlink-resolved railHit (with ancestor-dir
// deletion protection), @adlc/core globMatch & shell classification, and active
// ticket rail resolution across all 7 ADLC harnesses.

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  detectTicketStore,
  resolveActiveTicketAgainst,
  resolveActiveTicketId as resolveCanonicalActiveTicketId,
} from '@adlc/tickets';

const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'read_file', 'view_file', 'view_file_outline', 'view_code_item',
  'glob', 'grep', 'grep_search', 'find_by_name', 'list_dir', 'ls',
  'search_web', 'read_url_content', 'web_search', 'web_fetch',
  'todo_read', 'ask_question', 'list_resources', 'read_resource',
]);

const NON_FS_UI_TOOL_NAMES = new Set([
  'update_steps',
  'todo_write',
  'task_boundary',
  'enter_plan_mode',
  'exit_plan_mode',
]);

const SHELL_TOOL_NAMES = new Set([
  'bash', 'shell', 'run_command', 'execute_command', 'terminal',
  'powershell', 'exec', 'command',
]);

const PATCH_TOOL_NAMES = new Set(['apply_patch', 'patch']);

const FILE_MUTATION_TOOL_NAMES = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'write_file', 'edit_file',
  'modify_file', 'write_to_file', 'replace_file_content',
  'multi_replace_file_content', 'create_file', 'delete_file', 'remove_file',
  'rename_file', 'move_file', 'unlink',
]);

const DELETE_OR_MOVE_TOOL_NAMES = new Set([
  'delete_file', 'remove_file', 'rename_file', 'move_file', 'unlink',
]);

const DIR_DELETE_CMD_RE = /(?:^|[\s;&|()])(?:(?:command|env|sudo|busybox)\s+)*(?:[A-Za-z0-9_./-]+\/)?(?:(?:rm|rmdir|mv|unlink)\b|git\s+(?:rm|clean)\b|find\b[^\n;|&]*\s-delete\b)/;

const FILE_PATH_KEYS = [
  'file_path', 'filePath', 'FilePath', 'path', 'Path', 'TargetFile', 'target_file',
  'targetFile', 'target_path', 'targetPath', 'AbsolutePath', 'TargetContentPath',
  'TargetDir', 'old_path', 'new_path', 'source', 'destination', 'dest',
];

function isOutsideRoot(rel) {
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

function allowVerdict(root) {
  return { decision: 'allow', reason: null, matchedRail: null, resolvedPath: null, root };
}

function denyVerdict(reason, root, matchedRail = null, resolvedPath = null) {
  return { decision: 'deny', reason, matchedRail, resolvedPath, root };
}

function decodeFileUriOrPath(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('file://')) return trimmed;
  try {
    return fileURLToPath(trimmed);
  } catch {
    const stripped = trimmed.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      return decodeURIComponent(stripped);
    } catch {
      return stripped;
    }
  }
}

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

export function railHit(filePath, root, rails = [], opts = {}) {
  const { checkAncestorDir = false, baseDir = root } = opts;
  const raw = String(filePath ?? '').trim();
  if (!raw || !root || !Array.isArray(rails) || rails.length === 0) {
    return { hit: false, rail: null, resolvedPath: raw, ancestorDir: false };
  }
  const decoded = decodeFileUriOrPath(raw);
  const absCandidate = isAbsolute(decoded) ? decoded : resolve(baseDir, decoded);
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

export function isDirectoryDeletionCommand(command) {
  return DIR_DELETE_CMD_RE.test(String(command ?? ''));
}

/**
 * Identity-level active ticket resolver matching the CONFLICT_ADAPTERS contract
 * in packages/tickets/test/pointer.test.mjs (fail-closed on pointer corruption
 * or ADLC_TICKET conflict, returning `{ id, conflict, code, message, ticketHash }`).
 */
export function resolveActiveTicketId(root, env = process.env) {
  const resolved = resolveCanonicalActiveTicketId({ root: root ?? '.', env });
  if (!resolved.ok) {
    return { id: null, conflict: true, code: resolved.code, message: resolved.message };
  }
  return {
    id: resolved.value?.id ?? null,
    conflict: false,
    code: null,
    message: null,
    ticketHash: resolved.value?.ticketHash ?? null,
  };
}

export function readActiveTicketRails(root, { storeOverride = null, env = process.env } = {}) {
  const cleanEnv = env.ADLC_TICKET ? { ...env } : env;
  if (!root) return { ok: true, tickets: [], activeTicket: null, rails: [], boundTicket: false, error: null };
  let snapshot;
  try {
    const store = detectTicketStore({ root, ticketStore: storeOverride ?? undefined, allowRecovery: true, env: cleanEnv });
    snapshot = store.load();
  } catch (err) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      boundTicket: false,
      error: `ticket store unreadable: ${err?.message ?? String(err)}`,
    };
  }

  const tickets = snapshot.tickets ?? [];
  const active = activeTickets(tickets);
  const resolved = resolveActiveTicketAgainst(snapshot, { root, env: cleanEnv });
  if (!resolved.ok) {
    return {
      ok: false,
      tickets: [],
      activeTicket: null,
      rails: [],
      boundTicket: false,
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
        boundTicket: false,
        error: `active ticket "${selected.id}" is already completed`,
      };
    }
    const rails = Array.isArray(selected.rails)
      ? selected.rails.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : [];
    return { ok: true, tickets: active, activeTicket: selected, rails, boundTicket: true, error: null };
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
  return { ok: true, tickets: active, activeTicket, rails: [...railSet], boundTicket: false, error: null };
}

function extractFilePathsFromInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = [];
  for (const k of FILE_PATH_KEYS) {
    if (typeof toolInput[k] === 'string' && toolInput[k].trim()) {
      out.push(decodeFileUriOrPath(toolInput[k]));
    }
  }
  for (const uriKey of ['uri', 'URI']) {
    const raw = toolInput[uriKey];
    if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('file://') || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        out.push(decodeFileUriOrPath(trimmed));
      }
    }
  }
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) {
      if (typeof f === 'string' && f.trim()) out.push(decodeFileUriOrPath(f));
      else if (f && typeof f === 'object' && typeof f.path === 'string' && f.path.trim()) {
        out.push(decodeFileUriOrPath(f.path));
      }
    }
  }
  return out;
}

export function evaluatePreTool({
  toolName = '',
  toolInput = {},
  cwd = process.cwd(),
  outerRoot = null,
  rails = null,
  boundTicket = undefined,
  storeOverride = null,
  env = process.env,
} = {}) {
  const effectiveBase = typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
  const root = enclosingAdlcRoot(effectiveBase, { outerRoot, storeOverride });
  const normalizedTool = String(toolName ?? '').trim().toLowerCase();

  if (hasConflictingToolWorkdirs(toolInput, effectiveBase)) {
    return denyVerdict('conflicting working directory arguments in tool input', root);
  }

  let effectiveRails;
  let isBoundTicket;
  if (Array.isArray(rails)) {
    effectiveRails = rails;
    isBoundTicket = boundTicket ?? true;
  } else if (root) {
    const loaded = readActiveTicketRails(root, { storeOverride, env });
    if (!loaded.ok) {
      if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) return allowVerdict(root);
      return denyVerdict(`ADLC trust-state error (failing closed): ${loaded.error}`, root);
    }
    effectiveRails = loaded.rails;
    isBoundTicket = boundTicket !== undefined ? boundTicket : loaded.boundTicket;
  } else {
    effectiveRails = [];
    isBoundTicket = boundTicket ?? false;
  }

  if (effectiveRails.length === 0 || READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
    return allowVerdict(root);
  }
  if (NON_FS_UI_TOOL_NAMES.has(normalizedTool) && isBoundTicket === false) {
    return allowVerdict(root);
  }
  if (toolInput?.__unparseable === true) {
    return denyVerdict('unparseable tool payload while frozen rails are active — failing closed', root);
  }

  const checkRoot = root ?? effectiveBase;
  const toolWorkdir = extractToolWorkdir(toolInput);
  const pathBase = toolWorkdir
    ? (isAbsolute(toolWorkdir) ? toolWorkdir : resolve(effectiveBase, toolWorkdir))
    : effectiveBase;

  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    const cmd = String(toolInput?.command ?? toolInput?.CommandLine ?? toolInput?.cmd ?? '');
    const cls = classifyShellCommand(cmd);
    if (cls.readOnly && cls.writeOption) {
      return denyVerdict('shell command uses a file-writing output option while frozen rails are active', root);
    }
    if (cls.readOnly) return allowVerdict(root);
    if (!cls.mutating) {
      return denyVerdict('shell command is neither positively read-only nor a transparent file mutation while frozen rails are active', root);
    }
    if (cls.opaque || cls.changesCwd || cls.expands || cls.paths.length === 0) {
      return denyVerdict('shell mutation cannot be verified against frozen rails (opaque, cwd-changing, expanding, or targetless)', root);
    }
    const checkAncestorDir = isDirectoryDeletionCommand(cmd);
    for (const p of cls.paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? 'ancestor directory of frozen rail' : 'frozen rail';
        return denyVerdict(`shell command targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }

  if (PATCH_TOOL_NAMES.has(normalizedTool)) {
    const patchText = String(toolInput?.patch ?? toolInput?.input ?? toolInput?.diff ?? '');
    const patchPaths = new Set();
    collectPatchPaths(patchText, patchPaths);
    if (patchPaths.size === 0) {
      return denyVerdict('patch payload exposes no verifiable target paths while frozen rails are active', root);
    }
    for (const p of patchPaths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir: false, baseDir: pathBase });
      if (hit.hit) {
        return denyVerdict(`patch targets frozen rail "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }

  if (FILE_MUTATION_TOOL_NAMES.has(normalizedTool)) {
    const paths = extractFilePathsFromInput(toolInput);
    if (paths.length === 0) {
      return denyVerdict(`${toolName} exposes no verifiable target path while frozen rails are active`, root);
    }
    const checkAncestorDir = DELETE_OR_MOVE_TOOL_NAMES.has(normalizedTool);
    for (const p of paths) {
      const hit = railHit(p, checkRoot, effectiveRails, { checkAncestorDir, baseDir: pathBase });
      if (hit.hit) {
        const kind = hit.ancestorDir ? 'ancestor directory of frozen rail' : 'frozen rail';
        return denyVerdict(`${toolName} targets ${kind} "${hit.rail}" via "${hit.resolvedPath}"`, root, hit.rail, hit.resolvedPath);
      }
    }
    return allowVerdict(root);
  }

  return denyVerdict(`unrecognized tool "${toolName || '<empty>'}" cannot be verified as read-only while frozen rails are active`, root);
}
