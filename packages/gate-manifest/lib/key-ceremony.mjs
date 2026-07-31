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
import { openSync, writeSync, fsyncSync, closeSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { stdin, stdout } from 'node:process';
import { sha256, repoRoot } from '@adlc/core';
import { fsyncDirectory } from '@adlc/tickets/lib/durability.mjs';

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
 * Refuse a handoff path that resolves inside the repository — committing the key
 * handoff file, even accidentally (an editor swap file, a build artifact scan, a
 * misconfigured backup), would defeat the entire point of keeping it OUTSIDE the tree
 * under review. Resolves both paths (symlink-following) before comparing, so a
 * symlinked repo checkout or a `..`-relative handoff path cannot slip past a naive
 * string-prefix check.
 * @param {string} path  the operator-chosen handoff path
 * @param {{root?: string}} [options]  root: override for repoRoot() (test injection)
 */
export function assertHandoffPathOutsideRepo(path, { root = repoRoot() } = {}) {
  const resolvedRoot = realpathOfDeepestExisting(root);
  const resolvedPath = realpathOfDeepestExisting(path);
  const rel = relative(resolvedRoot, resolvedPath);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (inside || resolvedPath === resolvedRoot) {
    throw new Error(`the key handoff path must be OUTSIDE the repository; ${path} resolves inside ${resolvedRoot}`);
  }
}

/**
 * Write the key to a mode-0600 file at `path`, exclusive-create (refuses to overwrite
 * an existing file at that path — the operator chose it, and silently clobbering
 * whatever is already there would be a surprising, silent side effect). Refuses a
 * path inside the repository (assertHandoffPathOutsideRepo). The mode is asserted via
 * a POST-write chmodSync, not just openSync's mode argument, because that argument is
 * subject to the process umask — a permissive umask would silently widen the file
 * beyond 0600 (mirrors packages/rails-guard/lib/ci/bootstrap.mjs's identical two-step
 * pattern for its own restrictive-permission write).
 * @param {string} path
 * @param {string} key
 * @param {{root?: string}} [options]
 */
export function writeKeyHandoffFile(path, key, options = {}) {
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
    writeSync(fd, key);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  fsyncDirectory(dirname(resolve(path)));
}

/**
 * Read one line from `input` with terminal echo DISABLED, for the custody checkpoint's
 * "re-enter the key" prompt. Refuses outright when either stream is not an interactive
 * TTY (a pipe would either hang forever or silently read unrelated data — this
 * checkpoint exists specifically to prove a HUMAN captured the key, which a non-TTY
 * context cannot demonstrate). Restores the terminal's prior raw-mode state on every
 * exit path — normal completion, Ctrl-C, or an unexpected error — so a cancelled
 * ceremony never leaves the operator's shell with echo silently disabled.
 * @param {{input?: NodeJS.ReadStream, output?: NodeJS.WriteStream, prompt?: string}} [options]
 * @returns {Promise<string>}
 */
export function readSecretLine({
  input = stdin,
  output = stdout,
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
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    let settled = false;

    const restore = () => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      process.removeListener('SIGINT', onSigint);
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      restore();
      output.write('\n');
      fn();
    };
    const onSigint = () => settle(() => reject(new Error('custody checkpoint cancelled (Ctrl-C)')));
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { settle(() => resolvePromise(value)); return; }
        if (ch === '\u0003') { settle(() => reject(new Error('custody checkpoint cancelled (Ctrl-C)'))); return; }
        if (ch === '\u007f' || ch === '\b') { if (value.length > 0) value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    output.write(prompt);
    input.on('data', onData);
    process.on('SIGINT', onSigint);
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
    return { key: importKey, imported: true };
  }
  return { key: generateManifestKey(entropy), imported: false };
}
