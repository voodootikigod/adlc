// The BOUNDED model-plane profile (issue-autopilot spec §6.4 "Sandbox contract",
// §14 items 11 and 14; fleet ticket AC12).
//
// `lib/sandbox.mjs` is a frozen rail and its model-plane profile is `--ro-bind / /`
// with the write roots layered on top: the whole host is READABLE. That is the
// documented residual the autopilot cannot accept — the worker would see
// `.env.local`, other checkouts, `~/.ssh`, the orchestrator's state and the
// shared git database. This module expresses the profile sandbox.mjs cannot:
//
//   - NO root bind. Everything readable is an explicit `--ro-bind` of a fixed
//     system root or of a single pinned FILE (never the file's parent directory).
//   - a private empty tmpfs at `/tmp`, with TMPDIR/TMP/TEMP pointing inside it.
//   - a synthetic HOME: a tmpfs at the host HOME path, with exactly the enumerated
//     read-only leaves (credential copy, generated settings, plugin tree) and the
//     harness's scratch directories created EMPTY inside it. The operator's real
//     HOME is never bound, so `~/.ssh` is ENOENT rather than denied.
//
// Only bubblewrap can express this (tmpfs + per-file binds + mount ordering), so
// the class FAILS CLOSED on any other backend rather than approximating.
//
// bwrap applies mounts in ARGV ORDER and a later mount shadows whatever it covers,
// so the order emitted by `buildBoundedModelPlaneArgv` is the policy — see the
// comment block inside it.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * The fixed system roots (spec §6.4 INVARIANT). Bound WHOLE; a pinned executable
 * that lives under one of them (`/usr/bin/git`) needs no separate bind.
 */
