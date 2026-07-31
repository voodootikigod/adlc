// key-ceremony.test.mjs — key generation, custody handoff, and the custody checkpoint
// (T-01KYQMPBQT6Z2H507VGRCFANWM, T3 slice B, spec .adlc/specs/manifest-key-hermeticity.md
// Layer 3, "the key is GENERATED, never accepted").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KEY_BYTE_LENGTH,
  KEY_HEX_LENGTH,
  generateManifestKey,
  computeKeyFingerprint,
  assertHandoffPathOutsideRepo,
  writeKeyHandoffFile,
  readSecretLine,
  confirmCustody,
  resolveCeremonyKey,
  realpathOfDeepestExisting,
  repoBoundaryRoots,
  stripAclBestEffort,
} from '../lib/key-ceremony.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-'));
}

// ── generateManifestKey ─────────────────────────────────────────────────────────────

test('generates a 64-character lowercase hex string from real CSPRNG entropy', () => {
  const key = generateManifestKey();
  assert.equal(key.length, KEY_HEX_LENGTH);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('is deterministic given injected entropy — mirrors the ULID injectable-entropy convention', () => {
  const entropy = Buffer.alloc(KEY_BYTE_LENGTH, 0x11);
  const key = generateManifestKey(entropy);
  assert.equal(key, '11'.repeat(KEY_BYTE_LENGTH));
});

test('two real-entropy calls never collide (sanity, not a proof)', () => {
  assert.notEqual(generateManifestKey(), generateManifestKey());
});

test('rejects entropy that is not a Buffer', () => {
  assert.throws(() => generateManifestKey('not-a-buffer'), TypeError);
  assert.throws(() => generateManifestKey(null), TypeError);
});

test('rejects entropy of the wrong length', () => {
  assert.throws(() => generateManifestKey(Buffer.alloc(16)), TypeError);
  assert.throws(() => generateManifestKey(Buffer.alloc(64)), TypeError);
});

// ── computeKeyFingerprint ───────────────────────────────────────────────────────────

test('fingerprint is sha256 of the exact UTF-8 bytes of the key', () => {
  const key = generateManifestKey();
  const expected = createHash('sha256').update(key, 'utf8').digest('hex');
  assert.equal(computeKeyFingerprint(key), expected);
});

test('fingerprint is deterministic for the same key and differs for a different key', () => {
  const a = generateManifestKey();
  const b = generateManifestKey();
  assert.equal(computeKeyFingerprint(a), computeKeyFingerprint(a));
  assert.notEqual(computeKeyFingerprint(a), computeKeyFingerprint(b));
});

test('refuses an empty or non-string key', () => {
  assert.throws(() => computeKeyFingerprint(''), TypeError);
  assert.throws(() => computeKeyFingerprint(null), TypeError);
  assert.throws(() => computeKeyFingerprint(undefined), TypeError);
});

// ── assertHandoffPathOutsideRepo ────────────────────────────────────────────────────

test('accepts a path genuinely outside the repo root', () => {
  const root = tmpRoot();
  const outside = join(tmpdir(), 'somewhere-else-entirely', 'key.txt');
  assert.doesNotThrow(() => assertHandoffPathOutsideRepo(outside, { roots: [root] }));
});

test('rejects a path inside the repo root', () => {
  const root = tmpRoot();
  const inside = join(root, 'key.txt');
  assert.throws(() => assertHandoffPathOutsideRepo(inside, { roots: [root] }), /outside the repository/i);
});

test('rejects the repo root itself', () => {
  const root = tmpRoot();
  assert.throws(() => assertHandoffPathOutsideRepo(root, { roots: [root] }), /outside the repository/i);
});

test('rejects a nested inside-repo path even several directories deep', () => {
  const root = tmpRoot();
  const inside = join(root, 'a', 'b', 'c', 'key.txt');
  assert.throws(() => assertHandoffPathOutsideRepo(inside, { roots: [root] }), /outside the repository/i);
});

test('a sibling directory whose name merely starts with the repo root name is NOT inside it', () => {
  const root = tmpRoot();
  const sibling = `${root}-sibling`;
  const outsidePath = join(sibling, 'key.txt');
  assert.doesNotThrow(() => assertHandoffPathOutsideRepo(outsidePath, { roots: [root] }));
});

// ── repoBoundaryRoots: multiple linked worktrees of the SAME repository ─────────────

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-git-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'],
    { cwd: root },
  );
  return root;
}

