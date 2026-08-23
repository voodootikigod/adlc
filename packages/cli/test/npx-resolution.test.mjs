import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { dispatch, resolveNpxInvocation } from '../lib/dispatch.mjs';

// Issue #233: `adlc review` was unreachable on Windows because runExternal spawned the
// bare name `npx` with no shell, and Node does no PATHEXT resolution for a non-shell
// spawn. These are PLATFORM-BRANCH tests: they inject platform/execPath/isFile so both
// the win32 and the posix branch are asserted from a Linux runner. That injection is
// not a convenience -- the only Windows job in CI (ticket-store-platform.yml) never
// exercises @adlc/cli, so these assertions are the entire regression net for the
// Windows behaviour.
//
// Fixture paths use forward slashes even for the win32 cases. `path.join` follows the
// platform the TEST is running on, not the injected one, so a `C:\...` fixture would
// assert a mangled `C:\nodejs/node_modules/...` string and prove nothing about segment
// order. Forward-slash fixtures keep the expected path exact and the real separator is
// path.join's business on the real platform.

const WIN_BIN_DIR = '/fixture/Program Files/nodejs';
const WIN_EXEC_PATH = `${WIN_BIN_DIR}/node.exe`;
const WIN_NPX_CLI = join(WIN_BIN_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');
const WIN_NPX_CMD = join(WIN_BIN_DIR, 'npx.cmd');
// The path the POSIX prefix layout WOULD compute on win32: a sibling of the install
// dir, which npm never creates and an unprivileged user frequently can.
const WIN_SIBLING_PREFIX_CLI = join(WIN_BIN_DIR, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');

const POSIX_BIN_DIR = '/fixture/usr/local/bin';
const POSIX_EXEC_PATH = `${POSIX_BIN_DIR}/node`;
const POSIX_INSTALL_CLI = join(POSIX_BIN_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');
const POSIX_PREFIX_CLI = join(POSIX_BIN_DIR, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
const POSIX_NPX_SIBLING = join(POSIX_BIN_DIR, 'npx');

/** A probe that answers true for exactly the listed paths. */
function only(...paths) {
  const present = new Set(paths);
  return (path) => present.has(path);
}

/**
 * Fixture env where every listed path is a non-empty regular file AND executable.
 * The sibling-npx rung needs the execute bit, so a fixture that grants only isFile
 * would silently stop exercising that rung.
 */
function present(paths, rest) {
  const probe = only(...paths);
  return { ...rest, isFile: probe, isExecutable: probe };
}

// Permission bits do not restrain uid 0, so a readability test would silently invert
// under a root CI container. The execute-bit test needs no such guard: access(X_OK)
// fails even for root when no execute bit is set at all.
const isRoot = process.getuid?.() === 0;

function fakeChild({ status = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (error) child.emit('error', error);
    else child.emit('exit', status, null);
  });
  return child;
}

function recordSpawn(calls, childOpts) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return fakeChild(childOpts);
  };
}

// --- win32 branch -----------------------------------------------------------------

test('win32: resolves node + the npx-cli.js npm ships beside node.exe', () => {
  const resolved = resolveNpxInvocation({
    platform: 'win32',
    execPath: WIN_EXEC_PATH,
    isFile: only(WIN_NPX_CLI, WIN_NPX_CMD),
  });

  assert.equal(resolved.command, WIN_EXEC_PATH);
  assert.deepEqual(resolved.prefixArgs, [WIN_NPX_CLI]);
  assert.equal(resolved.resolved, true);
});

test('win32: never resolves npx.cmd, even when it is the only npx present', () => {
  // The CVE-2024-27980 hardening makes a non-shell .cmd spawn throw
  // ERR_CHILD_PROCESS_UNSUPPORTED_SPAWN, and shell: true would re-parse user argv
  // through cmd.exe. So npx.cmd is skipped and we degrade to the pre-existing bare
  // name rather than reaching for a shell.
  const resolved = resolveNpxInvocation({
    platform: 'win32',
    execPath: WIN_EXEC_PATH,
    isFile: only(WIN_NPX_CMD, join(WIN_BIN_DIR, 'npx.ps1')),
  });

  assert.equal(resolved.command, 'npx');
  assert.deepEqual(resolved.prefixArgs, []);
  assert.doesNotMatch(resolved.command, /\.cmd$|\.ps1$|\.bat$/);
});

test('win32: falls back to the bare name when the install ships no npx at all', () => {
  const resolved = resolveNpxInvocation({
    platform: 'win32',
    execPath: WIN_EXEC_PATH,
    isFile: () => false,
  });

  assert.equal(resolved.command, 'npx');
  assert.deepEqual(resolved.prefixArgs, []);
  assert.equal(resolved.resolved, false);
});

test('win32: a planted npx-cli.js OUTSIDE the install dir is never probed or run', () => {
  // The POSIX prefix layout walks `..` out of the install dir. On win32 that lands on a
  // sibling npm never creates -- e.g. an nvm-windows node at ...\nvm\v20.11.0\node.exe
  // probing ...\nvm\lib\... -- which an unprivileged user can often write. Present it as
  // the ONLY candidate: the resolver must ignore it and degrade, not execute it.
  const resolved = resolveNpxInvocation({
    platform: 'win32',
    execPath: WIN_EXEC_PATH,
    isFile: only(WIN_SIBLING_PREFIX_CLI),
  });

  assert.equal(resolved.command, 'npx');
  assert.deepEqual(resolved.prefixArgs, []);
  assert.equal(resolved.probed.includes(WIN_SIBLING_PREFIX_CLI), false, 'must not even probe it');
});

test('win32: every probed path stays inside the node install directory', () => {
  const { probed } = resolveNpxInvocation({
    platform: 'win32',
    execPath: WIN_EXEC_PATH,
    isFile: () => false,
  });

  // join() normalizes to the RUNNING platform's separator, so the expected prefix has
  // to be normalized the same way -- otherwise this assertion compares a backslash path
  // against a slash prefix and fails on Windows, which is the one platform this whole
  // file exists to protect.
  const binDirPrefix = join(WIN_BIN_DIR) + sep;
  assert.ok(probed.length > 0, 'expected at least one probe');
  for (const path of probed) {
    assert.ok(path.startsWith(binDirPrefix), `${path} escapes ${binDirPrefix}`);
  }
});

// --- posix branch -----------------------------------------------------------------

test('posix: resolves node + npx-cli.js from the <prefix>/lib install layout', () => {
  const resolved = resolveNpxInvocation({
    platform: 'linux',
    execPath: POSIX_EXEC_PATH,
    isFile: only(POSIX_PREFIX_CLI, POSIX_NPX_SIBLING),
  });

  assert.equal(resolved.command, POSIX_EXEC_PATH);
  assert.deepEqual(resolved.prefixArgs, [POSIX_PREFIX_CLI]);
});

test('posix: the install-dir layout wins when BOTH layouts are present', () => {
  // Pins the ORDER of the layout table, not just its membership. Without this, swapping
  // or reversing the entries is a silent no-op for the suite.
  const resolved = resolveNpxInvocation({
    platform: 'linux',
    execPath: POSIX_EXEC_PATH,
    isFile: only(POSIX_INSTALL_CLI, POSIX_PREFIX_CLI),
  });

  assert.deepEqual(resolved.prefixArgs, [POSIX_INSTALL_CLI]);
  assert.equal(resolved.probed[0], POSIX_INSTALL_CLI);
});

test('posix: falls back to the sibling npx script when no npx-cli.js layout matches', () => {
  const resolved = resolveNpxInvocation(
    present([POSIX_NPX_SIBLING], { platform: 'darwin', execPath: POSIX_EXEC_PATH }),
  );

  assert.equal(resolved.command, POSIX_NPX_SIBLING);
  assert.deepEqual(resolved.prefixArgs, []);
  // The sibling IS a resolution, not a degradation: it must not be reported as
  // unresolved, or every sibling-rung failure would carry the probe diagnostic.
  assert.equal(resolved.resolved, true);
});

test('posix: a NON-EXECUTABLE sibling npx is not taken, and the search degrades past it', () => {
  // The sibling is the one candidate the OS execs itself rather than handing to node,
  // so a readable-but-not-executable file is not a resolution: taking it would consume
  // the rung and then die with EACCES.
  const resolved = resolveNpxInvocation({
    platform: 'linux',
    execPath: POSIX_EXEC_PATH,
    isFile: only(POSIX_NPX_SIBLING),
    isExecutable: () => false,
  });

  assert.equal(resolved.command, 'npx');
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.probed.includes(POSIX_NPX_SIBLING), true, 'it should still be probed');
});