export const SYSTEM_ROOTS = Object.freeze(['/usr', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts']);

/** The private tmp root. A caller-supplied TMPDIR must live under it. */
export const PRIVATE_TMP = '/tmp';

const norm = (p) => resolve(String(p));
const isUnder = (root, path) => path === root || path.startsWith(root + sep);
const isStrictAncestor = (root, path) => path !== root && path.startsWith(root + sep);
const dedupe = (paths) => [...new Set(paths.map(norm))];

function defaultIsFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * How a read-only entry is bound. A SYSTEM_ROOT is bound whole; a regular file is
 * bound as a SINGLE FILE (`--ro-bind file file`), never its parent directory — the
 * property that keeps `~/.local/bin/claude` from exposing `~/.local/bin`.
 */
export function classifyReadOnlyEntry(path, { isFile = defaultIsFile } = {}) {
  const p = norm(path);
  if (SYSTEM_ROOTS.includes(p)) return 'system-root';
  return isFile(p) ? 'file' : 'directory';
}

const bindTargets = (homeBinds) => homeBinds.map((b) => norm(typeof b === 'string' ? b : b?.target));

/**
 * Spec §6.4 INVARIANT over a proposed read set — PURE (no fs), so the orchestrator
 * can check it before dispatch and fleet can assert it in its `--json` echo.
 *
 *   - no read-only entry equals or is an ancestor of a writable root, `home`, or `/tmp`;
 *   - a read-only path INSIDE a writable root is a violation, except (a) the
 *     enumerated `homeBinds` leaves — each of which must lie under `home` and be an
 *     ancestor of no scratch directory — and (b) under `home` ONLY, a single-FILE
 *     bind that `isFile` attests and that covers no scratch directory. (b) exists
 *     because the spec's own examples collide: a pinned `~/.local/bin/claude` is
 *     under `$HOME`, and the synthetic HOME tmpfs is mounted AT `$HOME`. A file
 *     leaf inside the tmpfs exposes one file; a directory there would shadow the
 *     scratch dirs, so directories and un-attested entries stay violations;
 *   - an entry under a SYSTEM_ROOT that is itself in the set is REDUNDANT (reported,
 *     droppable, not a violation);
 *   - an entry that is a strict ancestor of another non-system entry is a violation
 *     (it exposes the sibling's parent directory);
 *   - with an `isFile` predicate, a DIRECTORY entry that is neither a system root nor
 *     one of `allowedDirs` (the npm/corepack trees) is a violation — "no other
 *     directory bind is permitted".
 *
 * Duplicate entries are collapsed before any rule runs.
 */
export function checkReadSetInvariant({
  readOnlyPaths = [], writableRoots = [], home, homeBinds = [], homeScratchDirs = [],
  allowedDirs = [], isFile = null,
} = {}) {
  const violations = [];
  const redundant = [];
  const ro = dedupe(readOnlyPaths);
  const writable = dedupe([...writableRoots, ...(home ? [home] : []), PRIVATE_TMP]);
  const homeN = home ? norm(home) : null;
  const leaves = bindTargets(homeBinds);
  const scratch = dedupe(homeScratchDirs);
  const allowed = dedupe(allowedDirs);
  const roots = SYSTEM_ROOTS.filter((r) => ro.includes(r));

  for (const p of ro) {
    for (const w of writable) {
      if (isUnder(p, w)) violations.push(`read-only entry ${p} equals or is an ancestor of writable root ${w}`);
    }
    const coveringRoot = roots.find((r) => isStrictAncestor(r, p));
    if (coveringRoot) { redundant.push(`${p} is already covered by system root ${coveringRoot}`); continue; }
    const insideWritable = writable.find((w) => isStrictAncestor(w, p));
    if (insideWritable && !leaves.includes(p)) {
      const attestedFileLeaf = insideWritable === homeN && typeof isFile === 'function' && isFile(p)
        && !scratch.some((s) => isUnder(p, s));
      if (!attestedFileLeaf) {
        violations.push(`read-only entry ${p} lies inside writable root ${insideWritable} and is not an enumerated home bind`);
      }
    }
    const coveringAllowed = allowed.find((a) => isStrictAncestor(a, p));
    if (coveringAllowed) { redundant.push(`${p} is already covered by allowed tree ${coveringAllowed}`); continue; }
    if (SYSTEM_ROOTS.includes(p) || allowed.includes(p)) continue;
    const child = ro.find((q) => isStrictAncestor(p, q));
    if (child) violations.push(`read-only entry ${p} is a directory bind exposing the parent of ${child}`);
    else if (isFile && !isFile(p)) {
      violations.push(`read-only entry ${p} is a directory bind; only system roots, single-file binds and allowed trees are permitted`);
    }
  }

  for (const t of leaves) {
    if (!homeN || !isStrictAncestor(homeN, t)) violations.push(`home bind ${t} is not under the synthetic HOME ${homeN}`);
    const covered = scratch.find((s) => isUnder(t, s));
    if (covered) violations.push(`home bind ${t} equals or is an ancestor of scratch directory ${covered}`);
  }
  return { ok: violations.length === 0, violations, redundant };
}

const under = (root, path, what) => {
  const p = norm(path);
  if (!isStrictAncestor(norm(root), p)) throw new Error(`${what} ${p} is not under ${norm(root)}`);
  return p;
};

/**
 * Assemble the bwrap argv for one bounded model-plane run. Side-effect-free.
 *
 * MOUNT ORDER IS THE POLICY. bwrap performs mounts in argv order and a later
 * mount covers anything mounted beneath its path, so:
 *
 *   1. the two tmpfs mounts (`/tmp`, then HOME) go FIRST — a worktree under
 *      `/tmp` or a pinned `~/.local/bin/claude` bound before its tmpfs would be
 *      silently hidden by it;
 *   2. the scratch dirs are created inside the HOME tmpfs (empty, writable);
 *   3. the read-only entries, each bound AS GIVEN (a file as that file);
 *   4. the writable roots;
 *   5. the enumerated read-only HOME leaves, then the writable HOME files —
 *      layered INSIDE the tmpfs, so a write to a leaf fails EROFS while the
 *      tmpfs around it stays writable;
 *   6. environment: TMPDIR/TMP/TEMP inside the private tmp, HOME at the tmpfs.
 *
 * There is deliberately NO `--ro-bind / /`.
 */
export function buildBoundedModelPlaneArgv({
  worktree, writableRoots = [], readOnlyPaths = [], home, homeBinds = [], homeWritableFiles = [],
  homeScratchDirs = [], tmpDir = `${PRIVATE_TMP}/fleet-tmp`, unshareNet = false, isFile = defaultIsFile,
} = {}, innerArgv = []) {
  if (!worktree) throw new Error('buildBoundedModelPlaneArgv: worktree is required');
  if (!home) throw new Error('buildBoundedModelPlaneArgv: home is required');
  const wt = norm(worktree);
  const homeN = norm(home);
  const tmp = under(PRIVATE_TMP, tmpDir, 'TMPDIR');

  // Own PID / IPC / UTS namespaces: `--proc /proc` is then the SANDBOX's procfs — the host's
  // processes (their cmdlines, environments, fds; same uid) are not visible (codex r20 #1).
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--chdir', wt, '--proc', '/proc', '--dev', '/dev'];
  if (unshareNet) args.push('--unshare-net');

  // 1. tmpfs mounts first (see the order note above). `--perms 0700` scopes the
  //    synthetic HOME to the invoking uid, as the spec states.
  args.push('--tmpfs', PRIVATE_TMP, '--dir', tmp);
  args.push('--perms', '0700', '--tmpfs', homeN);
  // 2. empty scratch dirs inside the HOME tmpfs — nothing from the host is bound here.
  for (const d of dedupe(homeScratchDirs)) args.push('--dir', under(homeN, d, 'scratch dir'));
  // 3. read-only entries, bound as given: a file entry is that one file.
  for (const p of dedupe(readOnlyPaths)) {
    classifyReadOnlyEntry(p, { isFile }); // classification is informational for bwrap: the bind syntax is identical
    args.push('--ro-bind', p, p);
  }
  // 4. writable roots.
  for (const rw of dedupe([wt, ...writableRoots])) args.push('--bind', rw, rw);
  // 5. the enumerated HOME leaves — read-only first, then the writable files.
  for (const b of homeBinds) args.push('--ro-bind', norm(b.source), under(homeN, b.target, 'home bind target'));
  for (const f of homeWritableFiles) args.push('--bind', norm(f.source), under(homeN, f.target, 'home writable target'));
  // 6. environment.
  args.push('--setenv', 'TMPDIR', tmp, '--setenv', 'TMP', tmp, '--setenv', 'TEMP', tmp, '--setenv', 'HOME', homeN);
  return ['bwrap', ...args, '--', ...innerArgv];
}

/**
 * A resolved bounded sandbox for one run. Mirrors `Sandbox` in sandbox.mjs
 * (`wrap`, `run`, `canRead`, `canWrite`, `networkAllowed`) and adds `describe()`,
 * the object fleet's `--json` echoes so the orchestrator can assert the policy.
 *
 * Refuses any backend but bubblewrap: Seatbelt has no tmpfs or per-file bind
 * primitive, and a profile that only approximated this contract would be the
 * thing tests trust while the OS enforces something weaker.
 */
export class BoundedModelSandbox {
  constructor({
    backend, worktree, writableRoots = [], readOnlyPaths = [], home, homeBinds = [], homeWritableFiles = [],
    homeScratchDirs = [], tmpDir = `${PRIVATE_TMP}/fleet-tmp`, unshareNet = false, exec, isFile = defaultIsFile, commandMap = {},
  } = {}) {
    if (backend?.name !== 'bubblewrap') {
      throw new Error(`bounded model plane requires bubblewrap (got ${backend?.name ?? 'no backend'})`);
    }
    this.backend = backend;
    this.worktree = norm(worktree);
    this.writableRoots = dedupe(writableRoots);
    this.readOnlyPaths = dedupe(readOnlyPaths);
    this.home = norm(home);
    this.homeBinds = homeBinds;
    this.homeWritableFiles = homeWritableFiles;
    this.homeScratchDirs = dedupe(homeScratchDirs);
    this.tmpDir = tmpDir;
    this.unshareNet = unshareNet;
    this._exec = exec;
    // Bare command names the adapter invokes (`claude`) → the absolute realpath bound
    // read-only inside: with the host root absent and HOME a tmpfs, PATH lookup
    // inside the plane cannot find a HOME-installed executable (codex r5).
    this.commandMap = { ...commandMap };
    this._isFile = isFile;
    // Build once: a bad home bind or TMPDIR should fail at construction, not mid-dispatch.
    this.wrap([]);
  }

  get readPolicy() { return 'bounded'; }
  get networkAllowed() { return !this.unshareNet; }

  /** True if the profile exposes `path` for reading. */
  canRead(path) {
    const p = norm(path);
    const roots = [this.worktree, ...this.writableRoots, ...this.readOnlyPaths, this.home, PRIVATE_TMP];
    return roots.some((r) => isUnder(r, p));
  }

  /** True if the profile permits writing `path` (the read-only HOME leaves say no). */
  canWrite(path) {
    const p = norm(path);
    if (bindTargets(this.homeBinds).some((t) => isUnder(t, p))) return false;
    // A read-only entry inside HOME or the private tmp (an attested file leaf) is bound read-only
    // over the writable root; the predicate says so too (agy fleet r7 c1).
    if (this.readOnlyPaths.some((r) => isUnder(r, p))) return false;
    const roots = [this.worktree, ...this.writableRoots, this.home, PRIVATE_TMP, '/dev'];
    return roots.some((r) => isUnder(r, p));
  }

  /** A bare adapter command name → its bound absolute realpath; other argv untouched. */
  mapCommand(argv) {
    const [cmd, ...rest] = argv;
    return Object.hasOwn(this.commandMap, cmd) ? [this.commandMap[cmd], ...rest] : argv;
  }

  wrap(innerArgv) {
    const mapped = this.mapCommand(innerArgv);
    return buildBoundedModelPlaneArgv({
      worktree: this.worktree, writableRoots: this.writableRoots, readOnlyPaths: this.readOnlyPaths,
      home: this.home, homeBinds: this.homeBinds, homeWritableFiles: this.homeWritableFiles,
      homeScratchDirs: this.homeScratchDirs, tmpDir: this.tmpDir, unshareNet: this.unshareNet, isFile: this._isFile,
    }, mapped);
  }

  /** Execute `innerArgv` inside the sandbox; the whole option bag is forwarded (timeout, input, env). */
  async run(innerArgv, opts = {}) {
    const exec = this._exec ?? realExec;
    return await exec(this.wrap(innerArgv), { ...opts, cwd: opts.cwd ?? this.worktree });
  }

  /** The policy echo for `--json` (spec §6.4: readPolicy, privateTmp, homeBinds, egress). */
  describe() {
    return {
      readPolicy: 'bounded',
      privateTmp: true,
      readOnlyPaths: [...this.readOnlyPaths],
      writableRoots: [this.worktree, ...this.writableRoots],
      homeBinds: bindTargets(this.homeBinds),
      egress: this.unshareNet ? 'allowlist' : 'open',
    };
  }
}

function realExec(argv, opts) {
  const [cmd, ...rest] = argv;
  return execFileSync(cmd, rest, { ...opts, encoding: 'utf8' });
}
