/**
 * rot-checker.mjs — orchestrate claim extraction and verification for a skill.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractClaims } from './extract-claims.mjs';
import { verifyClaim } from './verify-claims.mjs';
import { upsertFrontmatter } from './frontmatter.mjs';

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
    const updated = upsertFrontmatter(content, 'last-verified', isoDate);
    writeFileSync(skillPath, updated, 'utf8');
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
