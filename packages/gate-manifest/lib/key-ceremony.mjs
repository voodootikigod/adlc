// key-ceremony.mjs — generate a manifest-signing key and hand it off to the operator
// without ever writing it to stdout, stderr, or any log (spec:
// .adlc/specs/manifest-key-hermeticity.md, Layer 3, "the key is GENERATED, never
// accepted"). T-01KYQMPBQT6Z2H507VGRCFANWM (T3), slice B.
//
// This repo has already had the exact incident this design defends against — a key
// echoed into a session transcript (see scripts/block-secret-exposure.mjs's header) —
// so a ceremony that prints the key anywhere, even once, re-creates it as a designed-in
// step: agent harnesses and CI both capture stdout/stderr.
//
// THE HANDOFF: a mode-0600 file at an operator-chosen path OUTSIDE the repository. The
// PATH is printed; the CONTENTS never are. THE CUSTODY CHECKPOINT: before this ceremony
// is considered complete, the operator must re-enter the key with terminal echo
// disabled, proving it was actually captured (not merely printed to a file the operator
// never opened).
//
// Caller-supplied keys are refused on the normal path — the ceremony does not take a
// key at all, closing the offline-guessing-oracle risk of a published fingerprint for
// anything but a CSPRNG-generated key. Legacy import is a distinct, explicit,
// audited exception (see resolveCeremonyKey below). Full doctor-reporting of an
// exercised import is deferred to the slice that wires this into the adoption
// transaction — this slice establishes the refusal and the exception flag itself.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, fchmodSync, realpathSync, unlinkSync, fstatSync } from 'node:fs';
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { sha256, git, splitNulPaths } from '@adlc/core';
import { fsyncDirectory } from '@adlc/tickets/lib/durability.mjs';

/**
 * Removal of any extended ACL on `path`, using the platform's own tool (macOS
 * `chmod -N`, Linux `setfacl -b`) — POSIX mode bits alone do not confine a file when an
 * inherited ACL entry (a macOS ACE, an NFSv4/POSIX ACL) grants another principal access
 * independent of those bits. UNSUPPORTED PLATFORM OR MISSING TOOL (`ENOENT` — the
 * binary itself does not exist) is tolerated: there is nothing this call can do there,
 * so it silently does nothing and narrows (does not close) the exposure the mode-bit
 * check alone cannot see. Any OTHER failure — the tool exists but exits non-zero or
 * errors (permission denied, an unexpected filesystem condition) — is NOT tolerated and
 * is thrown: a present tool that fails to do its job would otherwise let the ceremony
 * report success while the file remains ACL-exposed, so the caller must treat that as
 * a real confinement failure, not a soft warning.
 * Still not verified either way afterward (no built-in Node API exposes ACL state, and
 * this codebase has no ACL-reading dependency) — a tool that exits 0 without actually
 * having removed a real entry would not be caught here.
 * `platform`/`exec` are injectable (test injection — this repo's CI runs one OS at a
 * time, so the platform branch not currently running on cannot otherwise be exercised).
 * Spawns `chmod`/`setfacl` with an environment stripped down to just `PATH` (needed for
 * the OS to resolve the command name at all) — NOT the caller's full `process.env`.
 * Without this, a legacy-import ceremony (where `ADLC_MANIFEST_KEY` is already present
 * in the environment before this ever runs) would hand the signing key straight to a
 * child process by default, in reach of anything that can read that child's
 * environment: a malicious `chmod`/`setfacl` shim earlier on PATH, or another local
 * account able to read `/proc/<pid>/environ`-equivalent process state. Neither tool
 * needs any OTHER inherited variable to do its job.
 *
 * Invoked by a TRUSTED ABSOLUTE PATH, not a bare command name resolved through the
 * caller's PATH: a PATH-resolved shim receives the handoff pathname as an argument and
 * could rename the underlying inode to a hidden capture location before creating a
 * decoy at the original path — this call's own fd-bound mode check (writeKeyHandoffFile
 * uses fstatSync/the open descriptor, not the pathname) would still pass, and the
 * secret write still lands correctly on the renamed inode via that same descriptor, but
 * the file the OPERATOR is told to read from would then be the attacker's decoy while
 * the real key sits at the attacker's hidden path. An absolute path is not resolved
 * through PATH at all, closing this specific redirection vector for
 * this specific subprocess (it does not address an attacker who can already write to
 * system binary directories — a materially higher bar than prepending to PATH).
 * @param {string} path
 * @param {{platform?: string, exec?: Function}} [options]
 */
