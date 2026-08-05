/**
 * Durable evidence recording for mutating handoff CLI commands.
 * Missing ADLC_MANIFEST_KEY ⇒ refuse mutate (exit 1), never silent success.
 */

import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';

/**
 * Resolve signing key (bin-side only). Returns null when unset.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolveManifestKey(env = process.env) {
  return getKey(env);
}

/**
 * Require a non-empty signing key for mutating --write paths.
 * @returns {string}
 * @throws {{ message: string, exitCode: 1 }}
 */
export function requireManifestKey(env = process.env) {
  const key = resolveManifestKey(env);
  if (key == null) {
    const err = new Error('ADLC_MANIFEST_KEY is required for --write (refusing silent success)');
    err.exitCode = 1;
    throw err;
  }
  return key;
}

/**
 * Append a context-handoff evidence entry. Throws on failure.
 * @param {object} opts
 * @param {string} opts.gate — e.g. context-handoff-write
 * @param {string} [opts.ticket]
 * @param {object} [opts.data]
 * @param {string} opts.dir — absolute `.adlc` directory
 * @param {string} opts.key
 */
export function recordHandoffEvidence({ gate, ticket, data, dir, key }) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('ADLC_MANIFEST_KEY is required for durable evidence');
  }
  return record({
    gate,
    ticket,
    rawData: data === undefined ? undefined : JSON.stringify(data),
    dir,
    key,
  });
}
