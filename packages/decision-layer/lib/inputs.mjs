// Collecting change-risk-v1's raw inputs. Every value comes from a source that
// already exists: `git diff --numstat` between the merge-base of the revision
// with the default branch and the revision, and the ticket store.
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname } from 'node:path';
import { loadTicketSnapshot } from '@adlc/tickets';
import { ConfigError } from './errors.mjs';

/** Bounds on every git call: a hung or runaway git cannot stall or flood a run. */
export const GIT_OPTIONS = Object.freeze({ timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
const AMBIENT_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

function gitEnv() {
  const env = { ...process.env };
  for (const name of AMBIENT_GIT_VARIABLES) delete env[name];
  return env;
}

/** Run git in `root`; null when it fails. */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      ...GIT_OPTIONS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    });
  } catch {
    return null;
  }
}

/** The work tree containing `cwd`. */
export function projectRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!out) throw new ConfigError(`${cwd} is not inside a git work tree`);
  return out.trim();
}

/** The repository's main checkout, found through git's common directory, so linked worktrees share it. */
export function mainCheckoutRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = out?.trim();
  if (!common || basename(common) !== '.git') throw new ConfigError('cannot locate the main checkout of this repository');
  return dirname(common);
}

/** `rev` resolved to a full commit id. */
export function resolveRevision(root, rev) {
  const out = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (!out) throw new ConfigError(`--revision ${JSON.stringify(rev)} does not resolve to a commit`);
  return out.trim();
}

function defaultBranchRef(root) {
  const remoteHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.trim();
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  throw new ConfigError('cannot determine the default branch (no origin/HEAD, main or master)');
}

/** Parse `git diff --numstat -z --no-renames` output: "added\tdeleted\tpath\0" per file, "-" for binary. */
export function parseNumstat(output) {
  const stats = { extensionCounts: {}, linesAdded: 0, linesDeleted: 0, filesChanged: 0 };
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const [added, deleted, path] = record.split('\t');
    const extension = extname(path).slice(1).toLowerCase() || 'none';
    stats.extensionCounts[extension] = (stats.extensionCounts[extension] ?? 0) + 1;
    stats.linesAdded += added === '-' ? 0 : Number(added);
    stats.linesDeleted += deleted === '-' ? 0 : Number(deleted);
    stats.filesChanged += 1;
  }
  return stats;
}

/** Diff counts between the merge-base of `revision` with the default branch and `revision`. */
export function diffStats(root, revision) {
  const base = git(root, ['merge-base', defaultBranchRef(root), revision]);
  if (!base) throw new ConfigError(`${revision} shares no history with the default branch`);
  const out = git(root, ['diff', '--numstat', '-z', '--no-renames', base.trim(), revision]);
  if (out === null) throw new ConfigError(`git diff failed for ${revision}`);
  return parseNumstat(out);
}

/** The category and rail count of `ticketId`; an unknown ticket is a configuration error. */
export function ticketFacts(root, ticketId) {
  if (ticketId === null) return { ticketCategory: 'none', declaredRailCount: 'none' };
  let tickets;
  try {
    tickets = loadTicketSnapshot({ root }).mutableTickets();
  } catch (error) {
    throw new ConfigError(`cannot read the ticket store: ${error.message}`);
  }
  const ticket = tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) throw new ConfigError(`unknown --ticket ${ticketId}`);
  return {
    ticketCategory: typeof ticket.category === 'string' ? ticket.category : 'none',
    declaredRailCount: Array.isArray(ticket.rails) ? ticket.rails.length : 0,
  };
}
