// Pinned toolchain (spec §9.1; AC 68, 153).
//
// Every executable the autopilot spawns is resolved ONCE at preflight to an
// absolute path from a SANITIZED search list — the orchestrator's PATH entries
// that are absolute, exist, and are not under REPO_ROOT, any `.worktrees/`, or
// any `node_modules/` — then checked after realpath: the file and every
// ancestor up to `/` must be owned by the invoking user or root and must not be
// group- or world-writable. Children receive PATH = that sanitized list.

import { existsSync, statSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, join, dirname, sep, delimiter } from 'node:path';
import { isUnder } from './input.mjs';

export const REQUIRED_TOOLS = Object.freeze(['adlc', 'bwrap', 'claude', 'codex', 'adversarial-review', 'gh', 'git', 'ssh', 'ssh-add', 'ssh-keygen', 'npm', 'node']);
export const KEY_BEARING_TOOL = 'adlc';
export const MIN_NODE_MAJOR = 18;

export class ToolError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/** The sanitized search list. `entries` = PATH split; `exists`/`realpath` injectable. */
export function sanitizedSearchList(pathValue, { repoRoot, trustedBinDirs = null, exists = existsSync, realpath = realpathSync } = {}) {
  const raw = trustedBinDirs ?? String(pathValue ?? '').split(delimiter);
  const out = [];
  for (const d of raw) {
    if (!d || !isAbsolute(d) || !exists(d)) continue;
    let real; try { real = realpath(d); } catch { continue; }
    const parts = real.split(sep);
    if (parts.includes('.worktrees') || parts.includes('node_modules')) continue;
    if (repoRoot && isUnder(repoRoot, real)) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * The ownership/writability check over the realpath and every ancestor.
 * `stat` is injectable (tests fixture another uid / group-writable ancestors).
 */
export function checkTrustedPath(realPath, { uid, stat = statSync }) {
  let p = realPath;
  for (;;) {
    let st;
    try { st = stat(p); } catch (e) { return { ok: false, detail: `${p}: ${e.message}` }; }
    if (st.uid !== uid && st.uid !== 0) return { ok: false, detail: `${p} is owned by uid ${st.uid}, not ${uid} or root` };
    if (st.mode & (constants.S_IWGRP | constants.S_IWOTH)) return { ok: false, detail: `${p} is group- or world-writable` };
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return { ok: true };
}

/**
 * Resolve every required tool. Returns { pinned: {name: absPath}, searchList, path }.
 * Throws ToolError('untrusted-tool:<name>') or ('missing-tool:<name>').
 */
export function pinToolchain({ pathValue, repoRoot, uid, trustedBinDirs = null, exists = existsSync, realpath = realpathSync, stat = statSync, nodeVersion = process.version, required = REQUIRED_TOOLS }) {
  const searchList = sanitizedSearchList(pathValue, { repoRoot, trustedBinDirs, exists, realpath });
  const pinned = {};
  for (const name of required) {
    let found = null;
    for (const dir of searchList) {
      const candidate = join(dir, name);
      if (exists(candidate)) { found = candidate; break; }
    }
    if (!found) throw new ToolError(`missing-tool:${name}`, `not found on the sanitized search list [${searchList.join(', ')}]`);
    let real;
    try { real = realpath(found); } catch (e) { throw new ToolError(`untrusted-tool:${name}`, e.message); }
    const parts = real.split(sep);
    if (parts.includes('.worktrees') || parts.includes('node_modules') || (repoRoot && isUnder(repoRoot, real))) {
      throw new ToolError(`untrusted-tool:${name}`, `${real} resolves under a rejected directory`);
    }
    const trust = checkTrustedPath(real, { uid, stat });
    if (!trust.ok) throw new ToolError(`untrusted-tool:${name}`, trust.detail);
    pinned[name] = found;
    pinned[`${name}:realpath`] = real;
  }
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  if (!(major >= MIN_NODE_MAJOR)) throw new ToolError('node-too-old', `${nodeVersion} < ${MIN_NODE_MAJOR}`);
  return { pinned, searchList, path: searchList.join(delimiter) };
}

/** The realpaths of the pinned executables, for the model-plane READ_SET (§6.4). */
export function pinnedRealpaths(pinned) {
  return Object.entries(pinned).filter(([k]) => k.endsWith(':realpath')).map(([, v]) => v);
}