test('an UNREADABLE npx-cli.js does not consume the rung — the search continues', { skip: isRoot }, () => {
  // statSync succeeds on a file this process cannot read, so without a readability
  // check the first layout would be selected and `adlc review` would die with EACCES
  // while a perfectly good npm sat in the second layout.
  const root = mkdtempSync(join(tmpdir(), 'adlc-npx-r-'));
  try {
    const binDir = join(root, 'bin');
    const execPath = join(binDir, 'node');
    const firstLayout = join(binDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const secondLayout = join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    for (const path of [firstLayout, secondLayout]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '#!/usr/bin/env node\n');
    }
    chmodSync(firstLayout, 0o000);

    const resolved = resolveNpxInvocation({ platform: 'linux', execPath });

    assert.equal(resolved.probed.includes(firstLayout), true, 'fixture precondition: probed');
    assert.deepEqual(resolved.prefixArgs, [secondLayout], 'should have fallen through');
    assert.equal(resolved.resolved, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the DEFAULT executable probe reads the real mode bits', () => {
  // No injected isExecutable: exercises the accessSync-backed probe against a real file
  // whose only change between the two halves is chmod.
  const root = mkdtempSync(join(tmpdir(), 'adlc-npx-x-'));
  try {
    const binDir = join(root, 'bin');
    const sibling = join(binDir, 'npx');
    const execPath = join(binDir, 'node');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(sibling, '#!/usr/bin/env bash\n');

    chmodSync(sibling, 0o644);
    assert.equal(
      resolveNpxInvocation({ platform: 'linux', execPath }).resolved,
      false,
      'mode 0644 must not be taken',
    );

    chmodSync(sibling, 0o755);
    const executable = resolveNpxInvocation({ platform: 'linux', execPath });
    assert.equal(executable.resolved, true, 'mode 0755 must be taken');
    assert.equal(executable.command, sibling);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('posix: falls back to the bare name when no sibling npx exists either', () => {
  const resolved = resolveNpxInvocation({
    platform: 'linux',
    execPath: POSIX_EXEC_PATH,
    isFile: () => false,
  });

  assert.equal(resolved.command, 'npx');
  assert.deepEqual(resolved.prefixArgs, []);
});

// --- a candidate must be a regular FILE ---------------------------------------------

test('a non-file candidate is skipped and the search CONTINUES to the next rung', () => {
  // existsSync answers true for a directory, and `node <dir>` exits non-zero while
  // `node <empty file>` exits ZERO -- either would let `adlc review` report success
  // with no reviewer having run. A non-file must not end the search either.
  // npx-cli.js paths are directories here; only the sibling is a usable file.
  const resolved = resolveNpxInvocation(
    present([POSIX_NPX_SIBLING], { platform: 'linux', execPath: POSIX_EXEC_PATH }),
  );

  assert.equal(resolved.command, POSIX_NPX_SIBLING, 'should have fallen through to the sibling');
  assert.equal(resolved.probed.includes(POSIX_INSTALL_CLI), true, 'both layouts should be probed');
  assert.equal(resolved.probed.includes(POSIX_PREFIX_CLI), true);
});

test('the DEFAULT probe rejects a directory and a zero-byte file, but accepts a real one', () => {
  // Exercises the actual statSync-backed probe against a real filesystem, with no
  // injected isFile. existsSync answers true for BOTH rejected shapes, so an
  // existsSync-based probe would resolve them.
  //
  // The zero-byte case is the one that matters most: `node <empty file>` exits 0, and
  // runChild propagates that as success -- `adlc review` would go green with no
  // reviewer having run. An interrupted npm install produces exactly that file.
  const root = mkdtempSync(join(tmpdir(), 'adlc-npx-'));
  try {
    const binDir = join(root, 'bin');
    const npxCli = join(binDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const execPath = join(binDir, 'node');

    mkdirSync(npxCli, { recursive: true });
    assert.equal(statSync(npxCli).isDirectory(), true, 'fixture precondition: it is a directory');
    const asDirectory = resolveNpxInvocation({ platform: 'linux', execPath });
    assert.equal(asDirectory.probed.includes(npxCli), true, 'fixture precondition: it was probed');
    assert.equal(asDirectory.resolved, false, 'a directory must not be accepted as npx-cli.js');
    assert.equal(asDirectory.command, 'npx');

    rmSync(npxCli, { recursive: true });
    writeFileSync(npxCli, '');
    assert.equal(statSync(npxCli).size, 0, 'fixture precondition: it is empty');
    const asEmptyFile = resolveNpxInvocation({ platform: 'linux', execPath });
    assert.equal(asEmptyFile.resolved, false, 'a zero-byte file must not be accepted');
    assert.equal(asEmptyFile.command, 'npx');

    // One byte must already be enough. The threshold is EXACTLY "not empty" -- the
    // guard rejects the file npm's own interrupted install leaves behind and nothing
    // more. Any size heuristic beyond that would be guessing at what a valid npx-cli.js
    // looks like, which is the content-sniffing this deliberately does not do.
    writeFileSync(npxCli, '\n');
    assert.equal(statSync(npxCli).size, 1, 'fixture precondition: exactly one byte');
    assert.equal(resolveNpxInvocation({ platform: 'linux', execPath }).resolved, true);

    // And a plausible file resolves to the full invocation, so the assertions above do
    // not pass for the trivial reason that nothing ever resolves here.
    writeFileSync(npxCli, '#!/usr/bin/env node\n');
    const asFile = resolveNpxInvocation({ platform: 'linux', execPath });
    assert.equal(asFile.resolved, true);
    assert.deepEqual(asFile.prefixArgs, [npxCli]);
    assert.equal(asFile.command, execPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the branch is real, not incidental --------------------------------------------

test('the sibling-npx rung is what separates the two platforms', () => {
  // Same directory, same probe -- only `platform` differs. posix takes the sibling,
  // win32 refuses it. If the platform check were dropped, these would be equal and
  // win32 would be spawning a .cmd.
  const probes = present([POSIX_NPX_SIBLING], { execPath: POSIX_EXEC_PATH });
  const posix = resolveNpxInvocation({ ...probes, platform: 'linux' });
  const win = resolveNpxInvocation({ ...probes, platform: 'win32' });

  assert.equal(posix.command, POSIX_NPX_SIBLING);
  assert.equal(win.command, 'npx');
  assert.notEqual(posix.command, win.command);
});

test('the two platforms probe different candidate sets', () => {
  const args = { execPath: POSIX_EXEC_PATH, isFile: () => false };
  const posix = resolveNpxInvocation({ ...args, platform: 'linux' });
  const win = resolveNpxInvocation({ ...args, platform: 'win32' });

  assert.deepEqual(win.probed, [POSIX_INSTALL_CLI], 'win32 probes the install dir only');
  assert.deepEqual(posix.probed, [POSIX_INSTALL_CLI, POSIX_PREFIX_CLI, POSIX_NPX_SIBLING]);
});

// --- end to end through dispatch ----------------------------------------------------

test('dispatch("review") on win32 spawns node with npx-cli.js ahead of the package', async () => {
  const calls = [];
  const { code, error } = await dispatch('review', ['--base', 'origin/main'], {
    spawnFn: recordSpawn(calls),
    npxEnv: { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: only(WIN_NPX_CLI, WIN_NPX_CMD) },
  });

  assert.equal(error, undefined);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, WIN_EXEC_PATH);
  assert.deepEqual(calls[0].args, [WIN_NPX_CLI, 'adversarial-review', '--base', 'origin/main']);
});

test('dispatch("review") on posix spawns node with npx-cli.js ahead of the package', async () => {
  const calls = [];
  await dispatch('review', ['--scope', 'working-tree'], {
    spawnFn: recordSpawn(calls),
    npxEnv: { platform: 'linux', execPath: POSIX_EXEC_PATH, isFile: only(POSIX_PREFIX_CLI) },
  });

  assert.equal(calls[0].cmd, POSIX_EXEC_PATH);
  assert.deepEqual(calls[0].args, [POSIX_PREFIX_CLI, 'adversarial-review', '--scope', 'working-tree']);
});

test('no dispatch path ever asks for a shell', async () => {
  // AC3's pin: the fix must not have bought Windows reachability with `shell: true`.
  for (const npxEnv of [
    { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: only(WIN_NPX_CLI) },
    { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: only(WIN_NPX_CMD) },
    { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: () => false },
    { platform: 'linux', execPath: POSIX_EXEC_PATH, isFile: only(POSIX_PREFIX_CLI) },
    present([POSIX_NPX_SIBLING], { platform: 'linux', execPath: POSIX_EXEC_PATH }),
    { platform: 'linux', execPath: POSIX_EXEC_PATH, isFile: () => false },
  ]) {
    const calls = [];
    await dispatch('review', ['x'], { spawnFn: recordSpawn(calls), npxEnv });

    assert.equal(calls[0].options.shell, undefined, `shell requested for ${npxEnv.platform}`);
    assert.equal(calls[0].options.stdio, 'inherit');
  }
});

test('shell metacharacters in user args survive as literal separate argv entries', async () => {
  // The reason shell: true was rejected. `adlc review --focus '...'` carries arbitrary
  // user text; under a shell these would be operators, and the win32 branch is the one
  // that would have needed the shell.
  const hostile = ['--focus', 'a & b | c', '--label', '"quoted" ^caret^', '>out.txt'];
  const calls = [];

  await dispatch('review', hostile, {
    spawnFn: recordSpawn(calls),
    npxEnv: { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: only(WIN_NPX_CLI) },
  });

  assert.deepEqual(calls[0].args, [WIN_NPX_CLI, 'adversarial-review', ...hostile]);
});

test('an unresolved npx names the probed paths so the failure is not mistaken for a missing package', async () => {
  const calls = [];
  const { code, error } = await dispatch('review', [], {
    spawnFn: recordSpawn(calls, { error: new Error('spawn npx ENOENT') }),
    npxEnv: { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: () => false },
  });

  assert.equal(code, 1);
  assert.match(error, /adversarial-review/);
  assert.match(error, /spawn npx ENOENT/);
  assert.ok(error.includes(WIN_NPX_CLI), `expected the probed path in: ${error}`);
});

test('a resolved npx does NOT carry the probe diagnostic — on either rung', async () => {
  // Otherwise the message above would be noise on every ordinary failure and would stop
  // distinguishing anything. Both rungs that count as resolved are covered: the
  // npx-cli.js layout and the POSIX sibling script.
  for (const npxEnv of [
    { platform: 'win32', execPath: WIN_EXEC_PATH, isFile: only(WIN_NPX_CLI) },
    present([POSIX_NPX_SIBLING], { platform: 'linux', execPath: POSIX_EXEC_PATH }),
  ]) {
    const calls = [];
    const { error } = await dispatch('review', [], {
      spawnFn: recordSpawn(calls, { error: new Error('boom') }),
      npxEnv,
    });

    assert.equal(error, 'failed to run npx adversarial-review: boom', `for ${npxEnv.platform}`);
  }
});

// --- the real machine ---------------------------------------------------------------

test('with no injection, the resolution is internally consistent on this runner', () => {
  // Guards against the whole ladder being fixture-only, WITHOUT assuming the runner's
  // node ships an adjacent npm (a distro-split node does not, and that must degrade
  // rather than fail the suite).
  const { command, prefixArgs, resolved, probed } = resolveNpxInvocation();

  assert.ok(probed.length > 0);
  if (resolved) {
    const target = prefixArgs[0] ?? command;
    assert.equal(statSync(target).isFile(), true, `${target} should be a regular file`);
    assert.equal(probed.includes(target), true, 'the chosen target must be one it probed');
    if (prefixArgs.length > 0) assert.equal(command, process.execPath);
    else assert.equal(dirname(command), dirname(process.execPath));
  } else {
    assert.equal(command, 'npx');
    assert.deepEqual(prefixArgs, []);
  }
});
