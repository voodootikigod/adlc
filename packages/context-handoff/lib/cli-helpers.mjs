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
 */
export function commonFromValues(values, cwd = process.cwd()) {
  const { root, adlcDir } = resolveHandoffDirs(values.dir ?? '.adlc', cwd);
  return {
    root,
    adlcDir,
    write: values.write === true,
    json: values.json === true,
  };
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
 * For --write paths: require key and record evidence. Dry-run skips both.
 * @returns {{ key: string|null, recorded: object|null }}
 */
export function maybeRecord({ write, gate, ticket, data, adlcDir, env = process.env }) {
  if (!write) return { key: null, recorded: null };
  const key = requireManifestKey(env);
  const recorded = recordHandoffEvidence({ gate, ticket, data, dir: adlcDir, key });
  return { key, recorded };
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
  const msg = err?.message || String(err);
  if (code === 2) {
    console.error(msg);
    process.exit(2);
  }
  opError(msg);
}