test('repoBoundaryRoots is immune to GIT_DIR/GIT_WORK_TREE pointing at a DIFFERENT repository (round 12 finding — the actual bypass)', () => {
  const root = makeGitRepo();
  const otherRepo = makeGitRepo();
  const originalGitDir = process.env.GIT_DIR;
  const originalWorkTree = process.env.GIT_WORK_TREE;
  // Reproduced concretely before this fix: with these set, `git rev-parse
  // --git-common-dir` and `git worktree list` described ONLY otherRepo, so a handoff
  // path genuinely inside `root` was accepted as "outside the repository".
  process.env.GIT_DIR = join(otherRepo, '.git');
  process.env.GIT_WORK_TREE = otherRepo;
  try {
    const roots = repoBoundaryRoots({ cwd: root });
    assert.ok(
      roots.some((r) => realpathSync(r) === realpathSync(root)),
      `expected roots to still describe ${root} (not the GIT_DIR/GIT_WORK_TREE-poisoned ${otherRepo}), got ${JSON.stringify(roots)}`,
    );
    assert.throws(
      () => assertHandoffPathOutsideRepo(join(root, 'key.txt'), { roots }),
      /outside the repository/i,
      'a path genuinely inside root must still be refused despite the poisoned Git selector',
    );
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = originalGitDir;
    if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = originalWorkTree;
  }
});

test('repoBoundaryRoots fails closed if Git reports boundaries that do not contain cwd at all (defense in depth)', () => {
  const fakeGit = (args) => {
    if (args[0] === 'rev-parse') return '/some/totally-other-repo/.git\n';
    return 'worktree /some/totally-other-repo\0HEAD abc123\0branch refs/heads/main\0\0';
  };
  assert.throws(
    () => repoBoundaryRoots({ cwd: '/tmp/definitely-not-that-repo', git: fakeGit }),
    /do not contain the current directory/,
  );
});

test('repoBoundaryRoots never hands its Git children the signing key, even when it is exported (round 11 finding)', () => {
  const root = makeGitRepo();
  const shimDir = mkdtempSync(join(tmpdir(), 'adlc-git-shim-'));
  const markerPath = join(shimDir, 'leaked.txt');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimPath = join(shimDir, 'git');
  // A forwarding shim: if it ever sees the key in its own environment, it records that
  // fact, then delegates to the REAL git so repoBoundaryRoots's own logic still works —
  // this proves absence of the leak, not just "the function still returns something".
  writeFileSync(shimPath, `#!/bin/sh\nif [ -n "$ADLC_MANIFEST_KEY" ]; then echo leaked > "${markerPath}"; fi\nexec "${realGit}" "$@"\n`);
  execFileSync('chmod', ['+x', shimPath]);
  const originalPath = process.env.PATH;
  const originalKey = process.env.ADLC_MANIFEST_KEY;
  process.env.PATH = `${shimDir}:${originalPath}`;
  process.env.ADLC_MANIFEST_KEY = 'a-secret-that-must-never-reach-git';
  try {
    const roots = repoBoundaryRoots({ cwd: root });
    assert.ok(roots.length > 0, 'sanity: repoBoundaryRoots must still resolve correctly through the shim');
    assert.equal(existsSync(markerPath), false, 'the Git shim must never have observed ADLC_MANIFEST_KEY in its environment');
  } finally {
    process.env.PATH = originalPath;
    if (originalKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = originalKey;
  }
});

test('repoBoundaryRoots includes the current worktree root', () => {
  const root = makeGitRepo();
  const roots = repoBoundaryRoots({ cwd: root });
  assert.ok(roots.some((r) => realpathSync(r) === realpathSync(root)), `expected ${root} among ${JSON.stringify(roots)}`);
});

test('a LINKED WORKTREE of the same repository is refused as a handoff destination — the exact gap this closes', () => {
  const root = makeGitRepo();
  const linkedPath = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-linked-'));
  rmSync(linkedPath, { recursive: true, force: true }); // `git worktree add` requires the path not to exist yet
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'linked-test-branch', linkedPath], { cwd: root });
  try {
    const roots = repoBoundaryRoots({ cwd: root });
    const destination = join(linkedPath, 'key.txt');
    assert.throws(
      () => assertHandoffPathOutsideRepo(destination, { roots }),
      /outside the repository/i,
      'a destination inside a SIBLING linked worktree of the same repository must be refused, not just the current worktree',
    );
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedPath], { cwd: root });
  }
});

