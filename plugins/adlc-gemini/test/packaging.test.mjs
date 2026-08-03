// packaging.test.mjs — release-readiness (T37 AC1/AC2/AC3).
//
// AC1/AC2 prove @adlc/gemini publishes only its runtime surface
// (never test/, and plugin.json — agy's own manifest — MUST ship, since agy
// identifies an installed plugin by its presence) and carries the fields the
// lockstep release requires. AC3 proves the package stays self-contained: no
// @adlc/* runtime dependency, since `agy plugin install` copies the plugin
// WITHOUT node_modules (see core-inline.mjs for the rationale) — a regression
// adding one would silently break every fresh `agy plugin install`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

// --- AC1: package.json field contract -------------------------------------

// T38 P5 finding F1: cursor/opencode's install-smoke scripts guard their
// package.json 'name' field; pi/antigravity had no such guard, so a stale
// -package suffix regressing back in would ship silently.
test('T38: package.json name is the renamed short form', () => {
  assert.equal(pkg.name, '@adlc/gemini');
});

test('AC1: package.json is publishable (not private, licensed, sourced)', () => {
  assert.notEqual(pkg.private, true, 'package must not be private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, 'plugins/adlc-gemini');
  assert.match(pkg.repository?.url ?? '', /github\.com\/voodootikigod\/adlc/);
  assert.ok(pkg.homepage, 'homepage required');
  assert.ok(pkg.bugs, 'bugs required');
  assert.ok(pkg.author, 'author required');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('gemini'), 'keywords must include "gemini"');
});

// P5 finding 1 (release-blocking): scripts/release.mjs:136 runs
// `npm publish --provenance` with NO --access flag — it relies on every
// package declaring publishConfig.access=public (release.mjs's own header
// comment states this invariant). A scoped @adlc/* package with no
// publishConfig defaults to RESTRICTED access, and --provenance on a
// restricted-defaulting scoped package fails at actual publish time — landing
// AFTER packages/* already published (a partial-release repeat of the T30
// incident). Mirror @adlc/pi / @adlc/opencode exactly.
test('AC1: publishConfig grants public access + provenance (release.mjs relies on this, not --access)', () => {
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
});

test('AC1 (real subprocess): npm publish --dry-run reports PUBLIC access, never "default access"', () => {
  // Dry-run against a throwaway, never-published version. npm aborts a dry-run for
  // an ALREADY-published version before printing the access line ("cannot publish
  // over the previously published versions: X"), which would flip this assertion red
  // the moment the current version ships. Bumping to an unpublishable-high version
  // keeps the public-access check deterministic regardless of what is live on the
  // registry. The real package.json is restored in finally.
  const pkgJsonPath = join(pkgDir, 'package.json');
  const originalPkgJson = readFileSync(pkgJsonPath, 'utf8');
  let out;
  try {
    writeFileSync(pkgJsonPath, JSON.stringify({ ...JSON.parse(originalPkgJson), version: '999.999.999' }, null, 2) + '\n');
    const res = spawnSync('npm', ['publish', '--dry-run'], { cwd: pkgDir, encoding: 'utf8', timeout: 60_000 });
    out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  } finally {
    writeFileSync(pkgJsonPath, originalPkgJson);
  }
  assert.match(out, /with tag latest and public access/, `expected real npm to report public access:\n${out}`);
  assert.ok(!/default access/.test(out), `npm reported "default access" (restricted) — publishConfig is missing or wrong:\n${out}`);
});

// --- AC3: self-contained by design — no @adlc/* runtime dependency --------

test('AC3: no @adlc/* runtime dependency (agy copies without node_modules)', () => {
  const deps = pkg.dependencies ?? {};
  const adlcDeps = Object.keys(deps).filter((name) => name.startsWith('@adlc/'));
  assert.deepEqual(adlcDeps, [], `must stay self-contained — found: ${adlcDeps.join(', ')}`);
});

// --- AC2: files allowlist + real npm pack ----------------------------------

