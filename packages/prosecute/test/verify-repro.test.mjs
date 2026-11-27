import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRepro } from '../lib/verify-repro.mjs';
import { normalizeProvider, recordCrossModelReview } from '../lib/cross-model.mjs';

const CLI_PATH = fileURLToPath(new URL('../bin/adlc-prosecute.mjs', import.meta.url));

test('verifyRepro: rejects empty or whitespace command as operational error (exit 1)', () => {
  const res = verifyRepro({ cmd: '   ' });
  assert.equal(res.operationalError, true);
  assert.equal(res.exitCode, 1);
  assert.equal(res.reproduced, false);
});

test('verifyRepro: rejects shell wrapper binaries (sh, bash, zsh, eval) as operational error (exit 1)', (t) => {
  const shimDir = mkdtempSync(join(tmpdir(), 'verify-repro-eval-'));
  t.after(() => rmSync(shimDir, { recursive: true, force: true }));
  const evalBin = join(shimDir, 'eval');
  writeFileSync(evalBin, '#!/bin/sh\nexit 0\n');
  chmodSync(evalBin, 0o755);

  for (const sh of ['sh', 'bash', '/bin/bash', 'zsh', 'eval', evalBin]) {
    const res = verifyRepro({ cmd: `${sh} -c "exit 0"` });
    assert.equal(res.operationalError, true, `expected operational error for ${sh}`);
    assert.equal(res.exitCode, 1);
    assert.equal(res.reproduced, false);
  }
});

test('verifyRepro: rejects non-existent binary or missing command as operational failure (exit 1)', () => {
  const res = verifyRepro({ cmd: 'definitely-not-a-real-binary-12345 --foo' });
  assert.equal(res.operationalError, true);
  assert.equal(res.exitCode, 1);
  assert.equal(res.reproduced, false);
});

test('verifyRepro: distinguishes repro (exit 0) and refutation (exit 2) without expectFail', () => {
  const passRes = verifyRepro({ cmd: 'node -e "process.exit(0)"' });
  assert.equal(passRes.operationalError, false);
  assert.equal(passRes.reproduced, true);
  assert.equal(passRes.exitCode, 0);

  const failRes = verifyRepro({ cmd: 'node -e "process.exit(2)"' });
  assert.equal(failRes.operationalError, false);
  assert.equal(failRes.reproduced, false);
  assert.equal(failRes.exitCode, 2);
});

test('verifyRepro: with --expect-fail, non-zero exit means reproduced (exit 0) and 0 means refuted (exit 2)', () => {
  const failRes = verifyRepro({ cmd: 'node -e "process.exit(1)"', expectFail: true });
  assert.equal(failRes.operationalError, false);
  assert.equal(failRes.reproduced, true);
  assert.equal(failRes.exitCode, 0);

  const passRes = verifyRepro({ cmd: 'node -e "process.exit(0)"', expectFail: true });
  assert.equal(passRes.operationalError, false);
  assert.equal(passRes.reproduced, false);
  assert.equal(passRes.exitCode, 2);
});

