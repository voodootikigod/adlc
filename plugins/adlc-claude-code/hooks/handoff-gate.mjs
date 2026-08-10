// Claude Code payload readers for the context-handoff PreToolUse mode.
//
// The gate itself — D1-D3, the deny-set, `evaluateHandoffPreToolUse` — lives in
// `@adlc/context-handoff` (lib/adapter.mjs) and is reached through the
// dynamically-loaded `api` namespace, never a static import: an unresolvable
// package must fail closed for the `handoff` mode alone, not crash every hook
// mode at module load.
//
// KEEP IN SYNC — `resolveSessionId` and `isProtectedHandoffPath` below are
// behavioural twins of the package's `resolveHandoffSessionId` /
// `isProtectedHandoffPath`. They stay here because this module cannot resolve
// the package synchronously (the plugin install dir has no workspace
// node_modules, and Node 18 cannot `require()` an ESM package), while the
// slice-4 contract test drives them synchronously off this module. The two
// implementations are pinned by
// packages/context-handoff/adapter-test/cc-helper-drift.test.mjs; the hook's
// real decisions run through the package copy, not these.

import { basename, extname } from 'node:path';

/**
 * Session identity for deny markers / D2.
 *
 * Source order (first usable wins):
 * 1. `input.session_id` (Claude Code hook payload)
 * 2. `input.sessionId`
 * 3. basename of `transcript_path` without extension (uuid.jsonl → uuid)
 *
 * @param {object} input
 * @param {{ isSafeSessionId: (id: unknown) => boolean }} api
 * @returns {string|null}
 */
export function resolveSessionId(input, { isSafeSessionId }) {
  const candidates = [];
  if (input && typeof input === 'object') {
    candidates.push(input.session_id, input.sessionId);
    const tp = input.transcript_path;
    if (typeof tp === 'string') {
      if (tp !== '') {
        const base = basename(tp);
        const stem = base.slice(0, base.length - extname(base).length);
        candidates.push(stem);
      }
    }
  }
  for (const c of candidates) {
    if (isSafeSessionId(c)) return c;
  }
  return null;
}

/**
 * Repo-relative path is a handoff trust-root artifact agents must not Write.
 * @param {string} rel forward-slashed repo-relative path
 * @returns {boolean}
 */
export function isProtectedHandoffPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  // Collapse . / .. and separators; keep as repo-relative (no leading /).
  const norm = rel
    .replace(/\\/g, '/')
    .split('/')
    .reduce((acc, part) => {
      if (part === '' || part === '.') return acc;
      if (part === '..') {
        acc.pop();
        return acc;
      }
      acc.push(part);
      return acc;
    }, [])
    .join('/');
  if (norm === '.adlc/.deny-store' || norm === '.adlc/handoffs/.deny-store') return true;
  if (norm === '.adlc/handoffs/denies' || norm.startsWith('.adlc/handoffs/denies/')) return true;
  if (!norm.startsWith('.adlc/handoffs/')) return false;
  const leaf = basename(norm);
  return (
    leaf.endsWith('.resume-auth.json') ||
    leaf.endsWith('.model-ok') ||
    leaf.endsWith('.lock')
  );
}

/**
 * Bash tool command string from a PreToolUse payload.
 * @param {object} input
 * @returns {string}
 */
export function bashCommandFromInput(input) {
  const ti = input?.tool_input ?? input?.parameters ?? {};
  if (typeof ti.command === 'string') return ti.command;
  if (typeof ti.cmd === 'string') return ti.cmd;
  return '';
}