const ACL_TOOL_PATHS = { darwin: '/bin/chmod', linux: '/usr/bin/setfacl' };

export function stripAclBestEffort(path, { platform = process.platform, exec = execFileSync } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return;
  const command = ACL_TOOL_PATHS[platform];
  const args = platform === 'darwin' ? ['-N', path] : ['-b', path];
  try {
    exec(command, args, { stdio: 'ignore', env: {} });
  } catch (err) {
    if (err.code === 'ENOENT') return; // the tool itself is not installed — nothing more we can do
    throw new Error(
      `ACL removal via \`${command}\` failed on ${path} (${err.message}) — refusing to hand off a key `
      + 'whose confinement could not be established rather than silently proceeding as if it had been',
    );
  }
}

// Resolve `path` through every symlink, INCLUDING when `path` itself does not exist yet
// (the common case for a handoff file about to be created): walk up to the deepest
// EXISTING ancestor, realpath THAT, then reattach the missing tail lexically (nothing
// further can be a symlink if it does not exist). Without this, a lexical resolve()
// alone is fooled by a symlinked tmpdir (macOS's /tmp -> /private/tmp is the textbook
// case): the repo root resolves through the symlink to /private/tmp/repo while an
// operator-chosen path built from $TMPDIR does not, so the two are compared as if they
// were unrelated trees even when one is genuinely inside the other.
export function realpathOfDeepestExisting(path) {
  let current = resolve(path);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw err; // reached the filesystem root, still missing
      tail.push(basename(current));
      current = parent;
    }
  }
}

export const KEY_BYTE_LENGTH = 32;
export const KEY_HEX_LENGTH = KEY_BYTE_LENGTH * 2; // 64 hex chars

/**
 * Generate a manifest-signing key: CSPRNG, 32 random bytes, hex-encoded (64 chars).
 * Entropy is an injectable, defaulted parameter — mirrors this codebase's own
 * ULID-generation convention (gate-manifest/lib/lineage.mjs's generateSegmentUlid) —
 * so the ceremony is deterministically testable without weakening the real path.
 * @param {Buffer} [entropy]
 * @returns {string} a 64-character lowercase hex string
 */
export function generateManifestKey(entropy = randomBytes(KEY_BYTE_LENGTH)) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== KEY_BYTE_LENGTH) {
    throw new TypeError(`manifest key entropy must be a ${KEY_BYTE_LENGTH}-byte Buffer`);
  }
  return entropy.toString('hex');
}

/**
 * The adoption record's `keyFingerprint`: sha256 of the EXACT UTF-8 bytes the
 * generator emitted — the same bytes `createHmac('sha256', key)` consumes as the key,
 * so there is no canonicalization gap between commitment and use.
 * @param {string} key
 * @returns {string} 64-character lowercase hex sha256 digest
 */
export function computeKeyFingerprint(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('cannot fingerprint an empty or non-string key');
  }
  return sha256(key);
}