test('verifyRepro: scrubs ADLC_MANIFEST_KEY and sensitive candidate env in temp workspace', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'verify-repro-fixture-'));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  writeFileSync(join(fixtureDir, 'test.txt'), 'hello');
  writeFileSync(join(fixtureDir, '.env'), 'SECRET=123');
  mkdirSync(join(fixtureDir, '.git'));
  writeFileSync(join(fixtureDir, '.git', 'config'), 'gitconfig');

  process.env.ADLC_MANIFEST_KEY = 'super-secret-key';
  t.after(() => delete process.env.ADLC_MANIFEST_KEY);

  const script = `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    assert.equal(process.env.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY must be scrubbed');
    assert.equal(existsSync('.env'), false, '.env secret file must not be copied');
    assert.equal(existsSync('.git'), false, '.git directory must not be copied');
    assert.equal(readFileSync('test.txt', 'utf8'), 'hello', 'tracked/workspace file copied');
  `;
  const res = verifyRepro({
    cmd: `node --input-type=module -e "${script.replace(/\n/g, ' ')}"`,
    root: fixtureDir,
  });
  assert.equal(res.operationalError, false, res.stderr);
  assert.equal(res.reproduced, true);
  assert.equal(res.exitCode, 0);

  // Verify workspace symlinks inside node_modules/@scope/pkg, node_modules/.bin, AND external node_modules targets cannot be mutated
  const externalPkgDir = mkdtempSync(join(tmpdir(), 'verify-repro-ext-pkg-'));
  t.after(() => rmSync(externalPkgDir, { recursive: true, force: true }));
  writeFileSync(join(externalPkgDir, 'ext.mjs'), 'export const extSafe = 1;\n');

  mkdirSync(join(fixtureDir, 'packages', 'pkg', 'bin'), { recursive: true });
  writeFileSync(join(fixtureDir, 'packages', 'pkg', 'index.mjs'), 'export const safe = 1;\n');
  writeFileSync(join(fixtureDir, 'packages', 'pkg', 'bin', 'cli.mjs'), '#!/usr/bin/env node\nexport const binSafe = 1;\n');
  mkdirSync(join(fixtureDir, 'node_modules', '@demo'), { recursive: true });
  mkdirSync(join(fixtureDir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(join(fixtureDir, 'packages', 'pkg'), join(fixtureDir, 'node_modules', '@demo', 'pkg'), 'dir');
  symlinkSync(join(fixtureDir, 'packages', 'pkg', 'bin', 'cli.mjs'), join(fixtureDir, 'node_modules', '.bin', 'demo-cli'), 'file');
  symlinkSync(externalPkgDir, join(fixtureDir, 'node_modules', 'ext-pkg'), 'dir');

  const mutRes = verifyRepro({
    cmd: 'node --input-type=module -e "import { writeFileSync } from \'node:fs\'; writeFileSync(\'node_modules/@demo/pkg/index.mjs\', \'MUTATED\'); writeFileSync(\'node_modules/.bin/demo-cli\', \'MUTATED_BIN\'); try { writeFileSync(\'node_modules/ext-pkg/ext.mjs\', \'MUTATED_EXT\'); } catch {}"',
    root: fixtureDir,
  });
  assert.equal(mutRes.exitCode, 0, mutRes.stderr);
  assert.equal(readFileSync(join(fixtureDir, 'packages', 'pkg', 'index.mjs'), 'utf8'), 'export const safe = 1;\n');
  assert.equal(readFileSync(join(fixtureDir, 'packages', 'pkg', 'bin', 'cli.mjs'), 'utf8'), '#!/usr/bin/env node\nexport const binSafe = 1;\n');
  assert.equal(readFileSync(join(externalPkgDir, 'ext.mjs'), 'utf8'), 'export const extSafe = 1;\n');

  // Even under explicit unsafeNoSandbox=true (sandboxType=null), external node_modules are dereferenced copies so externalPkgDir stays untouched
  const unsafeExtRes = verifyRepro({
    cmd: 'node --input-type=module -e "import { writeFileSync } from \'node:fs\'; writeFileSync(\'node_modules/ext-pkg/ext.mjs\', \'MUTATED_EXT\');"',
    root: fixtureDir,
    sandboxType: null,
    unsafeNoSandbox: true,
  });
  assert.equal(unsafeExtRes.exitCode, 0, unsafeExtRes.stderr);
  assert.equal(readFileSync(join(externalPkgDir, 'ext.mjs'), 'utf8'), 'export const extSafe = 1;\n');

  // Fails closed when OS sandbox is unavailable and unsafeNoSandbox is false
  const noSbRes = verifyRepro({
    cmd: 'node -e "process.exit(0)"',
    root: fixtureDir,
    sandboxType: null,
    unsafeNoSandbox: false,
  });
  assert.equal(noSbRes.operationalError, true);
  assert.equal(noSbRes.exitCode, 1);
  assert.match(noSbRes.error, /No OS sandbox available/);
});

