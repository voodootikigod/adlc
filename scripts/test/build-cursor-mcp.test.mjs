import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { version as esbuildVersion } from 'esbuild';

import { buildCursorMcp, CURSOR_HOOK_NAMES, CURSOR_HOOK_BUNDLES } from '../build-cursor-mcp.mjs';
import { after } from 'node:test';

// Every fixture the factories below mint; removed once this file's tests finish.
const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({
  declaredEsbuildVersion = esbuildVersion,
  coreVersion = '1.2.3',
  ticketsVersion = '1.2.3',
  buildGateVersion = '1.2.3',
  flailDetectorVersion = '1.2.3',
  pluginVersion = '1.2.3',
  coreRange = '^1.2.3',
  ticketsRange = '^1.2.3',
  buildGateRange = '^1.2.3',
  flailDetectorRange = '^1.2.3',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-cursor-mcp-'));
  fixtureDirs.add(root);
  const plugin = join(root, 'plugins', 'adlc-cursor');
  mkdirSync(join(root, 'packages', 'core'), { recursive: true });
  mkdirSync(join(root, 'packages', 'tickets'), { recursive: true });
  mkdirSync(join(root, 'packages', 'build-gate'), { recursive: true });
  mkdirSync(join(root, 'packages', 'flail-detector'), { recursive: true });
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });

  writeJson(join(root, 'package.json'), {
    devDependencies: { esbuild: declaredEsbuildVersion },
  });
  writeJson(join(root, 'packages', 'core', 'package.json'), { version: coreVersion });
  writeJson(join(root, 'packages', 'tickets', 'package.json'), { version: ticketsVersion });
  writeJson(join(root, 'packages', 'build-gate', 'package.json'), { version: buildGateVersion });
  writeJson(join(root, 'packages', 'flail-detector', 'package.json'), { version: flailDetectorVersion });
  writeJson(join(plugin, 'package.json'), {
    version: pluginVersion,
    dependencies: {
      '@adlc/core': coreRange,
      '@adlc/tickets': ticketsRange,
      '@adlc/build-gate': buildGateRange,
      '@adlc/flail-detector': flailDetectorRange,
    },
  });
  writeFileSync(join(plugin, 'bin', 'adlc-mcp-wrapper.mjs'), '// fixture entry\n');
  for (const name of CURSOR_HOOK_NAMES) {
    writeFileSync(join(plugin, 'hooks', `${name}.mjs`), `// fixture hook ${name}\n`);
  }
  return root;
}

function buildResult(options) {
  return {
    outputFiles: [{ path: options.outfile, contents: Buffer.from(`fixture bundle:${options.outfile}\n`) }],
  };
}

test('buildCursorMcp returns exact generated output without writing in dry-run mode', () => {
  const root = makeFixture();
  try {
    const calls = [];
    const result = buildCursorMcp({
      root,
      write: false,
      buildSyncImpl(options) {
        calls.push(options);
        return buildResult(options);
      },
    });

    assert.equal(calls.length, 1 + CURSOR_HOOK_NAMES.length);
    for (const received of calls) {
      assert.equal(received.bundle, true);
      assert.equal(received.write, false);
      assert.equal(received.platform, 'node');
      assert.equal(received.format, 'esm');
      assert.equal(received.target, 'node18');
    }
    assert.match(result.metadata.toString(), /pluginVersion: '1\.2\.3'/);
    assert.match(result.metadata.toString(), /"@adlc\/core": "1\.2\.3"/);
    assert.match(result.metadata.toString(), /"@adlc\/build-gate": "1\.2\.3"/);
    assert.match(result.metadata.toString(), /"@adlc\/flail-detector": "1\.2\.3"/);
    assert.deepEqual(result.bundle, Buffer.from(`fixture bundle:${result.outputPath}\n`));
    assert.equal(Object.keys(result.hookBundles).length, CURSOR_HOOK_BUNDLES.length);
    for (const rel of CURSOR_HOOK_BUNDLES) {
      assert.ok(Buffer.isBuffer(result.hookBundles[rel]), `missing hook bundle buffer for ${rel}`);
      assert.throws(() => readFileSync(join(root, rel)));
    }
    assert.throws(() => readFileSync(result.metadataPath));
    assert.throws(() => readFileSync(result.outputPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCursorMcp writes the metadata, MCP bundle, and all 8 hook bundles', () => {
  const root = makeFixture();
  try {
    const result = buildCursorMcp({
      root,
      buildSyncImpl(options) {
        return buildResult(options);
      },
    });

    assert.deepEqual(readFileSync(result.metadataPath), result.metadata);
    assert.deepEqual(readFileSync(result.outputPath), result.bundle);
    assert.equal(CURSOR_HOOK_NAMES.at(-1), 'adlc-preflight');
    for (const rel of CURSOR_HOOK_BUNDLES) {
      assert.deepEqual(readFileSync(join(root, rel)), result.hookBundles[rel]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCursorMcp refuses an esbuild version that differs from package.json', () => {
  const root = makeFixture({ declaredEsbuildVersion: '0.0.0' });
  try {
    assert.throws(
      () => buildCursorMcp({ root, buildSyncImpl: buildResult }),
      /esbuild version mismatch.*npm install, then npm run build:cursor-mcp/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCursorMcp refuses an out-of-lockstep bundled dependency before building', () => {
  for (const [label, overrides, expected] of [
    ['@adlc/tickets', { ticketsRange: '^9.9.9' }, /@adlc\/tickets bundle lockstep mismatch/],
    ['@adlc/build-gate', { buildGateRange: '^9.9.9' }, /@adlc\/build-gate bundle lockstep mismatch/],
    ['@adlc/flail-detector', { flailDetectorVersion: '9.9.9' }, /@adlc\/flail-detector bundle lockstep mismatch/],
  ]) {
    const root = makeFixture(overrides);
    try {
      let called = false;
      assert.throws(
        () => buildCursorMcp({
          root,
          buildSyncImpl() {
            called = true;
            throw new Error('must not build after lockstep failure');
          },
        }),
        expected,
        label,
      );
      assert.equal(called, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('buildCursorMcp refuses a builder response without an output file', () => {
  const root = makeFixture();
  try {
    assert.throws(
      () => buildCursorMcp({ root, buildSyncImpl: () => ({ outputFiles: [] }) }),
      /esbuild returned no Cursor MCP bundle output/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Every other test passes an explicit root, so the module's own default — the
// repository root the release path and `npm run build:cursor-mcp` rely on —
// would otherwise go unexercised.
test('the default root is the repository root', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const explicit = buildCursorMcp({ root: repoRoot, write: false });
  const byDefault = buildCursorMcp({ write: false });

  assert.equal(byDefault.outputPath, explicit.outputPath);
  assert.equal(byDefault.metadataPath, explicit.metadataPath);
  assert.deepEqual(byDefault.bundle, explicit.bundle);
  assert.deepEqual(byDefault.metadata, explicit.metadata);
});
