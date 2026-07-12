// Protected-control-file integrity scan (spec §8.3(d); adversarial-review
// F1/N4/M2).
//
// The tracked-diff scope check (§8.3(c)) only sees committed changes, and the
// orchestrator's commit pathspec excludes `.claude/` and `.adlc/`. So a worker's
// WORKTREE write to a control file — including the tracked-but-unstaged
// `.adlc/tickets.json` trust root — never reaches HEAD and would evade the diff.
// This scan closes that gap: it compares the live worktree copy of each file on
// a CLOSED manifest against its authoritative version, and fails any NEW,
// non-allowlisted file appearing under a protected prefix.
//
// Pure and injectable: the caller supplies the candidate files (built from git
// status + the manifest) and the authoritative templates; no git or fs here.

import { globMatch } from '@adlc/core';

// Prefixes whose contents are permission/trust/plan control surfaces.
export const PROTECTED_PREFIXES = ['.claude/**', '.adlc/**'];

// The ONLY inert runtime artifacts allowed to differ/appear freely (§8.3d).
// A closed allowlist — everything else under a protected prefix must be on the
// manifest or it fails.
export const INERT_GLOBS = ['.adlc/fleet-logs/**'];

// The orchestrator-owned control files that always form the manifest, beyond any
// dynamically-provisioned files the caller adds. Trust roots are included
// explicitly (M2) — omitting tickets.json was the bug the third review caught.
export const BASE_MANIFEST = [
  '.claude/settings.local.json',
  '.adlc/config.json',
  '.adlc/fleet-status.json',
  '.adlc/tickets.json',
  '.adlc/current-ticket.json',
];

export function isUnderProtectedPrefix(path) {
  return PROTECTED_PREFIXES.some((g) => globMatch(g, path));
}

export function isInert(path) {
  return INERT_GLOBS.some((g) => globMatch(g, path));
}

/**
 * Scan candidate worktree files for control-file tampering.
 *
 * @param candidates array of { path, bytes } — every worktree file under a
 *   protected prefix that is either on the manifest OR is untracked/ignored/
 *   unstaged (i.e. a possible worker addition/mutation). Committed-and-unchanged
 *   files are not candidates (they'd show in the tracked diff if altered).
 * @param templates Map<path, bytes> — the authoritative version of each manifest
 *   file: the orchestrator-provisioned template, or the startSha-committed copy
 *   for the trust roots.
 * @returns { ok:boolean, violations:[{path, reason}] }
 */
export function scanProtectedPaths(candidates, templates) {
  const violations = [];
  const manifest = new Set([...BASE_MANIFEST, ...templates.keys()]);

  for (const { path, bytes } of candidates) {
    if (isInert(path)) continue; // explicitly-allowed inert artifact
    if (!isUnderProtectedPrefix(path)) continue; // not our concern

    if (manifest.has(path)) {
      const expected = templates.get(path);
      if (expected === undefined) {
        // A manifest file (e.g. a trust root) with no authoritative template
        // supplied means we cannot vouch for it → fail closed.
        violations.push({ path, reason: 'protected control file has no authoritative template to compare against' });
      } else if (bytes !== expected) {
        violations.push({ path, reason: 'worker modified a protected control file' });
      }
    } else {
      // A file under a protected prefix that is neither on the manifest nor
      // inert-allowlisted: an unexpected control file a worker introduced.
      violations.push({ path, reason: 'unexpected/unauthorized file created under a protected prefix' });
    }
  }
  return { ok: violations.length === 0, violations };
}
