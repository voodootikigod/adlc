// The gate's only door to git, plus the JSON reader every caller shares (#140).
//
// Every read the gate trusts goes through here, bound to an explicit cwd so the
// module is callable on a fixture repo in a test and on the checkout in CI without
// depending on process.cwd(). The hardening below was paid for in #314 review rounds
// 5-7 and must not be re-litigated per call site — that is exactly the duplication
// this file exists to end.

import { spawnSync } from 'node:child_process';
import { fail } from './errors.mjs';

// Well above Node's 1 MiB spawn default: .adlc/manifest.jsonl is an ever-growing
// append-only ledger, and `git cat-file`/`git show`/`git diff` over it can legitimately
// exceed 1 MiB. The default ENOBUFS'd a large-but-valid manifest and failed the gate
// (#314 round 6).
//
// Named to match the `maxBuffer` option it feeds, which is also how #359/#362's off-by-one
// operator recognises it as a TUNING constant rather than a boundary. +1 byte on a 512 MiB
// spawn bound is an EQUIVALENT mutant — distinguishing it would need git output sized
// between 536,870,912 and 537,919,488 bytes — so the operator masks it instead of demanding
// a test that cannot exist. The earlier `MAX_BUFFER_BYTES` spelling missed that masking
// (the key must be followed by the separator) and left an unkillable mutant behind.
const MAX_BUFFER = 512 * 1024 * 1024;

// Long enough that a cold, large repository does not spuriously fail the gate; short
// enough that a wedged git cannot hang the CI job indefinitely.
const GIT_TIMEOUT_MS = 60_000;

/**
 * Bind a git runner to one working directory.
 *
 * The returned function never throws for a non-zero git STATUS — a non-zero status is
 * routinely meaningful ("path absent at this ref"), and the callers distinguish it from
 * an operational error themselves. It DOES fail closed for a spawn error or a signal,
 * because neither carries a verdict.
 *
 * @param {string} cwd repository root to run every command in
 * @returns {(args: string[], label: string, opts?: {raw?: boolean}) => import('node:child_process').SpawnSyncReturns<string|Buffer>}
 */
export function createGit(cwd) {
  return function git(args, label, { raw = false } = {}) {
    // raw:true omits the encoding so stdout is a Buffer. Manifest evidence is compared
    // BYTE-for-byte because utf8 decoding is non-injective: distinct invalid byte
    // sequences both decode to U+FFFD, so a decoded-string prefix check could miss a
    // raw-byte rewrite of the base region (#314 round 7).
    const result = spawnSync('git', args, {
      cwd,
      encoding: raw ? 'buffer' : 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (result.error) fail(`${label} failed: ${result.error.message}`);
    if (result.signal) fail(`${label} timed out or was killed by ${result.signal}`);
    return result;
  };
}

/** Parse JSON or fail closed with the source named — never return a partial value. */
export function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`cannot parse ${label}: ${error.message}`);
  }
}

/**
 * Resolve a base ref to one immutable object id.
 *
 * `git show <ref>:<path>` returns non-zero for BOTH "ref does not resolve" and "path
 * absent at ref". Conflating them fails OPEN: an unfetched or mistyped base would look
 * like "no rails declared". So the ref is resolved FIRST, and everything downstream is
 * addressed by the resolved sha rather than the name — which also pins the trusted side
 * of every comparison to a single tree for the whole run.
 */
export function resolveTrustedBase(git, base) {
  const ref = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], 'git rev-parse base');
  if (ref.status !== 0) {
    fail(`base ref '${base}' does not resolve — rails cannot be verified. Fetch it (or pass the correct base).`);
  }
  const resolved = ref.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) fail(`base ref '${base}' did not resolve to an exact object ID`);
  return resolved;
}

/**
 * Whether `path` is tracked at `ref`, failing closed on an operational git error.
 * Empty output = genuinely absent; non-zero status = git itself failed, which is NOT
 * evidence of absence and must never be read as "nothing there".
 */
export function trackedAt(git, ref, path, label) {
  const ls = git(['ls-tree', '--name-only', ref, '--', path], label);
  if (ls.status !== 0) fail(`${label} (operational error) — failing closed.`);
  return Boolean(ls.stdout.trim());
}
