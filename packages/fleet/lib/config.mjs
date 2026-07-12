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
    modelAuthKey: config.modelAuthKey ?? null,
    // Worker harness selection (T44). Default 'claude-code' for backward compat.
    // `adapter` (a registered NAME — registry fails closed) and `model`/`adapterStdin`
    // (non-executable data) are safe from repo config. The worker BINARY override
    // (adapterCommand/adapterArgs) is OPERATOR-LOCAL ONLY (adversarial-review A2):
    // a repo-committed config must NOT be able to select the executable that runs
    // on the unsandboxed model plane with provider auth. Honored from CLI flags only.
    adapter: flags.adapter ?? config.adapter ?? 'claude-code',
    model: config.model ?? null,
    adapterStdin: config.adapterStdin === true,
    adapterCommand: flags.adapterCommand ?? null,
    adapterArgs: flags.adapterArgs ?? null,
    // operator-local ONLY:
    operatorOverride: flags.disposableContainer === true,
    repoConfigOverride: repoWantedOverride,
    warnings,
  };
}
