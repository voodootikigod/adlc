// install-sh.test.mjs — the served installers are a supply-chain trust root.
//
// `curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh` runs this script
// with the user's full privileges before they have any reason to trust us. Two
// classes of failure matter and neither is visible in review:
//
//   1. It touches a harness the user does not have. Detection that leaks means
//      writing into config for software that isn't installed.
//   2. It changes without anyone deciding to change it. The digest pin makes an
//      edit to a served installer a deliberate, reviewed act.
//
// The harness tests run the REAL script against a stub PATH where every binary
// is a logging shim, so what is asserted is the script's actual behavior, not a
// description of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_SH = path.join(repoRoot, 'apps/docs/public/install.sh');
const INSTALL_PS1 = path.join(repoRoot, 'apps/docs/public/install.ps1');
const DIGESTS = path.join(repoRoot, 'scripts/test/install-digests.json');

const read = (abs) => readFileSync(abs, 'utf8');

/** Every harness the installer knows how to detect, and the binary that reveals it. */
const HARNESSES = [
  { bin: 'claude', label: 'Claude Code' },
  { bin: 'codex', label: 'Codex' },
  { bin: 'opencode', label: 'OpenCode' },
  { bin: 'pi', label: 'pi' },
  { bin: 'agy', label: 'Google Antigravity' },
  { bin: 'herdr', label: 'herdr' },
  { bin: 'copilot', label: 'GitHub Copilot' },
];

/**
 * Build a sealed environment: a bin directory containing ONLY the shims asked
 * for, a throwaway HOME, and a log file every shim appends its argv to.
 *
 * PATH is replaced, not prepended — a real `codex` leaking in from the
 * developer's machine would make the detection assertions meaningless.
 */
// Default stub Node clears every floor in play, including @adlc/pi's 22.19 —
// v22.0.0 silently turned the pi cases into skips.
/**
 * @param {object} [opts]
 * @param {boolean} [opts.adlcOnPath] Simulate the post-install `adlc` binary
 *   being reachable. Defaults to true, because a successful `npm install -g` is
 *   the normal case; set false to model a global install landing outside PATH.
 */
