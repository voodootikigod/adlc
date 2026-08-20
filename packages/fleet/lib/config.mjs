// Fleet configuration (spec §7.1). Settings live under the `fleet` key of
// `.adlc/config.json`; CLI flags override. The disposable-container override is
// NEVER honored from repo-committed config (adversarial-review N1) — only from
// the operator-local CLI flag.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  concurrency: 2,
  base: 'main',
  timeoutMinutes: 30,
  prosecuteFailOn: 'medium',
});

/** Read the `fleet` config block from `.adlc/config.json`, or {} if absent. */
export function loadConfig(dir) {
  const p = join(dir, 'config.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed.fleet ?? {};
  } catch {
    return {};
  }
}

/**
 * Merge config + CLI flags into the effective run config. The
 * disposable-container override comes ONLY from `flags.disposableContainer`
 * (the operator-local CLI flag); a `disposableContainer` key in repo config is
 * ignored and surfaced as a warning (N1).
 */
export function resolveRunConfig(config = {}, flags = {}) {
  const warnings = [];
  const repoWantedOverride = config.disposableContainer === true;
  if (repoWantedOverride) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.disposableContainer; repo config cannot disable the sandbox (N1) — ignored.'
    );
  }
  if (config.adapterCommand != null || config.adapterArgs != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.adapterCommand/adapterArgs; the worker binary override is operator-local ' +
        '(CLI flag) only and CANNOT be set from repo config (A2) — ignored.'
    );
  }
  if (config.adapter != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.adapter; the worker HARNESS is operator-local (--adapter) only — a repo ' +
        'config must not silently switch the fleet onto a harness with weaker worker containment (K1) — ignored.'
    );
  }
  if (config.model != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.model; the worker MODEL is operator-local (--model) only — a repo config ' +
        'must not choose the model that judges it (operating-stack §4, §10) — ignored.'
    );
  }
  if (config.modelAuthKey != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.modelAuthKey; the worker CREDENTIAL is operator-local ' +
        '(--model-auth-key) only. `modelAuthKey` names the ONE env var exempted from secret stripping, so a repo ' +
        'value chooses which host secret enters an unsandboxed worker — ignored.'
    );
  }
  if (config.modelPlaneWritable != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.modelPlaneWritable; the model-plane WRITE boundary is operator-local ' +
        '(--model-plane-writable) only. That boundary exists to stop candidate-authored gate commands writing ' +
        'outside their worktree, so letting the candidate tree widen it would be the boundary disabling itself — ignored.'
    );
  }
  return {
    gate: config.gate ?? null,
    init: config.init ?? null,
    allowedCommands: config.allowedCommands ?? [],
    concurrency: flags.concurrency ?? config.concurrency ?? DEFAULTS.concurrency,
    base: flags.base ?? config.base ?? DEFAULTS.base,
    timeoutMinutes: config.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
    prosecuteFailOn: config.prosecuteFailOn ?? DEFAULTS.prosecuteFailOn,
    reviewBin: config.reviewBin ?? null,
    reviewProvider: config.reviewProvider ?? null,
    // OPERATOR-LOCAL, and the most dangerous of the three.
    //
    // `modelAuthKey` names the single environment variable that is EXEMPTED from
    // `modelPlaneEnv`'s secret stripping, so whoever sets it chooses which host
    // secret reaches a code-capable, unsandboxed worker. Read from repo config, a
    // candidate could name `ADLC_MANIFEST_KEY` — the key that signs cross-model
    // attestations — and have the worker read the repo's own trust anchor, then
    // forge approvals with it. Same rule as `adapter` and `model`: CLI only.
    modelAuthKey: flags.modelAuthKey ?? null,
    // Worker harness selection (T44). OPERATOR-LOCAL only (adversarial-review K1):
    // a repo-committed config must not silently switch the fleet onto a harness
    // with weaker worker containment (only claude-code installs a per-worktree
    // permission allowlist). Default 'claude-code' — fully contained. The worker
    // BINARY override (adapterCommand/adapterArgs, A2) is likewise CLI-only.
    adapter: flags.adapter ?? 'claude-code',
    // The worker MODEL is operator-local too, as of the quartermaster layer.
    //
    // It used to be read from repo config as "non-executable data". That was only
    // ever safe by accident: claude-code, codex, and opencode all silently DROPPED
    // the model, so the value reached nothing but the agy adapter. Now that every
    // adapter forces its model onto the command line (§4c), a repo-committed
    // `fleet.model` would be a candidate tree choosing the model that builds and
    // judges it — the exact downgrade operating-stack §4/§10 exist to forbid. So
    // it moves to the CLI, alongside `adapter`, and a repo value is warned + ignored.
    model: flags.model ?? null,
    adapterStdin: config.adapterStdin === true,
    adapterCommand: flags.adapterCommand ?? null,
    adapterArgs: flags.adapterArgs ?? null,
    // Extra paths the MODEL-plane worker may write, beyond the worktree and the
    // harness's own declared state (#395). OPERATOR-LOCAL only, for the same
    // reason the sandbox override is: a repo-committed value would let the
    // candidate tree widen the boundary that exists to contain it.
    modelPlaneWritable: flags.modelPlaneWritable ?? [],
    // operator-local ONLY:
    operatorOverride: flags.disposableContainer === true,
    repoConfigOverride: repoWantedOverride,
    warnings,
  };
}
