import { ADLC_DIR } from '@adlc/core';
import { appendManifestEntry as appendManifestEntryRaw } from './lib/record.mjs';
import { normalizeManifestDirAndCwd } from './lib/lineage.mjs';

export function appendManifestEntry(payload, dir = ADLC_DIR, opts = {}) {
  const normalized = normalizeManifestDirAndCwd(dir, opts);
  return appendManifestEntryRaw(payload, normalized.dir, { ...opts, cwd: normalized.cwd });
}

export { specApprovalIntegrityErrors, validateSpecApprovalRecord } from './lib/spec-approval.mjs';
