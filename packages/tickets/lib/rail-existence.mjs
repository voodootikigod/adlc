// A rail freezes the files it matches, so a rail matching no file freezes
// nothing. These helpers find the rails that match nothing in a repository.
import { spawnSync } from 'node:child_process';
import { globMatch } from './generated-glob-match.mjs';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Every tracked file and every untracked file git does not ignore, as
 * repo-relative '/'-separated paths; null when `root` is not a git work tree
 * (the existence check then does not apply, as for a store outside a repo).
 */
export function repositoryFiles(root, { spawn = spawnSync } = {}) {
  const result = spawn('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: null,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  const buf = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
  const files = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i += 1) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        const slice = buf.subarray(start, i);
        const decoded = slice.toString('utf8');
        if (Buffer.from(decoded, 'utf8').equals(slice)) files.push(decoded);
      }
      start = i + 1;
    }
  }
  return files;
}

/** The rails in `rails` that match none of `files`. */
export function railsMatchingNothing(rails, files) {
  if (!Array.isArray(rails) || rails.length === 0) return [];
  return rails.filter((rail) => typeof rail === 'string' && rail !== '' && !files.some((file) => globMatch(rail, file)));
}
