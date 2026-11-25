import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  assertEsbuildLockstep,
  compileHookBundle,
  buildHooks,
  DEFAULT_HOOK_TARGETS,
} from '../build-hooks.mjs';

test('DEFAULT_HOOK_TARGETS is non-empty and passes drift check against committed bundle', () => {
  assert.ok(DEFAULT_HOOK_TARGETS.length >= 1, 'DEFAULT_HOOK_TARGETS must compile at least one real bundle');
  const check = buildHooks({ check: true, write: false });
  assert.equal(check.ok, true, `default hook bundle(s) drifted: ${check.drifted.join(', ')}`);
});

test('assertEsbuildLockstep passes for repo esbuild version and throws on mismatch', () => {
  assert.doesNotThrow(() => assertEsbuildLockstep());
  assert.throws(() => assertEsbuildLockstep(process.cwd(), '0.0.0-mismatch'), /esbuild version mismatch/);
});

test('compileHookBundle produces deterministic byte-identical ESM and CJS bundles and rejects invalid format', () => {
  assert.throws(
    () => compileHookBundle({ entryPath: 'packages/hook-engine/index.mjs', outputPath: 'out.js', format: 'iife' }),
    /Unsupported bundle format/,
  );

  const esm1 = compileHookBundle({
    entryPath: 'packages/hook-engine/index.mjs',
    outputPath: 'dist/hook-engine.bundle.mjs',
    format: 'esm',
  });
  const esm2 = compileHookBundle({
    entryPath: 'packages/hook-engine/index.mjs',
    outputPath: 'dist/hook-engine.bundle.mjs',
    format: 'esm',
  });
  assert.ok(esm1.length > 1000, 'compiled ESM bundle should be non-trivial');
  assert.equal(esm1.equals(esm2), true, 'ESM bundle compilation must be byte-deterministic');

  const cjs1 = compileHookBundle({
    entryPath: 'packages/hook-engine/index.mjs',
    outputPath: 'dist/hook-engine.bundle.cjs',
    format: 'cjs',
  });
  assert.ok(cjs1.length > 1000, 'compiled CJS bundle should be non-trivial');
});

test('compiled ESM and CJS bundles execute inside a node_modules-free temp directory', () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), 'adlc-build-hooks-isolated-'));
  try {
    const esmOut = join(isolatedDir, 'hook-engine.bundle.mjs');
    const cjsOut = join(isolatedDir, 'hook-engine.bundle.cjs');
    const targets = [
      { name: 'esm-engine', entry: 'packages/hook-engine/index.mjs', output: esmOut, format: 'esm' },
      { name: 'cjs-engine', entry: 'packages/hook-engine/index.mjs', output: cjsOut, format: 'cjs' },
    ];

    const built = buildHooks({ targets, write: true });
    assert.equal(built.ok, true);

    // Drift check passes immediately after build.
    const cleanCheck = buildHooks({ targets, check: true, write: false });
    assert.equal(cleanCheck.ok, true);
    assert.deepEqual(cleanCheck.drifted, []);

    // Run compiled ESM bundle in isolatedDir with zero node_modules.
    const esmProbe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { evaluatePreTool, formatHookOutput, HARNESS_PROTOCOLS } from ${JSON.stringify(esmOut)};
         const res = evaluatePreTool({ toolName: 'Bash', toolInput: { command: 'rm -rf test' }, cwd: ${JSON.stringify(isolatedDir)}, rails: ['test/auth.test.mjs'] });
         const out = formatHookOutput('gemini', 'pretool', res);
         console.log(JSON.stringify({ decision: res.decision, allowTool: out.payload.allow_tool, harnesses: HARNESS_PROTOCOLS.length }));`,
      ],
      { cwd: isolatedDir, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(esmProbe.status, 0, `ESM bundle failed in isolated dir: ${esmProbe.stderr}`);
    const esmData = JSON.parse(esmProbe.stdout.trim());
    assert.deepEqual(esmData, { decision: 'deny', allowTool: false, harnesses: 7 });

    // Run compiled CJS bundle in isolatedDir with zero node_modules.
    const cjsProbe = spawnSync(
      process.execPath,
      [
        '-e',
        `const { evaluatePreTool, formatHookOutput } = require(${JSON.stringify(cjsOut)});
         const res = evaluatePreTool({ toolName: 'Edit', toolInput: { file_path: 'test/auth.test.mjs' }, cwd: ${JSON.stringify(isolatedDir)}, rails: ['test/auth.test.mjs'] });
         const out = formatHookOutput('claude-code', 'pretool', res);
         console.log(JSON.stringify({ decision: res.decision, perm: out.payload.hookSpecificOutput.permissionDecision }));`,
      ],
      { cwd: isolatedDir, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(cjsProbe.status, 0, `CJS bundle failed in isolated dir: ${cjsProbe.stderr}`);
    const cjsData = JSON.parse(cjsProbe.stdout.trim());
    assert.deepEqual(cjsData, { decision: 'deny', perm: 'deny' });

    // Mutate one output file and verify --check detects drift.
    writeFileSync(esmOut, `${readFileSync(esmOut, 'utf8')}\n// drifted\n`);
    const driftedCheck = buildHooks({ targets, check: true, write: false });
    assert.equal(driftedCheck.ok, false);
    assert.deepEqual(driftedCheck.drifted, [esmOut]);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});
