/**
 * format.mjs — human-readable and JSON output formatters for skill-rot.
 */

import { relative } from 'node:path';

function isZeroClaims(r) {
  return r.ok === 0 && r.stale === 0 && r.unverifiable === 0;
}

/**
 * Format skill results as a human-readable table.
 * @param {object[]} results - array of checkSkill results
 * @param {string} repoRoot
 * @returns {string}
 */
export function formatTable(results, repoRoot) {
  const lines = [];

  // Header
  lines.push('skill-rot results:');
  lines.push('');

  for (const r of results) {
    const rel = relative(repoRoot, r.path);
    const statusIcon = r.stale > 0 ? '[STALE]' : (isZeroClaims(r) ? '[NO-CLAIMS]' : '[OK]   ');
    lines.push(`  ${statusIcon} ${rel}`);
    lines.push(`         ok=${r.ok}  stale=${r.stale}  unverifiable=${r.unverifiable}`);

    if (r.staleDetails.length > 0) {
      for (const d of r.staleDetails) {
        lines.push(`         ! stale: "${d.claim}" — ${d.reason}`);
      }
    }
  }

  lines.push('');

  const totalClean = results.filter((r) => r.stale === 0 && !isZeroClaims(r)).length;
  const totalStale = results.filter((r) => r.stale > 0).length;
  const totalNoClaims = results.filter(isZeroClaims).length;
  lines.push(`Summary: ${results.length} skill(s) checked, ${totalClean} clean, ${totalStale} stale, ${totalNoClaims} no claims`);

  return lines.join('\n');
}

/**
 * Format skill results as JSON for orchestrators.
 * @param {object[]} results
 * @param {string} repoRoot
 * @returns {object}
 */
export function formatJson(results, repoRoot) {
  return {
    skills: results.map((r) => {
      const isZero = isZeroClaims(r);
      const skill = {
        path: relative(repoRoot, r.path),
        ok: r.ok,
        stale: r.stale,
        unverifiable: r.unverifiable,
        staleDetails: r.staleDetails,
        allOk: isZero ? false : r.allOk,
      };
      if (isZero) {
        skill.noClaims = true;
      }
      return skill;
    }),
    summary: {
      total: results.length,
      clean: results.filter((r) => r.stale === 0 && !isZeroClaims(r)).length,
      stale: results.filter((r) => r.stale > 0).length,
      noClaims: results.filter(isZeroClaims).length,
    },
  };
}
