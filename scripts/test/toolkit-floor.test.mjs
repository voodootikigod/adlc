// toolkit-floor — the post-forest-cutover toolkit version floor
// (T-01KZPYF2ERZ9XSGB313NHTRRAX).
//
// The failure this defends against: a pre-forest toolkit never reads the
// segmented-manifest marker and appends evidence directly to the frozen
// manifest root — discovered only at PR time by the rails-guard forest gate,
// after the bad evidence is already written locally. The floor check moves
// that failure to preflight (stale GLOBAL adlc) and to the rails-guard CI job
// (in-tree downgrade / branch-code runs).
//
// NOTE on literals: the floor value must live ONLY in scripts/toolkit-floor.json
// (AC1), so these tests never spell it out — fixtures use synthetic floors, and
// the against-the-real-floor cases copy the committed floor file into the
// fixture instead of restating its value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOOR_FILE,
  MARKER_FILE,
  checkGlobal,
  checkInTree,
  compareVersions,
  meetsFloor,
  parseVersion,
  readFloor,
  scrubNpmPath,
} from '../toolkit-floor-check.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO, 'scripts', 'toolkit-floor-check.mjs');

// Build a fixture repo root. `floor` is the minToolkit value to pin ('real'
// copies the committed floor file so a scenario can run against the actual
// floor without this test restating it). `gateManifestVersion` seeds the
// in-tree packages/gate-manifest/package.json.
function makeFixture({ floor, marker = true, gateManifestVersion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toolkit-floor-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  if (floor === 'real') {
    copyFileSync(join(REPO, FLOOR_FILE), join(dir, FLOOR_FILE));
  } else {
    writeFileSync(join(dir, FLOOR_FILE), `${JSON.stringify({ minToolkit: floor, reason: 'fixture floor' }, null, 2)}\n`);
  }
  if (marker) {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, MARKER_FILE), `${JSON.stringify({ format: 'adlc-manifest-segments', version: 1, auth: 'keyed' })}\n`);
  }
  if (gateManifestVersion !== undefined) {
    mkdirSync(join(dir, 'packages', 'gate-manifest'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'gate-manifest', 'package.json'), `${JSON.stringify({ name: '@adlc/gate-manifest', version: gateManifestVersion }, null, 2)}\n`);
  }
  return dir;
}

// A directory holding a fake `adlc` that reports `version`. Putting ONLY this
// directory on PATH makes the global check see exactly this CLI and nothing else.
function makeShim(version) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-shim-'));
  writeFileSync(join(dir, 'adlc'), `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return dir;
}

// An empty PATH directory: resolvable by spawn, resolves no adlc at all.
function emptyPathDir() {
  return mkdtempSync(join(tmpdir(), 'no-adlc-'));
}

// A global-npm-layout install of @adlc/gate-manifest at `version`, with `bins`
// symlinked into a bin dir the way `npm i -g` links them. The bin script
// writes a canary file if it is ever EXECUTED — the floor probe must read the
// owning package.json instead.
function makeGlobalWriterInstall(version, bins = ['gate-manifest']) {
  const prefix = mkdtempSync(join(tmpdir(), 'adlc-global-writer-'));
  const pkgDir = join(prefix, 'lib', 'node_modules', '@adlc', 'gate-manifest');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/gate-manifest', version }));
  const canary = join(prefix, 'executed-canary');
  const binDir = join(prefix, 'bin');
  mkdirSync(binDir);
  for (const bin of bins) {
    const target = join(pkgDir, 'bin', `${bin}.mjs`);
    // Shell BUILTIN redirect, not `touch`: the fixture PATH holds no external
    // utilities, so an executed writer must still manage to drop the canary.
    writeFileSync(target, `#!/bin/sh\n: > "${canary}"\n`, { mode: 0o755 });
    symlinkSync(target, join(binDir, bin));
  }
  return { prefix, binDir, canary };
}

function runCheck(mode, root, { path, cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, mode, '--root', root], {
    encoding: 'utf8',
    ...(cwd !== undefined ? { cwd } : {}),
    env: { ...process.env, ...(path !== undefined ? { PATH: path } : {}) },
  });
}

// ── AC1: single source of truth, read at runtime ──────────────────────────

