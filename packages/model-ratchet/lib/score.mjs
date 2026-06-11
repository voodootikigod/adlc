// score.mjs — Hot-score computation and ranking.
// HOT SCORE = churn[file] × (1 + inDegree[file])

/**
 * Compute hot scores for all files.
 *
 * @param {Object.<string, number>} churnMap   - file → commit count
 * @param {Object.<string, number>} inDegreeMap - file → in-degree count
 * @param {string[]}                files       - candidate file paths
 * @returns {Array<{file, churn, inDegree, score}>} sorted descending by score
 */
export function computeScores(churnMap, inDegreeMap, files) {
  const rows = [];
  for (const file of files) {
    const c = churnMap[file] ?? 0;
    const d = inDegreeMap[file] ?? 0;
    const score = c * (1 + d);
    rows.push({ file, churn: c, inDegree: d, score });
  }
  // Sort descending by score, then by file name for determinism on ties
  rows.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return rows;
}

/**
 * Select top N rows.
 * @param {Array<{file, churn, inDegree, score}>} rows
 * @param {number} n
 */
export function topN(rows, n) {
  return rows.slice(0, n);
}

/**
 * Build a prosecution plan charter line for a scored file.
 * @param {{file: string, churn: number, inDegree: number, score: number}} row
 */
export function charterLine(row) {
  return `Refute correctness of ${row.file} — hotspot: changed ${row.churn} times, imported by ${row.inDegree} files`;
}
