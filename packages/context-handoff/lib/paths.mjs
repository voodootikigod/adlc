/**
 * Artifact path helpers for context-handoff CLI.
 * `--dir` names the `.adlc` ledger directory; repo root is its parent.
 */

import { dirname, join, resolve } from 'node:path';
import { assertSafeSessionId } from './deny-marker.mjs';

/**
 * @param {string} [dirFlag='.adlc']
 * @param {string} [cwd=process.cwd()]
 * @returns {{ root: string, adlcDir: string }}
 */
export function resolveHandoffDirs(dirFlag = '.adlc', cwd = process.cwd()) {
  const adlcDir = resolve(cwd, dirFlag);
  return { root: dirname(adlcDir), adlcDir };
}

export function handoffsDir(root) {
  return join(root, '.adlc', 'handoffs');
}

export function finalPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, '.adlc', 'handoffs', 'finals', `${sessionId}.json`);
}

export function resumeAuthPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, '.adlc', 'handoffs', `${sessionId}.resume-auth.json`);
}

export function lockPath(root, sessionId) {
  assertSafeSessionId(sessionId);
  return join(root, '.adlc', 'handoffs', `${sessionId}.lock`);
}
