// packaging.test.mjs — release-readiness (T37 AC1/AC2/AC3).
//
// AC1/AC2 prove @adlc/antigravity publishes only its runtime surface
// (never test/, and plugin.json — agy's own manifest — MUST ship, since agy
// identifies an installed plugin by its presence) and carries the fields the
// lockstep release requires. AC3 proves the package stays self-contained: no
// @adlc/* runtime dependency, since `agy plugin install` copies the plugin
// WITHOUT node_modules (see core-inline.mjs for the rationale) — a regression
// adding one would silently break every fresh `agy plugin install`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(pkg.name, '@adlc/antigravity');
});

test('AC1: package.json is publishable (not private, licensed, sourced)', () => {
  assert.notEqual(pkg.private, true, 'package must not be private');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository?.directory, 'plugins/adlc-antigravity');
  assert.match(pkg.repository?.url ?? '', /github\.com\/voodootikigod\/adlc/);
  assert.ok(pkg.homepage, 'homepage required');
  assert.ok(pkg.bugs, 'bugs required');
  assert.ok(pkg.author, 'author required');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('antigravity'), 'keywords must include "antigravity"');
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
  assert.equal(pluginManifest.name, 'adlc-antigravity');
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
    const entryPoints = ['rails-checker.mjs', 'core-inline.mjs', pkg.agy.hooks.replace(/^\.\//, '')];
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
 * Run bin/cli.mjs with HOME and PATH SEALED OFF from the developer's machine.
 *
 * This is a containment control, not tidiness. cli.mjs installs for real: it
 * spawns the ambient `agy`, and when agy is missing or reports failure it falls
 * back to `cpSync(packageRoot, ~/.gemini/config/plugins/adlc-antigravity)`. Run
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
function runCliSealed(args, { agyScript } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-sealed-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });

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

  // HOME alone does NOT seal this. os.homedir() consults USERPROFILE first on
  // Windows, then HOMEDRIVE+HOMEPATH — all inherited through ...process.env — so
  // overriding only HOME leaves a Windows run copying into the developer's real
  // .gemini directory, which is the exact corruption this helper exists to stop.
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: pathValue };
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;

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
    assert.match(res.stdout, /adlc-agy install/);
    assert.match(res.stdout, /agy plugin install <path>/);
  } finally {
    cleanup();
  }
});

test('AC4: bin/cli.mjs runs install command and does not trigger help mode', () => {
  const { res, home, cleanup } = runCliSealed(['install']);
  try {
    assert.match(res.stdout, /Installing @adlc\/antigravity plugin from:/);
    assert.doesNotMatch(res.stdout, /ADLC Google Antigravity Plugin Helper/);
    // CONTAINMENT, asserted rather than assumed: with no agy on PATH the helper
    // takes its direct-copy fallback, and that copy must land under the sandbox
    // HOME. If this file ever escapes again, this assertion is what notices.
    assert.ok(
      existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity', 'plugin.json')),
      'the fallback copy must land under the sandboxed HOME, not the real one',
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
      !existsSync(join(home, '.gemini', 'config', 'plugins', 'adlc-antigravity')),
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
  // locations — `<npm root -g>/@adlc/antigravity` and
  // `node_modules/@adlc/antigravity` — both contain one, so passing packageRoot
  // straight through made agy answer `unknown marketplace: adlc/antigravity`
  // and fall through to the manual copy path on every single run.
  //
  // The package root here is deliberately shaped like a real npm install: the
  // bug is invisible from a source checkout, whose path has no `@`.
  const work = mkdtempSync(join(tmpdir(), 'adlc-agy-cli-'));
  try {
    const scopedRoot = join(work, 'node_modules', '@adlc', 'antigravity');
    mkdirSync(join(scopedRoot, 'bin'), { recursive: true });
    writeFileSync(join(scopedRoot, 'bin', 'cli.mjs'), readFileSync(join(pkgDir, 'bin', 'cli.mjs')));
    writeFileSync(join(scopedRoot, 'plugin.json'), '{"name":"adlc-antigravity"}\n');

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
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: join(work, 'home') },
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
    const scopedRoot = join(work, 'node_modules', '@adlc', 'antigravity');
    mkdirSync(join(scopedRoot, 'bin'), { recursive: true });
    writeFileSync(join(scopedRoot, 'bin', 'cli.mjs'), readFileSync(join(pkgDir, 'bin', 'cli.mjs')));
    writeFileSync(join(scopedRoot, 'plugin.json'), '{"name":"adlc-antigravity"}\n');

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
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: join(work, 'home'),
        TMPDIR: hostileTmp,
      },
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

