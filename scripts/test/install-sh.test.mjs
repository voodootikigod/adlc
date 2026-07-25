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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
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
function sandbox({ bins = [], nodeVersion = 'v22.0.0', failing = [] } = {}) {
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

  for (const name of bins) {
    if (name === 'node') {
      // `node -v` has to answer; anything else just logs.
      shim('node', `if [ "$1" = "-v" ]; then printf '${nodeVersion}\\n'; fi\nexit 0`);
    } else if (name === 'npm') {
      // `npm root -g` is used to locate the Antigravity plugin on disk.
      shim('npm', `if [ "$1" = "root" ]; then printf '%s\\n' "${root}/npmroot"; fi\nexit ${failing.includes('npm') ? 1 : 0}`);
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
    assert.match(commands, /pi install -l npm:@adlc\/pi/);

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

test('install.sh reports a failing harness without aborting the others', () => {
  // codex fails; pi must still be installed and the run must still exit 0.
  const box = sandbox({ bins: ['node', 'npm', 'codex', 'pi'], failing: ['codex'] });
  try {
    const result = runInstaller(box);
    assert.equal(result.status, 0, 'one broken harness must not fail the whole install');
    assert.match(box.commands(), /pi install -l npm:@adlc\/pi/, 'later harnesses must still run');
    assert.match(result.stdout, /failed for: .*Codex/);
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

test('install.sh is idempotent: a second run issues the same commands', () => {
  const box = sandbox({ bins: ['node', 'npm', 'codex', 'herdr'] });
  try {
    const first = runInstaller(box);
    assert.equal(first.status, 0);
    const firstLog = box.commands();

    writeFileSync(box.log, '');
    const second = runInstaller(box);
    assert.equal(second.status, 0, 're-running the installer must stay safe');
    assert.equal(box.commands(), firstLog, 'a second run must issue exactly the same commands');
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

test('install.ps1 exists, is labeled beta, and declares the same Node floor', () => {
  assert.ok(existsSync(INSTALL_PS1), 'apps/docs/public/install.ps1 must exist');
  const source = read(INSTALL_PS1);
  assert.match(source, /beta/i, 'the Windows installer must be labeled beta');
  assert.match(source, /18/, 'the Windows installer must state the Node 18 floor');
  assert.match(source, /@adlc\/cli/, 'the Windows installer must install the gate toolkit');
});

test('every surface offering the Windows installer states that adlc fleet is POSIX-only', () => {
  // `adlc fleet` hard-codes /bin/sh and POSIX sandbox backends. Shipping a
  // Windows installer without saying so would be a claim we cannot back.
  const CANDIDATES = [
    'README.md',
    'apps/docs/public/install.ps1',
    'apps/docs/content/docs/getting-started.mdx',
    'docs/integrations/windows.md',
  ];

  let checked = 0;
  for (const relative of CANDIDATES) {
    const abs = path.join(repoRoot, relative);
    if (!existsSync(abs)) continue;
    const text = read(abs);
    if (!text.includes('install.ps1')) continue;
    checked += 1;
    assert.match(
      text,
      /fleet[^.\n]*POSIX-only|POSIX-only[^.\n]*fleet/i,
      `${relative} offers install.ps1 without stating that adlc fleet is POSIX-only`,
    );
  }

  assert.ok(checked > 0, 'expected at least one surface to offer install.ps1');
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

  for (const relative of ['apps/docs/public/install.sh', 'apps/docs/public/install.ps1']) {
    assert.ok(relative in pinned, `${relative} is served but not pinned`);
  }
});