function sandbox({ bins = [], nodeVersion = 'v22.21.0', failing = [], adlcOnPath = true, npmPrefix } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'adlc-install-'));
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'commands.log');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, '');

  const shim = (name, body) => {
    const abs = path.join(binDir, name);
    writeFileSync(abs, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(abs, 0o755);
  };

  // The installer verifies its own work by running `adlc --version`, so a
  // sandbox modelling a SUCCESSFUL npm install has to provide it.
  const allBins = adlcOnPath && bins.includes('npm') ? [...bins, 'adlc'] : bins;

  for (const name of allBins) {
    if (name === 'adlc') {
      shim('adlc', "if [ \"$1\" = '--version' ]; then printf '1.6.0\\n'; fi\nexit 0");
      continue;
    }
    if (name === 'node') {
      // `node -v` has to answer; anything else just logs.
      shim('node', `if [ "$1" = "-v" ]; then printf '${nodeVersion}\\n'; fi\nexit 0`);
    } else if (name === 'npm') {
      // `npm root -g` locates the Antigravity plugin on disk; `npm prefix -g` is
      // how the installer checks whether the `adlc` it just ran is the one npm
      // wrote. npmPrefix defaults to a path the shimmed adlc is NOT under, so
      // the shadow warning is exercised; pass the bin dir to model a match.
      shim(
        'npm',
        `if [ "$1" = "root" ]; then printf '%s\\n' "${root}/npmroot"; fi\n` +
          `if [ "$1" = "prefix" ]; then printf '%s\\n' "${npmPrefix ?? `${root}/npmprefix`}"; fi\n` +
          `exit ${failing.includes('npm') ? 1 : 0}`,
      );
    } else {
      shim(name, `exit ${failing.includes(name) ? 1 : 0}`);
    }
  }

  // Real coreutils still need to resolve; the shim dir goes first so stubs win.
  const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  return {
    root,
    log,
    home,
    env: { PATH: `${binDir}:${systemPath}`, HOME: home },
    commands: () => readFileSync(log, 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runInstaller(box) {
  return spawnSync('sh', [INSTALL_SH], { encoding: 'utf8', env: box.env, timeout: 60_000 });
}

test('install.sh is POSIX sh and free of the common bashisms', () => {
  const syntax = spawnSync('sh', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `sh -n failed: ${syntax.stderr}`);

  // Comment lines are stripped before scanning: a bashism that is never
  // executed is not a bashism, and the header comment documenting this very
  // rule would otherwise trip it.
  const source = read(INSTALL_SH)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  // `sh -n` on a system whose /bin/sh is bash (or dash-with-extensions) will
  // happily accept these, so they are checked textually rather than trusted to
  // the parser that happens to be installed on the runner.
  const BASHISMS = [
    { label: '[[ ... ]]', pattern: /\[\[/ },
    { label: 'local', pattern: /(?<![\w-])local\s+\w/ },
    { label: 'array assignment', pattern: /^\s*\w+=\(/m },
    { label: 'function keyword', pattern: /(?<![\w-])function\s+\w+\s*\(/ },
    { label: '==  inside [', pattern: /\[\s+[^\]]*\s==\s/ },
  ];
  for (const { label, pattern } of BASHISMS) {
    assert.ok(!pattern.test(source), `install.sh uses the bashism ${label}`);
  }

  assert.match(read(INSTALL_SH), /^#!\/bin\/sh$/m, 'install.sh must declare #!/bin/sh');
});

test('install.sh survives truncation: a partial download executes nothing', () => {
  // `sh` reads a pipe incrementally and runs what it has, so `curl … | sh` on a
  // dropped connection executes whatever prefix arrived.
  //
  // Wrapping only the RUN SEQUENCE is not enough — a cut landing between two
  // complete top-level function definitions still parses, and sh exits 0 having
  // done nothing, which reports success for a truncated install. The whole body
  // therefore lives inside one function, so any truncation leaves its brace
  // unclosed and sh refuses the file outright.
  const full = read(INSTALL_SH);

  const box = sandbox({ bins: ['node', 'npm', 'codex'] });
  try {
    // EVERY line boundary, not a handful of sampled fractions. Sampling 25/50/
    // 75/95% is what missed the previous guard's real hole: with the body in a
    // function invoked on the last line, a cut in the narrow window between the
    // closing brace and that invocation produced a complete, valid, no-op
    // script that exited 0. A bug reachable only in a few hundred bytes of a
    // 12KB file is exactly what sampling cannot find.
    const offsets = [];
    for (let i = 0; i < full.length; i += 1) {
      // Strictly SHORTER than the file: the complete script is not a truncation.
      if (full[i] === '\n' && i + 1 < full.length) offsets.push(i + 1);
    }
    assert.ok(offsets.length > 50, 'sanity: the script should have many line boundaries');

    // A prefix consisting only of the shebang and leading comments is a valid
    // empty script and exits 0 — unavoidable for any `curl | sh`, and harmless:
    // nothing ran and the user sees no output at all, which reads as failure
    // rather than as a completed install. The opening brace is deliberately as
    // early as possible so that window stays a couple of lines.
    const braceLine = full.search(/^\{/m);
    assert.notEqual(braceLine, -1, 'the truncation guard brace must exist');
    const guardOpens = full.indexOf('\n', braceLine) + 1;

    // The unguarded prefix must stay TINY. It was ~1.7KB when the header
    // comment sat above the brace, which is a lot of surface where a dropped
    // connection yields a valid no-op script that exits 0.
    assert.ok(
      guardOpens < 120,
      `only the shebang and 'set -eu' may precede the guard; found ${guardOpens} bytes`,
    );

    for (const offset of offsets) {
      const truncated = path.join(box.root, 'truncated.sh');
      writeFileSync(truncated, full.slice(0, offset));
      writeFileSync(box.log, '');

      const result = spawnSync('sh', [truncated], { encoding: 'utf8', env: box.env, timeout: 30_000 });
      const pct = ((offset / full.length) * 100).toFixed(1);

      // The property that matters at EVERY offset: nothing is ever installed.
      assert.equal(
        box.commands(),
        '',
        `a ${pct}% download (byte ${offset}) installed something:\n${box.commands()}`,
      );
      // Past the opening brace, a truncated file must also be REFUSED outright.
      if (offset > guardOpens) {
        assert.notEqual(result.status, 0, `a ${pct}% download (byte ${offset}) reported success`);
      }
    }
  } finally {
    box.cleanup();
  }
});

test('install.sh refuses to run without Node and installs nothing', () => {
  const box = sandbox({ bins: ['npm'] }); // npm present, node absent
  try {
    const result = runInstaller(box);
    assert.ok(result.status >= 1, `expected a non-zero exit, got ${result.status}`);
    assert.match(result.stderr, /Node\.js 18\+/, 'stderr must name the Node 18 requirement');
    assert.equal(box.commands(), '', 'nothing may run when the prerequisite is missing');
  } finally {
    box.cleanup();
  }
});

test('install.sh refuses to run on a Node older than 18 and installs nothing', () => {
  const box = sandbox({ bins: ['node', 'npm'], nodeVersion: 'v16.20.2' });
  try {
    const result = runInstaller(box);
    assert.ok(result.status >= 1, `expected a non-zero exit, got ${result.status}`);
    assert.match(result.stderr, /found v16\.20\.2/, 'stderr must report the version it found');
    assert.ok(
      !box.commands().includes('npm install'),
      'no package may be installed on an unsupported Node',
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh installs the toolkit and only the harnesses that are present', () => {
  // Two present, five absent. The absent five are the point of the test.
  const present = ['codex', 'pi'];
  const absent = HARNESSES.filter((h) => !present.includes(h.bin));

  const box = sandbox({ bins: ['node', 'npm', ...present] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);

    const commands = box.commands();
    assert.match(commands, /npm install -g @adlc\/cli@latest/, 'the gate toolkit must be installed');

    // Present harnesses get their documented native command.
    assert.match(commands, /codex plugin marketplace add voodootikigod\/adlc --ref main/);
    assert.match(commands, /codex plugin add adlc-codex@adlc/);

    // pi must use the USER-GLOBAL form. `pi install -l` is the project install:
    // it writes into the current directory, and this script is machine-level and
    // normally run from $HOME, so -l here would configure the home directory
    // instead of the repo the user actually meant.
    assert.match(commands, /pi install npm:@adlc\/pi/);
    assert.ok(
      !commands.includes('pi install -l'),
      'the machine-level installer must not run pi\'s PROJECT install from the caller\'s cwd',
    );

    // Absent harnesses must not be touched. Asserting only "no command was
    // logged" would be hollow: an absent harness has no shim, so an attempt to
    // invoke it fails with command-not-found and logs NOTHING — indistinguishable
    // from never having tried. The installer's own detection output is the
    // observable that actually moves when a presence guard is removed.
    for (const harness of absent) {
      assert.ok(
        !result.stdout.includes(`${harness.label} detected`),
        `${harness.label} is not installed on this machine but the installer claimed to detect it:\n${result.stdout}`,
      );
      assert.ok(
        !new RegExp(`(installed|failed) for: [^\\n]*${harness.label}`).test(result.stdout),
        `${harness.label} is absent but appears in the installer summary:\n${result.stdout}`,
      );
      assert.ok(
        !new RegExp(`(^|\\n)${harness.bin} `).test(commands),
        `${harness.bin} is not installed on this machine but the installer invoked it:\n${commands}`,
      );
    }

    assert.match(result.stdout, /installed for: .*Codex/);
    assert.match(result.stdout, /installed for: .*pi/);
  } finally {
    box.cleanup();
  }
});

test('install.sh continues past a failing harness but exits non-zero', () => {
  // Two properties, and they pull in opposite directions. A broken harness must
  // not ABORT the run — the others on the machine are still worth installing.
  // But the run must not report SUCCESS either: `curl … | sh` hands this exit
  // status to whatever automation invoked it, and a partial install that exits 0
  // is a silent lie to that caller.
  const box = sandbox({ bins: ['node', 'npm', 'codex', 'pi'], failing: ['codex'] });
  try {
    const result = runInstaller(box);
    assert.match(box.commands(), /pi install npm:@adlc\/pi/, 'later harnesses must still run');
    assert.match(result.stdout, /failed for: .*Codex/, 'the failure must be named');
    assert.notEqual(result.status, 0, 'a partial install must not report success');
  } finally {
    box.cleanup();
  }
});

test('install.sh does not run project-scoped installers from the caller\'s directory', () => {
  // `@adlc/opencode init` defaults its root to the CWD and scaffolds .adlc/ and
  // .opencode/ there. This script is machine-level and the documented flow is
  // "install, THEN cd into your repo", so running it here would configure $HOME
  // and leave the intended repository untouched.
  const box = sandbox({ bins: ['node', 'npm', 'opencode'] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0);
    assert.ok(
      !box.commands().includes('@adlc/opencode init'),
      'the machine-level installer must not scaffold the caller\'s cwd',
    );
    assert.match(result.stdout, /manual step needed for: .*OpenCode/);
    assert.match(result.stdout, /INSIDE your repo/, 'the summary must say where to run it instead');
  } finally {
    box.cleanup();
  }
});

test('install.sh honours pi\'s 22.19 floor at the MINOR version, not just the major', () => {
  // @adlc/pi needs a higher Node than the toolkit (22.19 vs 18). Comparing only
  // the major accepts 22.0–22.18, which install a package outside its engine
  // contract that then fails at load time. The boundary cases are the test:
  // 22.18.x must be refused and 22.19.0 must be accepted.
  const CASES = [
    { version: 'v18.20.4', installs: false },
    { version: 'v22.0.0', installs: false },
    { version: 'v22.18.9', installs: false },
    { version: 'v22.19.0', installs: true },
    { version: 'v24.1.0', installs: true },
  ];

  for (const { version, installs } of CASES) {
    const box = sandbox({ bins: ['node', 'npm', 'pi'], nodeVersion: version });
    try {
      const result = runInstaller(box);
      assert.equal(result.status, 0, `${version}: a pi skip must not fail the whole install`);
      assert.equal(
        box.commands().includes('pi install'),
        installs,
        `${version}: expected pi install to be ${installs ? 'attempted' : 'skipped'}`,
      );
      if (!installs) {
        assert.match(result.stdout, /requires Node >= 22\.19/, `${version}: the reason must be stated`);
      }
    } finally {
      box.cleanup();
    }
  }
});

test('every harness recorded as manual has a printed instruction', () => {
  // The class behind two separate findings: a harness can be added to MANUAL in
  // one place and forgotten in the summary, so the output names it and then
  // tells the user nothing. Derived from the script itself, so a harness added
  // later is covered without anyone remembering to extend this test.
  const source = read(INSTALL_SH);
  const recorded = [...source.matchAll(/record_manual "([^"]+)"/g)].map((m) => m[1]);
  const instructed = [...source.matchAll(/manual_has "([^"]+)"/g)].map((m) => m[1]);

  assert.ok(recorded.length > 0, 'sanity: the installer should record manual steps');
  const missing = [...new Set(recorded)].filter((name) => !instructed.includes(name));
  assert.deepEqual(
    missing,
    [],
    `recorded as manual but never given an instruction: ${missing.join(', ')}`,
  );
});

test('install.sh prints manual steps only for the harnesses that need them', () => {
  // MANUAL was used as a boolean, so one manual harness printed instructions for
  // all four — handing the user commands for software they do not have.
  const box = sandbox({ bins: ['node', 'npm'] });
  try {
    mkdirSync(path.join(box.home, '.cursor'), { recursive: true }); // Cursor only
    const result = runInstaller(box);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Cursor:/, 'the harness that needs a step must be named');
    assert.ok(!/OpenCode:/.test(result.stdout), 'absent OpenCode must not get instructions');
    assert.ok(!/^\s+pi:/m.test(result.stdout), 'absent pi must not get instructions');
    assert.ok(
      !/Copilot:/.test(result.stdout),
      'Copilot installs from its marketplace — it must not also appear as a manual fallback',
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh allowlists platforms rather than denylisting Windows', () => {
  // A denylist only stops what it enumerates. FreeBSD, Solaris, and — worse — an
  // ABSENT or spoofed `uname` (which fell through as "unknown") all proceeded to
  // install globally on a platform this project does not claim to support.
  for (const reported of ['FreeBSD', 'OpenBSD', 'SunOS', 'Haiku']) {
    const box = sandbox({ bins: ['node', 'npm'] });
    try {
      const unameShim = path.join(box.root, 'bin', 'uname');
      writeFileSync(unameShim, `#!/bin/sh\nprintf '${reported}\\n'\n`);
      chmodSync(unameShim, 0o755);

      const result = runInstaller(box);
      assert.notEqual(result.status, 0, `${reported} must be refused, not installed onto`);
      assert.match(result.stderr, /unsupported platform/i);
      assert.match(result.stderr, /npm install -g @adlc\/cli/, 'the manual path must be offered');
      assert.equal(box.commands(), '', `${reported}: nothing may be installed`);
    } finally {
      box.cleanup();
    }
  }
});

test('install.sh refuses when uname is unavailable rather than assuming support', () => {
  const box = sandbox({ bins: ['node', 'npm'] });
  try {
    // A `uname` that fails is indistinguishable from a hostile one; either way
    // the platform is unknown and an unknown platform is not a supported one.
    const unameShim = path.join(box.root, 'bin', 'uname');
    writeFileSync(unameShim, '#!/bin/sh\nexit 1\n');
    chmodSync(unameShim, 0o755);

    const result = runInstaller(box);
    assert.notEqual(result.status, 0, 'an unknown platform must fail closed');
    assert.equal(box.commands(), '', 'nothing may be installed on an unknown platform');
  } finally {
    box.cleanup();
  }
});

test('install.sh warns when a different adlc shadows the one npm installed', () => {
  // Running `adlc` proves something named adlc runs, not that it is the binary
  // npm just wrote. With several Node managers or a stale user-local copy, the
  // user can end up running gates from a toolkit this script never touched.
  const box = sandbox({ bins: ['node', 'npm', 'codex'] });
  try {
    // The stub `npm prefix -g` answers with a path the shimmed adlc is NOT under.
    const result = runInstaller(box);
    assert.equal(result.status, 0, 'a shadowing binary is a warning, not a failure');
    assert.match(
      result.stdout,
      /shadow|not the one npm installed/i,
      `a mismatched adlc location must be reported:\n${result.stdout}`,
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh stays quiet when the adlc on PATH IS the one npm installed', () => {
  // The complement matters: a warning that fires on every healthy install is
  // noise, and noise is what teaches people to ignore the real one. Reporting a
  // prefix the shims genuinely sit under models the normal case — no test-only
  // branch in the installer, which is a served trust root.
  const box = sandbox({ bins: ['node', 'npm', 'codex'], npmPrefix: undefined });
  try {
    // Recreate npm reporting the sandbox root, which the bin dir is under.
    const npmShim = path.join(box.root, 'bin', 'npm');
    writeFileSync(
      npmShim,
      `#!/bin/sh\nprintf '%s\\n' "npm $*" >> "${box.log}"\n` +
        `if [ "$1" = "root" ]; then printf '%s\\n' "${box.root}/npmroot"; fi\n` +
        `if [ "$1" = "prefix" ]; then printf '%s\\n' "${box.root}"; fi\nexit 0\n`,
    );
    chmodSync(npmShim, 0o755);

    const result = runInstaller(box);
    assert.equal(result.status, 0);
    assert.ok(
      !/shadow/i.test(result.stdout),
      `a healthy install must not warn about shadowing:\n${result.stdout}`,
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh verifies the Antigravity plugin path instead of assuming it', () => {
  // `agy plugin install` takes a filesystem path, and with version managers or a
  // custom prefix `npm install -g` can write somewhere `npm root -g` does not
  // report. Passing an unverified path hands agy a non-existent directory and
  // produces a confusing downstream error instead of a clear one here.
  const box = sandbox({ bins: ['node', 'npm', 'agy'] });
  try {
    // The stub npm reports a root that does not contain the package.
    const result = runInstaller(box);
    assert.equal(result.status, 0, 'a bad plugin path must not fail the whole install');
    assert.ok(
      !box.commands().includes('agy plugin install'),
      'agy must not be invoked with a path that does not exist',
    );
    assert.match(result.stdout, /not found at/, 'the missing path must be reported');
    assert.match(result.stdout, /npm root -g/, 'the user needs an actionable next step');
    // Recording a manual step is not enough — every harness in MANUAL must also
    // get a printed instruction, or the summary names a harness and then tells
    // the user nothing about what to do with it.
    assert.match(
      result.stdout,
      /manual step needed for: .*Antigravity/,
      'the harness must appear in the manual summary',
    );
    assert.match(
      result.stdout,
      /Antigravity:.*npx @adlc\/antigravity@latest install/s,
      'a harness in MANUAL must get its own printed instruction',
    );
    // The version spec is load-bearing, not decoration: npx resolves a BARE name
    // against the current project first, so `npx @adlc/antigravity` inside a repo
    // shipping a workspace of that name runs THAT binary. Same hazard this script
    // already pins for the `plugins` package.
    assert.ok(
      !/npx @adlc\/antigravity(?!@)/.test(result.stdout),
      `an npx instruction lacks a version spec and can be shadowed locally:\n${result.stdout}`,
    );
    // The instruction must not hand the user the very command that fails: a bare
    // `agy plugin install <path>/@adlc/antigravity` is rejected by agy's
    // marketplace parser (see the @-free staging test below).
    assert.ok(
      !/agy plugin install \S*@/.test(result.stdout),
      `the fallback instruction still tells the user to pass an @ path:\n${result.stdout}`,
    );
    // Nor may it name a package that does not exist. `adlc-agy` is a BIN name
    // inside @adlc/antigravity, not a package: `npx adlc-agy install` resolves
    // against the registry on any machine without the global install and 404s —
    // and leaves an unclaimed name that someone else's code could answer to.
    assert.ok(
      !/npx adlc-agy/.test(result.stdout),
      `the instruction names an unpublished npm package:\n${result.stdout}`,
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh delegates the Antigravity install to the package helper, never agy directly', () => {
  // install.sh USED to stage the plugin and call `agy plugin install` itself, a
  // second copy of logic the shipped helper already owns: @-free staging, agy
  // resolution that ignores npm-injected bin dirs, a subprocess timeout, and
  // fail-closed semantics. The duplication did what duplication does — the helper
  // gained a timeout and this path kept none, so a wedged agy hung the whole
  // installer past its own summary and exit status.
  //
  // So the property this test pins is DELEGATION, not staging: staging is proved
  // where it now lives, in plugins/adlc-antigravity/test/packaging.test.mjs
  // (including the hostile-TMPDIR case). Asserting it in both places would
  // recreate the duplication in the tests.
  const box = sandbox({ bins: ['node', 'npm', 'agy'] });
  try {
    // Give the stub `npm root -g` a real helper to find.
    const helperDir = path.join(box.root, 'npmroot', '@adlc', 'antigravity', 'bin');
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(path.join(helperDir, 'cli.mjs'), '// helper\n');

    const result = runInstaller(box);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);

    const commands = box.commands();
    const nodeLine = commands
      .split('\n')
      .find((line) => line.startsWith('node ') && line.includes('cli.mjs'));
    assert.ok(nodeLine, `the helper was never invoked; log was:\n${commands}`);
    assert.match(nodeLine, /bin\/cli\.mjs install$/, `expected \`<helper> install\`: ${nodeLine}`);

    // And agy must NOT be driven from here any more — that is the whole point.
    assert.ok(
      !/(^|\n)agy /.test(commands),
      `install.sh must not invoke agy directly; it delegates:\n${commands}`,
    );
    assert.match(result.stdout, /installed for: .*Antigravity/);
  } finally {
    box.cleanup();
  }
});

test('install.sh refuses to run on native Windows but allows WSL', () => {
  // Git Bash / MSYS / Cygwin give a POSIX shell on a platform where the toolkit
  // passes 6 of 28 suites, so the script would install a broken toolkit and
  // report success. WSL reports "Linux" and is a supported path.
  const box = sandbox({ bins: ['node', 'npm'] });
  try {
    const unameShim = path.join(box.root, 'bin', 'uname');
    writeFileSync(unameShim, '#!/bin/sh\nprintf \'MINGW64_NT-10.0\\n\'\n');
    chmodSync(unameShim, 0o755);

    const result = runInstaller(box);
    assert.notEqual(result.status, 0, 'native Windows must fail closed');
    assert.match(result.stderr, /native Windows is not supported/);
    assert.match(result.stderr, /WSL/, 'the refusal must point somewhere useful');
    assert.equal(box.commands(), '', 'nothing may be installed on an unsupported platform');
  } finally {
    box.cleanup();
  }
});

test('install.sh installs the Copilot native plugin from its marketplace', () => {
  // Copilot ships a real native plugin (rails hook, build-gate, MCP, agents) via
  // its Git marketplace. The marketplace path does not go through npm, so the
  // unpublished @adlc/copilot package is no reason to downgrade this to a
  // manual step.
  const box = sandbox({ bins: ['node', 'npm', 'copilot'] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    assert.match(box.commands(), /copilot plugin marketplace add voodootikigod\/adlc/);
    assert.match(box.commands(), /copilot plugin install adlc-copilot@adlc/);
    assert.match(result.stdout, /installed for: .*Copilot/);
  } finally {
    box.cleanup();
  }
});

test('install.sh fails when npm succeeds but adlc is not on PATH', () => {
  // npm exiting 0 proves the package was written, not that it is runnable — a
  // custom prefix routinely puts the bin outside PATH. Reporting success and
  // then telling the user to run `adlc init` sends them to command-not-found.
  const box = sandbox({ bins: ['node', 'npm', 'codex'], adlcOnPath: false });
  try {
    const result = runInstaller(box);
    assert.notEqual(result.status, 0, 'an unusable toolkit must not report success');
    assert.match(result.stderr, /not on your PATH/);
    assert.match(result.stderr, /npm prefix -g/, 'the fix must be actionable');
    assert.ok(
      !box.commands().includes('codex plugin'),
      'no harness should be configured against a toolkit that cannot run',
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh cannot be hijacked by a repo-local package named "plugins"', () => {
  // npx resolves a BARE package name against the current project first, so a
  // malicious repo shipping a workspace/dependency named `plugins` would have
  // its binary executed. The agent-led flow runs from inside the target repo,
  // which is precisely where that attack lands.
  const box = sandbox({ bins: ['node', 'npm', 'npx', 'claude', 'mktemp'] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);

    const npxLine = box.commands().split('\n').find((line) => line.startsWith('npx '));
    assert.ok(npxLine, `expected an npx invocation; log was:\n${box.commands()}`);
    assert.match(
      npxLine,
      /plugins@/,
      'the package must carry a version spec so npx resolves from the registry, not the local project',
    );
    assert.ok(
      !/(^|\s)plugins(\s|$)/.test(npxLine.replace('plugins@latest', '')),
      'no bare `plugins` specifier may remain',
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh passes non-interactive flags to every nested installer', () => {
  // Under `curl … | sh` stdin is NOT a terminal. herdr refuses a remote plugin
  // install without --yes in that case, and `plugins` prompts for confirmation.
  // Either one hangs or fails the install, and no other test can see it: the
  // shims never prompt, so the failure mode is invisible without asserting the
  // flags directly.
  const box = sandbox({ bins: ['node', 'npm', 'npx', 'claude', 'herdr', 'mktemp'] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0, `installer failed: ${result.stderr}`);
    const commands = box.commands();

    const herdrLine = commands.split('\n').find((line) => line.startsWith('herdr '));
    assert.ok(herdrLine, `no herdr invocation; log:\n${commands}`);
    assert.match(herdrLine, /--yes/, 'herdr refuses non-interactive remote installs without --yes');

    // npx consumes every flag BEFORE the package spec, so a leading --yes never
    // reaches `plugins`. The tool's own --yes has to come after the subcommand.
    const npxLine = commands.split('\n').find((line) => line.startsWith('npx '));
    assert.ok(npxLine, `no npx invocation; log:\n${commands}`);
    assert.match(
      npxLine,
      /plugins@\S+ add \S+ .*--yes/,
      `the trailing --yes must reach 'plugins', not be eaten by npx: ${npxLine}`,
    );
    // `plugins add` defaults to auto-detect, i.e. install into EVERY agent tool
    // found. Unscoped, the Claude payload lands in Codex/Cursor too.
    assert.match(
      npxLine,
      /--target claude-code/,
      `the Claude branch must scope its install: ${npxLine}`,
    );

    // An EXACT version, never a tag. This call runs unattended inside a
    // `curl | sh`, so the user never chooses which third-party code executes —
    // the narrowing of ADR-0009 Decision 3 recorded in ADR-0010 Decision 8.
    // Two independent cross-model reviews flagged the unpinned form.
    assert.match(
      npxLine,
      /plugins@\d+\.\d+\.\d+ /,
      `the automated plugins call must pin an exact version, not a tag: ${npxLine}`,
    );
    assert.ok(
      !/plugins@(latest|next|beta)/.test(npxLine),
      `a mutable tag reintroduces the risk the pin exists to close: ${npxLine}`,
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh detects Cursor by config directory and asks for the manual step', () => {
  // Cursor is a GUI app: no `cursor` binary is guaranteed, and its plugin
  // install has no shell command. Detecting it must not invent one.
  const box = sandbox({ bins: ['node', 'npm'] });
  try {
    mkdirSync(path.join(box.home, '.cursor'), { recursive: true });
    const result = runInstaller(box);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /manual step needed for: .*Cursor/);
    assert.ok(
      !box.commands().includes('cursor '),
      'Cursor has no supported shell install — the installer must not fabricate one',
    );
  } finally {
    box.cleanup();
  }
});

test('install.sh survives an environment with no HOME', () => {
  // `set -u` plus a bare ${HOME} kills the install with "unbound variable" —
  // an error naming nothing the user can act on. Containers and some CI shells
  // have no HOME, and `curl | sh` is exactly what runs in a container.
  const box = sandbox({ bins: ['node', 'npm', 'codex'] });
  try {
    const result = spawnSync('sh', [INSTALL_SH], {
      encoding: 'utf8',
      env: { PATH: box.env.PATH }, // deliberately no HOME
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `installer failed without HOME: ${result.stderr}`);
    assert.ok(
      !/unbound variable/.test(result.stderr),
      `installer tripped set -u on an unset variable:\n${result.stderr}`,
    );
    assert.match(box.commands(), /npm install -g @adlc\/cli/, 'the toolkit must still install');
  } finally {
    box.cleanup();
  }
});

test('install.sh is idempotent against harnesses that are ALREADY installed', () => {
  // Stateless shims cannot prove idempotence: they answer identically forever,
  // so "same commands twice" says nothing about what happens when a plugin is
  // already registered. These shims remember, and on a second invocation behave
  // like the real tools do — "already exists", exit 0 — so the assertion is
  // about the installer's tolerance of prior state, not about shim determinism.
  const box = sandbox({ bins: ['node', 'npm'] });
  try {
    const stateDir = path.join(box.root, 'state');
    mkdirSync(stateDir, { recursive: true });

    for (const bin of ['codex', 'herdr']) {
      const abs = path.join(box.root, 'bin', bin);
      writeFileSync(
        abs,
        `#!/bin/sh\n` +
          `printf '%s\\n' "${bin} $*" >> "${box.log}"\n` +
          `marker="${stateDir}/${bin}.installed"\n` +
          `if [ -e "$marker" ]; then\n` +
          `  echo "${bin}: plugin already installed" >&2\n` +
          `  exit 0\n` +
          `fi\n` +
          `touch "$marker"\n` +
          `exit 0\n`,
      );
      chmodSync(abs, 0o755);
    }

    const first = runInstaller(box);
    assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
    assert.match(first.stdout, /installed for: .*Codex/);

    writeFileSync(box.log, '');
    const second = runInstaller(box);
    assert.equal(second.status, 0, 'a re-run over an existing install must still succeed');
    assert.match(
      second.stdout,
      /installed for: .*Codex/,
      'an already-installed harness must not be reported as failed',
    );
    assert.ok(
      !/failed for:/.test(second.stdout),
      `a re-run reported failures:\n${second.stdout}`,
    );
  } finally {
    box.cleanup();
  }
});

test('ADLC_SKIP_HARNESSES=1 installs the toolkit and touches no harness', () => {
  const box = sandbox({ bins: ['node', 'npm', 'codex', 'pi', 'herdr'] });
  try {
    const result = spawnSync('sh', [INSTALL_SH], {
      encoding: 'utf8',
      env: { ...box.env, ADLC_SKIP_HARNESSES: '1' },
      timeout: 60_000,
    });
    assert.equal(result.status, 0);
    const commands = box.commands();
    assert.match(commands, /npm install -g @adlc\/cli/);
    for (const bin of ['codex', 'pi', 'herdr']) {
      assert.ok(!new RegExp(`(^|\\n)${bin} `).test(commands), `${bin} ran despite ADLC_SKIP_HARNESSES=1`);
    }
  } finally {
    box.cleanup();
  }
});

test('no Windows installer is served while the toolkit fails on Windows', () => {
  // A windows-latest run of the core gate suites passed 6 of 28: the shared
  // bin-resolution path builds `D:\D:\...` from an already-absolute Windows
  // path. Serving an installer for a platform the toolkit does not run on is a
  // claim we cannot back (ADR-0009 Decision 4, ADR-0010 Decision 6).
  //
  // This test is the tripwire on re-adding one: restore install.ps1 only
  // together with a green windows-latest job, and update this test in the same
  // change so the two can never drift apart.
  assert.ok(
    !existsSync(INSTALL_PS1),
    'apps/docs/public/install.ps1 is served again — re-add it only with a green windows-latest gate',
  );
});

test('every surface that offers the installer states the platform limits', () => {
  const CANDIDATES = [
    'README.md',
    'apps/docs/lib/install-commands.mjs',
    'apps/docs/lib/agent-guide.mjs',
  ];

  let checked = 0;
  for (const relative of CANDIDATES) {
    const abs = path.join(repoRoot, relative);
    if (!existsSync(abs)) continue;
    const text = read(abs);
    if (!text.includes('install.sh') && !text.includes('UNIVERSAL_INSTALL')) continue;
    checked += 1;
    assert.match(
      text,
      /Windows/i,
      `${relative} offers the installer without addressing Windows at all`,
    );
    assert.ok(
      /not supported|does not currently run|isn't supported|6 of 28/i.test(text),
      `${relative} must state that Windows is unsupported rather than implying it works`,
    );
  }

  assert.ok(checked > 0, 'expected at least one surface to offer the installer');
});

test('the served installers are content-pinned', () => {
  // Not a security control on its own — anyone editing the script can edit the
  // digest. It is a control against an UNNOTICED edit: a change to a file that
  // lands on thousands of machines cannot ride along in an unrelated diff.
  assert.ok(existsSync(DIGESTS), 'scripts/test/install-digests.json must exist');
  const pinned = JSON.parse(read(DIGESTS));

  for (const [relative, expected] of Object.entries(pinned)) {
    const abs = path.join(repoRoot, relative);
    assert.ok(existsSync(abs), `${relative} is pinned but does not exist`);
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    assert.equal(
      actual,
      expected,
      `${relative} changed but scripts/test/install-digests.json was not updated.\n` +
        `  This file is served at https://www.agenticlifecycle.ai/${path.basename(relative)} and piped to a shell.\n` +
        `  If the change is intended, set the digest to: ${actual}`,
    );
  }

  // Anything served out of public/ that a user pipes to a shell must be pinned.
  // Derived from the directory rather than hard-coded, so adding a second
  // installer without pinning it fails here instead of shipping unnoticed.
  const servedScripts = readdirSync(path.join(repoRoot, 'apps/docs/public'))
    .filter((entry) => /\.(sh|ps1)$/.test(entry))
    .map((entry) => `apps/docs/public/${entry}`);

  assert.ok(servedScripts.length > 0, 'expected at least one served installer');
  for (const relative of servedScripts) {
    assert.ok(relative in pinned, `${relative} is served but not pinned`);
  }
});
