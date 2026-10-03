/**
 * format.mjs — human-readable and JSON output formatters for skill-rot.
 *
 * Every status derives from the checker's verdict: a skill is clean only when
 * checkSkill reported allOk (at least one verified claim, none stale).
 */

import { relative } from 'node:path';

function isZeroClaims(r) {
  return r.ok === 0 && r.stale === 0 && r.unverifiable === 0;
}

/** Claims exist and none are stale, but nothing could be verified. */
function isUnverified(r) {
  return r.stale === 0 && !r.allOk && !isZeroClaims(r);
}

function statusLabel(r) {
  if (r.stale > 0) return '[STALE]';
  if (isZeroClaims(r)) return '[NO-CLAIMS]';
  if (r.allOk) return '[OK]   ';
  return '[UNVERIFIED]';
}

function summarize(results) {
  return {
    total: results.length,
    clean: results.filter((r) => r.stale === 0 && r.allOk).length,
    stale: results.filter((r) => r.stale > 0).length,
    noClaims: results.filter(isZeroClaims).length,
    unverified: results.filter(isUnverified).length,
  };
}

/**
 * Format skill results as a human-readable table.
 * @param {object[]} results - array of checkSkill results
 * @param {string} repoRoot
 * @returns {string}
 */
export function formatTable(results, repoRoot) {
  const lines = [];

  lines.push('skill-rot results:');
  lines.push('');

  for (const r of results) {
    lines.push(`  ${statusLabel(r)} ${relative(repoRoot, r.path)}`);
    lines.push(`         ok=${r.ok}  stale=${r.stale}  unverifiable=${r.unverifiable}`);
    for (const d of r.staleDetails) {
      lines.push(`         ! stale: "${d.claim}" — ${d.reason}`);
    }
  }

  lines.push('');

  const s = summarize(results);
  lines.push(`Summary: ${s.total} skill(s) checked, ${s.clean} clean, ${s.stale} stale, ${s.noClaims} no claims, ${s.unverified} unverified`);

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
    skills: results.map((r) => ({
      path: relative(repoRoot, r.path),
      ok: r.ok,
      stale: r.stale,
      unverifiable: r.unverifiable,
      staleDetails: r.staleDetails,
      allOk: isZeroClaims(r) ? false : r.allOk,
      ...(isZeroClaims(r) ? { noClaims: true } : {}),
      ...(isUnverified(r) ? { unverified: true } : {}),
    })),
    summary: summarize(results),
  };
}
