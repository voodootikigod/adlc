// Build concise, bounded repository facts for grounding parallax prompts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_MANIFESTS = [
  'Cargo.toml',
  'go.mod',
  'package.json',
  'pyproject.toml',
  'tsconfig.json',
];

const EXCLUDED_TOP_DIRS = new Set(['node_modules', 'target', 'dist', 'build']);

/**
 * Build deterministic plain-text repository facts for `repoDir`.
 *
 * @param {string} repoDir
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function buildRepoFacts(repoDir, { maxChars = 3800 } = {}) {
  const presentManifests = STACK_MANIFESTS.filter((name) => {
    try {
      return existsSync(join(repoDir, name));
    } catch {
      return false;
    }
  }).sort();

  const topDirs = [];
  try {
    const entries = readdirSync(repoDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || EXCLUDED_TOP_DIRS.has(ent.name)) continue;
      topDirs.push(ent.name);
    }
  } catch {
    // Leave topDirs empty if unreadable
  }
  topDirs.sort();
  const cappedTopDirs = topDirs.slice(0, 25);

  const workspaces = [];
  try {
    const pkgEntries = readdirSync(join(repoDir, 'packages'), { withFileTypes: true });
    for (const ent of pkgEntries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(repoDir, 'packages', ent.name, 'package.json'), 'utf8'));
        if (typeof pkg?.name === 'string' && pkg.name.trim() !== '') {
          workspaces.push(pkg.name.trim());
        }
      } catch {
        // Ignore unreadable workspace package.json
      }
    }
  } catch {
    // Optional: repo may have no packages/ directory
  }
  workspaces.sort();
  const cappedWorkspaces = workspaces.slice(0, 40);

  let testScript = null;
  try {
    const rootPkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
    if (typeof rootPkg?.scripts?.test === 'string' && rootPkg.scripts.test.trim() !== '') {
      testScript = rootPkg.scripts.test.replace(/\s+/g, ' ').trim();
    }
  } catch {
    // Optional: repo may have no root package.json or scripts.test
  }

  const lines = [
    `Stack manifests: ${presentManifests.length > 0 ? presentManifests.join(', ') : 'none'}`,
    `Top-level directories: ${cappedTopDirs.length > 0 ? cappedTopDirs.join(', ') : 'none'}`,
  ];
  if (cappedWorkspaces.length > 0) {
    lines.push(`Workspaces: ${cappedWorkspaces.join(', ')}`);
  }
  if (testScript !== null) {
    lines.push(`Test script: ${testScript}`);
  }

  const text = lines.join('\n');
  if (text.length > maxChars) {
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  }
  return text;
}
