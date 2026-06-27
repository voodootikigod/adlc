import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function newHash() {
  const hash = createHash('sha256');
  return {
    add(part) {
      hash.update(part);
      hash.update('\0');
    },
    digest() {
      return hash.digest('hex');
    },
  };
}

function addWorkingTreeFile(hash, cwd, relative, object) {
  const absolute = join(cwd, relative);
  if (!existsSync(absolute)) {
    return;
  }
  hash.add(Buffer.from(relative));
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    hash.add(Buffer.from(`non-file:${stat.mode}:${stat.size}`));
    return;
  }
  const mode = (stat.mode & 0o111) ? '100755' : '100644';
  hash.add(Buffer.from(`git-blob:${mode}:${object}`));
}

function splitNull(raw) {
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function trackedEntries(cwd) {
  const entries = new Map();
  for (const record of splitNull(git(['ls-files', '-s', '-z'], cwd))) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const metadata = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (metadata.length >= 3 && path) entries.set(path, { mode: metadata[0], object: metadata[1] });
  }
  return entries;
}

function dirtyTrackedPaths(cwd) {
  return new Set(splitNull(git(['diff', '--name-only', '-z'], cwd)));
}

function addGitBlob(hash, relative, entry) {
  hash.add(Buffer.from(relative));
  hash.add(Buffer.from(`git-blob:${entry.mode}:${entry.object}`));
}

function batchWorkingTreeBlobs(cwd, paths) {
  if (paths.length === 0) return new Map();
  const objects = new Map();
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const output = git(['hash-object', '--', ...chunk], cwd).toString('utf8').split('\n').filter(Boolean);
    for (const [index, path] of chunk.entries()) {
      const object = output[index];
      if (object) objects.set(path, object);
    }
    chunk = [];
    chunkBytes = 0;
  };

  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && chunkBytes + pathBytes > 128 * 1024) flush();
    chunk.push(path);
    chunkBytes += pathBytes;
  }
  flush();
  return objects;
}

const DEFAULT_IGNORED_PATHS = [
  '.adlc/manifest.jsonl',
  '.adlc/manifest.lock',
  '.adlc/tickets.json',
  '.adlc/current-ticket.json',
];

function normalizeRelativePath(cwd, path) {
  const normalized = relative(cwd, resolve(cwd, path)).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function ignoredPathSet(cwd, paths) {
  return new Set(
    [...DEFAULT_IGNORED_PATHS, ...paths]
      .map((path) => normalizeRelativePath(cwd, path))
      .filter(Boolean)
  );
}

function isIgnoredPath(relativePath, ignoredPaths) {
  const normalized = relativePath.replaceAll('\\', '/');
  return ignoredPaths.has(normalized);
}

export function resolveRevision({ cwd = process.cwd(), revision, ignorePaths = [] } = {}) {
  if (revision !== undefined && revision !== null && String(revision).trim() !== '') {
    return String(revision);
  }

  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    const tracked = trackedEntries(cwd);
    const dirtyTracked = dirtyTrackedPaths(cwd);
    const untracked = splitNull(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd));
    const hash = newHash();
    const ignoredPaths = ignoredPathSet(cwd, ignorePaths);
    const files = new Set([
      ...tracked.keys(),
      ...untracked,
    ]);
    const sortedFiles = Array.from(files).sort();
    const workingTreeBlobIds = batchWorkingTreeBlobs(
      cwd,
      sortedFiles.filter((relative) => {
        if (isIgnoredPath(relative, ignoredPaths)) return false;
        const trackedEntry = tracked.get(relative);
        if (trackedEntry && !dirtyTracked.has(relative)) return false;
        try {
          return statSync(join(cwd, relative)).isFile();
        } catch {
          return false;
        }
      })
    );

    for (const relative of sortedFiles) {
      if (isIgnoredPath(relative, ignoredPaths)) continue;
      try {
        const trackedEntry = tracked.get(relative);
        if (trackedEntry && !dirtyTracked.has(relative)) {
          addGitBlob(hash, relative, trackedEntry);
        } else {
          addWorkingTreeFile(hash, cwd, relative, workingTreeBlobIds.get(relative));
        }
      } catch {
        hash.add(Buffer.from(relative));
        hash.add(Buffer.from('missing'));
      }
    }
    return `git-worktree:${hash.digest()}`;
  } catch {
    return null;
  }
}