test('the floor file is the single source of truth and its readers never restate the value', () => {
  const floor = JSON.parse(readFileSync(join(REPO, FLOOR_FILE), 'utf8'));
  assert.match(String(floor.minToolkit), /^\d+\.\d+\.\d+$/, 'minToolkit is an exact version');
  assert.ok(String(floor.reason).length > 0, 'the floor records why it exists');

  const preflight = readFileSync(join(REPO, 'scripts', 'preflight.mjs'), 'utf8');
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const checker = readFileSync(SCRIPT, 'utf8');

  assert.ok(preflight.includes('toolkit-floor-check.mjs'), 'preflight reads the floor via the check module');
  assert.match(ci, /node scripts\/toolkit-floor-check\.mjs in-tree/, 'CI reads the floor via the check script');

  for (const [name, src] of [['preflight.mjs', preflight], ['ci.yml', ci], ['toolkit-floor-check.mjs', checker]]) {
    assert.ok(!src.includes(floor.minToolkit), `${name} must read the floor file at runtime, not hardcode ${floor.minToolkit}`);
  }
});

test('the CI floor step lives in the rails-guard job, BEFORE npm install', () => {
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobStart = ci.indexOf('\n  rails-guard:');
  assert.notEqual(jobStart, -1, 'the rails-guard job exists');
  const jobEnd = ci.indexOf('\n  mutation-gate:', jobStart);
  const job = ci.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
  const floorAt = job.search(/node scripts\/toolkit-floor-check\.mjs in-tree/);
  assert.notEqual(floorAt, -1, 'the floor step is present');
  const installAt = job.indexOf('run: npm ci --ignore-scripts');
  assert.notEqual(installAt, -1, 'the install step is present');
  // Ordering is load-bearing: the dependency-free checker must judge the tree
  // before candidate lifecycle scripts (npm install) can mutate it.
  assert.ok(floorAt < installAt, 'the floor gate must run before npm install');
});

// ── AC2: stale global CLI fails preflight with an actionable message ──────

test('global mode fails a below-floor adlc with a message naming the floor file and the upgrade command', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const shim = makeShim('1.9.0');
  try {
    const r = runCheck('global', root, { path: shim });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scripts\/toolkit-floor\.json/);
    assert.match(r.stderr, /npm i -g @adlc\/cli@latest/);
    assert.match(r.stderr, /2\.3\.4/, 'the message states the floor it enforces');
    assert.match(r.stderr, /1\.9\.0/, 'the message states the version it found');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

test('preflight fails fast, before any gate, when the global adlc is below the repo floor', () => {
  // Against the REAL repo tree and its committed floor: a shim far below any
  // plausible floor must stop `npm run preflight` (which runs this script) at
  // the precondition, before the first gate banner is printed.
  //
  // The repo's real node_modules/.bin sits FIRST on PATH, exactly as `npm run`
  // arranges it — its workspace `adlc` (current version, above the floor) must
  // NOT shadow the stale global shim behind it, or the check is vacuous
  // through the documented entry point.
  const shim = makeShim('0.0.1');
  try {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'preflight.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(REPO, 'node_modules', '.bin')}:${shim}` },
    });
    // Exactly 1 — preflight's "refused to run" exit, distinct from a gate's own
    // status (rail-freeze propagates 2). Pinning the value is what proves the
    // precondition exits on ITS path rather than falling through to a gate.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /toolkit-floor/);
    assert.match(r.stderr, /npm i -g @adlc\/cli@latest/);
    assert.ok(!r.stdout.includes('── [1/'), 'no gate may run once the floor check has failed');
  } finally {
    rmSync(shim, { recursive: true, force: true });
  }
});