test('the PRIMARY checkout (queried from a linked worktree) is refused as a handoff destination', () => {
  const root = makeGitRepo();
  const linkedPath = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-linked-'));
  rmSync(linkedPath, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'linked-test-branch-2', linkedPath], { cwd: root });
  try {
    // Query boundaries FROM the linked worktree — it must still know about the primary
    // checkout (root) as a boundary, not only its own directory.
    const roots = repoBoundaryRoots({ cwd: linkedPath });
    const destinationInPrimary = join(root, 'key.txt');
    assert.throws(() => assertHandoffPathOutsideRepo(destinationInPrimary, { roots }), /outside the repository/i);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedPath], { cwd: root });
  }
});

test('a linked worktree whose path contains a space and non-ASCII characters is still recognized as a boundary — NUL-delimited parsing, not newline-split', () => {
  const root = makeGitRepo();
  const parent = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-linked-'));
  const linkedPath = join(parent, 'wörktree with spaces');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'linked-unicode-branch', linkedPath], { cwd: root });
  try {
    const roots = repoBoundaryRoots({ cwd: root });
    assert.ok(
      roots.some((r) => realpathSync(r) === realpathSync(linkedPath)),
      `expected the space/unicode worktree path among ${JSON.stringify(roots)}`,
    );
    const destination = join(linkedPath, 'key.txt');
    assert.throws(
      () => assertHandoffPathOutsideRepo(destination, { roots }),
      /outside the repository/i,
      'a handoff destination inside this worktree must still be refused even though its path has a space and non-ASCII characters',
    );
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedPath], { cwd: root });
  }
});

// ── realpathOfDeepestExisting ────────────────────────────────────────────────────────

test('reattaches the full non-existent tail exactly, not just the deepest existing ancestor', () => {
  const root = tmpRoot();
  const target = join(root, 'not-yet-created', 'nested', 'file.txt');
  const result = realpathOfDeepestExisting(target);
  assert.equal(result, join(realpathSync(root), 'not-yet-created', 'nested', 'file.txt'));
});

test('returns the exact realpath when the target itself already exists (no tail to reattach)', () => {
  const root = tmpRoot();
  const existingFile = join(root, 'exists.txt');
  writeFileSync(existingFile, 'x');
  assert.equal(realpathOfDeepestExisting(existingFile), realpathSync(existingFile));
});

// ── writeKeyHandoffFile ──────────────────────────────────────────────────────────────

test('writes the key to the handoff path with mode 0600', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const key = generateManifestKey();
  const handoffPath = join(outsideDir, 'key.txt');
  writeKeyHandoffFile(handoffPath, key, { roots: [root] });
  // Newline-terminated so the documented `read -r` loader doesn't hit EOF before a
  // delimiter (round 5 finding) — the key VALUE itself is still exactly `key`.
  assert.equal(readFileSync(handoffPath, 'utf8'), `${key}\n`);
  const mode = statSync(handoffPath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('refuses to overwrite an existing file at the handoff path', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  writeFileSync(handoffPath, 'pre-existing content');
  assert.throws(
    () => writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root] }),
    /refusing to overwrite/,
  );
  assert.equal(readFileSync(handoffPath, 'utf8'), 'pre-existing content', 'the pre-existing file must be untouched');
});

