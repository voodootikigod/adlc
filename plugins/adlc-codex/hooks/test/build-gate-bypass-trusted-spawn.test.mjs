// build-gate-bypass-trusted-spawn.test.mjs — #807. recordBuildGateBypass must
// resolve `adlc` through resolveTrustedBinary (never a bare spawnSync('adlc', ...)
// PATH lookup) and forward only RECOVERY_AUDIT_ENV_ALLOWLIST to the child, exactly
// like adlc-handoff-gate.mjs's recordRecoveryUnderBand already does — see that
// file's "resolveTrustedBinary: node_modules exclusion" and "forwards only the
// env allowlist" tests in observe-handoff-signals.test.mjs, which this mirrors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBuildGateBypass } from '../adlc-build-gate.mjs';
import { RECOVERY_AUDIT_ENV_ALLOWLIST } from '../adlc-handoff-gate.mjs';

function withPath(pathEnv, fn) {
  const prev = process.env.PATH;
  process.env.PATH = pathEnv;
  try { return fn(); } finally { process.env.PATH = prev; }
}

// A fake `adlc` that just dumps its received env to a JSON file and exits 0 —
// the same "spawn a real tiny script" technique the ticket names as an
// alternative to DI, and the one adlc-handoff-gate's own allowlist test uses.
//
// Mirrors the REAL deployment shape deliberately: a genuine `npm i -g
// @adlc/cli` bin-links an EXTENSIONLESS `adlc` on PATH as a symlink to a
// `.mjs` target (verified against this repo's own global install). An
// extensionless file's OWN content decides its module type inconsistently
// across Node versions (older Node defaults such a file to CommonJS and
// fails on `import`); resolveTrustedBinary correctly returns that
// extensionless symlink path, so recordBuildGateBypass must realpath it to
// the `.mjs` target before invoking — these fixtures exercise exactly that
// symlink shape rather than a same-named extensionless file with ESM
// content directly, which would pass on newer Node's auto-detection but is
// not what production actually looks like.
function writeFakeAdlc(dir, envDumpPath) {
  const implPath = join(dir, 'adlc-impl.mjs');
  writeFileSync(
    implPath,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
  );
  const fakeBin = join(dir, 'adlc');
  symlinkSync(implPath, fakeBin);
  return fakeBin;
}

// A shim inside a node_modules-shaped PATH entry that would prove it ran by
// writing a marker file — resolveTrustedBinary must skip it by directory
// string alone, so the marker must never appear regardless of file contents
// or permissions.
function writeNodeModulesShim(parentDir, markerPath) {
  const fakeDir = join(parentDir, 'node_modules', '.bin');
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(
    join(fakeDir, 'adlc'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
  );
  return fakeDir;
}

test('recordBuildGateBypass skips a node_modules PATH entry and uses the real trusted candidate further down PATH', () => {
  const nmDir = mkdtempSync(join(tmpdir(), 'bgb-nm-'));
  const realDir = mkdtempSync(join(tmpdir(), 'bgb-real-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bgb-cwd-'));
  try {
    mkdirSync(join(cwd, '.adlc'), { recursive: true });
    const marker = join(nmDir, 'ran-marker');
    const nmBinDir = writeNodeModulesShim(nmDir, marker);
    const envDumpPath = join(realDir, 'env-dump.json');
    writeFakeAdlc(realDir, envDumpPath);

    const ok = withPath([nmBinDir, realDir].join(':'), () =>
      recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd }));

    assert.equal(ok, true, 'must succeed via the real, non-node_modules candidate');
    assert.equal(existsSync(marker), false, 'the node_modules-shaped shim must never run');
    assert.equal(existsSync(envDumpPath), true, 'the real candidate must have been invoked');
  } finally {
    rmSync(nmDir, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass returns false and spawns nothing when every PATH candidate is inside node_modules', () => {
  const nmDir1 = mkdtempSync(join(tmpdir(), 'bgb-nm-only-1-'));
  const nmDir2 = mkdtempSync(join(tmpdir(), 'bgb-nm-only-2-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bgb-cwd-none-'));
  try {
    mkdirSync(join(cwd, '.adlc'), { recursive: true });
    const marker1 = join(nmDir1, 'ran-marker-1');
    const marker2 = join(nmDir2, 'ran-marker-2');
    const bin1 = writeNodeModulesShim(nmDir1, marker1);
    const bin2 = writeNodeModulesShim(nmDir2, marker2);

    const ok = withPath([bin1, bin2].join(':'), () =>
      recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd }));

    assert.equal(ok, false, 'no trusted binary resolvable — must report failure, never a bare-PATH fallback');
    assert.equal(existsSync(marker1), false);
    assert.equal(existsSync(marker2), false);
  } finally {
    rmSync(nmDir1, { recursive: true, force: true });
    rmSync(nmDir2, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass returns false when PATH is empty — no candidate at all', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bgb-cwd-empty-'));
  try {
    mkdirSync(join(cwd, '.adlc'), { recursive: true });
    const ok = withPath('', () =>
      recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd }));
    assert.equal(ok, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass forwards only RECOVERY_AUDIT_ENV_ALLOWLIST to the child — a manifest key never reaches it', () => {
  const realDir = mkdtempSync(join(tmpdir(), 'bgb-allowlist-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bgb-allowlist-cwd-'));
  const prevKey = process.env.ADLC_MANIFEST_KEY;
  try {
    mkdirSync(join(cwd, '.adlc'), { recursive: true });
    const envDumpPath = join(realDir, 'env-dump.json');
    writeFakeAdlc(realDir, envDumpPath);
    process.env.ADLC_MANIFEST_KEY = 'super-secret-should-never-leave-this-process';

    const ok = withPath(realDir, () =>
      recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd }));

    assert.equal(ok, true);
    const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'));
    assert.equal(dumped.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY must never reach the spawned child');
    assert.equal(dumped.ADLC_ADMIN_KEY, undefined);
    assert.equal(dumped.PATH, realDir, 'an allowlisted var (PATH), as set during the call, must still reach the child');
    for (const key of Object.keys(dumped)) {
      assert.ok(
        RECOVERY_AUDIT_ENV_ALLOWLIST.includes(key),
        `child env carried a non-allowlisted var: ${key}`,
      );
    }
  } finally {
    if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
    else process.env.ADLC_MANIFEST_KEY = prevKey;
    rmSync(realDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass preserves the cwd passthrough contract with the trusted spawn path', () => {
  const realDir = mkdtempSync(join(tmpdir(), 'bgb-cwd-passthrough-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bgb-cwd-passthrough-target-'));
  try {
    mkdirSync(join(cwd, '.adlc'), { recursive: true });
    const cwdDumpPath = join(realDir, 'cwd-dump.txt');
    const implPath = join(realDir, 'adlc-impl.mjs');
    writeFileSync(
      implPath,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(cwdDumpPath)}, process.cwd());\n`,
    );
    symlinkSync(implPath, join(realDir, 'adlc'));

    const ok = withPath(realDir, () =>
      recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd }));

    assert.equal(ok, true);
    assert.equal(readFileSync(cwdDumpPath, 'utf8'), cwd);
  } finally {
    rmSync(realDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