test('global mode ignores an npm-injected node_modules/.bin adlc and judges the real global', () => {
  // An above-floor workspace adlc in a node_modules/.bin PATH entry sits AHEAD
  // of a below-floor "global" shim — the npm-run arrangement. The check must
  // skip the injected entry and fail on the shim behind it.
  const root = makeFixture({ floor: '2.3.4' });
  const shim = makeShim('1.9.0');
  // The injected entry belongs to the WORKSPACE the check runs in (cwd), which
  // is what the workspace-scoped scrub removes — an unrelated prefix's entry
  // is deliberately kept (separate test below).
  const fakeRepo = mkdtempSync(join(tmpdir(), 'fake-repo-'));
  const nmBin = join(fakeRepo, 'node_modules', '.bin');
  mkdirSync(nmBin, { recursive: true });
  writeFileSync(join(nmBin, 'adlc'), '#!/bin/sh\necho "99.99.99"\n', { mode: 0o755 });
  try {
    const r = runCheck('global', root, { path: `${nmBin}:${shim}`, cwd: fakeRepo });
    assert.equal(r.status, 1, `the workspace adlc must not shadow the stale global: ${r.stdout}`);
    assert.match(r.stderr, /1\.9\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
    rmSync(fakeRepo, { recursive: true, force: true });
  }
});

test('a prerelease of the floor version fails both modes; a prerelease above it passes', () => {
  const belowGlobal = makeFixture({ floor: '2.3.4' });
  const rcShim = makeShim('2.3.4-rc.1');
  const aboveShim = makeShim('2.3.5-rc.1');
  try {
    const denied = runCheck('global', belowGlobal, { path: rcShim });
    assert.equal(denied.status, 1, denied.stdout);
    assert.match(denied.stderr, /2\.3\.4-rc\.1/);
    const allowed = runCheck('global', belowGlobal, { path: aboveShim });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    rmSync(belowGlobal, { recursive: true, force: true });
    rmSync(rcShim, { recursive: true, force: true });
    rmSync(aboveShim, { recursive: true, force: true });
  }

  const inTree = makeFixture({ floor: '2.3.4', gateManifestVersion: '2.3.4-rc.1' });
  try {
    const r = runCheck('in-tree', inTree);
    assert.equal(r.status, 1, r.stdout);
  } finally {
    rmSync(inTree, { recursive: true, force: true });
  }
});

// ── AC3: a missing global adlc is not a failure ───────────────────────────

test('global mode passes when no adlc resolves on PATH', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const empty = emptyPathDir();
  try {
    const r = runCheck('global', root, { path: empty });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('checkGlobal passes only on a MISSING binary; other spawn errors fail closed', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const spawnError = (code) => ({ error: Object.assign(new Error(`spawn adlc ${code}`), { code }) });
  try {
    // pathValue: '' — no standalone-writer scan; this case is purely the
    // umbrella spawn contract.
    assert.equal(checkGlobal(root, { run: () => spawnError('ENOENT'), pathValue: '' }).ok, true, 'absent binary is not a failure');
    // EACCES etc. mean an adlc may exist whose version was NOT verified.
    const denied = checkGlobal(root, { run: () => spawnError('EACCES'), pathValue: '' });
    assert.equal(denied.ok, false, 'a non-ENOENT spawn error must fail closed');
    assert.match(denied.message, /EACCES/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC4: real semver comparison, not string comparison ────────────────────

test('versions above the real floor pass: next patch and next major', () => {
  const root = makeFixture({ floor: 'real' });
  const real = readFloor(root);
  const [major, minor, patch] = real.floor.triple;
  const nextPatch = [major, minor, patch + 1].join('.');
  const nextMajor = [major + 1, 0, 0].join('.');
  for (const version of [nextPatch, nextMajor, real.minToolkit]) {
    const shim = makeShim(version);
    try {
      const r = runCheck('global', root, { path: shim });
      assert.equal(r.status, 0, `${version} must satisfy the ${real.minToolkit} floor: ${r.stderr}`);
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('comparison is numeric per component, never lexicographic', () => {
  // "10.0.0" < "9.0.0" as strings — a string compare fails this case.
  const root = makeFixture({ floor: '9.0.0' });
  const shim = makeShim('10.0.0');
  try {
    const r = runCheck('global', root, { path: shim });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

test('compareVersions orders each component with the right precedence', () => {
  assert.ok(compareVersions([2, 3, 3], [2, 3, 4]) < 0, 'patch below');
  assert.equal(compareVersions([2, 3, 4], [2, 3, 4]), 0, 'equal');
  assert.ok(compareVersions([2, 3, 5], [2, 3, 4]) > 0, 'patch above');
  assert.ok(compareVersions([2, 2, 9], [2, 3, 4]) < 0, 'minor outranks patch');
  assert.ok(compareVersions([2, 4, 0], [2, 3, 9]) > 0, 'minor outranks patch (above)');
  assert.ok(compareVersions([1, 9, 9], [2, 0, 0]) < 0, 'major outranks minor');
  assert.ok(compareVersions([10, 0, 0], [9, 9, 9]) > 0, 'numeric, not lexicographic');
});

test('parseVersion extracts the version from CLI-style output and rejects garbage', () => {
  assert.deepEqual(parseVersion('2.3.4'), { version: '2.3.4', triple: [2, 3, 4], prerelease: false });
  assert.deepEqual(parseVersion('adlc 2.3.4\n'), { version: '2.3.4', triple: [2, 3, 4], prerelease: false });
  assert.deepEqual(parseVersion('2.3.4-rc.1'), { version: '2.3.4-rc.1', triple: [2, 3, 4], prerelease: true });
  // Semver allows a purely numeric prerelease starting with 0 (e.g. "1.0.0-0"):
  // it must still register as a prerelease, not be dropped as a non-match.
  assert.deepEqual(parseVersion('2.3.4-0'), { version: '2.3.4-0', triple: [2, 3, 4], prerelease: true });
  assert.equal(parseVersion('flurble'), null);
});

test('meetsFloor orders a prerelease below its release, per semver', () => {
  const floor = parseVersion('2.3.4');
  assert.equal(meetsFloor(parseVersion('2.3.4'), floor), true, 'stable at the floor passes');
  assert.equal(meetsFloor(parseVersion('2.3.4-rc.1'), floor), false, 'a prerelease of the floor version precedes it');
  assert.equal(meetsFloor(parseVersion('2.3.5-rc.1'), floor), true, 'a prerelease of a HIGHER version still postdates the floor');
  assert.equal(meetsFloor(parseVersion('2.3.3'), floor), false, 'below the floor fails');
});

test('scrubNpmPath drops only the workspace-and-ancestor entries npm injects', () => {
  const kept = '/usr/local/bin:/usr/bin';
  const injected = `/repo/packages/x/node_modules/.bin/:/repo/node_modules/.bin:${kept}`;
  // Workspace /repo/packages/x: both its own and its ancestor /repo's entries
  // are npm's injection and go; everything else stays.
  assert.equal(scrubNpmPath(injected, ':', '/repo/packages/x'), kept);
  // A node_modules/.bin under an UNRELATED prefix is a deliberate user PATH
  // entry — the shell resolves from it, so the probes must see it.
  assert.equal(
    scrubNpmPath('/opt/adlc/node_modules/.bin:/repo/node_modules/.bin', ':', '/repo'),
    '/opt/adlc/node_modules/.bin'
  );
  // A directory that merely CONTAINS the substring deeper in the path is not
  // npm's injection and must survive.
  assert.equal(scrubNpmPath('/opt/node_modules/.bin-tools/bin', ':', '/repo'), '/opt/node_modules/.bin-tools/bin');
  // Windows-shaped PATH: semicolon delimiter, backslash separators.
  assert.equal(
    scrubNpmPath('C:\\repo\\node_modules\\.bin;C:\\Windows\\system32;C:\\Program Files\\nodejs', ';', 'C:\\repo\\packages\\x'),
    'C:\\Windows\\system32;C:\\Program Files\\nodejs'
  );
});

test('global mode fails closed when adlc resolves but its version cannot be determined', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const shim = makeShim('flurble');
  try {
    const r = runCheck('global', root, { path: shim });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /npm i -g @adlc\/cli@latest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

// ── #489: standalone manifest-writer bins on PATH ─────────────────────────

test('a below-floor standalone gate-manifest fails preflight WITHOUT being executed', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const writer = makeGlobalWriterInstall('1.9.0');
  try {
    const r = runCheck('global', root, { path: writer.binDir }); // no adlc anywhere
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /gate-manifest/);
    assert.match(r.stderr, /1\.9\.0/);
    assert.match(r.stderr, /scripts\/toolkit-floor\.json/);
    // Surface-specific remediation: the umbrella upgrade nests its own copy
    // and cannot replace a separately installed standalone package.
    assert.match(r.stderr, /npm i -g @adlc\/gate-manifest@latest/);
    assert.equal(existsSync(writer.canary), false, 'the probe must never execute the stale writer');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(writer.prefix, { recursive: true, force: true });
  }
});

test('standalone writers at, above, and prerelease-above the floor pass; prerelease OF the floor fails', () => {
  const root = makeFixture({ floor: '2.3.4' });
  try {
    for (const [version, expected] of [['2.3.4', 0], ['3.0.0', 0], ['2.3.5-rc.1', 0], ['2.3.4-rc.1', 1]]) {
      const writer = makeGlobalWriterInstall(version);
      try {
        const r = runCheck('global', root, { path: writer.binDir });
        assert.equal(r.status, expected, `${version}: ${r.stdout}${r.stderr}`);
        assert.equal(existsSync(writer.canary), false);
      } finally {
        rmSync(writer.prefix, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adlc-spend is probed too, and an above-floor umbrella does not mask a stale writer', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const shim = makeShim('9.9.9'); // umbrella comfortably above the floor
  const writer = makeGlobalWriterInstall('1.9.0', ['adlc-spend']);
  try {
    const r = runCheck('global', root, { path: `${shim}:${writer.binDir}` });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /adlc-spend/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
    rmSync(writer.prefix, { recursive: true, force: true });
  }
});

test('an above-floor NON-executable decoy does not mask a stale executable writer later on PATH', () => {
  // Shell resolution skips a non-executable candidate and runs the next PATH
  // hit; the probe must judge the same file the shell would execute.
  const root = makeFixture({ floor: '2.3.4' });
  const decoy = makeGlobalWriterInstall('9.9.9');
  const stale = makeGlobalWriterInstall('1.9.0');
  try {
    chmodSync(join(decoy.binDir, 'gate-manifest'), 0o644); // symlink target perms govern access
    chmodSync(join(decoy.prefix, 'lib', 'node_modules', '@adlc', 'gate-manifest', 'bin', 'gate-manifest.mjs'), 0o644);
    const r = runCheck('global', root, { path: `${decoy.binDir}:${stale.binDir}` });
    assert.equal(r.status, 1, `the executable stale writer must be the judged surface: ${r.stdout}`);
    assert.match(r.stderr, /1\.9\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(decoy.prefix, { recursive: true, force: true });
    rmSync(stale.prefix, { recursive: true, force: true });
  }
});

test('an EMPTY PATH component means the current directory, exactly as the shell resolves it', () => {
  // PATH=":" is two empty components — POSIX resolution searches the cwd. A
  // stale executable writer in the cwd must be found, not classified absent.
  const root = makeFixture({ floor: '2.3.4' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@adlc/gate-manifest', version: '1.9.0' }));
  writeFileSync(join(root, 'gate-manifest'), '#!/bin/sh\n: > executed-canary\n', { mode: 0o755 });
  try {
    const r = runCheck('global', root, { path: ':', cwd: root });
    assert.equal(r.status, 1, `the cwd writer must be judged: ${r.stdout}`);
    assert.match(r.stderr, /1\.9\.0/);
    assert.equal(existsSync(join(root, 'executed-canary')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight end-to-end: a stale standalone writer fails the gate with no adlc anywhere', () => {
  // The CALLER-level wiring: `node scripts/preflight.mjs` (what npm run
  // preflight executes) must surface the standalone-writer verdict — the probe
  // reads the process PATH, so caller-side suppression of it breaks this test.
  const writer = makeGlobalWriterInstall('0.0.1');
  try {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'preflight.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PATH: writer.binDir },
    });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /gate-manifest/);
    assert.match(r.stderr, /0\.0\.1/);
    assert.equal(existsSync(writer.canary), false);
    assert.ok(!r.stdout.includes('── [1/'), 'no gate may run once the floor check has failed');
  } finally {
    rmSync(writer.prefix, { recursive: true, force: true });
  }
});

test('a stale writer under an UNRELATED node_modules/.bin prefix is still probed', () => {
  // A user-managed prefix (e.g. /opt/adlc/node_modules/.bin) is a real PATH
  // entry the shell resolves from — the workspace-scoped scrub must keep it.
  const root = makeFixture({ floor: '2.3.4' });
  const prefix = mkdtempSync(join(tmpdir(), 'adlc-user-prefix-'));
  const pkgDir = join(prefix, 'node_modules', '@adlc', 'gate-manifest');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/gate-manifest', version: '1.9.0' }));
  const target = join(pkgDir, 'bin', 'gate-manifest.mjs');
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const binDir = join(prefix, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(target, join(binDir, 'gate-manifest'));
  try {
    const r = runCheck('global', root, { path: binDir, cwd: root });
    assert.equal(r.status, 1, `the user-prefix writer must be judged: ${r.stdout}`);
    assert.match(r.stderr, /1\.9\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('on POSIX a plain-file wrapper never borrows an adjacent manifest — it fails closed', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX-only semantics; Windows legitimately uses the adjacent layout');
  // npm on POSIX always symlinks, so a plain executable named like a writer is
  // NOT npm's layout. Certifying it against a neighbouring package's version
  // would approve a wrapper that dispatches to a different (possibly stale)
  // install — refuse instead, even when the adjacent manifest is above floor.
  const prefix = mkdtempSync(join(tmpdir(), 'adlc-shim-layout-'));
  const pkgDir = join(prefix, 'node_modules', '@adlc', 'gate-manifest');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@adlc/gate-manifest', version: '9.9.9' }));
  writeFileSync(join(prefix, 'gate-manifest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const root = makeFixture({ floor: '2.3.4' });
  try {
    const r = runCheck('global', root, { path: prefix });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /could not locate its owning @adlc\/gate-manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('a writer bin whose owning package cannot be located fails closed', () => {
  const root = makeFixture({ floor: '2.3.4' });
  const strayDir = mkdtempSync(join(tmpdir(), 'stray-writer-'));
  writeFileSync(join(strayDir, 'gate-manifest'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const r = runCheck('global', root, { path: strayDir });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /could not locate its owning @adlc\/gate-manifest/);
    assert.match(r.stderr, /npm i -g @adlc\/gate-manifest@latest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(strayDir, { recursive: true, force: true });
  }
});

// ── #489: the floor inputs are trust roots ────────────────────────────────

test('the floor inputs are declared in REPO_TRUST_ROOTS, CODEOWNERS, and the tier classifier', () => {
  const FLOOR_INPUTS = [
    'scripts/toolkit-floor.json',
    'scripts/toolkit-floor-check.mjs',
    'scripts/test/toolkit-floor.test.mjs',
    // The enforcement CALLER and its wiring test: editing preflight alone can
    // suppress the check while every other floor input stays untouched.
    'scripts/preflight.mjs',
    'scripts/test/preflight.test.mjs',
  ];
  const wrapper = readFileSync(join(REPO, 'scripts', 'rails-guard-ci.mjs'), 'utf8');
  const codeowners = readFileSync(join(REPO, 'CODEOWNERS'), 'utf8');
  for (const path of FLOOR_INPUTS) {
    assert.ok(wrapper.includes(`'${path}'`), `REPO_TRUST_ROOTS must carry ${path}`);
    assert.match(codeowners, new RegExp(`^/${path.replaceAll('.', '\\.').replaceAll('/', '\\/')}\\s+@`, 'm'), `CODEOWNERS must own ${path}`);
  }
});

test('the tier classifier makes every floor input cross-model tier', async () => {
  const { classifyTrustRootTier } = await import('../../packages/prosecute/lib/tier.mjs');
  for (const path of ['scripts/toolkit-floor.json', 'scripts/toolkit-floor-check.mjs', 'scripts/test/toolkit-floor.test.mjs', 'scripts/preflight.mjs', 'scripts/test/preflight.test.mjs']) {
    const verdict = classifyTrustRootTier({ changedFiles: [path] });
    assert.equal(verdict.isTrustRootTier, true, `${path} must tier`);
    assert.ok(verdict.reasons.some((r) => r.includes(path)), `reason names ${path}`);
  }
  // Control: an ordinary script still does not tier.
  assert.equal(classifyTrustRootTier({ changedFiles: ['scripts/changelog.mjs'] }).isTrustRootTier, false);
});

// ── #489: the rails-guard job's install is script-free and verified clean ─

test('the rails-guard job installs with npm ci --ignore-scripts and asserts a clean tree before the gates', () => {
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobStart = ci.indexOf('\n  rails-guard:');
  const jobEnd = ci.indexOf('\n  mutation-gate:', jobStart);
  const job = ci.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
  const installAt = job.indexOf('run: npm ci --ignore-scripts');
  assert.notEqual(installAt, -1, 'the install must be npm ci --ignore-scripts');
  assert.ok(!/run: npm install\s*$/m.test(job), 'no plain npm install may remain in the job');
  const cleanAt = job.indexOf('Tracked tree is unmodified before privileged gates');
  const railFreezeAt = job.indexOf('Rail-freeze gate');
  assert.notEqual(cleanAt, -1, 'the cleanliness assertion step exists');
  assert.ok(installAt < cleanAt && cleanAt < railFreezeAt, 'install → cleanliness assertion → rail-freeze, in that order');
  // Against HEAD, not the index: a mutation that was also STAGED leaves the
  // working tree matching the index, and a plain `git diff` reads clean.
  assert.ok(job.includes('git diff --name-only HEAD --'), 'the cleanliness diff must compare against HEAD');
});

// ── the marker is the switch: no forest mode, no floor ────────────────────

test('global mode is inert without the segmented-manifest marker', () => {
  const root = makeFixture({ floor: '2.3.4', marker: false });
  const shim = makeShim('0.0.1');
  try {
    const r = runCheck('global', root, { path: shim });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

test('an unreadable marker directory fails closed in both modes, never "not in forest mode"', (t) => {
  // An absent marker means no forest mode; an UNREADABLE one is
  // indistinguishable from a cut-over repo and must fail, not silently pass.
  if (process.getuid?.() === 0) return t.skip('permission fixtures are meaningless as root');
  const globalRoot = makeFixture({ floor: '2.3.4' });
  const inTreeRoot = makeFixture({ floor: '2.3.4', gateManifestVersion: '9.9.9' });
  const shim = makeShim('9.9.9');
  const markerDir = (root) => join(root, '.adlc', 'manifest.d');
  try {
    chmodSync(markerDir(globalRoot), 0o000);
    chmodSync(markerDir(inTreeRoot), 0o000);
    const globalRun = runCheck('global', globalRoot, { path: shim });
    assert.equal(globalRun.status, 1, `global must fail closed: ${globalRun.stdout}`);
    assert.match(globalRun.stderr, /marker/);
    const inTreeRun = runCheck('in-tree', inTreeRoot);
    assert.equal(inTreeRun.status, 1, `in-tree must fail closed: ${inTreeRun.stdout}`);
    assert.match(inTreeRun.stderr, /marker/);
  } finally {
    chmodSync(markerDir(globalRoot), 0o755);
    chmodSync(markerDir(inTreeRoot), 0o755);
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(inTreeRoot, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

test('a malformed floor file fails closed rather than silently not enforcing', () => {
  const root = makeFixture({ floor: '^2.3.4' });
  const shim = makeShim('9.9.9');
  try {
    const r = runCheck('global', root, { path: shim });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /minToolkit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shim, { recursive: true, force: true });
  }
});

// ── AC5: the in-tree CI check ─────────────────────────────────────────────

test('in-tree mode fails when the marker exists and gate-manifest is versioned below the floor', () => {
  const root = makeFixture({ floor: '2.3.4', gateManifestVersion: '2.3.3' });
  try {
    const r = runCheck('in-tree', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scripts\/toolkit-floor\.json/);
    assert.match(r.stderr, /packages\/gate-manifest\/package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-tree mode passes at and above the floor', () => {
  for (const version of ['2.3.4', '2.4.0', '3.0.0']) {
    const root = makeFixture({ floor: '2.3.4', gateManifestVersion: version });
    try {
      const r = runCheck('in-tree', root);
      assert.equal(r.status, 0, `${version}: ${r.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('in-tree mode is inert without the marker', () => {
  const root = makeFixture({ floor: '2.3.4', marker: false, gateManifestVersion: '0.0.1' });
  try {
    const r = runCheck('in-tree', root);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-tree mode fails closed when the marker exists but the package manifest is unreadable', () => {
  const root = makeFixture({ floor: '2.3.4' }); // no packages/gate-manifest at all
  try {
    const r = runCheck('in-tree', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /packages\/gate-manifest\/package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real repo tree passes the in-tree floor check', () => {
  // The committed tree must always satisfy its own floor — otherwise the CI
  // step added by this ticket would fail every PR.
  const r = spawnSync(process.execPath, [SCRIPT, 'in-tree'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// checkInTree is also importable; pin the unit surface the CI step relies on.
test('checkInTree returns a failing verdict object below the floor', () => {
  const root = makeFixture({ floor: '2.3.4', gateManifestVersion: '1.0.0' });
  try {
    const verdict = checkInTree(root);
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /below the minimum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
