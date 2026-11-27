import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  ADLC_DIR,
  OpError,
  classifyRiskTier,
  git,
  isGitRepo,
  refExists,
  splitNulPaths,
} from '@adlc/core';
import { TRACK_REQUIREMENTS } from './assertions.mjs';

export const VALID_TRACKS = Object.freeze(['trivial', 'bounded', 'substantial', 'architectural']);

export const TEST_FILE_RE =
  /(?:^|\/)(?:test|tests|__tests__|cli-test|adapter-test)\/|\.(?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i;

export const CODE_EXT_RE =
  /\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|rb|php|cs|c|cc|cpp|h|hpp|swift|kt)$/i;

export const CONTRACT_SURFACE_RE =
  /(?:^|\/)package\.json$|\.d\.ts$|(?:^|\/)(?:drizzle|migrations|prisma\/migrations|alembic\/versions|supabase\/migrations)\/|(?:^|\/)openapi(?:\.[a-z0-9]+)?$|(?:^|\/)schema\.(?:prisma|sql|graphql|json|ya?ml)$/i;

export function nonTestCode(filePath) {
  return CODE_EXT_RE.test(filePath) && !TEST_FILE_RE.test(filePath);
}

function normalizePath(rawPath) {
  return String(rawPath).trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function isAdlcRuntimePath(filePath, cwd, dir) {
  if (filePath === '.adlc' || filePath.startsWith('.adlc/')) return true;
  if (!dir) return false;
  const relDir = relative(resolve(cwd), resolve(cwd, dir)).replaceAll('\\', '/');
  if (!relDir || relDir === '.' || relDir.startsWith('..')) return false;
  return filePath === relDir || filePath.startsWith(`${relDir}/`);
}

function countFileLines(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8');
    if (content.length === 0) return 0;
    const body = content.endsWith('\n') ? content.slice(0, -1) : content;
    return body.split('\n').length;
  } catch {
    return 0;
  }
}

