// Path contract (spec §6 "Path contract", §9.1c, §9.4a, §10; AC 24, AC 25).
//
// REPO_ROOT is the primary checkout (the main worktree — `git worktree list`'s
// first entry), never a linked worktree. Everything the autopilot writes under
// it is gitignored via `.git/info/exclude` and lives under `.adlc/autopilot-*`
// or `.worktrees/autopilot-issue-*`; the primary working tree itself is never
// written.

import { join } from 'node:path';
import { validateIssueNumber, validateOid, underRoot, isUnder } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

export const EXCLUDE_ENTRIES = Object.freeze([
  '.adlc/autopilot-status.json',
  '.adlc/autopilot.lock/',
  '.adlc/autopilot-runs/',
  '.worktrees/autopilot-issue-*',
]);

export class PathError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/**
 * Resolve REPO_ROOT from a cwd using an injectable git runner
 * `git(args) => stdout`. Refuses a linked worktree (`not-main-worktree`).
 */
registerSeams(['paths.helperRefusesLinkedWorktree', 'paths.allowLinkedWorktree', 'paths.acceptAnyRunId']);

export function resolveRepoRoot({ cwd, git, explicitRoot = null }) {
  const top = explicitRoot ?? git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  if (!top) throw new PathError('not-a-repository', cwd);
  const porcelain = git(['worktree', 'list', '--porcelain'], { cwd: top });
  const first = porcelain.split('\n').find((l) => l.startsWith('worktree '));
  const main = first ? first.slice('worktree '.length).trim() : null;
  // Mutation seam `paths.allowLinkedWorktree`: a linked worktree passes as REPO_ROOT.
  if (!active('paths.allowLinkedWorktree') && (!main || main !== top)) throw new PathError('not-main-worktree', `${top} is a linked worktree of ${main ?? '?'}`);
  return top;
}

/**
 * The MAIN worktree of the repository `cwd` belongs to — for the pre-strike quota helper, which
 * fleet spawns from inside the ISSUE worktree (a linked worktree the orchestrator itself refuses).
 * Mutation seam `paths.helperRefusesLinkedWorktree`: the helper applies the orchestrator's rule.
 */
export function resolveMainRoot({ cwd, git }) {
  if (active('paths.helperRefusesLinkedWorktree')) return resolveRepoRoot({ cwd, git });
  const top = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  if (!top) throw new PathError('not-a-repository', cwd);
  const porcelain = git(['worktree', 'list', '--porcelain'], { cwd: top });
  const first = porcelain.split('\n').find((l) => l.startsWith('worktree '));
  const main = first ? first.slice('worktree '.length).trim() : null;
  if (!main) throw new PathError('not-a-repository', `${top}: no main worktree`);
  return main;
}

/** A fleet run id as a path fragment: one segment of [A-Za-z0-9._-], never empty, never a dot-name. */
export function validateRunId(id) {
  const v = String(id ?? '');
  // Mutation seam `paths.acceptAnyRunId`: the fleet run id is used as a path fragment unchecked.
  if (active('paths.acceptAnyRunId')) return v;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) || v === '.' || v === '..') throw new PathError('bad-run-id', `fleet run id ${JSON.stringify(v)} is not a safe path fragment`);
  return v;
}

/** Every path the autopilot derives, rooted at REPO_ROOT. */
export function autopilotPaths(repoRoot) {
  const adlc = join(repoRoot, '.adlc');
  const runs = join(adlc, 'autopilot-runs');
  const p = {
    repoRoot,
    adlc,
    statusFile: join(adlc, 'autopilot-status.json'),
    lockDir: join(adlc, 'autopilot.lock'),
    runsDir: runs,
    netGit: join(runs, 'net.git'),
    knownHosts: join(adlc, 'autopilot-known_hosts'),
    worktreesDir: join(repoRoot, '.worktrees'),
    issueWorktree: (n) => join(repoRoot, '.worktrees', `autopilot-issue-${validateIssueNumber(n)}`),
    stagingWorktree: (n, token) => `${p.issueWorktree(n)}.creating-${token}`,
    retiringWorktree: (n, token) => `${p.issueWorktree(n)}.retiring-${token}`,
    runDir: (n) => join(runs, String(validateIssueNumber(n))),
    mirror: (n) => join(p.runDir(n), 'mirror.git'),
    gateMirror: (n) => join(p.runDir(n), 'gate.git'),
    gateDeps: (n) => join(p.runDir(n), 'gate-deps'),
    workerDeps: (n) => join(p.runDir(n), 'worker-deps'),
    npmCache: (n) => join(p.runDir(n), 'npm-cache'),
    record: (n) => join(runs, `${validateIssueNumber(n)}.json`),
    tombstone: (n) => join(runs, `${validateIssueNumber(n)}.tombstone.json`),
    attempts: (n) => join(runs, `${validateIssueNumber(n)}.attempts.json`),
    attemptsArchive: (n) => join(runs, `${validateIssueNumber(n)}.attempts.archive.jsonl`),
    attemptsJournal: (n) => join(runs, `${validateIssueNumber(n)}.attempts.reset.journal`),
    findingsLedger: (n) => join(runs, `${validateIssueNumber(n)}.findings.jsonl`),
    triageCriteria: (n) => join(runs, `${validateIssueNumber(n)}-ac.md`),
    // `fleet-<id>.json`: never `<digits>.json` (an issue record), and the id is validated — it comes from
    // fleet's result document, never trusted as a path fragment (codex r9 A1/B4).
    fleetResult: (runId) => join(runs, `fleet-${validateRunId(runId)}.json`),
    preflightWorktree: (oid) => join(runs, `preflight-${validateOid(oid)}`),
    sshDir: (token) => join(runs, `ssh-${token}`),
    issueAdlc: (n) => join(p.issueWorktree(n), '.adlc'),
    issueTickets: (n) => join(p.issueWorktree(n), '.adlc', 'tickets'),
    issueSpecs: (n) => join(p.issueWorktree(n), '.adlc', 'specs'),
  };
  return p;
}

/** Assert a constructed path resolves under REPO_ROOT (AC 73's realpath rule). */
export function assertUnderRepo(repoRoot, components, opts) {
  return underRoot(repoRoot, components, opts);
}

export { isUnder };
