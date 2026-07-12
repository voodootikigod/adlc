// Real cross-model prosecution runner (spec §8.4) — the concrete `runReview`
// that lib/prosecute.mjs's blocking gate consumes. Runs `adversarial-review`
// over the ticket-local diff (`startSha..HEAD`, N3) in the worker's worktree and
// returns parsed findings, or `{ ok:false }` (→ prosecute fails CLOSED) when no
// review provider is reachable. `spawn` is injectable so this is unit-testable
// with no live model call.
//
// SECURITY (adversarial-review L1): the prosecutor MUST run a TRUSTED binary.
// Invoking `npx` from `cwd = worktree` would let a worker plant a fake
// `node_modules/.bin/adversarial-review` and self-attest a clean review. So we
// spawn the review binary BY NAME resolved against the ORCHESTRATOR's PATH
// (never the worktree's node_modules/.bin) — the worktree cannot shadow it. The
// worktree is still the cwd, so the git diff sees the ticket branch, but the
// executable is trusted. `reviewBin` is configurable for a pinned absolute path.

import { spawnSync } from 'node:child_process';

/**
 * @param opts.spawn     (cmd, args, options) => { status, stdout, stderr, error }
 * @param opts.reviewBin the trusted review command (default 'adversarial-review',
 *                       resolved against the orchestrator PATH — NOT via npx)
 * @param opts.trustedPath PATH used to resolve reviewBin (default the orchestrator's)
 * @param opts.provider  optional --provider passthrough (e.g. 'codex', 'openai')
 * @param opts.failOn    passed through to the CLI's deterministic gate (default medium)
 * @param opts.timeoutMs per-review timeout
 * @returns a runReview({ worktree, startSha, ticket }) => { ok, findings?, reason? }
 */
export function makeReviewRunner({ spawn = defaultSpawn, reviewBin = 'adversarial-review', trustedPath, provider, failOn = 'medium', timeoutMs = 600000 } = {}) {
  return ({ worktree, startSha }) => {
    const args = ['--base', startSha, '--json', '--fail-on', failOn];
    if (provider) args.push('--provider', provider);
    // Resolve reviewBin against the orchestrator PATH so a worktree-local binary
    // can never be selected; drop the worktree from PATH defensively.
    const env = { ...process.env, PATH: trustedPath ?? process.env.PATH };

    let res;
    try {
      res = spawn(reviewBin, args, { cwd: worktree, env, encoding: 'utf8', timeout: timeoutMs });
    } catch (e) {
      return { ok: false, reason: `adversarial-review spawn failed: ${e.message}` };
    }
    if (res.error) {
      // ENOENT here means the TRUSTED review binary is not installed — fail
      // closed rather than silently skipping prosecution.
      return { ok: false, reason: `adversarial-review binary not runnable (install it or set config.reviewBin): ${res.error.message ?? res.error}` };
    }
    // Exit codes: 0 = approve, 2 = needs-attention (both are COMPLETED reviews
    // with valid JSON). 1 = the review could not complete (no provider, git
    // collection failure, etc.) → fail closed.
    if (res.status !== 0 && res.status !== 2) {
      return { ok: false, reason: `adversarial-review could not complete (exit ${res.status}): ${String(res.stderr ?? '').slice(0, 300)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      // A 0/2 exit but unparseable stdout means we cannot trust the verdict.
      return { ok: false, reason: 'adversarial-review output was not valid JSON — failing closed' };
    }
    return { ok: true, findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
  };
}

function defaultSpawn(cmd, args, options) {
  return spawnSync(cmd, args, options);
}
