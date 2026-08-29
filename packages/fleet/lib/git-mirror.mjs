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
import { existsSync, realpathSync, readdirSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';

export const FETCHED_REF_PREFIX = 'refs/fleet/fetched/';

/** The "ref must not exist yet" old-value for `git update-ref` (works for SHA-1 and SHA-256 repos). */
/** The null object id of the repository's object format: as wide as the tip it guards (40 for SHA-1, 64 for SHA-256). */
export const zeroOidFor = (oid) => '0'.repeat(String(oid).length);
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
/**
 * The only config keys a disposable mirror ever carries (the bare-repository boilerplate).
 * The worker has read-write access to the mirror's git directory in mirror mode, and the
 * HOST later runs git inside it (worktree add/remove/prune, fetch): a `core.fsmonitor`,
 * `core.hooksPath`, `filter.*.smudge`, `core.sshCommand`, `include.path`, … planted in that
 * config would execute as the host user. A positive allowlist, never a deny-list (codex r14 #1).
 */
export const MIRROR_CONFIG_ALLOWED_KEYS = Object.freeze([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks',
]);

/** Host git invocations INSIDE the mirror carry these, whatever the mirror's own config says. */
export const HOST_SAFE_GIT_FLAGS = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=/bin/false']);

/**
 * Refuse a mirror whose `config` carries any key outside the allowlist, any `config.worktree`
 * under `worktrees/`, or any live hook. Reads the config as a FILE (`git config --file`), which
 * never consults hooks or fsmonitor, so this check is safe to run on a poisoned mirror.
 */
export function assertMirrorConfigPristine({ mirror, gitAt = defaultGit } = {}) {
  requireArgs('assertMirrorConfigPristine', { mirror }, ['mirror']);
  const git = gitAt(mirror);
  const configPath = join(mirror, 'config');
  let listing = '';
  if (existsSync(configPath)) {
    // `--file` reads ONLY that file; the host-safe overrides ride along so even this read never honours the mirror's own directives.
    try { listing = git(...HOST_SAFE_GIT_FLAGS, 'config', '--file', configPath, '--list', '--name-only'); }
    catch (e) { throw new Error(`mirror ${mirror} config is unreadable (${errorText(e)}): the mirror is refused`); }
  }
  const keys = listing.split('\n').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const foreign = keys.filter((k) => !MIRROR_CONFIG_ALLOWED_KEYS.includes(k));
  if (foreign.length) throw new Error(`mirror ${mirror} is poisoned: config carries ${foreign.join(', ')} (a disposable mirror sets only ${MIRROR_CONFIG_ALLOWED_KEYS.join(', ')})`);
  const worktreesDir = join(mirror, 'worktrees');
  if (existsSync(worktreesDir)) {
    for (const w of readdirSync(worktreesDir)) if (existsSync(join(worktreesDir, w, 'config.worktree'))) throw new Error(`mirror ${mirror} is poisoned: worktrees/${w}/config.worktree exists`);
  }
  const hooksDir = join(mirror, 'hooks');
  const liveHooks = existsSync(hooksDir) ? readdirSync(hooksDir).filter((f) => !f.endsWith('.sample')) : [];
  if (liveHooks.length) throw new Error(`mirror ${mirror} is poisoned: live hooks (${liveHooks.join(', ')})`);
  return { keys };
}

/**
 * A linked worktree's `.git` is a FILE the worker can rewrite (`gitdir: /anything`), which would make
 * the host's next git command inside the worktree honour a git directory of the worker's choosing.
 * Before the host runs git there, the link must be a regular file naming a directory under
 * `<gitDirRoot>/worktrees/` (the mirror, or the caller repository's .git) — codex r15 #1.
 */
export function assertWorktreeLink({ path, gitDirRoot } = {}) {
  requireArgs('assertWorktreeLink', { path, gitDirRoot }, ['path', 'gitDirRoot']);
  const link = join(path, '.git');
  let st;
  try { st = lstatSync(link); } catch (e) { throw new Error(`worktree ${path}: .git is missing (${errorText(e)}); refusing to run git there`); }
  if (!st.isFile()) throw new Error(`worktree ${path}: .git is not a regular file; refusing to run git there`);
  const text = readFileSync(link, 'utf8').trim();
  const m = /^gitdir:\s*(.+)$/.exec(text);
  if (!m) throw new Error(`worktree ${path}: .git does not name a gitdir; refusing to run git there`);
  const target = isAbsolute(m[1]) ? m[1] : resolve(path, m[1]);
  let real; let rootReal;
  try { real = realpathSync(target); rootReal = realpathSync(join(gitDirRoot, 'worktrees')); } catch (e) { throw new Error(`worktree ${path}: gitdir ${target} is unreadable (${errorText(e)})`); }
  if (real !== rootReal && !real.startsWith(rootReal + '/')) throw new Error(`worktree ${path}: .git points at ${real}, outside ${rootReal}; refusing to run git there`);
  // A SIBLING worktree's gitdir is also under the root: the gitdir's own back-pointer (`<gitdir>/gitdir`
  // names `<worktree>/.git`) must resolve to THIS worktree (codex r18 #2).
  let back = null;
  try { back = readFileSync(join(real, 'gitdir'), 'utf8').trim(); } catch { back = null; }
  if (!back) throw new Error(`worktree ${path}: gitdir ${real} has no back-pointer; refusing to run git there`);
  let backReal = null; let pathReal = null;
  try { backReal = realpathSync(dirname(back)); pathReal = realpathSync(path); } catch { backReal = null; }
  if (backReal === null || backReal !== pathReal) throw new Error(`worktree ${path}: .git points at ${real}, which belongs to ${back}; refusing to run git there`);
  // The gitdir's `commondir` (writable by the worker) must still name the expected root: a rewritten
  // commondir would make host git use another repository's objects, refs and config (codex r21 #2).
  let common = null;
  try { common = readFileSync(join(real, 'commondir'), 'utf8').trim(); } catch { common = null; }
  if (!common) throw new Error(`worktree ${path}: gitdir ${real} has no commondir; refusing to run git there`);
  let commonReal = null;
  try { commonReal = realpathSync(resolve(real, common)); } catch { commonReal = null; }
  if (commonReal === null || commonReal !== realpathSync(gitDirRoot)) throw new Error(`worktree ${path}: commondir ${common} resolves to ${commonReal ?? '?'}, not ${gitDirRoot}; refusing to run git there`);
  return { gitdir: real, commondir: commonReal };
}

export function assertBareMirror({ mirror, gitAt = defaultGit } = {}) {
  requireArgs('assertBareMirror', { mirror }, ['mirror']);
  // The config is vetted BEFORE any other host git runs inside the mirror (a worker had it
  // read-write), and every probe carries the host-safe overrides regardless (agy fleet r8 c2).
  assertMirrorConfigPristine({ mirror, gitAt });
  const git = (...args) => gitAt(mirror)(...HOST_SAFE_GIT_FLAGS, ...args);
  let bare;
  try { bare = git('rev-parse', '--is-bare-repository'); }
  catch (e) { throw new Error(`mirror ${mirror} is not a git repository: ${errorText(e)}`); }
  if (bare !== 'true') {
    throw new Error(`mirror ${mirror} is not a bare repository (rev-parse --is-bare-repository printed ${JSON.stringify(bare)})`);
  }
  const branches = listRefs(git, 'refs/heads/').map((r) => r.refname.slice('refs/heads/'.length));
  // The disposable-mirror contract (codex r8): ONE base branch plus this run's
  // `fleet/*` worker branches, no remotes, no live hooks. Anything else is a
  // general-purpose repository the model worker must never get read-write.
  const base = branches.filter((b) => !b.startsWith('fleet/'));
  if (base.length !== 1) throw new Error(`mirror ${mirror} must carry exactly one base branch (found ${base.length}: ${branches.join(', ') || 'none'})`);
  const remotes = (() => { try { return git('remote').split('\n').filter(Boolean); } catch { return []; } })();
  if (remotes.length) throw new Error(`mirror ${mirror} carries remotes (${remotes.join(', ')}); a disposable mirror has none`);
  const hooksDir = join(mirror, 'hooks');
  const liveHooks = existsSync(hooksDir) ? readdirSync(hooksDir).filter((f) => !f.endsWith('.sample')) : [];
  if (liveHooks.length) throw new Error(`mirror ${mirror} carries hooks (${liveHooks.join(', ')}); a disposable mirror has none`);
  return { branches, baseBranch: base[0] };
}

/**
 * Bring the mirror's base branch to `tip` from the caller repository when the
 * mirror does not yet hold it (an integration merge advanced the tip since the
 * mirror was cut) — a local-path fetch of exactly that ref, fast-forward only.
 */
export function refreshMirrorTip({ mirror, repo, baseBranch, sourceRef, tip, gitAt = defaultGit } = {}) {
  requireArgs('refreshMirrorTip', { mirror, repo, baseBranch, sourceRef, tip }, ['mirror', 'repo', 'baseBranch', 'sourceRef', 'tip']);
  requireOid('refreshMirrorTip', 'tip', tip);
  const git = gitAt(mirror);
  try { git('cat-file', '-e', `${tip}^{commit}`); return { refreshed: false }; } catch { /* not held yet */ }
  git(...HOST_SAFE_GIT_FLAGS, 'fetch', '-q', '--no-tags', repo, `refs/heads/${sourceRef}:refs/heads/${baseBranch}`);
  try { git('cat-file', '-e', `${tip}^{commit}`); } catch (e) { throw new Error(`mirror ${mirror} still lacks ${tip} after refreshing ${baseBranch} from ${sourceRef}: ${errorText(e)}`); }
  return { refreshed: true };
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
  git('update-ref', ref, cutTip, zeroOidFor(cutTip));
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
  try { git(...HOST_SAFE_GIT_FLAGS, 'worktree', 'remove', '--force', path); } catch { /* not a registered worktree */ }
  try { git(...HOST_SAFE_GIT_FLAGS, 'worktree', 'prune'); } catch { /* best effort */ }
  try { git('branch', '-D', workerBranch); } catch { /* no stale branch */ }
  git(...HOST_SAFE_GIT_FLAGS, 'worktree', 'add', '-b', workerBranch, path, cutTip);
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

  // The mirror's objects are worker-written: every object received is fsck'd (codex r22 #2).
  try { git('-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', mirror, `+refs/heads/${workerBranch}:${tmpRef}`); }
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

/**
 * The worktrees (other than `except`) that have `refs/heads/<branch>` checked out, from
 * `git worktree list --porcelain` (`worktree <path>` … `branch <ref>` stanzas). Moving a
 * branch pointer under a live worktree leaves its index and tree behind HEAD (codex r24 #3).
 */
export function worktreesHoldingBranch({ repo, branch, except = null, gitAt = defaultGit } = {}) {
  requireArgs('worktreesHoldingBranch', { repo, branch }, ['repo', 'branch']);
  const listing = gitAt(repo)('worktree', 'list', '--porcelain');
  const exceptReal = except && existsSync(except) ? realpathSync(except) : null;
  const holders = [];
  let current = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch ') && current !== null) {
      if (line.slice('branch '.length) === `refs/heads/${branch}`) {
        let real = current; try { real = realpathSync(current); } catch { /* keep the listed path */ }
        if (!exceptReal || real !== exceptReal) holders.push(current);
      }
    } else if (line === '') current = null;
  }
  return holders;
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
  try { git(...HOST_SAFE_GIT_FLAGS, 'worktree', 'remove', '--force', path); } catch { /* already gone or never registered */ }
  try { git(...HOST_SAFE_GIT_FLAGS, 'worktree', 'prune'); } catch { /* best effort */ }
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
