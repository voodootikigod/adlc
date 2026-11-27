#!/usr/bin/env node
// build-hooks.mjs — deterministic zero-dependency ESM/CJS hook bundle compiler
// powered by esbuild (Wave 3 T-P21a). Produces standalone Node >=18 bundles
// that run in a node_modules-free directory with zero external dependencies.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync, version as esbuildVersion } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SUPPORTED_FORMATS = Object.freeze(['esm', 'cjs']);

/**
 * Default hook bundle targets compiled when `buildHooks()` is invoked without
 * explicit `targets`. Populated by plugin migrations in T-P21b.
 *
 * @type {readonly Array<{ name: string, entry: string, output: string, format?: 'esm' | 'cjs' }>}
 */
/**
 * Default plugin hook bundle targets compiled when `buildHooks()` is invoked
 * without explicit `targets` (populated when the 7 plugins migrate in T-P21b).
 * When empty, `buildHooks()` still smoke-compiles `packages/hook-engine/index.mjs`
 * in memory so `node scripts/build-hooks.mjs [--check]` never silently no-ops.
 *
 * @type {readonly Array<{ name: string, entry: string, output: string, format?: 'esm' | 'cjs' }>}
 */
export const DEFAULT_HOOK_TARGETS = Object.freeze([
  {
    name: 'adlc-gemini',
    entry: 'packages/hook-engine/lib/cli-gemini.mjs',
    output: 'plugins/adlc-gemini/hooks/adlc-rails-guard.bundle.mjs',
    format: 'esm',
  },
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Verify the loaded esbuild version matches root `package.json` so bundles are
 * byte-reproducible across developer machines and CI.
 *
 * @param {string} [root]
 * @param {string} [loadedVersion]
 */
export function assertEsbuildLockstep(root = ROOT, loadedVersion = esbuildVersion) {
  const rootPkg = readJson(join(root, 'package.json'));
  const declared = rootPkg.devDependencies?.esbuild;
  if (declared !== loadedVersion) {
    throw new Error(
      `esbuild version mismatch: package.json declares ${declared ?? '<missing>'}, ` +
      `loaded ${loadedVersion}. Run npm ci before running build-hooks.`
    );
  }
}

/**
 * Compile a single hook entrypoint into a deterministic, self-contained Node
 * ESM or CJS bundle buffer (never writes to disk).
 *
 * @param {object} opts
 * @param {string} opts.entryPath - absolute or root-relative entrypoint path
 * @param {string} opts.outputPath - logical output path for esbuild
 * @param {'esm' | 'cjs'} [opts.format='esm']
 * @param {string} [opts.root]
 * @param {string} [opts.label]
 * @param {Record<string, string>} [opts.define]
 * @param {typeof buildSync} [opts.buildSyncImpl]
 * @returns {Buffer}
 */
export function compileHookBundle({
  entryPath,
  outputPath,
  format = 'esm',
  root = ROOT,
  label = 'hook',
  define = {},
  buildSyncImpl = buildSync,
}) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`Unsupported bundle format "${format}" (expected one of: ${SUPPORTED_FORMATS.join(', ')})`);
  }
  const absEntry = resolve(root, entryPath);
  const absOutput = resolve(root, outputPath);
  const cjsShim = format === 'cjs'
    ? {
        banner: { js: 'const __adlcImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
        define: { 'import.meta.url': '__adlcImportMetaUrl', ...define },
      }
    : { define };
  const result = buildSyncImpl({
    absWorkingDir: root,
    entryPoints: [absEntry],
    bundle: true,
    platform: 'node',
    format,
    target: 'node18',
    outfile: absOutput,
    write: false,
    legalComments: 'none',
    ...cjsShim,
  });
  const outputFile =
    result.outputFiles?.find((file) => file.path === absOutput) ??
    result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild returned no output for ${label}`);
  }
  return Buffer.from(outputFile.contents);
}

function publishStagedWithRollback(entries, { writeFileSyncImpl = writeFileSync, renameSyncImpl = renameSync } = {}) {
  const staged = [];
  const snapshots = entries.map(({ target }) =>
    existsSync(target)
      ? { target, existed: true, previous: readFileSync(target) }
      : { target, existed: false, previous: null },
  );
  const committed = [];
  try {
    for (let i = 0; i < entries.length; i += 1) {
      const { target, contents } = entries[i];
      mkdirSync(dirname(target), { recursive: true });
      const tempPath = `${target}.tmp-${process.pid}-${i}`;
      writeFileSyncImpl(tempPath, contents);
      staged.push({ tempPath, target, snapshot: snapshots[i] });
    }
    for (const item of staged) {
      renameSyncImpl(item.tempPath, item.target);
      committed.push(item);
    }
  } catch (err) {
    const rollbackErrors = [];
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      const { target, snapshot } = committed[i];
      const rollbackTemp = `${target}.rollback-${process.pid}-${i}`;
      try {
        if (snapshot.existed) {
          writeFileSync(rollbackTemp, snapshot.previous);
          renameSync(rollbackTemp, target);
        } else {
          rmSync(target, { force: true });
        }
      } catch (rbErr) {
        rmSync(rollbackTemp, { force: true });
        rollbackErrors.push(`${target}: ${rbErr?.message ?? rbErr}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${err?.message ?? err} (rollback errors: ${rollbackErrors.join('; ')})`);
    }
    throw err;
  } finally {
    for (const { tempPath } of staged) {
      rmSync(tempPath, { force: true });
    }
  }
}

/**
 * Compile (and optionally write or drift-check) all hook targets.
 *
 * @param {object} [opts]
 * @param {readonly Array<{ name: string, entry: string, output: string, format?: 'esm' | 'cjs', define?: Record<string, string> }>} [opts.targets]
 * @param {string} [opts.root]
 * @param {boolean} [opts.write=true]
 * @param {boolean} [opts.check=false]
 * @param {'esm' | 'cjs' | null} [opts.formatOverride=null]
 * @param {typeof buildSync} [opts.buildSyncImpl]
 * @param {typeof writeFileSync} [opts.writeFileSyncImpl]
 * @param {typeof renameSync} [opts.renameSyncImpl]
 * @returns {{ ok: boolean, drifted: string[], bundles: Record<string, Buffer>, esbuildVersion: string }}
 */
export function buildHooks({
  targets = DEFAULT_HOOK_TARGETS,
  root = ROOT,
  write = true,
  check = false,
  formatOverride = null,
  buildSyncImpl = buildSync,
  writeFileSyncImpl = writeFileSync,
  renameSyncImpl = renameSync,
} = {}) {
  assertEsbuildLockstep(root);

  const bundles = {};
  const stagedEntries = [];
  const drifted = [];

  if (targets.length === 0) {
    const fmt = formatOverride ?? 'esm';
    const ext = fmt === 'cjs' ? 'cjs' : 'mjs';
    bundles[`hook-engine.bundle.${ext}`] = compileHookBundle({
      entryPath: 'packages/hook-engine/index.mjs',
      outputPath: `hook-engine.bundle.${ext}`,
      format: fmt,
      root,
      label: 'hook-engine',
      buildSyncImpl,
    });
    return {
      ok: true,
      drifted,
      bundles,
      esbuildVersion,
    };
  }

  for (const target of targets) {
    const fmt = formatOverride ?? target.format ?? 'esm';
    let outRel = target.output;
    if (formatOverride === 'cjs' && outRel.endsWith('.mjs')) {
      outRel = `${outRel.slice(0, -4)}.cjs`;
    } else if (formatOverride === 'esm' && outRel.endsWith('.cjs')) {
      outRel = `${outRel.slice(0, -4)}.mjs`;
    }
    const absOut = resolve(root, outRel);
    const contents = compileHookBundle({
      entryPath: target.entry,
      outputPath: absOut,
      format: fmt,
      root,
      label: target.name ?? outRel,
      define: target.define ?? {},
      buildSyncImpl,
    });
    bundles[outRel] = contents;
    stagedEntries.push({ target: absOut, contents });

    if (check) {
      const current = existsSync(absOut) ? readFileSync(absOut) : null;
      if (!current || !current.equals(contents)) {
        drifted.push(outRel);
      }
    }
  }

  if (write && !check && stagedEntries.length > 0) {
    publishStagedWithRollback(stagedEntries, { writeFileSyncImpl, renameSyncImpl });
  }

  return {
    ok: drifted.length === 0,
    drifted,
    bundles,
    esbuildVersion,
  };
}

function runCli(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const fmtIdx = argv.indexOf('--format');
  const formatOverride = fmtIdx >= 0 ? argv[fmtIdx + 1] : null;
  const result = buildHooks({ check, write: !check, formatOverride });
  if (check && !result.ok) {
    process.stderr.write(`build-hooks: drifted bundle(s):\n  ${result.drifted.join('\n  ')}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