function parseNumstatBuffer(buf) {
  const stats = new Map();
  for (const record of splitNulPaths(buf)) {
    const firstTab = record.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    const path = normalizePath(record.slice(secondTab + 1));
    if (!path) continue;
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
    stats.set(path, {
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return stats;
}

function readUntrackedPaths(cwd) {
  const raw = git(['status', '--porcelain', '-z', '-uall'], { cwd, encoding: 'buffer' });
  const parts = splitNulPaths(raw);
  const untracked = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.startsWith('?? ')) {
      const p = normalizePath(entry.slice(3));
      if (p) untracked.push(p);
    } else if (/^[RC]/.test(entry)) {
      i += 1;
    }
  }
  return untracked;
}

function collectGitNumstat(cwd, base, scopedFiles) {
  if (!refExists(base, cwd)) {
    if (base !== 'HEAD') {
      throw new OpError(`unknown git base ref: ${base}`);
    }
    return new Map();
  }
  const args = ['--literal-pathspecs', 'diff', '--numstat', '--no-renames', '-z', base, '--'];
  if (scopedFiles && scopedFiles.length > 0) args.push(...scopedFiles);
  const buf = git(args, { cwd, encoding: 'buffer' });
  return parseNumstatBuffer(buf);
}

function partitionForFile(filePath) {
  const m = filePath.match(/^(packages\/[^/]+|plugins\/[^/]+|apps\/[^/]+|services\/[^/]+|crates\/[^/]+)/);
  if (m) return m[1];
  return filePath.includes('/') ? filePath.split('/')[0] : '(root)';
}

export function evaluateTriage({
  cwd = process.cwd(),
  base = 'HEAD',
  files,
  linesAdded: overrideAdded,
  linesDeleted: overrideDeleted,
  dir = ADLC_DIR,
} = {}) {
  const hasAddedOverride = Number.isFinite(overrideAdded);
  const hasDeletedOverride = Number.isFinite(overrideDeleted);

  let changedFiles = [];
  let linesAdded = 0;
  let linesDeleted = 0;

  if (Array.isArray(files) && files.length > 0) {
    changedFiles = Array.from(new Set(files.map(normalizePath).filter(Boolean)));
    if (hasAddedOverride && hasDeletedOverride) {
      linesAdded = overrideAdded;
      linesDeleted = overrideDeleted;
    } else if (isGitRepo(cwd)) {
      const stats = collectGitNumstat(cwd, base, changedFiles);
      const untracked = new Set(readUntrackedPaths(cwd));
      let gitAdded = 0;
      let gitDeleted = 0;
      for (const f of changedFiles) {
        if (!nonTestCode(f)) continue;
        const st = stats.get(f);
        if (st) {
          gitAdded += st.added;
          gitDeleted += st.deleted;
        } else if (untracked.has(f)) {
          gitAdded += countFileLines(resolve(cwd, f));
        }
      }
      linesAdded = hasAddedOverride ? overrideAdded : gitAdded;
      linesDeleted = hasDeletedOverride ? overrideDeleted : gitDeleted;
    } else {
      linesAdded = hasAddedOverride ? overrideAdded : 0;
      linesDeleted = hasDeletedOverride ? overrideDeleted : 0;
    }
  } else if (Array.isArray(files)) {
    changedFiles = [];
    linesAdded = hasAddedOverride ? overrideAdded : 0;
    linesDeleted = hasDeletedOverride ? overrideDeleted : 0;
  } else {
    if (!isGitRepo(cwd)) {
      throw new OpError('not inside a git repository (pass --files or run inside a git worktree)');
    }
    const stats = collectGitNumstat(cwd, base, null);
    const untracked = readUntrackedPaths(cwd);
    const fileSet = new Set();
    let gitAdded = 0;
    let gitDeleted = 0;

    for (const [f, st] of stats.entries()) {
      if (isAdlcRuntimePath(f, cwd, dir)) continue;
      fileSet.add(f);
      if (nonTestCode(f)) {
        gitAdded += st.added;
        gitDeleted += st.deleted;
      }
    }
    for (const f of untracked) {
      if (isAdlcRuntimePath(f, cwd, dir) || fileSet.has(f)) continue;
      fileSet.add(f);
      if (nonTestCode(f)) {
        gitAdded += countFileLines(resolve(cwd, f));
      }
    }

    changedFiles = Array.from(fileSet).sort();
    linesAdded = hasAddedOverride ? overrideAdded : gitAdded;
    linesDeleted = hasDeletedOverride ? overrideDeleted : gitDeleted;
  }

  const partitions = Array.from(new Set(changedFiles.map(partitionForFile))).sort();
  const riskMatches = classifyRiskTier(changedFiles).matches;
  const contractSurfaceChanged = changedFiles.some((f) => CONTRACT_SURFACE_RE.test(f));
  const totalCodeLines = linesAdded + linesDeleted;
  const codeFilesChanged = changedFiles.filter(nonTestCode).length;

  let track = 'trivial';
  let ticketRequired = false;
  let requireFreshContext = false;

  if ((contractSurfaceChanged === true && partitions.length >= 2) || (partitions.length >= 3 && riskMatches.length > 0)) {
    track = 'architectural';
    ticketRequired = true;
    requireFreshContext = true;
  } else if (partitions.length >= 2 || totalCodeLines > 150 || riskMatches.length > 0 || contractSurfaceChanged === true) {
    track = 'substantial';
    ticketRequired = true;
    requireFreshContext = true;
  } else if (totalCodeLines <= 150 && partitions.length <= 1 && (totalCodeLines > 30 || codeFilesChanged > 2)) {
    track = 'bounded';
    ticketRequired = true;
    requireFreshContext = false;
  } else {
    track = 'trivial';
    ticketRequired = false;
    requireFreshContext = false;
  }

  return {
    track,
    ticketRequired,
    requireFreshContext,
    requiredGates: [...TRACK_REQUIREMENTS[track]],
    changedFiles,
    codeFilesChanged,
    linesAdded,
    linesDeleted,
    totalCodeLines,
    partitions,
    riskMatches,
    contractSurfaceChanged,
  };
}
