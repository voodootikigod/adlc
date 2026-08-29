/**
 * rot-checker.mjs — orchestrate claim extraction and verification for a skill.
 */

import { readFileSync, writeFileSync as nodeWriteFileSync, renameSync as nodeRenameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { extractClaims } from './extract-claims.mjs';
import { verifyClaim } from './verify-claims.mjs';
import { upsertFrontmatter } from './frontmatter.mjs';

// Random suffix length for the atomic-write temp file. Any value large enough
// to make a collision practically impossible is equally correct — no test can
// observe 6 vs 7 bytes of entropy, so this is a magnitude, not a boundary.
const RANDOM_SUFFIX_BYTES = 6;

/**
 * Stamp last-verified into a SKILL.md file's frontmatter and write it back
 * atomically: the updated content is written to a sibling temp file first,
 * then renamed over the original, so a write interrupted mid-flight never
 * leaves a truncated skill file — the rename either completes or the
 * original is untouched.
 *
 * @param {string} skillPath - absolute path to SKILL.md
 * @param {string} isoDate - the last-verified value to stamp
 * @param {{ writeFileSync?: Function, rename?: Function }} [io] - injectable fs seams for tests
 */
export function stampVerified(skillPath, isoDate, io = {}) {
  const { writeFileSync = nodeWriteFileSync, rename = nodeRenameSync } = io;
  const content = readFileSync(skillPath, 'utf8');
  const updated = upsertFrontmatter(content, 'last-verified', isoDate);
  const tmpPath = `${skillPath}.tmp-${randomBytes(RANDOM_SUFFIX_BYTES).toString('hex')}`;
  writeFileSync(tmpPath, updated, 'utf8');
  rename(tmpPath, skillPath);
}

/**
 * Check a single SKILL.md file for rot.
 *
 * @param {string} skillPath - absolute path to SKILL.md
 * @param {string} repoRoot  - absolute path to repo root
 * @param {{ write: boolean }} opts
 * @returns {{
 *   path: string,
 *   ok: number,
 *   stale: number,
 *   unverifiable: number,
 *   staleDetails: { claim: string, reason: string }[],
 *   allOk: boolean
 * }}
 */
export function checkSkill(skillPath, repoRoot, opts = {}) {
  const content = readFileSync(skillPath, 'utf8');
  const skillDir = dirname(skillPath);

  const claims = extractClaims(content);
  const ctx = { repoRoot, skillDir };

  let okCount = 0;
  let staleCount = 0;
  let unverifiableCount = 0;
  const staleDetails = [];

  for (const claim of claims) {
    const result = verifyClaim(claim, ctx);
    if (result.status === 'ok') {
      okCount++;
    } else if (result.status === 'stale') {
      staleCount++;
      staleDetails.push({ claim: claim.raw, reason: result.reason });
    } else {
      unverifiableCount++;
    }
  }

  const allOk = staleCount === 0 && (okCount > 0 || unverifiableCount > 0 || claims.length === 0);

  // --write: upsert last-verified only when ALL claims are ok
  if (opts.write && staleCount === 0) {
    const isoDate = new Date().toISOString().slice(0, 10);
    stampVerified(skillPath, isoDate);
  }

  return {
    path: skillPath,
    ok: okCount,
    stale: staleCount,
    unverifiable: unverifiableCount,
    staleDetails,
    allOk,
  };
}
