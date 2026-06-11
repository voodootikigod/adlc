/**
 * verify-claims.mjs — verify extracted claims against the actual environment.
 *
 * Claim status:
 *  - ok          — claim is verifiable and passes
 *  - stale       — claim is verifiable but fails
 *  - unverifiable — cannot determine truth (e.g. URL, ambiguous token)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Verify a single claim.
 * @param {{ type: 'command'|'path'|'script', value: string, raw: string }} claim
 * @param {{ repoRoot: string, skillDir: string }} ctx
 * @returns {{ status: 'ok'|'stale'|'unverifiable', reason?: string }}
 */
export function verifyClaim(claim, ctx) {
  switch (claim.type) {
    case 'command':
      return verifyCommand(claim.value, ctx.repoRoot);
    case 'path':
      return verifyPath(claim.value, ctx.repoRoot, ctx.skillDir);
    case 'script':
      return verifyScript(claim.value, ctx.repoRoot);
    default:
      return { status: 'unverifiable', reason: 'unknown claim type' };
  }
}

/**
 * Verify a command exists via `command -v <tok>` or in ./node_modules/.bin.
 */
function verifyCommand(cmd, repoRoot) {
  // Skip obvious placeholders
  if (isPlaceholder(cmd)) {
    return { status: 'unverifiable', reason: 'placeholder token' };
  }

  // Check ./node_modules/.bin first
  const nmBin = join(repoRoot, 'node_modules', '.bin', cmd);
  if (existsSync(nmBin)) {
    return { status: 'ok' };
  }

  // Use `command -v` via sh to check for shell builtins and PATH binaries
  try {
    execFileSync('sh', ['-c', `command -v ${shellEscape(cmd)}`], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return { status: 'ok' };
  } catch {
    return { status: 'stale', reason: `command not found: ${cmd}` };
  }
}

/**
 * Verify a repo-relative file path exists.
 * Check from repo root first, then relative to skill dir.
 */
function verifyPath(pathValue, repoRoot, skillDir) {
  // Skip URLs
  if (/^https?:\/\//.test(pathValue)) {
    return { status: 'unverifiable', reason: 'URL' };
  }

  const fromRoot = resolve(repoRoot, pathValue);
  if (existsSync(fromRoot)) return { status: 'ok' };

  const fromSkill = resolve(skillDir, pathValue);
  if (existsSync(fromSkill)) return { status: 'ok' };

  return { status: 'stale', reason: `path not found: ${pathValue}` };
}

/**
 * Verify a script name exists in root package.json scripts.
 */
function verifyScript(scriptName, repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return { status: 'unverifiable', reason: 'no root package.json' };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { status: 'unverifiable', reason: 'could not parse root package.json' };
  }

  const scripts = pkg.scripts || {};
  if (Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    return { status: 'ok' };
  }

  return { status: 'stale', reason: `script not in package.json: ${scriptName}` };
}

/**
 * Return true if the token looks like a placeholder.
 * Placeholders: <...> or UPPERCASE_VARS (3+ chars, all caps/underscores/digits).
 */
function isPlaceholder(tok) {
  return /^<[^>]*>$/.test(tok) || /^[A-Z][A-Z0-9_]{2,}$/.test(tok);
}

/**
 * Simple shell-escape for a single token (no spaces expected in command names).
 */
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
