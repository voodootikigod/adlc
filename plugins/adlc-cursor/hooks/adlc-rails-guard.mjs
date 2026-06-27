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
import { isAbsolute } from 'node:path';
import { checkRail } from '../rails-checker.mjs';

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

/** Pull the edited path from the input bag (or the top-level payload as fallback). */
export function extractFilePath(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  for (const bagKey of INPUT_BAG_KEYS) {
    const bag = payload[bagKey];
    const hit = firstString(bag, PATH_KEYS);
    if (hit) return hit;
  }
  return firstString(payload, PATH_KEYS);
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
 */
export function resolveRoot(payload, filePath, fallback = process.cwd()) {
  const roots = candidateRoots(payload);
  if (filePath && isAbsolute(filePath)) {
    const owning = roots
      .filter((r) => { const rr = r.endsWith('/') ? r : `${r}/`; return filePath === r || filePath.startsWith(rr); })
      .sort((a, b) => b.length - a.length)[0];
    if (owning) return owning;
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
    const filePath = extractFilePath(payload);
    // Nothing path-shaped to gate (e.g. a non-file tool slipped past the matcher):
    // allow. Bash/shell writes are intentionally not gated here.
    if (!filePath) return { permission: 'allow' };

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
    return { permission: 'allow' };
  } catch (err) {
    // Advisory layer: a hook crash must not brick the editor. Fail open and let
    // the unbypassable CI rail-freeze gate catch the edit.
    process.stderr.write(
      `adlc-rails-guard: internal error (failing OPEN, advisory) — ${err?.message ?? err}\n`,
    );
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
