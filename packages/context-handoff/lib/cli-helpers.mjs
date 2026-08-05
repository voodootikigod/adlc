/**
 * Shared CLI helpers for handoff subcommands.
 */

import { opError, printJson, gateFail } from '@adlc/core';
import { requireSessionId } from './deny-lifecycle.mjs';
import { resolveHandoffDirs } from './paths.mjs';
import { requireManifestKey, recordHandoffEvidence } from './evidence.mjs';

export { printJson, opError, gateFail };

/**
 * Parse common flags shared by every subcommand.
 * @param {Record<string, unknown>} values
 * @returns {{ ok: true, root: string, adlcDir: string, write: boolean, json: boolean } | { ok: false, error: string }}
 */
export function commonFromValues(values, cwd = process.cwd()) {
  const dirs = resolveHandoffDirs(values.dir ?? '.adlc', cwd);
  if (!dirs.ok) return { ok: false, error: dirs.error };
  return {
    ok: true,
    root: dirs.root,
    adlcDir: dirs.adlcDir,
    write: values.write === true,
    json: values.json === true,
  };
}

/**
 * Resolve common flags or exit 1 with the reason.
 * @returns {{ root: string, adlcDir: string, write: boolean, json: boolean }}
 */
export function commonOrExit(values, cwd = process.cwd()) {
  const common = commonFromValues(values, cwd);
  if (!common.ok) opError(common.error);
  return common;
}

/**
 * @param {unknown} sessionId
 * @param {string} [label]
 * @returns {string}
 */
export function requireSafeSession(sessionId, label = 'session') {
  const got = requireSessionId(sessionId, label);
  if (!got.ok) opError(got.error);
  return got.id;
}

/**
 * Require the signing key before any mutation, so a missing key cannot leave
 * half-written state behind.
 * @returns {string}
 */
export function requireKeyOrExit(env = process.env) {
  try {
    return requireManifestKey(env);
  } catch (err) {
    return opError(err.message);
  }
}

/**
 * Append durable evidence, or exit 1. `onFailure` runs before exiting so a
 * caller can roll back what it already wrote.
 * @returns {object}
 */
export function recordOrExit({ gate, ticket, data, adlcDir, key }, onFailure = null) {
  try {
    return recordHandoffEvidence({ gate, ticket, data, dir: adlcDir, key });
  } catch (err) {
    if (typeof onFailure === 'function') onFailure();
    return opError(`failed to record evidence: ${err.message}`);
  }
}

/**
 * Emit JSON or a one-line human summary, then exit.
 */
export function finish({ json, payload, human, code = 0 }) {
  if (json) printJson(payload);
  else if (human) console.log(human);
  process.exit(code);
}

/**
 * Map a thrown error / result with exitCode to process exit.
 */
export function exitFrom(err) {
  const code = typeof err?.exitCode === 'number' ? err.exitCode : 1;
  const msg = err?.message || err?.error || String(err);
  if (code === 2) {
    console.error(msg);
    process.exit(2);
  }
  opError(msg);
}
