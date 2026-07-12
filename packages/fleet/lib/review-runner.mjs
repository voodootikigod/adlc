// Real cross-model prosecution runner (spec §8.4) — the concrete `runReview`
// that lib/prosecute.mjs's blocking gate consumes. Spawns `adversarial-review`
// over the ticket-local diff (`startSha..HEAD`, N3) in the worker's worktree and
// returns parsed findings, or `{ ok:false }` (→ prosecute fails CLOSED) when no
// review provider is reachable. `spawn` is injectable so this is unit-testable
// with no live model call.

import { spawnSync } from 'node:child_process';

/**
 * @param opts.spawn    (cmd, args, options) => { status, stdout, stderr, error }
 * @param opts.provider optional --provider passthrough (e.g. 'codex', 'openai')
 * @param opts.failOn   passed through to the CLI's deterministic gate (default medium)
 * @param opts.timeoutMs per-review timeout
 * @returns a runReview({ worktree, startSha, ticket }) => { ok, findings?, reason? }
 */
export function makeReviewRunner({ spawn = defaultSpawn, provider, failOn = 'medium', timeoutMs = 600000 } = {}) {
  return ({ worktree, startSha }) => {
    const args = ['--yes', 'adversarial-review', '--base', startSha, '--json', '--fail-on', failOn];
    if (provider) args.push('--provider', provider);

    let res;
    try {
      res = spawn('npx', args, { cwd: worktree, encoding: 'utf8', timeout: timeoutMs });
    } catch (e) {
      return { ok: false, reason: `adversarial-review spawn failed: ${e.message}` };
    }
    if (res.error) {
      return { ok: false, reason: `adversarial-review not runnable: ${res.error.message ?? res.error}` };
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
