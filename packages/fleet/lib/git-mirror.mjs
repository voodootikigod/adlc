// "mirror" git mode (spec §6.4 WRITABLE roots (b), §14 item 12, AC 84/106/108).
//
// The worker's nested worktree is cut from a CALLER-supplied bare mirror — the
// worker's ONLY git database: its objects, refs and worktree metadata land in the
// mirror and nowhere else, so the host `.git` (other branches, stashes, reflogs,
// credential config) is never reachable from inside the sandbox. After the worker
// exits, fleet brings the worker branch back into the caller repository with an
// explicit compare-and-swap sequence; from then on the gates, prosecution and
// merge operate on that branch in the caller repository exactly as in shared mode.
// The mirror is never read by any gate.
//
// Every git call goes through an injectable `gitAt(dir) => (...args) => stdout`
// runner (the `defaultGit` shape from worktrees.mjs: trimmed stdout, THROWS on a
// non-zero exit) so tests can drive real git and record/inject failures per step.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const FETCHED_REF_PREFIX = 'refs/fleet/fetched/';

/** The "ref must not exist yet" old-value for `git update-ref` (works for SHA-1 and SHA-256 repos). */
const ZERO_OID = '0'.repeat(40);
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function defaultGit(dir) {
  return (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function requireArgs(fn, args, names) {
  for (const name of names) {
    if (typeof args[name] !== 'string' || args[name] === '') {
      throw new TypeError(`${fn}: "${name}" is required (got ${JSON.stringify(args[name])})`);
    }
  }
}

/**
 * A compare-and-swap old value MUST be a resolved object id. A ref NAME is resolved by
 * git at swap time — to the ref's CURRENT value — so the swap would always succeed and
 * the guard would be inert (verified against git 2.53). Fail closed at the boundary.
 */
function requireOid(fn, name, value) {
  if (!FULL_OID.test(value)) {
    throw new TypeError(`${fn}: "${name}" must be a full commit object id, got ${JSON.stringify(value)}`);
  }
}

function requireAbsolute(fn, name, value) {
  if (!isAbsolute(value)) throw new TypeError(`${fn}: "${name}" must be an absolute path, got ${JSON.stringify(value)}`);
}

function errorText(e) {
  return String((e && (e.stderr || e.message)) || e).trim();
}

/** `for-each-ref` under a prefix as `[{ refname, sha }]` — empty when nothing matches, throws when not a repo. */
function listRefs(git, prefix) {
  const out = git('for-each-ref', '--format=%(refname) %(objectname)', ...(prefix ? [prefix] : []));
  return out.split('\n').filter(Boolean).map((line) => {
    const [refname, sha] = line.split(' ');
    return { refname, sha };
  });
}

/** Sha of exactly `fullRef`, or null when absent. Avoids exit-code parsing on the injected runner. */
function refSha(git, fullRef) {
  const hit = listRefs(git, fullRef).find((r) => r.refname === fullRef);
  return hit ? hit.sha : null;
}

/** Throws unless `mirror` is a bare repository; returns its branch names. */
export function assertBareMirror({ mirror, gitAt = defaultGit } = {}) {
  requireArgs('assertBareMirror', { mirror }, ['mirror']);
  const git = gitAt(mirror);
  let bare;
  try { bare = git('rev-parse', '--is-bare-repository'); }
  catch (e) { throw new Error(`mirror ${mirror} is not a git repository: ${errorText(e)}`); }
  if (bare !== 'true') {
    throw new Error(`mirror ${mirror} is not a bare repository (rev-parse --is-bare-repository printed ${JSON.stringify(bare)})`);
  }
  const branches = listRefs(git, 'refs/heads/').map((r) => r.refname.slice('refs/heads/'.length));
  return { branches };
}

/**
 * Make sure `refs/heads/<workerBranch>` exists in the caller repository at `cutTip`,
 * creating it with a zero-OID compare-and-swap (so a concurrent creation is a loud
 * failure, never a silent overwrite). An existing ref is returned untouched — the
 * later fetch-back CAS is what decides whether its value is still the cut tip.
 */
export function ensureWorkerBranchInRepo({ repo, workerBranch, cutTip, gitAt = defaultGit } = {}) {
  requireArgs('ensureWorkerBranchInRepo', { repo, workerBranch, cutTip }, ['repo', 'workerBranch', 'cutTip']);
  requireOid('ensureWorkerBranchInRepo', 'cutTip', cutTip);
  const git = gitAt(repo);
  const ref = `refs/heads/${workerBranch}`;
  const existing = refSha(git, ref);
  if (existing) return { created: false, sha: existing };
  git('update-ref', ref, cutTip, ZERO_OID);
  return { created: true, sha: cutTip };
}

/**
 * Cut the worker's worktree from the MIRROR (not the caller repository) at `cutTip`.
 * A stale worktree/branch of the same name from a previous strike is removed first.
 * The cut tip must already be an object the mirror holds: the mirror was cloned
 * single-branch from the caller, so any OID outside the issue branch's history is a
 * caller bug, reported by OID rather than as git's opaque "invalid reference".
 */
export function cutMirrorWorktree({ mirror, workerBranch, path, cutTip, gitAt = defaultGit } = {}) {
  requireArgs('cutMirrorWorktree', { mirror, workerBranch, path, cutTip }, ['mirror', 'workerBranch', 'path', 'cutTip']);
  requireOid('cutMirrorWorktree', 'cutTip', cutTip);
  requireAbsolute('cutMirrorWorktree', 'path', path);
  const git = gitAt(mirror);
  try { git('cat-file', '-e', `${cutTip}^{commit}`); }
  catch (e) {
    throw new Error(`cut tip ${cutTip} is not a commit the mirror ${mirror} holds (${errorText(e)}); ` +
      'the mirror carries only the pinned baseline and the issue branch');
  }
  try { git('worktree', 'remove', '--force', path); } catch { /* not a registered worktree */ }
  try { git('worktree', 'prune'); } catch { /* best effort */ }
  try { git('branch', '-D', workerBranch); } catch { /* no stale branch */ }
  git('worktree', 'add', '-b', workerBranch, path, cutTip);
  return { path, branch: workerBranch, startSha: cutTip };
}

/**
 * Bring the worker branch from the mirror into the caller repository. Exactly four
 * git steps, in order (spec §6.4): a bare `git fetch <mirror> <branch>` only updates
 * FETCH_HEAD, so (1) fetch into a temporary ref; (2) the worker's tip must DESCEND
 * from the tip fleet cut (a rewritten/orphaned branch is refused, not merged);
 * (3) compare-and-swap the branch ref against `cutTip` — the branch is never checked
 * out in the caller repository, so the ref is advanced directly, and a ref that moved
 * since the cut (a concurrent run, a human) fails the swap instead of being clobbered;
 * (4) delete the temporary ref.
 *
 * Never throws for a git failure: `{ ok:false, reason:'mirror-fetch-failed', step, detail }`
 * with the branch ref untouched and the temporary ref deleted (best effort). A failure
 * of step 4 alone rolls the swap back so the "ok:false ⇒ ref untouched" invariant holds.
 */
export function fetchBackWorkerBranch({ repo, mirror, workerBranch, cutTip, gitAt = defaultGit } = {}) {
  requireArgs('fetchBackWorkerBranch', { repo, mirror, workerBranch, cutTip }, ['repo', 'mirror', 'workerBranch', 'cutTip']);
  requireOid('fetchBackWorkerBranch', 'cutTip', cutTip);
  const git = gitAt(repo);
  const tmpRef = FETCHED_REF_PREFIX + workerBranch;
  const headRef = `refs/heads/${workerBranch}`;
  const dropTmp = () => { try { git('update-ref', '-d', tmpRef); } catch { /* best effort */ } };
  const failed = (step, e) => {
    dropTmp();
    return { ok: false, reason: 'mirror-fetch-failed', step, detail: `${step}: ${errorText(e)}` };
  };

  try { git('fetch', '--no-tags', mirror, `+refs/heads/${workerBranch}:${tmpRef}`); }
  catch (e) { return failed('fetch', e); }
  // The only read in the sequence: the fetched tip is the value returned on success and
  // the exact old-value a step-4 rollback must compare against, so it is taken once, here.
  let sha;
  try { sha = git('rev-parse', '--verify', `${tmpRef}^{commit}`); }
  catch (e) { return failed('resolve', e); }
  try { git('merge-base', '--is-ancestor', cutTip, tmpRef); }
  catch (e) { return failed('ancestry', e); }
  try { git('update-ref', headRef, tmpRef, cutTip); }
  catch (e) { return failed('cas', e); }
  try { git('update-ref', '-d', tmpRef); }
  catch (e) {
    // The swap landed but the temp ref lingers. Reporting failure while leaving the
    // branch advanced would strand the caller (a retry's CAS could never match cutTip
    // again), so undo the swap with the reverse CAS and report which of the two held.
    let rollback = 'rolled back';
    try { git('update-ref', headRef, cutTip, sha); }
    catch (r) { rollback = `ROLLBACK FAILED (${errorText(r)}); branch left at ${sha}`; }
    dropTmp();
    return { ok: false, reason: 'mirror-fetch-failed', step: 'cleanup', detail: `cleanup: ${errorText(e)}; ${rollback}` };
  }
  return { ok: true, sha };
}

function isWorktreeOf(repoGit, path) {
  if (!existsSync(path)) return false;
  const want = realpathSync(path);
  let listing;
  try { listing = repoGit('worktree', 'list', '--porcelain'); } catch { return false; }
  return listing.split('\n').some((line) => {
    if (!line.startsWith('worktree ')) return false;
    const p = line.slice('worktree '.length);
    try { return realpathSync(p) === want; } catch { return false; }
  });
}

/**
 * The caller-repository worktree the gates/prosecution/merge run in, on the fetched-back
 * worker branch. An existing worktree at `path` is REFRESHED rather than recreated:
 * detach first so that `reset --hard` can never move whichever branch the worktree
 * happened to be on (a previous ticket's), then reset to the worker tip and check the
 * branch out. Otherwise a new worktree is added; `worktree prune` first so a worktree
 * whose directory vanished cannot still "hold" the branch and block the checkout.
 */
export function ensureGateWorktree({ repo, path, workerBranch, gitAt = defaultGit } = {}) {
  requireArgs('ensureGateWorktree', { repo, path, workerBranch }, ['repo', 'path', 'workerBranch']);
  requireAbsolute('ensureGateWorktree', 'path', path);
  const repoGit = gitAt(repo);
  try { repoGit('worktree', 'prune'); } catch { /* best effort */ }
  if (isWorktreeOf(repoGit, path)) {
    const wt = gitAt(path);
    wt('checkout', '-q', '--detach');
    wt('reset', '-q', '--hard', workerBranch);
    wt('checkout', '-q', workerBranch);
    return { path };
  }
  repoGit('worktree', 'add', path, workerBranch);
  return { path };
}

/**
 * Detach the gate worktree so a later `update-ref` on the worker branch never targets a
 * checked-out branch (which would leave that worktree's index and tree behind HEAD).
 * A missing path is not an error — there is nothing to detach.
 */
export function detachGateWorktree({ path, gitAt = defaultGit } = {}) {
  requireArgs('detachGateWorktree', { path }, ['path']);
  if (!existsSync(path)) return { path, detached: false };
  gitAt(path)('checkout', '-q', '--detach');
  return { path, detached: true };
}

/** Remove the worker's mirror worktree and its registration; tolerant of it being gone already. */
export function removeMirrorWorktree({ mirror, path, gitAt = defaultGit } = {}) {
  requireArgs('removeMirrorWorktree', { mirror, path }, ['mirror', 'path']);
  const git = gitAt(mirror);
  try { git('worktree', 'remove', '--force', path); } catch { /* already gone or never registered */ }
  try { git('worktree', 'prune'); } catch { /* best effort */ }
  return { path, removed: !existsSync(path) };
}

/** Every ref the mirror holds (`for-each-ref --format=%(refname)`), for tests and forensics. */
export function mirrorRefs({ mirror, gitAt = defaultGit } = {}) {
  requireArgs('mirrorRefs', { mirror }, ['mirror']);
  return gitAt(mirror)('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
}

/** Absolute path of the worktree's shared git database (for asserting a worktree belongs to the mirror). */
export function gitCommonDir(path, gitAt = defaultGit) {
  return realpathSync(resolve(path, gitAt(path)('rev-parse', '--git-common-dir')));
}