test('refuses a handoff path inside the repository, before writing anything', () => {
  const root = tmpRoot();
  const insidePath = join(root, 'key.txt');
  assert.throws(() => writeKeyHandoffFile(insidePath, generateManifestKey(), { roots: [root] }), /outside the repository/i);
});

test('fails closed on win32 — chmod there does not install an owner-only ACL', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    assert.throws(
      () => writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root] }),
      /win32/,
    );
    assert.equal(existsSync(handoffPath), false, 'nothing should be written when the platform is refused up front');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  }
});

test('writes every byte of the key — guards the write loop against reporting success on a short write', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const key = generateManifestKey();
  const handoffPath = join(outsideDir, 'key.txt');
  writeKeyHandoffFile(handoffPath, key, { roots: [root] });
  const writtenBytes = readFileSync(handoffPath);
  const expected = Buffer.from(`${key}\n`, 'utf8');
  assert.equal(writtenBytes.length, expected.length, 'the file must contain the FULL key plus its trailing newline, not a truncated prefix');
  assert.ok(writtenBytes.equals(expected));
});

test('verifies the mode the filesystem actually enforced, not merely that chmod was called', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  // Inject a `stat` that reports a filesystem which silently ignored the chmod(0600)
  // call (e.g. FAT/exFAT, some network mounts) — real chmodSync still runs, but the
  // post-write verification must catch the mismatch and refuse the handoff anyway.
  const fakeStat = () => ({ mode: 0o644 });
  assert.throws(
    () => writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root], stat: fakeStat }),
    /did not enforce mode 0600/,
  );
  assert.equal(existsSync(handoffPath), false, 'a file whose mode could not be verified must not be left behind');
});

test('confines the file (chmod, ACL-strip, mode-verify) BEFORE writing a single secret byte, not after (round 8 finding)', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  let sizeAtVerification;
  const stat = (fd) => {
    sizeAtVerification = fstatSync(fd).size;
    return fstatSync(fd);
  };
  writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root], stat });
  assert.equal(sizeAtVerification, 0, 'the mode-verification step must observe an EMPTY file — proving confinement happened before the secret was written, not after');
  assert.ok(statSync(handoffPath).size > 0, 'the finished file must still contain the actual key');
});

test('a genuine ACL-strip failure aborts the whole ceremony and cleans up, rather than proceeding as if confined (round 9 finding)', () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-handoff-'));
  const handoffPath = join(outsideDir, 'key.txt');
  const stripAcl = () => { throw new Error('ACL removal via `chmod` failed on it (permission denied) — refusing to hand off'); };
  assert.throws(
    () => writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root], stripAcl }),
    /refusing to hand off/,
  );
  assert.equal(existsSync(handoffPath), false, 'a file whose ACL confinement genuinely failed must not be left behind');
});

// ── stripAclBestEffort: real inherited ACL, real removal (round 7 finding) ─────────

test('stripAclBestEffort invokes exactly the right TRUSTED ABSOLUTE PATH tool with the right arguments', () => {
  const calls = [];
  const exec = (...args) => calls.push(args);

  stripAclBestEffort('/some/path', { platform: 'darwin', exec });
  assert.deepEqual(calls, [['/bin/chmod', ['-N', '/some/path'], { stdio: 'ignore', env: {} }]]);

  calls.length = 0;
  stripAclBestEffort('/some/path', { platform: 'linux', exec });
  assert.deepEqual(calls, [['/usr/bin/setfacl', ['-b', '/some/path'], { stdio: 'ignore', env: {} }]]);

  calls.length = 0;
  stripAclBestEffort('/some/path', { platform: 'win32', exec });
  assert.deepEqual(calls, [], 'an unsupported platform must not invoke any ACL tool');
});

