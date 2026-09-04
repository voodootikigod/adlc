// Preflight (spec §9, §6.0, §14) — the public surface. Phase A
// (`preflight-a.mjs`) runs before the baseline exists; `resolveBaseline` and
// phase B (`preflight-b.mjs`) read everything from the pinned blob; the §14
// spec-approval binding lives in `spec-approval.mjs`.

export { PreflightError, BUILD_TICKET_ID, SPEC_PATH, PLUGIN_JSON_PATH, CONFIG_PATH, TICKET_SYNC_SCHEMA_PATH, MANIFEST_DIR, TOKEN_MARGIN_MS, requireBaseline, showAtBaseline, listTreeAtBaseline } from './preflight-common.mjs';
export { phaseA, checkKeyFile, checkExclude, modelFamily, MODEL_FAMILIES } from './preflight-a.mjs';
export { resolveBaseline, phaseB, installedPluginVersion, tokenMargin, withPreflightWorktree, fleetDryRun } from './preflight-b.mjs';
export { extractResiduals, assumptionsHash, newestSpecApproval, parseSegmentEntries, readManifestAtBaseline, runnerGate, mergeIdentity, checkSpecApproval } from './spec-approval.mjs';

import { removeSshDir } from './ssh.mjs';

/** Remove per-iteration transport material: the dry-run mkdtemp (§0) or the run's `ssh-<token>/` (§9.4a). */
export function cleanupPreflight(ctx) {
  if (ctx.sshDryRunParent) { removeSshDir(ctx.sshDryRunParent); ctx.sshDryRunParent = null; }
  else if (ctx.ssh?.dir) removeSshDir(ctx.ssh.dir);
  ctx.ssh = null;
}
