import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version as esbuildVersion } from 'esbuild';

import { buildCursorMcp } from '../build-cursor-mcp.mjs';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({
  declaredEsbuildVersion = esbuildVersion,
  coreVersion = '1.2.3',
  ticketsVersion = '1.2.3',
  pluginVersion = '1.2.3',
  coreRange = '^1.2.3',
  ticketsRange = '^1.2.3',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-cursor-mcp-'));
  const plugin = join(root, 'plugins', 'adlc-cursor');
  mkdirSync(join(root, 'packages', 'core'), { recursive: true });
  mkdirSync(join(root, 'packages', 'tickets'), { recursive: true });
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  mkdirSync(join(plugin, 'lib'), { recursive: true });

  writeJson(join(root, 'package.json'), {
    devDependencies: { esbuild: declaredEsbuildVersion },
  });
  writeJson(join(root, 'packages', 'core', 'package.json'), { version: coreVersion });
  writeJson(join(root, 'packages', 'tickets', 'package.json'), { version: ticketsVersion });
  writeJson(join(plugin, 'package.json'), {
    version: pluginVersion,
    dependencies: {
      '@adlc/core': coreRange,
      '@adlc/tickets': ticketsRange,
    },
  });
  writeFileSync(join(plugin, 'bin', 'adlc-mcp-wrapper.mjs'), '// fixture entry\n');
  return root;
}

function buildResult(options) {
  return {
    outputFiles: [{ path: options.outfile, contents: Buffer.from('fixture bundle\n') }],
  };
}

test('buildCursorMcp returns exact generated output without writing in dry-run mode', () => {
  const root = makeFixture();
  try {
    let received;
    const result = buildCursorMcp({
      root,
      write: false,
      buildSyncImpl(options) {
        received = options;
        return buildResult(options);
      },
    });

    assert.equal(received.bundle, true);
    assert.equal(received.write, false);
    assert.equal(received.platform, 'node');
    assert.equal(received.format, 'esm');
    assert.equal(received.target, 'node18');
    assert.match(result.metadata.toString(), /pluginVersion: '1\.2\.3'/);
    assert.match(result.metadata.toString(), /"@adlc\/core": "1\.2\.3"/);
    assert.deepEqual(result.bundle, Buffer.from('fixture bundle\n'));
    assert.throws(() => readFileSync(result.metadataPath));
    assert.throws(() => readFileSync(result.outputPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCursorMcp writes the metadata and bundle returned by the official builder', () => {
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
  const root = makeFixture({ ticketsRange: '^9.9.9' });
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
      /@adlc\/tickets bundle lockstep mismatch/,
    );
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