/**
 * Every filesystem boundary that belongs to THIS repository's Git identity — not just
 * the current worktree's own top-level. A repository can have multiple LINKED
 * worktrees (`git worktree add`) that all share one underlying repository: writing the
 * handoff file into the primary checkout, or a sibling worktree, is exactly as
 * dangerous as writing it into the current one, since any of them can be staged and
 * committed by a concurrent session. Also includes the common `.git` directory itself
 * (`git rev-parse --git-common-dir`) — a handoff file placed there is invisible to
 * `git status` today but is not a boundary this ceremony should trust either.
 *
 * Parses `worktree list --porcelain -z`, NOT the newline-delimited default: a worktree
 * path is an arbitrary filesystem path and can itself contain a newline, so splitting
 * plain porcelain output on `\n` can silently truncate or misplace a path and drop it
 * from the boundary set. `-z` NUL-terminates each field with no escaping, and
 * splitNulPaths (this codebase's existing helper, `@adlc/core`, #249) splits on the raw
 * bytes before decoding and fails closed on anything that cannot round-trip through
 * UTF-8 — the same aliasing risk a decode-then-split would reintroduce here.
 *
 * Both Git invocations run with `ADLC_MANIFEST_KEY` AND every `GIT_*`-prefixed
 * variable deleted from their environment (everything else in `process.env` is
 * preserved — `HOME` and the like are Git's ordinary dependencies, not something this
 * call has any business stripping). `ADLC_MANIFEST_KEY` matters because this
 * ceremony's own contract requires the signing key to already be present in the
 * environment during a legacy import (and it may still be exported during rotation) —
 * without stripping it, a PATH-resolved `git` shim would receive it by simple
 * environment inheritance, the same exposure class stripAclBestEffort closes for its
 * own subprocess. `GIT_*` matters even more: `GIT_DIR` and `GIT_WORK_TREE` override
 * which repository Git reports on ENTIRELY, independent of `cwd` — verified directly:
 * with `GIT_DIR` pointed at a second repository, both `rev-parse --git-common-dir`
 * and `worktree list` described ONLY that other repository, so without this
 * sanitization this function would have returned boundaries that never include the
 * real current repository at all, and a handoff path genuinely inside it would have
 * been accepted as "outside" — the actual bypass this function exists to prevent, not
 * a defense-in-depth nicety.
 *
 * As a second, independent check (belt-and-suspenders against exactly this class of
 * poisoning, in case some future Git selector this function doesn't yet know to strip
 * has the same effect): the returned roots MUST contain `cwd` itself. If Git's answer
 * does not describe the caller's own directory at all, something is deeply wrong with
 * repository selection and the answer cannot be trusted as a boundary set — this fails
 * closed rather than silently handing back roots for a repository the caller never
 * asked about.
 * @param {{cwd?: string, git?: Function}} [options]  git: override for @adlc/core's git() (test injection, for the fail-closed self-check)
 * @returns {string[]}
 */
function sanitizedGitEnv() {
  const sanitized = { ...process.env };
  delete sanitized.ADLC_MANIFEST_KEY;
  for (const name of Object.keys(sanitized)) {
    if (name.startsWith('GIT_')) delete sanitized[name];
  }
  return sanitized;
}

