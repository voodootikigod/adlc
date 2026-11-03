/**
 * verify-claims.mjs — verify extracted claims against the actual environment.
 *
 * Claim status:
 *  - ok          — claim is verifiable and passes
 *  - stale       — claim is verifiable but fails
 *  - unverifiable — cannot determine truth (e.g. URL, ambiguous token)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, delimiter } from 'node:path';

/**
 * Verify a single claim.
 * @param {{ type: 'command'|'path'|'script', value: string, raw: string }} claim
 * @param {{ repoRoot: string, skillDir: string }} ctx
 * @returns {{ status: 'ok'|'stale'|'unverifiable', reason?: string }}
 */
export function verifyClaim(claim, ctx) {
  switch (claim.type) {
    case 'command':
      return verifyCommand(claim.value, ctx.repoRoot, ctx);
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
export function findOnWindowsPath(cmd, env = process.env, pathDelimiter = delimiter) {
  const pathVal = env.PATH ?? env.Path ?? '';
  const dirs = pathVal.split(pathDelimiter).filter(Boolean);
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = [cmd, ...exts.map((ext) => cmd + ext), ...exts.map((ext) => cmd + ext.toLowerCase())];
  for (const dir of dirs) {
    for (const name of candidates) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

function verifyCommand(cmd, repoRoot, opts = {}) {
  // Skip obvious placeholders
  if (isPlaceholder(cmd)) {
    return { status: 'unverifiable', reason: 'placeholder token' };
  }

  // Check ./node_modules/.bin first
  const nmBin = join(repoRoot, 'node_modules', '.bin', cmd);
  if (existsSync(nmBin) || existsSync(nmBin + '.cmd')) {
    return { status: 'ok' };
  }

  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const execFn = opts.execFileSync ?? execFileSync;

  if (platform === 'win32') {
    if (findOnWindowsPath(cmd, env, opts.pathDelimiter ?? delimiter)) {
      return { status: 'ok' };
    }
  }

  // Use `command -v` via sh to check for shell builtins and PATH binaries
  try {
    execFn('sh', ['-c', `command -v ${shellEscape(cmd)}`], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return { status: 'ok' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'unverifiable', reason: 'no POSIX shell available' };
    }
    return { status: 'stale', reason: `command not found: ${cmd}` };
  }
}

/**
 * Verify a repo-relative file path exists.
 * Check from repo root first, then relative to skill dir.
 */
function isContainedWithin(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRealpathContained(candidate, root) {
  const realCandidate = realpathSync(candidate);
  const realRoot = realpathSync(root);
  return isContainedWithin(realCandidate, realRoot);
}

function verifyPath(pathValue, repoRoot, skillDir) {
  // Skip URLs
  if (/^https?:\/\//.test(pathValue)) {
    return { status: 'unverifiable', reason: 'URL' };
  }

  const fromRoot = resolve(repoRoot, pathValue);
  const inRoot = isContainedWithin(fromRoot, repoRoot);
  if (inRoot && existsSync(fromRoot)) {
    if (!isRealpathContained(fromRoot, repoRoot)) {
      return { status: 'unverifiable', reason: 'outside repository' };
    }
    return { status: 'ok' };
  }

  const fromSkill = resolve(skillDir, pathValue);
  const inSkillOrRepo = isContainedWithin(fromSkill, repoRoot) || isContainedWithin(fromSkill, skillDir);
  if (inSkillOrRepo && existsSync(fromSkill)) {
    if (!isRealpathContained(fromSkill, repoRoot) && !isRealpathContained(fromSkill, skillDir)) {
      return { status: 'unverifiable', reason: 'outside repository' };
    }
    return { status: 'ok' };
  }

  if (!inRoot && !inSkillOrRepo) {
    return { status: 'unverifiable', reason: 'outside repository' };
  }

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
