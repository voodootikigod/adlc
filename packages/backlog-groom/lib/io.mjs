/**
 * Filesystem wiring for the CLI, in lib so it can be tested.
 *
 * Left in the binary, these branches are only reachable by spawning the process
 * with a live `gh` behind it, so they go untested and a flipped guard — writing
 * the cache only when there is no cache, say — passes every suite.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseProfile } from './profile.mjs';

/** The profile schema version a bare, profile-less repo is treated as declaring. */
export const IMPLIED_SCHEMA_VERSION = 1;

/**
 * Load and validate the profile.
 *
 * A MISSING profile is not an error: the documented defaults are a complete,
 * conservative profile, and demanding the file would make the tool unusable on a
 * repo that has not adopted it. A MALFORMED one is an error — that is a
 * statement the operator made and got wrong.
 */
export function loadProfile(path, io = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = io;
  const raw = exists(path) ? JSON.parse(readFile(path)) : { schemaVersion: IMPLIED_SCHEMA_VERSION };
  return parseProfile(raw);
}

/**
 * Load the cache, or `{}`.
 *
 * A corrupt cache costs a slow run, never a wrong answer, so it degrades to
 * empty rather than throwing.
 */
export function loadCache(path, io = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = io;
  try {
    if (!exists(path)) return {};
    const parsed = JSON.parse(readFile(path));
    // A valid JSON PRIMITIVE is not a cache. `"bad"` and `7` are truthy and
    // parse cleanly, so a hand-edited or partially-replaced file would sail past
    // a truthiness check and then throw on the first assignment — crashing a run
    // that had a perfectly good answer to give.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Serialise a JSON artifact the way the rest of the repo writes them. */
export function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Persist the cache, returning a warning string rather than throwing.
 *
 * An unwritable cache must not fail a run that already produced its answer.
 */
export function saveCache(path, cache, io = {}) {
  if (!cache) return null;
  const { write = writeFileSync } = io;
  try {
    write(path, serialiseJson(cache));
    return null;
  } catch (err) {
    return `could not write the cache at ${path}: ${err.message}`;
  }
}

/**
 * The autonomy floor as it exists at the MERGE BASE with the default branch.
 *
 * §3.7/AC24: the comparison that makes the floor a floor is against the base,
 * not the checked-out file. The working copy is exactly what someone widening
 * the floor controls, so a check reading only the working copy validates the
 * attacker's own claim.
 *
 * Returns `null` when the base profile cannot be read — and `null` is NOT an
 * empty floor. `assertFloorNotWidened` refuses to act on a null base precisely
 * so that deleting the profile at the base cannot become the cheapest widening.
 *
 * @returns {string[]|null}
 */
/**
 * The head commit of the REMOTE's default branch, or null.
 *
 * THE BASELINE MUST NOT COME FROM A LOCAL REF (#1036). The floor is compared
 * against the profile at the merge base, so whoever picks the comparison point
 * decides the answer. `--base-ref` was removed because passing `HEAD` made the
 * merge base the working copy — a widened floor then compared equal to itself —
 * but reading `refs/remotes/origin/HEAD` or `origin/main` reproduced exactly
 * that with no flag: `git update-ref refs/remotes/origin/main HEAD` is a local
 * write, and this package's own e2e fixture does it to build a base.
 *
 * ONE QUESTION TO ONE REMOTE. `ls-remote --symref origin HEAD` answers with the
 * remote's own default branch and the commit it points at, over a single
 * connection:
 *
 *     ref: refs/heads/main<TAB>HEAD
 *     <sha><TAB>HEAD
 *
 * An earlier version asked the forge instead (`gh api repos/<owner>/<repo>`) and
 * resolved that branch name against `origin`. It needed a slug parsed out of the
 * remote URL, and it could not bind the two: `gh` answers from whatever host it
 * is configured for, so an SSH alias, an enterprise remote or a filesystem remote
 * had its branch name chosen by a DIFFERENT forge that happened to hold a
 * same-named repository. Asking the remote itself removes the slug, the host, the
 * forge dependency and that whole class of mismatch.
 *
 * Every failure returns null, which the floor guards turn into a refusal. There
 * is deliberately no fallback to a local ref: falling back would restore the hole
 * exactly when the remote could not contradict it.
 */
export function resolveRemoteBaseSha({ run = defaultGitRun } = {}) {
  let out;
  try {
    out = String(run(['ls-remote', '--symref', 'origin', 'HEAD']) ?? '');
  } catch {
    return null; // no origin, unreachable, or not a repository we can ask
  }

  // The sha line is the one whose ref is HEAD; the `ref:` line names the branch
  // and carries no sha. Matched rather than indexed, because git is free to emit
  // further symref lines above it.
  const sha = out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'HEAD')
    .map((parts) => parts[0])
    .find((candidate) => /^[0-9a-f]{40}$/.test(candidate));
  if (!sha) return null;

  // THE SHA MUST BE IN THE LOCAL OBJECT DATABASE, or `merge-base` cannot use it.
  // `ls-remote` answers with where the branch points NOW, which in any clone that
  // has not fetched recently is a commit this repository has never seen — so the
  // anchoring would refuse every run on an ordinary stale clone, which is a
  // refusal nobody can act on rather than a safety property. Fetching that one
  // commit is cheap and moves no ref: the baseline still comes from the remote's
  // answer, not from anything local.
  try {
    run(['cat-file', '-e', sha + '^{commit}']);
    return sha;
  } catch {
    // Not present — fetch it, then insist on it.
  }
  try {
    run(['fetch', '--quiet', 'origin', sha]);
  } catch {
    // A server that refuses a by-sha fetch still serves its default branch.
    try {
      run(['fetch', '--quiet', 'origin', 'HEAD']);
    } catch {
      return null;
    }
  }
  try {
    run(['cat-file', '-e', sha + '^{commit}']);
  } catch {
    return null; // still absent: the baseline cannot be read, so refuse
  }
  return sha;
}

export function baseProfileFromGit(profilePath, { run = defaultGitRun } = {}) {
  // Anchored to the remote, never to a local ref — see resolveRemoteBaseSha.
  const remoteSha = resolveRemoteBaseSha({ run });
  if (!remoteSha) return null;

  let mergeBase;
  try {
    mergeBase = String(run(['merge-base', 'HEAD', remoteSha])).trim();
  } catch {
    return null;
  }
  if (!mergeBase) return null;

  // REACHABLE FROM THE REMOTE HEAD, proven rather than assumed. A merge base is
  // only a trustworthy baseline if it is part of the history the remote actually
  // published; `--is-ancestor` exits non-zero when it is not.
  try {
    run(['merge-base', '--is-ancestor', mergeBase, remoteSha]);
  } catch {
    return null;
  }

  // ABSENCE IS PROVEN, not inferred from a failure. `git show` fails the same way
  // for "no such path" and for a corrupt object store or a bad revision, and
  // treating every failure as absence hands back the permissive default floor
  // exactly when the repository cannot be read.
  let present;
  try {
    present = String(run(['ls-tree', '--name-only', mergeBase, '--', profilePath])).trim() !== '';
  } catch {
    return null;
  }
  // The WHOLE default profile, not just the floor: the base supplies every
  // authorization term the write path compares against — reviewer and relabel
  // vocabulary included — and an absent profile's terms are the defaults.
  if (!present) return parseProfile({ schemaVersion: IMPLIED_SCHEMA_VERSION });

  let raw;
  try {
    raw = run(['show', `${mergeBase}:${profilePath}`]);
  } catch {
    // Listed as present but unreadable: genuinely unknown.
    return null;
  }

  try {
    return parseProfile(JSON.parse(raw));
  } catch {
    // PRESENT but unreadable is genuinely unknown, and distinct from absent: the
    // file may have declared a fuller floor than the default, so assuming the
    // default would under-detect a real widening.
    return null;
  }
}

/**
 * The environment child processes get: ours, minus the ledger signing key.
 *
 * A child that can read the key can mint its own approvals, which is the whole
 * authorization boundary. The apply path also deletes it from its own
 * environment, so this is the second of two locks on the same door — and the
 * cheap one, since every spawn in this module goes through here.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  return env;
}

/**
 * How long any child of this module may take.
 *
 * The baseline lookup runs `ls-remote` and sometimes `fetch` — network calls —
 * and the apply lock is already held when it does. An unbounded spawn waits
 * forever on a remote that accepts the connection and then stops answering, so
 * the run would hang holding the lock and every later apply would refuse behind
 * it. A timeout turns that into an ordinary refusal, which the floor guards
 * already know how to handle.
 */
export const CHILD_TIMEOUT_MS = 30_000;

/** The spawn options every child of this module gets: no key, and a bound. */
export function childRunOpts() {
  return {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // `stdio: 'pipe'` rather than a positional array: execFileSync's DEFAULT
    // writes the child's stderr to the parent's, so a profile simply absent at
    // the merge base — an ordinary, expected state — would print a fatal-looking
    // git error beside a run that succeeded. Specifying 'pipe' captures it.
    stdio: 'pipe',
    env: childEnv(),
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  };
}

function defaultGitRun(args) {
  return execFileSync('git', args, childRunOpts());
}

/**
 * Load the gate ledger — STRICTLY, unlike the cache.
 *
 * The cache degrades to empty on corruption because a lost cache costs a slow
 * run and never a wrong answer. The ledger is the opposite: it is the ONLY
 * record that a revision has already spent its one review, so a ledger that
 * degrades to `{}` degrades replay protection to nothing. Delete the file and
 * the same revision can be reviewed again, and again, until it approves.
 *
 * So: absent is a legitimate first run and yields `{}`. Present but unreadable
 * or malformed is an operational error, because it is indistinguishable from a
 * ledger someone removed on purpose.
 */
export function loadLedger(path, io = {}) {
  const { exists = existsSync, readFile = (p) => readFileSync(p, 'utf8') } = io;
  if (!exists(path)) return {};

  let parsed;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (err) {
    throw Object.assign(
      new Error(`backlog-groom: the gate ledger at ${path} exists but could not be read (${err.message}) — refusing to act, because an unreadable ledger cannot show a revision has already been reviewed`),
      { isOpError: true }
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Object.assign(
      new Error(`backlog-groom: the gate ledger at ${path} is not an object — refusing to act rather than treating it as empty`),
      { isOpError: true }
    );
  }
  return parsed;
}

/**
 * Persist the ledger, throwing on failure.
 *
 * Unlike the cache's warn-and-continue: a gate decision that could not be
 * written is a decision the next run will not see, so continuing would execute
 * against authorization nothing can later prove was spent.
 */
export function saveLedger(path, ledger, io = {}) {
  const { write = writeFileSync } = io;
  try {
    write(path, serialiseJson(ledger));
  } catch (err) {
    throw Object.assign(
      new Error(`backlog-groom: could not persist the gate ledger at ${path} (${err.message}) — refusing to act on authorization that cannot be recorded`),
      { isOpError: true }
    );
  }
}

/**
 * Take an exclusive lock for the apply transaction, or throw.
 *
 * `mkdir` is atomic, so exactly one process wins. Without it two runs starting
 * together both read a ledger with no entry for a revision, both obtain an
 * approval for it, and both comment and close the same issue — the one-shot rule
 * holding within a process and not across them.
 */
/** How long an owner-less lock may sit before it is presumed abandoned. */
export const STALE_LOCK_MS = 60 * 60 * 1000;

/** Identity and mtime of the lock directory, or null when it cannot be read. */
function lockStat(path, { stat = statSync } = {}) {
  try {
    const st = stat(path);
    return { ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * True when the directory at `claimed` is the lock that was judged stale.
 *
 * A lock with an owner is identified by its owner file, byte for byte — a fresh
 * holder writes a new pid and start time. An owner-less lock has nothing to
 * compare but the directory itself, so its inode and mtime must both match.
 */
function sameLock(claimed, judged, { read, io }) {
  let raw = null;
  try { raw = read(`${claimed}/owner.json`); } catch { /* absent */ }
  if (raw !== judged.ownerRaw) return false;
  if (judged.ownerRaw !== null) return true;
  const now = lockStat(claimed, io);
  return Boolean(now && judged.stat && now.ino === judged.stat.ino && now.mtimeMs === judged.stat.mtimeMs);
}

/** Age of the lock directory, or null when it cannot be determined. */
function lockAgeMs(path, { stat = statSync, now = Date.now } = {}) {
  try {
    return now() - stat(path).mtimeMs;
  } catch {
    return null;
  }
}

export function acquireApplyLock(path, io = {}) {
  const {
    mkdir = mkdirSync,
    rmdir = rmSync,
    write = writeFileSync,
    read = (p) => readFileSync(p, 'utf8'),
    alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    rename = renameSync,
    pid = process.pid,
  } = io;

  const ownerFile = `${path}/owner.json`;

  const take = () => {
    mkdir(path);
    // Owner metadata, so a lock left by a killed process can be told from one a
    // live process is holding. Without it a crash mid-run leaves a lock nobody
    // can safely clear: removing it might race a writer that is still going.
    try { write(ownerFile, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`); } catch { /* the lock still holds without it */ }
  };

  try {
    take();
  } catch (err) {
    let ownerRaw = null;
    try { ownerRaw = read(ownerFile); } catch { /* an unreadable owner is an unknown owner */ }
    let owner = null;
    try { owner = ownerRaw === null ? null : JSON.parse(ownerRaw); } catch { /* an unparseable owner is an unknown owner */ }
    // What was judged stale, so the claim below can prove it took THAT lock.
    const judged = { ownerRaw, stat: lockStat(path, io) };

    // An owner-less lock is normally treated as live — but a process killed
    // between `mkdir` and writing the metadata leaves one permanently, with
    // nothing to prove it is dead. After the TTL it is stale: a real run that
    // has held the lock this long has bigger problems than a second one.
    const ageMs = owner ? 0 : lockAgeMs(path, io);
    const expired = !owner && ageMs !== null && ageMs > STALE_LOCK_MS;

    // Otherwise an unknown owner stays LIVE. Guessing "dead" on a lock we cannot
    // read would let two writers run, which is the thing the lock exists to
    // prevent — the opposite failure to a stuck lock, and the worse one.
    if ((!owner && !expired) || (owner && alive(owner.pid))) {
      throw Object.assign(
        new Error(
          `backlog-groom: another apply run holds the lock at ${path}${owner ? ` (pid ${owner.pid}, since ${owner.startedAt})` : ''} — refusing to run two write transactions against one ledger`
        ),
        { isOpError: true }
      );
    }

    // The holder is gone — but CLEARING then retaking is not safe. Two recoverers
    // interleave: A removes and recreates, B removes A's NEW lock and recreates
    // it, and both proceed to mutate GitHub. Instead each recoverer tries to
    // RENAME the stale directory to a name only it knows. rename is atomic, so
    // exactly one succeeds and the losers get ENOENT and refuse.
    const claimed = `${path}.stale-${pid}-${Date.now()}`;
    try {
      rename(path, claimed);
    } catch (claimErr) {
      throw Object.assign(
        new Error(`backlog-groom: another run recovered the stale lock at ${path} first (${claimErr.code ?? claimErr.message})`),
        { isOpError: true }
      );
    }
    // The rename moves whatever is at the path NOW, which is only the lock judged
    // stale if nobody recovered it in between. A recoverer that lost that race has
    // just moved the WINNER's live lock, and clearing it would put two runs in one
    // transaction. So prove the claim before clearing it, and hand a lock that is
    // not the judged one straight back.
    if (!sameLock(claimed, judged, { read, io })) {
      try { rename(claimed, path); } catch { /* best effort: the holder's own release clears its path */ }
      throw Object.assign(
        new Error(`backlog-groom: another run recovered the stale lock at ${path} first — the lock now there is live, and was left in place`),
        { isOpError: true }
      );
    }
    try { rmdir(claimed, { recursive: true, force: true }); } catch { /* the claim is what mattered */ }

    try {
      take();
    } catch (retakeErr) {
      throw Object.assign(
        new Error(`backlog-groom: could not recover the stale lock at ${path} (${retakeErr.code ?? retakeErr.message}) — another run took it first`),
        { isOpError: true }
      );
    }
  }

  return () => {
    try { rmdir(path, { recursive: true, force: true }); } catch { /* releasing a lock must never mask the run's own error */ }
  };
}

/** Just the floor, for callers that only need that half. */
export function baseFloorFromGit(profilePath, opts = {}) {
  const base = baseProfileFromGit(profilePath, opts);
  return base ? base.autonomyFloor : null;
}
