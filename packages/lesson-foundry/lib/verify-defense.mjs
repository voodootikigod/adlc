import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeCandidateEnv } from '@adlc/core';
import { buildCheckScript } from './emit.mjs';
import { extractLiteralPattern, clusterName } from './route.mjs';

/**
 * Verify candidate lint clusters against:
 * 1. Positive synthetic check: temp file with pattern must exit 2
 * 2. Negative synthetic check: empty temp dir must exit 0
 * 3. Baseline repo check: if root already matches pattern, demote route to 'spec-gap'
 *
 * @param {Array<object>} clusters
 * @param {Array<object>} allFindings
 * @param {object} options
 * @param {string} options.root
 * @returns {Array<object>} Mutated or verified clusters
 */
export function verifyLintClusters(clusters, allFindings, { root = process.cwd() } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'adlc-verify-defense-'));

  try {
    for (const cluster of clusters) {
      if (cluster.route !== 'lint') continue;

      const clusterFindings = cluster.indices ? cluster.indices.map((i) => allFindings[i]) : [];
      const name = clusterName(clusterFindings);
      const literal = extractLiteralPattern(clusterFindings);
      const testPattern = literal || name;

      // Generate check-<slug>.mjs
      const scriptArtifact = buildCheckScript(name, clusterFindings);
      const scriptPath = join(tempDir, `check-${name}.mjs`);
      writeFileSync(scriptPath, scriptArtifact.content, 'utf8');

      const childEnv = sanitizeCandidateEnv(process.env);
      delete childEnv.ADLC_MANIFEST_KEY;

      // (a) Positive synthetic check: temp file containing pattern (must exit 2)
      const posDir = join(tempDir, `pos-${name}`);
      mkdirSync(posDir, { recursive: true });
      writeFileSync(join(posDir, 'sample.mjs'), `// test\nconst x = ${JSON.stringify(testPattern)};\n`, 'utf8');

      const posRes = spawnSync(process.execPath, [scriptPath], {
        cwd: posDir,
        env: childEnv,
        timeout: 10000,
        encoding: 'utf8',
      });

      // (b) Negative synthetic check: empty temp dir (must exit 0)
      const negDir = join(tempDir, `neg-${name}`);
      mkdirSync(negDir, { recursive: true });

      const negRes = spawnSync(process.execPath, [scriptPath], {
        cwd: negDir,
        env: childEnv,
        timeout: 10000,
        encoding: 'utf8',
      });

      // If synthetic tests fail to behave properly, demote
      if (posRes.status !== 2 || negRes.status !== 0) {
        cluster.route = 'spec-gap';
        cluster.demotedReason = 'synthetic-check-failed';
        continue;
      }

      // (c) Baseline check against root: if root already matches the literal pattern, demote
      const baseRes = spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        env: childEnv,
        timeout: 15000,
        encoding: 'utf8',
      });

      if (baseRes.status !== 0) {
        cluster.route = 'spec-gap';
        cluster.demotedReason = baseRes.status === 2 ? 'matches-existing-repo' : 'baseline-check-failed';
      }
    }

    return clusters;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