test('AC2: files allowlist ships the runtime surface, plugin.json, and never test/', () => {
  const files = pkg.files ?? [];
  for (const entry of ['agents/', 'bin/', 'build-gate-inline.mjs', 'commands/', 'constants.mjs', 'core-inline.mjs', 'flail-inline.mjs', 'hooks/', 'hooks.json', 'rails-checker.mjs', 'skills/', 'plugin.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(entry), `files must include ${entry}`);
  }
  assert.ok(!files.some((f) => f.replace(/^\.\//, '').startsWith('test')), 'files must not include test/');
});

test('AC2: npm pack --dry-run ships the runtime surface, plugin.json, and NO test files', () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8', timeout: 120_000 });
  assert.equal(res.status, 0, `npm pack failed:\n${res.stderr}`);
  const manifest = JSON.parse(res.stdout);
  const paths = manifest[0].files.map((f) => f.path.replace(/^\.\//, ''));

  for (const dir of ['agents/', 'bin/', 'commands/', 'hooks/', 'skills/']) {
    assert.ok(paths.some((p) => p.startsWith(dir)), `pack must include ${dir}`);
  }
  for (const file of ['bin/cli.mjs', 'build-gate-inline.mjs', 'constants.mjs', 'core-inline.mjs', 'flail-inline.mjs', 'hooks.json', 'rails-checker.mjs', 'plugin.json', 'README.md', 'LICENSE']) {
    assert.ok(paths.includes(file), `pack must include ${file}`);
  }
  assert.ok(!paths.some((p) => p.startsWith('test/')), `pack must NOT include test/: ${paths.filter((p) => p.startsWith('test/')).join(', ')}`);
});

test('AC2: plugin.json version is untouched by this ticket (still agy-native, not lockstep)', () => {
  const pluginManifest = JSON.parse(readFileSync(join(pkgDir, 'plugin.json'), 'utf8'));
  assert.equal(pluginManifest.name, 'adlc-gemini');
  // Not asserting an exact version — only that it exists and is independent of
  // package.json's lockstep version (proves the two are not accidentally synced).
  assert.ok(pluginManifest.version, 'plugin.json keeps its own version field');
});

// --- AC4: the packed tarball actually loads --------------------------------

// The AC1/AC2 checks above compare against a HARDCODED file list, so they pass
// whenever the list matches itself — they cannot see a module the tarball
// imports but never ships. That blind spot published 1.4.1 with
// core-inline.mjs importing ./generated-ticket-reader.mjs while the files
// allowlist omitted it: every npm install hit the shim fail-safe, which
// allow-alls when ADLC_P4_ENFORCEMENT is unset, so rails were silently
// unenforced on the primary distribution path.
//
// Resolving the real entry point out of a real tarball is what makes that class
// of defect impossible to ship: the import graph is the assertion, so a newly
// added relative import is covered without anyone remembering to list it.
// agy copies plugins WITHOUT node_modules (see AC3), so extracting with no
// node_modules present is the faithful install, not a stricter one.
test('AC4: packed tarball extracted outside the repo imports rails-checker with no node_modules', () => {
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-pack-'));
  try {
    const tarballName = execFileSync('npm', ['pack', '--pack-destination', work], {
      cwd: pkgDir,
      encoding: 'utf8',
      timeout: 120_000,
    })
      .trim()
      .split('\n')
      .pop();
    const extractedRoot = join(work, 'extracted');
    mkdirSync(extractedRoot, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, tarballName), '-C', extractedRoot]);
    const pkgRoot = join(extractedRoot, 'package'); // npm tarballs always nest under package/

    // Every module the plugin's own manifest points agy at must both ship and
    // resolve — including each module they import transitively.
    const entryPoints = ['rails-checker.mjs', 'core-inline.mjs', pkg.gemini.hooks.replace(/^\.\//, '')];
    for (const entry of entryPoints) {
      assert.ok(existsSync(join(pkgRoot, entry)), `tarball must ship ${entry}`);
    }

    // Importing is the real gate: a relative import of an unshipped module
    // throws ERR_MODULE_NOT_FOUND here, which is exactly the 1.4.1 break.
    const res = spawnSync(
      'node',
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'rails-checker.mjs')).href)})`],
      { encoding: 'utf8', timeout: 30_000, cwd: pkgRoot }
    );
    assert.equal(
      res.status,
      0,
      `packed rails-checker.mjs must import standalone with no node_modules — a relative import is missing from the files allowlist:\n${res.stderr}`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

/**
 * Build an environment whose HOME is sealed on EVERY platform.
 *
 * HOME alone is not enough: os.homedir() consults USERPROFILE first on Windows,
 * then HOMEDRIVE+HOMEPATH — all inherited through ...process.env. A test that
 * overrides only HOME still resolves the developer's real profile there, and
 * cli.mjs's direct-copy fallback would write into their live .gemini plugin.
 * One helper so the four call sites cannot drift apart again.
 *
 * @param {string} home Sandbox home directory.
 * @param {string} pathValue PATH for the child process.
 */
function sealedEnv(home, pathValue) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: pathValue };
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  return env;
}

/**
 * Run bin/cli.mjs with HOME and PATH SEALED OFF from the developer's machine.
 *
 * This is a containment control, not tidiness. cli.mjs installs for real: it
 * spawns the ambient `agy`, and when agy is missing or reports failure it falls
 * back to `cpSync(packageRoot, ~/.gemini/config/plugins/adlc-gemini)`. Run
 * with the inherited environment, that writes into the developer's LIVE plugin.
 *
 * That is not hypothetical. The mutation gate mutates cli.mjs in place, and the
 * `status === 0` → `status === 1` mutant made a SUCCESSFUL agy install read as a
 * failure — so these tests copied MUTATED source into the live plugin, which was
 * later found serving `if (status === 1)`. The gate restores the repo checkout;
 * it cannot restore anything outside it. Any test that executes this CLI must
 * therefore be sealed, including ones that only expect to print help: a mutant
 * that flips the `--help` guard falls straight through into the install path.
 *
 * PATH deliberately omits `agy`, so the fallback branch is what runs and the
 * assertion below can prove the copy landed inside the sandbox. process.execPath
 * is used instead of the string 'node' because PATH no longer resolves it.
 */
function runCliSealed(args, { agyScript, seedTarget, extraEnv } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-sealed-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });

  // Pre-populate the live plugin directory to model an UPGRADE over an install
  // that already exists.
  for (const [relative, contents] of Object.entries(seedTarget ?? {})) {
    const abs = join(home, '.gemini', 'config', 'plugins', 'adlc-gemini', relative);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  // PATH omits agy by default, so the fallback branch runs. Pass agyScript to
  // put a stub agy in front of it instead.
  let pathValue = '/usr/bin:/bin';
  if (agyScript) {
    const binDir = join(work, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'agy'), agyScript);
    chmodSync(join(binDir, 'agy'), 0o755);
    pathValue = `${binDir}:${pathValue}`;
  }

  const env = { ...sealedEnv(home, pathValue), ...(extraEnv ?? {}) };

  const res = spawnSync(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  });
  return { res, work, home, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

test('AC4: bin/cli.mjs executable displays help output on --help', () => {
  const { res, cleanup } = runCliSealed(['--help']);
  try {
    assert.equal(res.status, 0);
    assert.match(res.stdout, /adlc-gemini install/);
    assert.match(res.stdout, /\[agent\] plugin install <path>/);
  } finally {
    cleanup();
  }
});

test('AC4: bin/cli.mjs runs install command and does not trigger help mode', () => {
  const { res, home, cleanup } = runCliSealed(['install']);
  try {
    assert.match(res.stdout, /Installing @adlc\/gemini plugin from:/);
    assert.doesNotMatch(res.stdout, /ADLC Google Gemini Plugin Helper/);
    // CONTAINMENT, asserted rather than assumed: with no agy on PATH the helper
    // takes its direct-copy fallback, and that copy must land under the sandbox
    // HOME. If this file ever escapes again, this assertion is what notices.
    assert.ok(
      existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini', 'plugin.json')),
      'the fallback copy must land under the sandboxed HOME, not the real one',
    );
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs ignores a repo-local node_modules/.bin/agy (npx PATH hijack)', () => {
  // `npx @adlc/gemini@latest install` runs through npm exec, which PREPENDS
  // the current project's node_modules/.bin to the child PATH. Pinning the npx
  // spec protects which helper is fetched; it does nothing about which `agy` that
  // helper then runs. A repo shipping a dependency with a bin named `agy` gets
  // arbitrary code executed the moment the helper probes `agy --version`.
  // Verified reproducible against a real npm install before this guard existed.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-hijack-'));
  try {
    const home = join(work, 'home');
    const evilBin = join(work, 'project', 'node_modules', '.bin');
    const realBin = join(work, 'realbin');
    const marker = join(work, 'who-ran.txt');
    mkdirSync(home, { recursive: true });
    mkdirSync(evilBin, { recursive: true });
    mkdirSync(realBin, { recursive: true });

    for (const [dir, label] of [[evilBin, 'ATTACKER'], [realBin, 'REAL']]) {
      writeFileSync(
        join(dir, 'agy'),
        `#!/bin/sh\nprintf '%s\\n' "${label} $*" >> "${marker}"\n` +
          `if [ "$1" = "--version" ]; then echo 1.1.8; fi\nexit 0\n`,
      );
      chmodSync(join(dir, 'agy'), 0o755);
    }

    // Exactly npm exec's layout: the project's .bin FIRST, the real one behind it.
    const env = sealedEnv(home, `${evilBin}:${realBin}:/usr/bin:/bin`);

    const res = spawnSync(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      encoding: 'utf8',
      timeout: 20_000,
      env,
    });
    assert.equal(res.status, 0, `install failed: ${res.stdout}\n${res.stderr}`);

    const ran = readFileSync(marker, 'utf8');
    assert.ok(!ran.includes('ATTACKER'), `a repo-local node_modules/.bin/agy was executed:\n${ran}`);
    assert.ok(ran.includes('REAL'), `the trusted agy was never reached:\n${ran}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs direct-copy REPLACES an existing install, dropping removed files', () => {
  // cpSync over an existing directory only overwrites files still present in the
  // source, so an upgrade would strand every skill/agent/hook a later version
  // deleted. agy loads whatever is in this directory, so a retired hook would
  // keep firing from a plugin reporting the new version.
  const { res, home, cleanup } = runCliSealed(['install'], {
    seedTarget: { 'skills/retired-skill.md': 'a skill a later version deleted\n' },
  });
  try {
    assert.equal(res.status, 0, `install failed: ${res.stdout}\n${res.stderr}`);
    const target = join(home, '.gemini', 'config', 'plugins', 'adlc-gemini');
    assert.ok(existsSync(join(target, 'plugin.json')), 'the new payload must be installed');
    assert.ok(
      !existsSync(join(target, 'skills', 'retired-skill.md')),
      'a file removed upstream must not survive the upgrade',
    );
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs self-reinstall from the installed copy does not erase the plugin', () => {
  // `node ~/.gemini/config/plugins/adlc-gemini/bin/cli.mjs install` from a
  // session with no agy on PATH makes packageRoot === targetDir. A replace-first
  // fallback deletes the directory it is about to copy FROM, so the advertised
  // idempotent reinstall would erase the plugin and its hooks outright.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-self-'));
  try {
    const home = join(work, 'home');
    const target = join(home, '.gemini', 'config', 'plugins', 'adlc-gemini');
    mkdirSync(join(target, 'bin'), { recursive: true });
    writeFileSync(join(target, 'bin', 'cli.mjs'), readFileSync(join(pkgDir, 'bin', 'cli.mjs')));
    writeFileSync(join(target, 'plugin.json'), '{"name":"adlc-gemini"}\n');

    const res = spawnSync(process.execPath, [join(target, 'bin', 'cli.mjs'), 'install'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: sealedEnv(home, '/usr/bin:/bin'), // no agy → the direct-copy branch
    });

    assert.equal(res.status, 0, `self-reinstall failed: ${res.stdout}\n${res.stderr}`);
    assert.ok(existsSync(join(target, 'plugin.json')), 'the installed plugin must survive a self-reinstall');
    assert.ok(existsSync(join(target, 'bin', 'cli.mjs')), 'the helper itself must survive a self-reinstall');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs rejects an ADLC_AGY_TIMEOUT_MS that would disable the bound', () => {
  // Both of these DISABLE the protection rather than shorten it: spawnSync treats
  // 0 as "no timeout", and Infinity is not a duration. Quietly falling back to the
  // default would leave an operator believing their bound is in force while the
  // hang it exists to prevent is back — so an unusable value is refused outright.
  for (const value of ['0', 'Infinity', '-1', 'soon']) {
    const { res, cleanup } = runCliSealed(['install'], {
      agyScript: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\nexit 0\n',
      extraEnv: { ADLC_AGY_TIMEOUT_MS: value },
    });
    try {
      assert.equal(res.status, 1, `ADLC_AGY_TIMEOUT_MS=${value} must be refused, not accepted`);
      assert.match(res.stderr, /must be a positive, finite number of milliseconds/);
    } finally {
      cleanup();
    }
  }
});

test('bin/cli.mjs accepts the smallest positive ADLC_AGY_TIMEOUT_MS (boundary is 0, not 1)', () => {
  // The contract is "positive and finite", so the boundary sits at 0. 1ms is
  // pathological but legal; refusing it would impose an arbitrary undocumented
  // floor. The run still fails — no real agy finishes in 1ms — but it must fail as
  // a TIMEOUT, not as malformed configuration, and that distinction is the only
  // thing separating a correct boundary from an off-by-one.
  const { res, cleanup } = runCliSealed(['install'], {
    agyScript: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\nsleep 5\n',
    extraEnv: { ADLC_AGY_TIMEOUT_MS: '1' },
  });
  try {
    assert.doesNotMatch(
      res.stderr,
      /must be a positive, finite number/,
      'a positive duration must not be refused as malformed configuration',
    );
    assert.equal(res.status, 1, 'a 1ms bound still cannot complete an install');
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs bounds an agy that IGNORES SIGTERM', () => {
  // A single-signal timeout is not a bound. Measured directly: spawnSync with
  // killSignal SIGTERM against a child trapping SIGTERM returned after 6147ms for
  // a 300ms timeout, versus 303ms with SIGKILL. So SIGKILL alone risks tearing agy
  // down mid-copy, SIGTERM alone lets a wedged agy hang forever, and only
  // escalation gives both — this asserts the escalation actually escalates.
  const started = Date.now();
  const { res, cleanup } = runCliSealed(['install'], {
    agyScript:
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\n' +
      "trap '' TERM\nsleep 600\n",
    extraEnv: { ADLC_AGY_TIMEOUT_MS: '1000' },
  });
  try {
    const elapsed = Date.now() - started;
    // No harness escape hatch: if the OUTER spawnSync timeout fired instead of our
    // bound, res.error is set and status is null, so this must be checked or the
    // test could pass on the harness's timeout rather than the behaviour under test.
    assert.ok(!res.error, `the outer harness timed out, not our bound: ${res.error?.code}`);
    assert.equal(res.status, 1, `an unkillable-by-TERM agy must still fail:\n${res.stderr}`);
    assert.match(res.stderr, /did not complete/);
    // 1s timeout + 2s grace + overhead. The 600s sleep is the control: without
    // escalation to SIGKILL this cannot finish anywhere near here.
    assert.ok(elapsed < 30_000, `the bound did not hold — took ${elapsed}ms`);
  } finally {
    cleanup();
  }
});

/**
 * Read a pid from a file a shell stub is writing, waiting for real CONTENT.
 *
 * `echo $! > file` creates the file before the bytes land, so existsSync alone
 * yields an empty read — and Number('') is 0. That matters far more than a flaky
 * assertion: process.kill(0, …) signals THE CALLER'S OWN PROCESS GROUP, so a pid of
 * 0 reaching the helpers below would SIGKILL the test runner. Hence pid > 1 (1 is
 * init) here and a hard guard in both helpers.
 */
function readPidWhenReady(pidFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
  }
  return 0;
}

/** Poll until `pid` is gone, or the deadline passes. Returns true if it survived. */
function survives(pid, ms) {
  assert.ok(Number.isInteger(pid) && pid > 1, `refusing to probe pid ${pid} — 0 means our own group`);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
  }
  return true;
}

/** Best-effort reaping so a failing assertion does not litter the machine. */
function reap(pid) {
  // Never signal 0 or 1: 0 is our own process group, 1 is init.
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

test('bin/cli.mjs SIGKILLs a surviving agy WORKER even when the leader exits on SIGTERM', () => {
  // The topology that matters, and the one an earlier version of this test missed:
  // the group LEADER handles SIGTERM and exits promptly while a WORKER ignores it.
  // If escalation is cancelled by the leader's exit, the helper resolves and
  // deletes the staging directory with that worker still running against it.
  //
  // The worker PID is captured with `$!`, not `$$`. Verified on this platform:
  // inside `( … ) &`, `$$` expands to the LEADER's pid, so the earlier test was
  // asserting that the leader died — something a plain single-PID kill also does.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-tree-'));
  let workerPidValue = 0;
  try {
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const pidFile = join(work, 'worker.pid');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(binDir, 'agy'),
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\n' +
        // Worker ignores SIGTERM; its real pid is recorded via $!.
        "( trap '' TERM; sleep 600 ) &\n" +
        `echo $! > "${pidFile}"\n` +
        // Leader takes the default disposition: SIGTERM exits it immediately.
        'wait\n',
    );
    chmodSync(join(binDir, 'agy'), 0o755);

    const res = spawnSync(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...sealedEnv(home, `${binDir}:/usr/bin:/bin`), ADLC_AGY_TIMEOUT_MS: '1000' },
    });
    assert.ok(!res.error, `the outer harness timed out, not our bound: ${res.error?.code}`);
    assert.equal(res.status, 1, `a wedged agy tree must fail:\n${res.stderr}`);

    workerPidValue = readPidWhenReady(pidFile, 5_000);
    assert.ok(workerPidValue > 1, 'stub must record a worker pid');
    assert.equal(
      survives(workerPidValue, 5_000),
      false,
      `a SIGTERM-ignoring worker survived the timeout (pid ${workerPidValue})`,
    );
  } finally {
    if (workerPidValue) reap(workerPidValue);
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs forwards Ctrl-C to the detached agy group and cleans staging', async () => {
  // Detaching agy so the timeout can bound its tree also detaches it from the
  // terminal: Ctrl-C reaches only OUR process group. Without forwarding, the user
  // gets their prompt back while agy keeps rewriting the live plugin directory,
  // and the staging `finally` never runs because the default disposition kills us.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-sigint-'));
  let leaderPidValue = 0;
  try {
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const pidFile = join(work, 'agy.pid');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'agy'),
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\n' +
        `echo $$ > "${pidFile}"\n` +
        'sleep 600\n',
    );
    chmodSync(join(binDir, 'agy'), 0o755);

    // GIVE THE CHILD ITS OWN TMPDIR, so "was staging left behind" is a question
    // about THIS cli.mjs and nothing else.
    //
    // cli.mjs stages under os.tmpdir(), which is shared machine-wide. A
    // before/after delta over the shared directory attributes to this test every
    // adlc-agy-XXXXXX that appears during its window — including ones created by a
    // cli.mjs running in another worktree, another agent session, or a second CI
    // job on the same host. That is what made this flake load-dependent: the
    // assertion failed on a directory this test never created, while the CLI's own
    // cleanup was correct (it rmSync's staging before process.exit, on every path).
    // Isolating TMPDIR makes the observation exact instead of probabilistic, so the
    // guarantee below is asserted immediately and strictly — no polling, no grace.
    const stagingRoot = join(work, 'staging');
    mkdirSync(stagingRoot, { recursive: true });

    const child = spawn(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      env: {
        ...sealedEnv(home, `${binDir}:/usr/bin:/bin`),
        TMPDIR: stagingRoot,
        ADLC_AGY_TIMEOUT_MS: '60000',
      },
      stdio: 'ignore',
    });

    // The helper's OWN EXIT is the synchronization point, not agy's death. The
    // interrupt handler escalates TERM->KILL over a grace period and removes
    // staging on its way out, so sampling the moment agy dies races that cleanup —
    // which is exactly how the first version of this test failed intermittently.
    const exited = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => resolveExit({ code, signal }));
    });

    // Wait for agy to be running, then interrupt the helper as a user would.
    leaderPidValue = readPidWhenReady(pidFile, 20_000);
    assert.ok(leaderPidValue > 1, 'the stub agy never recorded its pid');
    child.kill('SIGINT');

    const { code } = await exited;
    // 128 + SIGINT(2): a cancelled install must not look like a clean one to
    // whatever invoked it.
    assert.equal(code, 130, `expected exit 130 for a Ctrl-C'd install, got ${code}`);

    assert.equal(
      survives(leaderPidValue, 10_000),
      false,
      `agy survived Ctrl-C of its parent (pid ${leaderPidValue})`,
    );
    // Staging must not survive a cancelled install either — the `finally` cannot
    // run once a signal terminates us, so the interrupt handler has to do it.
    const leaked = readdirSync(stagingRoot).filter((entry) => /^adlc-agy-[A-Za-z0-9]{6}$/.test(entry));
    assert.deepEqual(leaked, [], `cancelled install left staging behind: ${leaked.join(', ')}`);
  } finally {
    if (leaderPidValue) reap(leaderPidValue);
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs Ctrl-C kills a SIGTERM-IGNORING worker after the leader exits', async () => {
  // The topology the first Ctrl-C test missed: it used a leader whose whole tree
  // died on SIGTERM, so it could not see that escalation had lost its handle.
  // activeChildren is mutable and drops a child the moment it exits, so a leader
  // that exits promptly leaves the delayed SIGKILL with nothing to signal — and a
  // worker that ignores SIGTERM keeps rewriting the plugin directory while the
  // user's retry races it.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-sigint2-'));
  let workerPidValue = 0;
  try {
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const pidFile = join(work, 'worker.pid');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'agy'),
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\n' +
        // Worker ignores SIGTERM; recorded via $! (NOT $$, which is the leader).
        "( trap '' TERM; sleep 600 ) &\n" +
        `echo $! > "${pidFile}"\n` +
        // Leader takes the default disposition, so SIGTERM exits it at once.
        'wait\n',
    );
    chmodSync(join(binDir, 'agy'), 0o755);

    const child = spawn(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      env: { ...sealedEnv(home, `${binDir}:/usr/bin:/bin`), ADLC_AGY_TIMEOUT_MS: '60000' },
      stdio: 'ignore',
    });
    const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));

    workerPidValue = readPidWhenReady(pidFile, 20_000);
    assert.ok(workerPidValue > 1, 'the stub agy never recorded a worker pid');
    child.kill('SIGINT');

    const code = await exited;
    assert.equal(code, 130, `expected exit 130 for a Ctrl-C'd install, got ${code}`);
    assert.equal(
      survives(workerPidValue, 5_000),
      false,
      `a SIGTERM-ignoring worker outlived cancellation (pid ${workerPidValue})`,
    );
  } finally {
    if (workerPidValue) reap(workerPidValue);
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs Ctrl-C during the VERSION PROBE reaps the worker and reports cancellation', async () => {
  // The third exit path to carry this bug. The probe-failure branch exited 1
  // directly, which cancelled the pending group SIGKILL, returned 1 instead of
  // 130, and left a SIGTERM-ignoring worker alive to race the user's retry.
  //
  // It also went unfixed longer than the others because an earlier patch to this
  // exact branch silently no-oped on an indentation mismatch — so this test exists
  // partly to make that class of miss impossible to repeat quietly.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-probe-'));
  let workerPidValue = 0;
  try {
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const pidFile = join(work, 'worker.pid');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // --version itself forks a worker that ignores SIGTERM, then hangs.
    writeFileSync(
      join(binDir, 'agy'),
      '#!/bin/sh\n' +
        "( trap '' TERM; sleep 600 ) &\n" +
        `echo $! > "${pidFile}"\n` +
        'wait\n',
    );
    chmodSync(join(binDir, 'agy'), 0o755);

    // Own TMPDIR for the same reason as the Ctrl-C test above: a shared-tmpdir
    // delta blames this test for staging created by any other concurrent cli.mjs.
    const stagingRoot = join(work, 'staging');
    mkdirSync(stagingRoot, { recursive: true });

    const child = spawn(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      env: {
        ...sealedEnv(home, `${binDir}:/usr/bin:/bin`),
        TMPDIR: stagingRoot,
        ADLC_AGY_TIMEOUT_MS: '60000',
      },
      stdio: 'ignore',
    });
    const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));

    workerPidValue = readPidWhenReady(pidFile, 20_000);
    assert.ok(workerPidValue > 1, 'the stub agy --version never recorded a worker pid');
    child.kill('SIGINT');

    const code = await exited;
    assert.equal(code, 130, `a Ctrl-C'd probe must report cancellation, not failure; got ${code}`);
    assert.equal(
      survives(workerPidValue, 5_000),
      false,
      `a probe worker outlived cancellation (pid ${workerPidValue})`,
    );
    // Cancelling the probe must not go on to start an install.
    const created = readdirSync(stagingRoot).filter((entry) => /^adlc-agy-[A-Za-z0-9]{6}$/.test(entry));
    assert.deepEqual(created, [], `an install was staged after cancellation: ${created.join(', ')}`);
  } finally {
    if (workerPidValue) reap(workerPidValue);
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs does not delete staging while a cancelled agy worker still reads it', async () => {
  // ORDERING, not just liveness. On Ctrl-C the leader exits on SIGTERM; if that
  // exit settles runBounded, the caller's `finally` removes the staged source while
  // a SIGTERM-ignoring worker is still copying out of it — two seconds before
  // escalation reaches that worker. The worker here reports if its source vanishes
  // underneath it, which is the observable that distinguishes correct ordering from
  // "everything died eventually".
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-order-'));
  let workerPidValue = 0;
  try {
    const home = join(work, 'home');
    const binDir = join(work, 'bin');
    const pidFile = join(work, 'worker.pid');
    const vanished = join(work, 'vanished');
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // `agy plugin install <staged>` → the staged path is $3.
    writeFileSync(
      join(binDir, 'agy'),
      '#!/bin/sh\n' +
        'if [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\n' +
        'STAGED="$3"\n' +
        "( trap '' TERM\n" +
        '  i=0\n' +
        '  while [ $i -lt 200 ]; do\n' +
        `    [ -d "$STAGED" ] || { echo yes > "${vanished}"; exit 0; }\n` +
        '    sleep 0.05\n' +
        '    i=$((i+1))\n' +
        '  done ) &\n' +
        `echo $! > "${pidFile}"\n` +
        'wait\n',
    );
    chmodSync(join(binDir, 'agy'), 0o755);

    const child = spawn(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
      env: { ...sealedEnv(home, `${binDir}:/usr/bin:/bin`), ADLC_AGY_TIMEOUT_MS: '60000' },
      stdio: 'ignore',
    });
    const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));

    workerPidValue = readPidWhenReady(pidFile, 20_000);
    assert.ok(workerPidValue > 1, 'the stub agy never recorded a worker pid');
    child.kill('SIGINT');
    const code = await exited;

    assert.equal(code, 130, `expected exit 130 for a Ctrl-C'd install, got ${code}`);
    assert.ok(
      !existsSync(vanished),
      'the staged source was deleted while a cancelled worker was still reading it',
    );
    assert.equal(
      survives(workerPidValue, 5_000),
      false,
      `the worker outlived cancellation (pid ${workerPidValue})`,
    );
  } finally {
    if (workerPidValue) reap(workerPidValue);
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs ignores RELATIVE PATH entries when resolving agy', () => {
  // join('.', 'agy') is 'agy' and join('bin', 'agy') is 'bin/agy' — both resolve
  // against the CURRENT DIRECTORY, so a PATH containing '.' or a project-relative
  // bin dir lets the repository supply the very executable this resolution exists
  // to distrust. Resolving to an absolute path is the entire point.
  for (const relativeEntry of ['.', 'bin']) {
    const work = mkdtempSync(join(tmpdir(), 'adlc-agy-relpath-'));
    try {
      const home = join(work, 'home');
      const cwd = join(work, 'repo');
      const realBin = join(work, 'realbin');
      const marker = join(work, 'who-ran.txt');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(cwd, 'bin'), { recursive: true });
      mkdirSync(realBin, { recursive: true });

      // The attacker's agy sits where the relative entry points, from cwd.
      const evilPath = relativeEntry === '.' ? join(cwd, 'agy') : join(cwd, 'bin', 'agy');
      for (const [abs, label] of [[evilPath, 'ATTACKER'], [join(realBin, 'agy'), 'REAL']]) {
        writeFileSync(
          abs,
          `#!/bin/sh\nprintf '%s\\n' "${label} $*" >> "${marker}"\n` +
            `if [ "$1" = "--version" ]; then echo 1.1.8; fi\nexit 0\n`,
        );
        chmodSync(abs, 0o755);
      }

      const res = spawnSync(process.execPath, [join(pkgDir, 'bin', 'cli.mjs'), 'install'], {
        encoding: 'utf8',
        timeout: 20_000,
        cwd,
        env: sealedEnv(home, `${relativeEntry}:${realBin}:/usr/bin:/bin`),
      });
      assert.equal(res.status, 0, `install failed: ${res.stdout}\n${res.stderr}`);

      const ran = readFileSync(marker, 'utf8');
      assert.ok(
        !ran.includes('ATTACKER'),
        `PATH entry "${relativeEntry}" let a cwd-relative agy run:\n${ran}`,
      );
      assert.ok(ran.includes('REAL'), `the trusted agy was never reached:\n${ran}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test('bin/cli.mjs does not hang forever on a wedged agy', () => {
  // spawnSync with no timeout waits indefinitely. A wedged agy would hang the
  // helper with no failure path and no cleanup — the staging directory surviving
  // for the lifetime of the hang, and any automation waiting forever.
  const { res, home, cleanup } = runCliSealed(['install'], {
    agyScript: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\nsleep 600\n',
    extraEnv: { ADLC_AGY_TIMEOUT_MS: '1500' },
  });
  try {
    assert.equal(res.status, 1, `a hung agy must fail, not hang:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /did not complete/);
    // Fail closed still applies: a hang is a PRESENT agy that did not install.
    assert.ok(
      !existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini')),
      'a hung agy must not be papered over by copying the files anyway',
    );
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs does not hang forever on a wedged agy version probe', () => {
  const { res, cleanup } = runCliSealed(['install'], {
    agyScript: '#!/bin/sh\nsleep 600\n', // hangs on --version itself
    extraEnv: { ADLC_AGY_TIMEOUT_MS: '1500' },
  });
  try {
    assert.equal(res.status, 1, `a hung version probe must fail, not hang:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /agy --version` failed/);
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs fails closed when a PRESENT agy fails its version probe', () => {
  // The complement of the rejection case. Treating a discovered-but-broken agy as
  // an ABSENT one routes straight back into copy-and-report-success: version
  // skew or a broken runtime would silently become "installed" for a plugin that
  // agy never validated or registered.
  const { res, home, cleanup } = runCliSealed(['install'], {
    agyScript: '#!/bin/sh\nexit 7\n', // present and executable, but --version fails
  });
  try {
    assert.equal(res.status, 1, `a broken agy must exit non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /agy --version` failed/);
    assert.ok(
      !existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini')),
      'a broken agy must NOT be papered over by copying the files anyway',
    );
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs fails closed when a PRESENT agy rejects the plugin', () => {
  // The direct copy is for a machine with NO agy. Reaching for it when an agy
  // that IS installed refused the plugin turns a manifest/compatibility rejection
  // into "✓ installed" with exit 0 — the plugin never registered, the cause lost
  // in scrollback, and any automation reading the status told it succeeded.
  const { res, home, cleanup } = runCliSealed(['install'], {
    agyScript: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.1.8; exit 0; fi\nexit 3\n',
  });
  try {
    assert.equal(res.status, 1, `a rejected install must exit non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /Not falling back to a direct copy/);
    assert.doesNotMatch(res.stdout, /Successfully installed/);
    // The load-bearing half: no silent direct copy behind agy's back.
    assert.ok(
      !existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-gemini')),
      'a rejected install must NOT be papered over by copying the files anyway',
    );
  } finally {
    cleanup();
  }
});

test('bin/cli.mjs hands agy a plugin path containing no "@"', () => {
  // agy resolves `plugin install <target>` as `plugin@marketplace` BEFORE
  // deciding whether the target is a filesystem path, so an `@` anywhere in the
  // argument is read as that separator. This package's only npm install
  // locations — `<npm root -g>/@adlc/gemini` and
  // `node_modules/@adlc/gemini` — both contain one, so passing packageRoot
  // straight through made agy answer `unknown marketplace: adlc/gemini`
  // and fall through to the manual copy path on every single run.
  //
  // The package root here is deliberately shaped like a real npm install: the
  // bug is invisible from a source checkout, whose path has no `@`.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-cli-'));
  try {
    const scopedRoot = join(work, 'node_modules', '@adlc', 'gemini');
    mkdirSync(join(scopedRoot, 'bin'), { recursive: true });
    writeFileSync(join(scopedRoot, 'bin', 'cli.mjs'), readFileSync(join(pkgDir, 'bin', 'cli.mjs')));
    writeFileSync(join(scopedRoot, 'plugin.json'), '{"name":"adlc-gemini"}\n');

    // A stub agy that records its argv. HOME is redirected too, so the fallback
    // copy path can never touch the developer's real ~/.gemini.
    const binDir = join(work, 'bin');
    const log = join(work, 'agy.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'agy'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    chmodSync(join(binDir, 'agy'), 0o755);

    const res = spawnSync('node', [join(scopedRoot, 'bin', 'cli.mjs'), 'install'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: sealedEnv(join(work, 'home'), `${binDir}:${process.env.PATH}`),
    });
    assert.equal(res.status, 0, `cli.mjs install failed: ${res.stderr}`);

    const logText = readFileSync(log, 'utf8');
    const installLine = logText.split('\n').find((line) => line.startsWith('plugin install '));
    assert.ok(installLine, `agy was never asked to install; log:\n${logText}`);

    const target = installLine.replace('plugin install ', '').trim();
    assert.ok(!target.includes('@'), `agy was handed a path it parses as plugin@marketplace: ${target}`);
    assert.match(res.stdout, /Successfully installed/);

    // agy COPIES the plugin into ~/.gemini/config/plugins/<name>/, so the staged
    // source is disposable — and must actually be disposed of, or every install
    // leaks a full copy of the plugin into TMPDIR.
    assert.ok(!existsSync(target), `the staging directory was left behind: ${target}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('bin/cli.mjs still stages @-free when TMPDIR itself contains an "@"', () => {
  // Staging only helps if the STAGED PATH is @-free, and os.tmpdir() honours
  // TMPDIR. A TMPDIR of /var/tmp/user@example.com would put the `@` straight
  // back into agy's argument and reproduce the original failure — with the
  // staging code sitting right there looking like it had handled it.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-cli-'));
  try {
    const scopedRoot = join(work, 'node_modules', '@adlc', 'gemini');
    mkdirSync(join(scopedRoot, 'bin'), { recursive: true });
    writeFileSync(join(scopedRoot, 'bin', 'cli.mjs'), readFileSync(join(pkgDir, 'bin', 'cli.mjs')));
    writeFileSync(join(scopedRoot, 'plugin.json'), '{"name":"adlc-gemini"}\n');

    const binDir = join(work, 'bin');
    const log = join(work, 'agy.log');
    const hostileTmp = join(work, 'user@example.com');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(hostileTmp, { recursive: true });
    writeFileSync(join(binDir, 'agy'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    chmodSync(join(binDir, 'agy'), 0o755);

    const res = spawnSync('node', [join(scopedRoot, 'bin', 'cli.mjs'), 'install'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...sealedEnv(join(work, 'home'), `${binDir}:${process.env.PATH}`), TMPDIR: hostileTmp },
    });
    assert.equal(res.status, 0, `cli.mjs install failed: ${res.stderr}`);

    const logText = readFileSync(log, 'utf8');
    const installLine = logText.split('\n').find((line) => line.startsWith('plugin install '));
    assert.ok(installLine, `agy was never asked to install; log:\n${logText}`);
    const target = installLine.replace('plugin install ', '').trim();
    assert.ok(
      !target.includes('@'),
      `a hostile TMPDIR put an "@" back into agy's argument: ${target}`,
    );
    assert.ok(!existsSync(target), `the staging directory was left behind: ${target}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