test('stripAclBestEffort never hands the child process the caller\'s environment at all', () => {
  let capturedEnv;
  const exec = (_command, _args, opts) => { capturedEnv = opts.env; };
  const originalKey = process.env.ADLC_MANIFEST_KEY;
  process.env.ADLC_MANIFEST_KEY = 'a-secret-that-must-never-reach-the-child';
  try {
    stripAclBestEffort('/some/path', { platform: 'darwin', exec });
    assert.deepEqual(capturedEnv, {}, 'the child environment must be empty — an absolute-path invocation needs no PATH lookup and no other inherited variable');
    assert.ok(!('ADLC_MANIFEST_KEY' in capturedEnv), 'the signing key must never be present in the ACL-strip child process environment');
  } finally {
    if (originalKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = originalKey;
  }
});

test('stripAclBestEffort tolerates the tool simply being absent (ENOENT) — nothing more it can do there', () => {
  const exec = () => { const err = new Error('spawnSync chmod ENOENT'); err.code = 'ENOENT'; throw err; };
  assert.doesNotThrow(() => stripAclBestEffort('/some/path', { platform: 'darwin', exec }));
  assert.doesNotThrow(() => stripAclBestEffort('/some/path', { platform: 'linux', exec }));
});

test('stripAclBestEffort FAILS CLOSED when the tool exists but genuinely fails (round 9 finding) — never silently proceeds', () => {
  const exec = () => { throw new Error('permission denied'); };
  assert.throws(
    () => stripAclBestEffort('/some/path', { platform: 'darwin', exec }),
    /ACL removal via `\/bin\/chmod` failed/,
  );
  assert.throws(
    () => stripAclBestEffort('/some/path', { platform: 'linux', exec }),
    /ACL removal via `\/usr\/bin\/setfacl` failed/,
  );
});

test('stripAclBestEffort does nothing on an unsupported platform (e.g. win32) — no tool invoked, nothing thrown', () => {
  const calls = [];
  const exec = (...args) => calls.push(args);
  assert.doesNotThrow(() => stripAclBestEffort('/some/path', { platform: 'win32', exec }));
  assert.deepEqual(calls, []);
});

test('stripAclBestEffort removes a real ACL entry inherited from the parent directory', { skip: process.platform !== 'darwin' }, () => {
  // POSIX mode bits alone would not have caught this: the file below reads back as
  // 0600 the whole time, yet a real ACE grants `everyone` read access until stripped.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-key-acl-'));
  execFileSync('chmod', ['+a', 'everyone allow read,file_inherit', dir]);
  const childPath = join(dir, 'child.txt');
  writeFileSync(childPath, 'x');
  const before = execFileSync('ls', ['-le', childPath], { encoding: 'utf8' });
  assert.ok(before.trim().split('\n').length > 1, 'the child file must have really inherited an ACL entry before the test proceeds');
  stripAclBestEffort(childPath);
  const after = execFileSync('ls', ['-le', childPath], { encoding: 'utf8' });
  assert.equal(after.trim().split('\n').length, 1, 'the inherited ACL entry must actually be gone, not just the mode bits unaffected');
});

test('writeKeyHandoffFile strips a real inherited ACL end to end, not just mode bits', { skip: process.platform !== 'darwin' }, () => {
  const root = tmpRoot();
  const dir = mkdtempSync(join(tmpdir(), 'adlc-key-acl-e2e-'));
  execFileSync('chmod', ['+a', 'everyone allow read,file_inherit', dir]);
  const handoffPath = join(dir, 'key.txt');
  writeKeyHandoffFile(handoffPath, generateManifestKey(), { roots: [root] });
  const listing = execFileSync('ls', ['-le', handoffPath], { encoding: 'utf8' });
  assert.equal(listing.trim().split('\n').length, 1, 'the handoff file must not carry the ACL its parent directory would have inherited onto it');
});

// ── readSecretLine / confirmCustody: fake TTY-like streams (no real pty needed) ────

function makeFakeTty({ isTTY = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; };
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  let written = '';
  const output = new EventEmitter();
  output.isTTY = isTTY;
  output.write = (s) => { written += s; };
  return { input, output, writtenOutput: () => written };
}

function typeAndEnter(input, text) {
  for (const ch of text) input.emit('data', ch);
  input.emit('data', '\r');
}

test('readSecretLine refuses when input is not a TTY', async () => {
  const { input, output } = makeFakeTty({ isTTY: false });
  await assert.rejects(() => readSecretLine({ input, output }), /interactive terminal/);
});

test('readSecretLine refuses when output is not a TTY', async () => {
  const { input } = makeFakeTty();
  const output = { isTTY: false, write: () => {} };
  await assert.rejects(() => readSecretLine({ input, output }), /interactive terminal/);
});

test('readSecretLine resolves with the typed value, echo disabled', async () => {
  const { input, output, writtenOutput } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'the-typed-secret');
  const result = await resultPromise;
  assert.equal(result, 'the-typed-secret');
  assert.ok(!writtenOutput().includes('the-typed-secret'), 'the typed value must never be echoed back to output');
});