export function repoBoundaryRoots({ cwd = process.cwd(), git: gitFn = git } = {}) {
  const env = sanitizedGitEnv();
  const commonDirRaw = gitFn(['rev-parse', '--git-common-dir'], { cwd, env }).trim();
  const commonDir = resolve(cwd, commonDirRaw);
  const worktreeListRaw = gitFn(['worktree', 'list', '--porcelain', '-z'], { cwd, env, encoding: null });
  const roots = [commonDir];
  for (const field of splitNulPaths(worktreeListRaw)) {
    if (field.startsWith('worktree ')) roots.push(field.slice('worktree '.length));
  }
  const resolvedCwd = realpathOfDeepestExisting(cwd);
  const describesCwd = roots.some((root) => {
    const resolvedRoot = realpathOfDeepestExisting(root);
    const rel = relative(resolvedRoot, resolvedCwd);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  if (!describesCwd) {
    throw new Error(
      `git reported repository boundaries that do not contain the current directory (${cwd}) — refusing to `
      + 'trust a repository-selection answer that appears to describe a different repository entirely '
      + '(e.g. via GIT_DIR/GIT_WORK_TREE)',
    );
  }
  return roots;
}

/**
 * Refuse a handoff path that resolves inside ANY repository boundary (repoBoundaryRoots
 * — every linked worktree, the primary checkout, and the common .git directory, not
 * just the current worktree) — committing the key handoff file, even accidentally (an
 * editor swap file, a build artifact scan, a misconfigured backup, a concurrent session
 * in a sibling worktree), would defeat the entire point of keeping it OUTSIDE every tree
 * under review. Resolves every path (symlink-following) before comparing, so a
 * symlinked checkout or a `..`-relative handoff path cannot slip past a naive
 * string-prefix check.
 * @param {string} path  the operator-chosen handoff path
 * @param {{roots?: string[]}} [options]  roots: override for repoBoundaryRoots() (test injection)
 */
export function assertHandoffPathOutsideRepo(path, { roots = repoBoundaryRoots() } = {}) {
  const resolvedPath = realpathOfDeepestExisting(path);
  for (const root of roots) {
    const resolvedRoot = realpathOfDeepestExisting(root);
    const rel = relative(resolvedRoot, resolvedPath);
    const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    if (inside || resolvedPath === resolvedRoot) {
      throw new Error(`the key handoff path must be OUTSIDE the repository; ${path} resolves inside ${resolvedRoot}`);
    }
  }
}

/**
 * Write the key to a mode-0600 file at `path`, exclusive-create (refuses to overwrite
 * an existing file at that path — the operator chose it, and silently clobbering
 * whatever is already there would be a surprising, silent side effect). Refuses a
 * path inside the repository (assertHandoffPathOutsideRepo, checked against EVERY
 * linked worktree and the common .git directory, not just the current worktree). The
 * mode is asserted via an explicit fchmodSync BEFORE any secret byte is written, not
 * just openSync's mode argument, because that argument is subject to the process
 * umask — a permissive umask would silently widen the file beyond 0600 (mirrors
 * packages/rails-guard/lib/ci/bootstrap.mjs's identical two-step pattern for its own
 * restrictive-permission write, though that one chmods after its own non-secret write).
 * A short write is treated as a failure, not success: `writeSync` returns the number
 * of bytes actually written and a single call is not guaranteed to write the whole
 * buffer, so the loop below keeps writing until every byte lands before fsyncing. On
 * ANY failure after the exclusive create — a short-write loop error, fsync, chmod, or
 * the directory fsync — the just-created file is removed (best-effort) so a retry is
 * not permanently blocked by `EEXIST` against a partial or unusable secret. The file
 * content is `key + '\n'` (fingerprinting still uses `key` alone) so the documented
 * `read -r VAR < file` loader finds a line delimiter before EOF — without it `read`
 * returns nonzero and aborts the workflow under `set -e`. After chmod, the mode is
 * READ BACK and verified equal to 0600, not merely assumed — some filesystems accept a
 * chmod call without actually enforcing owner-only access.
 * Fails closed on win32: `chmodSync`/the `0o600` open mode there only toggle the
 * read-only attribute, not an owner-only ACL — the file actually inherits its parent
 * directory's permissions, so claiming "mode 0600" would be a false promise of
 * confinement for a signing key. Real Windows support needs an explicit, verified
 * owner-only DACL (out of scope for this slice); until then this refuses to run
 * rather than hand back a key file that looks restricted but is not.
 * RESIDUAL LIMITATION: assertHandoffPathOutsideRepo is a pathname check, not an open —
 * it inspects the repository boundary set and returns, without retaining any file
 * descriptor or lock for what it verified. A concurrent process registering a new
 * linked worktree (or retargeting an ancestor symlink) at the exact chosen path between
 * that check and this function's own openSync could in principle make a path validated
 * as "outside" resolve "inside" before the write happens. Fully closing that gap would
 * need every boundary check bound to the same opened inode via an openat-style,
 * fd-relative primitive — Node's `fs` module has none without a native addon, and this
 * is the same pathname-check-then-open shape (and the same gap) already documented on
 * @adlc/tickets's generation-descriptor.mjs (readAdoptionRecord) and this codebase's
 * other filesystem-boundary checks (forest.mjs, manifest-segments.mjs).
 * @param {string} path
 * @param {string} key
 * @param {{roots?: string[], stat?: Function, stripAcl?: Function}} [options]  stat: override for fstatSync (test injection, for the post-chmod mode-verification step) — called with the open FILE DESCRIPTOR, not the path. stripAcl: override for stripAclBestEffort (test injection)
 */
export function writeKeyHandoffFile(path, key, options = {}) {
  const { stat = fstatSync, stripAcl = stripAclBestEffort } = options;
  if (process.platform === 'win32') {
    throw new Error(
      'the key handoff ceremony is not supported on win32 yet: chmod/mode 0600 only toggles the '
      + 'read-only attribute there, not an owner-only ACL, so the file would NOT actually be '
      + 'confined to the current user — refusing rather than writing a secret behind a false sense '
      + 'of restricted permissions.',
    );
  }
  assertHandoffPathOutsideRepo(path, options);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(`refusing to overwrite an existing file at the handoff path: ${path}`);
    }
    throw err;
  }
  try {
    // Confine the (still EMPTY) file BEFORE a single secret byte is written — chmod,
    // ACL-strip, and mode verification all happen first, in that order. Doing this
    // AFTER writing would leave a window where the complete key sits in a file an
    // inherited ACL entry could still let another principal read, even though the
    // write is fsynced and closed a moment later.
    //
    // fchmodSync/fstatSync operate on the OPEN DESCRIPTOR, not the pathname — immune to
    // a path being replaced between these calls (the secret write below also goes
    // through this same `fd`, so even a pathname swap aimed at THIS step cannot divert
    // the actual key bytes to a different file). stripAclBestEffort still necessarily
    // takes a path (the external chmod -N/setfacl -b tools have no fd-argument form),
    // so it alone keeps the pathname-check-then-open TOCTOU already documented above.
    //
    // A window remains even with this ordering: on a filesystem where the CHOSEN
    // DIRECTORY carries an inheritable ACL entry, that ACE attaches to this file at the
    // moment openSync creates it — atomically, at the OS level, before this process
    // ever gets to run fchmodSync or stripAcl. A principal already granted access by
    // that inherited ACE could in principle open the file for reading during the
    // (small, but nonzero) interval between creation and stripAcl's external-process
    // call completing, and an already-open descriptor is not revoked by a later
    // chmod/ACL change. Closing this needs either an OS-native "create with no
    // inherited ACL" primitive (not exposed by Node's `fs` without a native addon) or
    // doing the ACL removal via a syscall instead of spawning an external process
    // (which would shrink the window's dominant cost, not eliminate the window).
    fchmodSync(fd, 0o600);
    // Narrow (not close) the inherited-ACL exposure — an ACE inherited from the chosen
    // directory's ancestry grants access independent of POSIX mode bits, so removing it
    // here is what actually reduces exposure. See stripAclBestEffort's doc comment for
    // exactly what this does and does not cover.
    stripAcl(path);
    // Verify the filesystem actually enforced the mode we just requested — chmod can
    // succeed as a no-op on filesystems that don't map POSIX permissions faithfully
    // (FAT/exFAT, some network mounts), which would otherwise let this command report
    // "mode 0600" over a file the OS never actually confined to the owner. This checks
    // the standard nine permission bits only; ownership and any ACL entry that survived
    // stripAclBestEffort (unsupported platform, missing tool, unsupported filesystem)
    // are NOT verified here — closing that residual gap needs an OS-native ACL-reading
    // mechanism this codebase does not have, the same category of limitation as the
    // win32 refusal above.
    const actualMode = stat(fd).mode & 0o777;
    if (actualMode !== 0o600) {
      throw new Error(
        `the filesystem at ${path} did not enforce mode 0600 (observed ${actualMode.toString(8)}) — `
        + 'refusing to hand off a key the OS cannot actually confine to the current user',
      );
    }
    // ONLY NOW does the secret itself get written. A trailing newline makes the file
    // line-oriented WITHOUT changing the key value itself: the fingerprint is computed
    // from `key` (never from file bytes), and `read -r` strips the delimiter it read
    // on, so the loaded env var is still exactly `key`. Without it, `read -r VAR < file`
    // hits EOF before finding a line delimiter and returns exit status 1 — under `set
    // -e` (the ordinary case for CI/maintenance scripts) that aborts the documented
    // loading snippet before export/delete/record ever run, verified against both bash
    // and zsh.
    const buffer = Buffer.from(`${key}\n`, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(resolve(path)));
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort; the write-side error is what matters */ }
    }
    try { unlinkSync(path); } catch { /* best-effort cleanup so a retry is not blocked by EEXIST */ }
    throw err;
  }
}