test('verifyRepro: treats signal termination as non-zero failure in both modes', () => {
  const sigDefault = verifyRepro({ cmd: 'node -e "process.kill(process.pid, \'SIGKILL\')"' });
  assert.equal(sigDefault.operationalError, false);
  assert.notEqual(sigDefault.status, 0);
  assert.equal(sigDefault.reproduced, false);
  assert.equal(sigDefault.exitCode, 2);

  const sigExpectFail = verifyRepro({ cmd: 'node -e "process.kill(process.pid, \'SIGKILL\')"', expectFail: true });
  assert.equal(sigExpectFail.operationalError, false);
  assert.notEqual(sigExpectFail.status, 0);
  assert.equal(sigExpectFail.reproduced, true);
  assert.equal(sigExpectFail.exitCode, 0);

  const sigUnsandboxed = verifyRepro({
    cmd: 'node -e "process.kill(process.pid, \'SIGKILL\')"',
    sandboxType: null,
    unsafeNoSandbox: true,
  });
  assert.equal(sigUnsandboxed.status, null);
  assert.equal(sigUnsandboxed.reproduced, false);
  assert.equal(sigUnsandboxed.exitCode, 2);
});

test('adlc-prosecute verify-repro CLI dispatch and JSON output', () => {
  const defaultRes = spawnSync(process.execPath, [
    CLI_PATH,
    'verify-repro',
    '--cmd',
    'node -e "process.exit(0)"',
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(defaultRes.status, 0);
  assert.equal(JSON.parse(defaultRes.stdout).reproduced, true);

  const res = spawnSync(process.execPath, [
    CLI_PATH,
    'verify-repro',
    '--cmd',
    'node -e "process.exit(1)"',
    '--expect-fail',
    '--json',
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.reproduced, true);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.operationalError, false);

  // CLI fails closed by default when no OS sandbox binary is on PATH, and allows explicit --unsafe-no-sandbox
  const nodeOnlyBin = mkdtempSync(join(tmpdir(), 'verify-repro-nosb-bin-'));
  symlinkSync(process.execPath, join(nodeOnlyBin, 'node'));
  try {
    const cliNoSb = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-repro', '--cmd', 'node -e "process.exit(0)"', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: nodeOnlyBin } },
    );
    assert.equal(cliNoSb.status, 1);
    assert.equal(JSON.parse(cliNoSb.stdout).operationalError, true);

    const cliExplicitUnsafe = spawnSync(
      process.execPath,
      [CLI_PATH, 'verify-repro', '--cmd', 'node -e "process.exit(0)"', '--unsafe-no-sandbox', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: nodeOnlyBin } },
    );
    assert.equal(cliExplicitUnsafe.status, 0);
    assert.equal(JSON.parse(cliExplicitUnsafe.stdout).reproduced, true);
  } finally {
    rmSync(nodeOnlyBin, { recursive: true, force: true });
  }
});

test('cross-model normalizeProvider maps codex-cli to openai and claude-cli to anthropic', (t) => {
  assert.equal(normalizeProvider('codex-cli'), 'openai');
  assert.equal(normalizeProvider('codex.1'), 'openai');
  assert.equal(normalizeProvider('codexx'), 'codexx');
  assert.equal(normalizeProvider('claude-cli'), 'anthropic');

  const dir = mkdtempSync(join(tmpdir(), 'cm-codex-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () =>
      recordCrossModelReview({
        ticket: 'T1',
        revision: 'rev-1',
        provider: 'codex-cli',
        authorProvider: 'openai',
        verdict: 'approve',
        dir,
        key: 'local-hmac-test',
      }),
    /distinct from the author/,
  );
});
