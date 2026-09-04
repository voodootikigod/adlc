// Key hygiene (spec §9.3, AC 12, AC 160): `ADLC_MANIFEST_KEY` reaches EXACTLY
// the key-bearing children and no other spawn. This module is the ONE
// authority — the orchestrator classifies every spawn through it and the test
// table is built from the same export, so the two cannot drift.

import { active } from './mutations.mjs';

export const MANIFEST_KEY_VAR = 'ADLC_MANIFEST_KEY';

/**
 * The key-bearing commands, as token sets over the TOOL argv (the argv after the
 * pinned executable). The first token must match positionally; every other
 * token must be present anywhere in the argv (flags are order-free).
 *
 * Seven entries today — the number the spec pins.
 */
export const KEY_BEARING_ARGV = Object.freeze([
  Object.freeze(['ticket', 'create', '--write']),
  Object.freeze(['ticket', 'complete', '--write']),
  Object.freeze(['ticket', 'update', '--write']),       // reopen-for-retry only (§6.6)
  Object.freeze(['coldstart', '--record-verdict']),
  Object.freeze(['spec-lint', '--record']),
  Object.freeze(['prosecute', 'record-cross-model']),
  Object.freeze(['gate-manifest', 'verify']),           // the one READER: signature verification is inert without the key
]);

/** Which tool a recorded spawn is, given the pinned executables of §9.1. */
export function classifySpawn(argv, pinned = {}) {
  const [exe, ...rest] = argv;
  if (pinned.adlc && exe === pinned.adlc) return { tool: 'adlc', toolArgv: rest };
  if (pinned.node && exe === pinned.node && pinned.specLintBin && rest[0] === pinned.specLintBin) return { tool: 'spec-lint', toolArgv: ['spec-lint', ...rest.slice(1)] };
  for (const name of ['gh', 'git', 'claude', 'codex', 'adversarialReview', 'npm', 'bwrap', 'ssh', 'sshAdd', 'sshKeygen']) {
    if (pinned[name] && exe === pinned[name]) return { tool: name === 'adversarialReview' ? 'adversarial-review' : name, toolArgv: rest };
  }
  if (pinned.node && exe === pinned.node) return { tool: 'node', toolArgv: rest };
  return { tool: 'unknown', toolArgv: rest };
}

/** True iff the tool argv is one of the key-bearing commands. */
export function isKeyBearing(toolArgv) {
  if (!Array.isArray(toolArgv) || toolArgv.length === 0) return false;
  return KEY_BEARING_ARGV.some((entry) => toolArgv[0] === entry[0] && entry.slice(1).every((tok) => toolArgv.includes(tok)));
}

/** A spawn is key-bearing iff it is the pinned `adlc`/spec-lint bin AND its argv matches. */
export function spawnIsKeyBearing(argv, pinned) {
  const { tool, toolArgv } = classifySpawn(argv, pinned);
  if (tool === 'adlc') return isKeyBearing(toolArgv);
  if (tool === 'spec-lint') return isKeyBearing(toolArgv);
  return false;
}

/**
 * The environment a child receives. The key is ADDED only for a key-bearing
 * spawn and is otherwise absent — `base` must already be the sanitized
 * environment (never process.env), so the key cannot leak in from it either.
 */
export function childEnv(base, { key = null, keyBearing = false } = {}) {
  const out = { ...base };
  delete out[MANIFEST_KEY_VAR];
  // Mutation seam `keys.leakKey`: every child gets the key.
  if (active('keys.leakKey') && key) { out[MANIFEST_KEY_VAR] = key; return out; }
  if (keyBearing) {
    if (!key) throw new Error('key-bearing spawn without ADLC_MANIFEST_KEY');
    out[MANIFEST_KEY_VAR] = key;
  }
  return out;
}

/**
 * Every environment value that must never leave the process: the manifest key,
 * every `*_KEY` / `*_TOKEN` / `*_SECRET` value and the harness token the quota
 * gate reads. Fed to the redactor as literal values (§6.6).
 */
export function keyBearingValues(env, extra = []) {
  const values = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (k === MANIFEST_KEY_VAR || /(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(k) || /^GH_/.test(k) || k === 'GITHUB_TOKEN') values.push(v);
  }
  for (const v of extra) if (typeof v === 'string' && v.length >= 8) values.push(v);
  return [...new Set(values)];
}