/**
 * Read one line from `input` with terminal echo DISABLED, for the custody checkpoint's
 * "re-enter the key" prompt. Refuses outright when either stream is not an interactive
 * TTY (a pipe would either hang forever or silently read unrelated data — this
 * checkpoint exists specifically to prove a HUMAN captured the key, which a non-TTY
 * context cannot demonstrate). Restores the terminal's prior raw-mode state on every
 * exit path — normal completion, Ctrl-C (a soft cancel: rejects the promise, does not
 * exit the process), SIGTERM/SIGHUP (restore-then-exit with the conventional 128+signal
 * code, preserving their normal termination semantics rather than suppressing them),
 * an `error`/`end`/`close` on either stream (a dropped SSH session or killed terminal
 * surfaces this way, not as a keystroke), or setup itself throwing (e.g. a synchronous
 * write failure on `output`) — so a cancelled, disconnected, terminated, or failed
 * ceremony never leaves the operator's shell with echo silently disabled. SIGKILL
 * cannot be caught by any process and is therefore unrecoverable by design.
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, prompt?: string, exit?: Function}} [options]  exit: override for process.exit (test injection, for the SIGTERM/SIGHUP path)
 * @returns {Promise<string>}
 */
export function readSecretLine({
  input = stdin,
  output = stdout,
  exit = process.exit.bind(process),
  prompt = 'Re-enter the generated key to confirm capture (input hidden): ',
} = {}) {
  return new Promise((resolvePromise, reject) => {
    if (input.isTTY !== true || output.isTTY !== true) {
      reject(new Error(
        'the custody checkpoint requires an interactive terminal (TTY) on both input and output — '
        + 'refusing to read a secret from a pipe, where no human confirmation is possible',
      ));
      return;
    }
    const wasRaw = input.isRaw === true;
    let value = '';
    let settled = false;
    let listenersAttached = false;

    // Best-effort: runs on EVERY exit path, including setup itself failing (the
    // try/catch below) — a throwing stream method must not leave raw mode enabled
    // with no listener ever registered to call restore() again.
    const teardown = () => {
      try { input.setRawMode(wasRaw); } catch { /* best-effort restore */ }
      try { input.pause(); } catch { /* best-effort */ }
      if (listenersAttached) {
        input.removeListener('data', onData);
        input.removeListener('error', onInputError);
        input.removeListener('end', onInputEnd);
        input.removeListener('close', onInputEnd);
        output.removeListener('error', onOutputError);
        output.removeListener('close', onOutputClose);
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGHUP', onSighup);
      }
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      teardown();
      try { output.write('\n'); } catch { /* best-effort; the settlement reason (fn) is what matters */ }
      fn();
    };
    const onSigint = () => settle(() => reject(new Error('custody checkpoint cancelled (Ctrl-C)')));
    // Unlike SIGINT (a soft cancel — the promise rejects, the process is left running so
    // the caller decides what happens next), SIGTERM/SIGHUP preserve their NORMAL exit
    // semantics: restore the terminal first, then actually exit with the conventional
    // 128+signal code. Registering a signal listener without exiting ourselves would
    // otherwise suppress the process's normal termination on that signal entirely, for
    // as long as this promise is pending.
    const onSigterm = () => { teardown(); exit(128 + 15); };
    const onSighup = () => { teardown(); exit(128 + 1); };
    // A closed terminal (SSH drop, killed session) surfaces as an 'error' or 'end'/'close'
    // on either stream rather than a normal keystroke — without these, the promise
    // never settles and raw mode is never restored.
    const onInputError = (err) => settle(() => reject(err));
    const onInputEnd = () => settle(() => reject(new Error(
      'custody checkpoint input ended before a value was entered — the terminal or session was likely closed',
    )));
    const onOutputError = (err) => settle(() => reject(err));
    const onOutputClose = () => settle(() => reject(new Error(
      'custody checkpoint output stream closed unexpectedly',
    )));
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { settle(() => resolvePromise(value)); return; }
        if (ch === '\u0003') { settle(() => reject(new Error('custody checkpoint cancelled (Ctrl-C)'))); return; }
        if (ch === '\u007f' || ch === '\b') { if (value.length > 0) value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    try {
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      output.write(prompt);
      input.on('data', onData);
      input.on('error', onInputError);
      input.on('end', onInputEnd);
      input.on('close', onInputEnd);
      output.on('error', onOutputError);
      output.on('close', onOutputClose);
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
      process.on('SIGHUP', onSighup);
      listenersAttached = true;
    } catch (err) {
      if (!settled) {
        settled = true;
        teardown();
        reject(err);
      }
    }
  });
}

/**
 * The custody checkpoint: the operator re-enters the generated key, proving it was
 * captured (not merely printed to a file never opened) BEFORE this ceremony is
 * considered complete. `readSecret` is injectable so this can be tested without a
 * real TTY — matching this codebase's own injectable-prompt convention
 * (packages/tickets/lib/prompt.mjs's `ask` parameter).
 * @param {string} expectedKey
 * @param {{input?, output?, readSecret?: Function}} [options]
 * @returns {Promise<true>}
 */
export async function confirmCustody(expectedKey, { input, output, readSecret = readSecretLine } = {}) {
  const entered = await readSecret({ input, output });
  const a = Buffer.from(entered, 'utf8');
  const b = Buffer.from(expectedKey, 'utf8');
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) {
    throw new Error('custody checkpoint failed: the re-entered value does not match the generated key');
  }
  return true;
}