test('readSecretLine enables raw mode while reading and restores the PRIOR raw state after', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  assert.equal(input.isRaw, true, 'raw mode must be enabled for the duration of the read');
  typeAndEnter(input, 'x');
  await resultPromise;
  assert.equal(input.isRaw, false, 'raw mode must be restored to what it was before the read');
});

test('readSecretLine handles backspace by removing the last character', async () => {
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  for (const ch of 'abcX') input.emit('data', ch);
  input.emit('data', '\u007f'); // backspace removes the 'X'
  input.emit('data', '\r');
  assert.equal(await resultPromise, 'abc');
});

test('readSecretLine backspace on an empty buffer does not underflow', async () => {
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  input.emit('data', '\u007f');
  input.emit('data', 'y');
  input.emit('data', '\r');
  assert.equal(await resultPromise, 'y');
});

test('readSecretLine rejects and restores raw mode when input emits "error"', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  input.emit('error', new Error('synthetic input error'));
  await assert.rejects(() => resultPromise, /synthetic input error/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine rejects and restores raw mode when input ends before a value is entered', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  input.emit('end');
  await assert.rejects(() => resultPromise, /input ended before a value was entered/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine rejects and restores raw mode when input emits "close"', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  input.emit('close');
  await assert.rejects(() => resultPromise, /input ended before a value was entered/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine rejects and restores raw mode when output emits "error"', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  output.emit('error', new Error('synthetic output stream error'));
  await assert.rejects(() => resultPromise, /synthetic output stream error/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine rejects and restores raw mode when output emits "close"', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  output.emit('close');
  await assert.rejects(() => resultPromise, /output stream closed unexpectedly/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine restores the terminal and exits with the conventional code, preserving normal SIGTERM semantics', () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const exitCalls = [];
  readSecretLine({ input, output, exit: (code) => exitCalls.push(code) });
  assert.equal(input.isRaw, true, 'raw mode is enabled while the prompt is pending');
  process.emit('SIGTERM');
  assert.deepEqual(exitCalls, [143], 'exits with the conventional 128+15 code for SIGTERM, not silently swallowing it');
  assert.equal(input.isRaw, false, 'raw mode must be restored BEFORE exiting');
});

test('readSecretLine restores the terminal and exits with the conventional code, preserving normal SIGHUP semantics', () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const exitCalls = [];
  readSecretLine({ input, output, exit: (code) => exitCalls.push(code) });
  process.emit('SIGHUP');
  assert.deepEqual(exitCalls, [129], 'exits with the conventional 128+1 code for SIGHUP');
  assert.equal(input.isRaw, false);
});

test('readSecretLine restores raw mode when writing the prompt throws synchronously', async () => {
  const { input } = makeFakeTty();
  input.isRaw = false;
  const output = {
    isTTY: true,
    write: () => { throw new Error('synthetic output failure'); },
  };
  await assert.rejects(() => readSecretLine({ input, output }), /synthetic output failure/);
  assert.equal(input.isRaw, false, 'raw mode must be restored even when the prompt write itself throws');
  assert.equal(input.listenerCount('data'), 0, 'no dangling data listener after a setup failure');
});

test('readSecretLine rejects on Ctrl-C and restores raw mode', async () => {
  const { input, output } = makeFakeTty();
  input.isRaw = false;
  const resultPromise = readSecretLine({ input, output });
  input.emit('data', '\u0003');
  await assert.rejects(() => resultPromise, /Ctrl-C/);
  assert.equal(input.isRaw, false);
});

test('readSecretLine does not leak a "data" listener on input after resolving', async () => {
  const { input, output } = makeFakeTty();
  const before = input.listenerCount('data');
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'z');
  await resultPromise;
  assert.equal(input.listenerCount('data'), before);
});

test('readSecretLine does not leak a process SIGINT listener after resolving', async () => {
  const before = process.listenerCount('SIGINT');
  const { input, output } = makeFakeTty();
  const resultPromise = readSecretLine({ input, output });
  typeAndEnter(input, 'z');
  await resultPromise;
  assert.equal(process.listenerCount('SIGINT'), before);
});

// ── confirmCustody ───────────────────────────────────────────────────────────────────

test('confirmCustody succeeds when the re-entered value matches the key', async () => {
  const key = generateManifestKey();
  const result = await confirmCustody(key, { readSecret: async () => key });
  assert.equal(result, true);
});

test('confirmCustody throws when the re-entered value does not match', async () => {
  const key = generateManifestKey();
  await assert.rejects(
    () => confirmCustody(key, { readSecret: async () => 'a-completely-different-value' }),
    /does not match/,
  );
});

test('confirmCustody throws on a value that differs only in length (no partial-match acceptance)', async () => {
  const key = generateManifestKey();
  await assert.rejects(() => confirmCustody(key, { readSecret: async () => key.slice(0, -1) }), /does not match/);
});

test('confirmCustody end-to-end with a fake TTY (no real pty)', async () => {
  const key = generateManifestKey();
  const { input, output } = makeFakeTty();
  const resultPromise = confirmCustody(key, { input, output });
  typeAndEnter(input, key);
  assert.equal(await resultPromise, true);
});

// ── resolveCeremonyKey ───────────────────────────────────────────────────────────────

test('with no importKey, generates a fresh key', () => {
  const resolved = resolveCeremonyKey();
  assert.equal(resolved.imported, false);
  assert.match(resolved.key, /^[0-9a-f]{64}$/);
});

test('refuses a caller-supplied key without the exception flag', () => {
  assert.throws(
    () => resolveCeremonyKey({ importKey: 'some-legacy-key' }),
    /never accepts one/,
  );
});

test('accepts a caller-supplied key WITH the exception flag, and reports it as imported', () => {
  const resolved = resolveCeremonyKey({ importKey: 'some-legacy-key', allowKeyImport: true });
  assert.deepEqual(resolved, { key: 'some-legacy-key', imported: true });
});

test('refuses an empty imported key even with the exception flag', () => {
  assert.throws(() => resolveCeremonyKey({ importKey: '', allowKeyImport: true }), TypeError);
});

test('passes injected entropy through to generation on the normal (non-import) path', () => {
  const entropy = Buffer.alloc(KEY_BYTE_LENGTH, 0x22);
  const resolved = resolveCeremonyKey({ entropy });
  assert.equal(resolved.key, '22'.repeat(KEY_BYTE_LENGTH));
});
