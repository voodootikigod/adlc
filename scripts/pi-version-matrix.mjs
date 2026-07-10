#!/usr/bin/env node
// pi-version-matrix.mjs — upstream-drift smoke for the adlc-pi extension (spec 5.3).
//
// Runs the existing scripts/pi-live-deny.mjs deny proof against BOTH pi builds:
//   1. the PINNED devDependency (the same build the required CI leg uses), and
//   2. the LATEST published @earendil-works/pi-coding-agent, installed into a
//      throwaway prefix and selected via the ADLC_PI_BIN override the deny proof
//      honors.
//
// Purpose: catch pi hook-contract drift (e.g. the 0.80.0 pi-ai compat alias slated
// for removal) BEFORE it reaches the pinned bump — without flaking the required
// job. This is a NON-required, cron+dispatch workflow: it exits 0 when the latest
// build still passes the deny proof (with a WARN when it drifts from the pin) and
// exits 1 ONLY when the latest build FAILS the proof.
//
// No API keys or network beyond the npm registry are needed. If the registry is
// unreachable (offline), the latest leg is SKIPPED and the job exits 0 rather than
// flaking.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PI_CORE = '@earendil-works/pi-coding-agent';

/**
 * Pure decision table for the matrix outcome — exported so the behavior is unit
 * tested without spawning a real pi process. The ONLY exit-1 path is a latest
 * build that is installable but fails the deny proof; every other case is a
 * non-fatal exit 0 (clean, drift-but-passing, or skipped).
 */
export function matrixVerdict({ pinnedSkipped, latestInstallable, latestPassed, pinnedVersion, latestVersion }) {
  if (pinnedSkipped) {
    return { code: 0, level: 'SKIP', message: `SKIP: the deny proof skipped on this runtime (pi needs Node >= 22.19) — matrix cannot compare builds.` };
  }
  if (!latestInstallable) {
    return { code: 0, level: 'SKIP', message: `SKIP: could not install ${PI_CORE}@latest (registry offline?) — pinned leg only; no drift signal.` };
  }
  if (latestPassed) {
    if (latestVersion === pinnedVersion) {
      return { code: 0, level: 'CLEAN', message: `MATRIX CLEAN: latest (${latestVersion}) == pinned (${pinnedVersion}); deny proof holds.` };
    }
    return { code: 0, level: 'WARN', message: `WARN: pinned=${pinnedVersion} latest=${latestVersion} differ, but the latest build PASSES the deny proof — no hook-contract drift yet.` };
  }
  return { code: 1, level: 'FAIL', message: `FAIL: latest ${PI_CORE} (${latestVersion}) FAILED the deny proof — upstream hook-contract drift. Investigate before bumping the pin.` };
}

// --- runner ---------------------------------------------------------------

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function pinnedPiVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'plugins', 'adlc-pi', 'package.json'), 'utf8'));
  return pkg.devDependencies?.[PI_CORE] ?? 'unknown';
}

/** Run scripts/pi-live-deny.mjs once. `piBin` (when set) is passed via ADLC_PI_BIN. */
function runDenyProof(root, piBin) {
  const env = { ...process.env };
  if (piBin) env.ADLC_PI_BIN = piBin;
  const res = spawnSync('node', [join(root, 'scripts', 'pi-live-deny.mjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { passed: res.status === 0 && /PASS:/.test(out), skipped: /^SKIP:/m.test(out), status: res.status, out };
}

/** Install PI_CORE@latest into a throwaway prefix; return { ok, version, bin, dir }. */
function installLatest() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-version-matrix-'));
  const res = spawnSync('npm', ['install', '--prefix', dir, `${PI_CORE}@latest`, '--no-audit', '--no-fund', '--no-save', '--silent'], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  const pkgPath = join(dir, 'node_modules', PI_CORE, 'package.json');
  if (res.status !== 0 || !existsSync(pkgPath)) {
    return { ok: false, dir };
  }
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const bin = join(dir, 'node_modules', '.bin', 'pi');
  return { ok: existsSync(bin), version, bin, dir };
}

export function main() {
  const root = repoRoot();
  const pinnedVersion = pinnedPiVersion(root);

  console.log(`[matrix] pinned ${PI_CORE} = ${pinnedVersion}`);
  console.log('[matrix] running deny proof against the pinned build ...');
  const pinned = runDenyProof(root);
  if (pinned.skipped) {
    const v = matrixVerdict({ pinnedSkipped: true });
    console.log(v.message);
    return v.code;
  }
  console.log(`[matrix] pinned leg: ${pinned.passed ? 'PASS' : 'FAIL'}`);

  console.log(`[matrix] installing ${PI_CORE}@latest into a temp prefix ...`);
  const latest = installLatest();
  try {
    if (!latest.ok) {
      const v = matrixVerdict({ latestInstallable: false, pinnedVersion });
      console.log(v.message);
      return v.code;
    }
    console.log(`[matrix] latest ${PI_CORE} = ${latest.version}; running deny proof against it ...`);
    const latestRun = runDenyProof(root, latest.bin);
    console.log(`[matrix] latest leg: ${latestRun.passed ? 'PASS' : 'FAIL'}`);
    const v = matrixVerdict({
      latestInstallable: true,
      latestPassed: latestRun.passed,
      pinnedVersion,
      latestVersion: latest.version,
    });
    if (!latestRun.passed) {
      // Surface the latest-leg output so the drift is diagnosable from the log.
      console.error(latestRun.out.slice(-4000));
    }
    console.log(v.message);
    return v.code;
  } finally {
    rmSync(latest.dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