/**
 * Resolve the key this ceremony run will use: generated (the normal path — no key
 * argument at all, closing the offline-guessing-oracle risk a published fingerprint
 * would otherwise create for anything but a CSPRNG-generated key), or an explicit,
 * audited legacy IMPORT of a caller-supplied key. A caller-supplied key without the
 * exception flag is REFUSED, not silently generated instead — the flag's whole point
 * is to make the exception visible and deliberate, never an accidental fallback.
 *
 * `importKey` MUST be sourced from the environment (this codebase's existing
 * `ADLC_MANIFEST_KEY` / `getKey()` resolution, Layer 2), NEVER from a CLI argument —
 * argv is visible via `ps`, xtrace, shell history, and any command-logging harness,
 * exactly the exposure class this whole ceremony exists to prevent. This function
 * itself is agnostic to where the caller sourced `importKey` from; it is the CLI's
 * responsibility to never accept it as a flag value.
 * @param {{importKey?: string, allowKeyImport?: boolean, entropy?: Buffer}} [options]
 * @returns {{key: string, imported: boolean}}
 */
export function resolveCeremonyKey({ importKey, allowKeyImport = false, entropy } = {}) {
  if (importKey !== undefined) {
    if (!allowKeyImport) {
      throw new Error(
        'a caller-supplied key was provided, but the normal ceremony path never accepts one — '
        + 'the key is always generated (CSPRNG), never accepted, so a published fingerprint cannot '
        + 'become an offline guessing oracle for a weak key. To import a pre-existing key anyway '
        + '(a legacy, audited exception), pass the explicit import-exception flag.',
      );
    }
    if (typeof importKey !== 'string' || importKey.length === 0) {
      throw new TypeError('an imported key must be a non-empty string');
    }
    // The handoff file is line-oriented (writeKeyHandoffFile appends a trailing '\n'
    // so the documented `read -r` loader finds a delimiter before EOF). An imported key
    // that itself contains a newline would round-trip through that file as only its
    // first line — a silently DIFFERENT value than the one just fingerprinted/imported,
    // not merely a formatting quirk.
    if (importKey.includes('\n') || importKey.includes('\r')) {
      throw new TypeError(
        'an imported key must not contain a newline — the handoff file is line-oriented, so a '
        + 'multiline value would round-trip through the documented `read -r` loader as only its '
        + 'first line, silently diverging from the key that was actually imported and fingerprinted',
      );
    }
    return { key: importKey, imported: true };
  }
  return { key: generateManifestKey(entropy), imported: false };
}
