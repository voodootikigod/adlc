/**
 * Artifact path helpers for context-handoff CLI.
 * `--dir` names the `.adlc` ledger directory; repo root is its parent.
 */

import { basename, dirname, join, resolve } from 'node:path';
import { assertSafeSessionId } from './deny-marker.mjs';

/** Every artifact path below hardcodes this segment, so `--dir` must agree. */
export const LEDGER_DIRNAME = '.adlc';

/**
 * Resolve the ledger directory and its repo root.
 *
 * Artifact helpers below join `.adlc` onto `root` themselves, while evidence is
 * written into `adlcDir` — so a `--dir` whose last segment is not `.adlc` would
 * split the two apart silently. Refuse it instead.
 *
 * @param {string} [dirFlag='.adlc']
 * @param {string} [cwd=process.cwd()]
 * @returns {{ ok: true, root: string, adlcDir: string } | { ok: false, error: string }}
 */
export function resolveHandoffDirs(dirFlag = '.adlc', cwd = process.cwd()) {
  const adlcDir = resolve(cwd, dirFlag);
  if (basename(adlcDir) !== LEDGER_DIRNAME) {
    return {
      ok: false,
      error: `--dir must end in "${LEDGER_DIRNAME}" (got "${dirFlag}"); artifacts and evidence would land in different trees`,
    };
  }
  return { ok: true, root: dirname(adlcDir), adlcDir };
}

export function handoffsDir(root) {
  return join(root, LEDGER_DIRNAME, 'handoffs');
}

export function finalPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, LEDGER_DIRNAME, 'handoffs', 'finals', `${sessionId}.json`);
}

export function resumeAuthPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, LEDGER_DIRNAME, 'handoffs', `${sessionId}.resume-auth.json`);
}

export function lockPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, LEDGER_DIRNAME, 'handoffs', `${sessionId}.lock`);
}
