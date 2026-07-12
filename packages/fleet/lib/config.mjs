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
    // Worker harness selection (T44). OPERATOR-LOCAL only (adversarial-review K1):
    // a repo-committed config must not silently switch the fleet onto a harness
    // with weaker worker containment (only claude-code installs a per-worktree
    // permission allowlist). Default 'claude-code' — fully contained. The worker
    // BINARY override (adapterCommand/adapterArgs, A2) is likewise CLI-only.
    // `model`/`adapterStdin` are non-executable data and stay repo-config-safe.
    adapter: flags.adapter ?? 'claude-code',
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
