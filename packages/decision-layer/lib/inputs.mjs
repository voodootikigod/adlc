// Collecting change-risk-v1's raw inputs. Every value comes from a source that
// already exists: `git diff --numstat` between the merge-base of the revision
// with the default branch and the revision, and the ticket store.
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { loadTicketSnapshot } from '@adlc/tickets';
import { ConfigError, GitOutputError } from './errors.mjs';

/** Bounds on every git call: a hung or runaway git cannot stall or flood a run. */
export const GIT_OPTIONS = Object.freeze({ timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
/** The process environment without GIT_* variables, which could point git at another repository. */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
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

/**
 * The repository's main work tree: the first entry `git worktree list` reports,
 * so every linked worktree shares it. In a submodule or a --separate-git-dir
 * checkout git reports the git directory there instead; the work tree is then
 * its `core.worktree` (submodules), or this checkout's own top level when this
 * checkout is the main one. A bare main repository has no work tree: git lists
 * its directory, which is also the common directory, and no checkout of it is
 * the main one, so it is refused below.
 */
export function mainCheckoutRoot(cwd) {
  const fail = () => { throw new ConfigError('cannot locate the main work tree of this repository'); };
  const out = git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const fields = (out ?? '').split('\0\0')[0].split('\0');
  const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
  if (!path) fail();
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  if (path !== common) return path;
  const configured = git(cwd, ['config', '--file', join(common, 'config'), 'core.worktree'])?.trim();
  if (configured) return resolve(common, configured);
  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir'])?.trim();
  // A bare repository has no main checkout, so a run in one of its worktrees is refused here.
  return gitDir === common ? projectRoot(cwd) : fail();
}

/** `rev` resolved to a full commit id. */
export function resolveRevision(root, rev) {
  const out = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (!out) throw new ConfigError(`--revision ${JSON.stringify(rev)} does not resolve to a commit`);
  return out.trim();
}

/** origin/HEAD's target when it resolves to a commit, else local main or master. */
function defaultBranchRef(root) {
  const remoteHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (remoteHead && git(root, ['rev-parse', '--verify', '--quiet', `${remoteHead}^{commit}`])) return remoteHead;
  for (const ref of ['refs/heads/main', 'refs/heads/master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  throw new ConfigError('cannot determine the default branch (no origin/HEAD, main or master)');
}

const COUNT = /^(?:-|\d+)$/;

function unreadable(detail) {
  return new GitOutputError(`unreadable git diff --numstat output: ${detail}`);
}

function lineCount(value) {
  if (!COUNT.test(value ?? '')) throw unreadable(`count ${JSON.stringify(value)} is neither a number nor "-"`);
  return value === '-' ? 0 : Number(value);
}

/**
 * Parse `git diff --numstat -z --find-renames` output. A record is
 * "added\tdeleted\tpath\0", with "-" counts for a binary file and the path
 * verbatim (it may itself contain a tab). A rename leaves the path field empty
 * and is followed by "old\0new\0"; it counts as one file under the new path,
 * with its real line counts. Anything else is refused rather than guessed.
 */
export function parseNumstat(output) {
  const tokens = output.split('\0');
  const counts = new Map();
  const stats = { linesAdded: 0, linesDeleted: 0, filesChanged: 0 };
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '' && i === tokens.length - 1) break;
    const [added, deleted, ...rest] = tokens[i].split('\t');
    if (rest.length === 0) throw unreadable(`record ${JSON.stringify(tokens[i])} has too few fields`);
    let path = rest.join('\t');
    if (path === '') {
      path = tokens[i + 2];
      if (!tokens[i + 1] || !path) throw unreadable('a rename is missing its paths');
      i += 2;
    }
    stats.linesAdded += lineCount(added);
    stats.linesDeleted += lineCount(deleted);
    const extension = extname(path).slice(1).toLowerCase() || 'none';
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
    stats.filesChanged += 1;
  }
  return { extensionCounts: Object.fromEntries(counts), ...stats };
}

/** Diff counts between the merge-base of `revision` with the default branch and `revision`. */
export function diffStats(root, revision) {
  const base = git(root, ['merge-base', defaultBranchRef(root), revision]);
  if (!base) throw new ConfigError(`${revision} shares no history with the default branch`);
  const out = git(root, ['diff', '--numstat', '-z', '--find-renames', base.trim(), revision]);
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
