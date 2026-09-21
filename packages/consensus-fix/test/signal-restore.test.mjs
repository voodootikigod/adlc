/**
 * signal-restore.test.mjs — Verify snapshot restore on termination signals
 * (SIGTERM, SIGHUP, SIGINT) and atomic write behavior (issue #600).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  chmodSync,
  statSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileAtomic, restoreSnapshot, applyChanges, takeSnapshot, applyWinner } from '../lib/snapshot.mjs';

const BIN = resolve(new URL('../bin/consensus-fix.mjs', import.meta.url).pathname);

test('SIGTERM restores snapshot when process is terminated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-sigterm-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    const readyFile = join(dir, 'ready.txt');
    writeFileSync(targetFile, 'ORIGINAL_CONTENT\n');

    const testCmd = `node -e "const fs = require('fs'); fs.writeFileSync('${targetFile}', 'MUTATED_CONTENT\\n'); fs.writeFileSync('${readyFile}', 'ready'); setTimeout(() => process.exit(1), 600);"`;

    const child = spawn(process.execPath, [
      BIN,
      '--test-cmd', testCmd,
      '--files', targetFile,
      '--allow-dirty',
    ], {
      cwd: dir,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'mock-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const start = Date.now();
    while (!existsSync(readyFile) && Date.now() - start < 5000) {
      await new Promise((res) => setTimeout(res, 50));
    }

    assert.ok(existsSync(readyFile), 'testCmd did not signal ready in time');
    assert.equal(readFileSync(targetFile, 'utf8'), 'MUTATED_CONTENT\n');

    child.kill('SIGTERM');

    const [exitCode] = await new Promise((res) => {
      child.on('exit', (code, sig) => res([code, sig]));
    });

    assert.equal(exitCode, 1, 'process should exit 1 on SIGTERM restore');
    assert.equal(readFileSync(targetFile, 'utf8'), 'ORIGINAL_CONTENT\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGHUP restores snapshot when process receives hangup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-sighup-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    const readyFile = join(dir, 'ready.txt');
    writeFileSync(targetFile, 'ORIGINAL_CONTENT\n');

    const testCmd = `node -e "const fs = require('fs'); fs.writeFileSync('${targetFile}', 'MUTATED_CONTENT\\n'); fs.writeFileSync('${readyFile}', 'ready'); setTimeout(() => process.exit(1), 600);"`;

    const child = spawn(process.execPath, [
      BIN,
      '--test-cmd', testCmd,
      '--files', targetFile,
      '--allow-dirty',
    ], {
      cwd: dir,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'mock-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const start = Date.now();
    while (!existsSync(readyFile) && Date.now() - start < 5000) {
      await new Promise((res) => setTimeout(res, 50));
    }

    assert.ok(existsSync(readyFile), 'testCmd did not signal ready in time');
    assert.equal(readFileSync(targetFile, 'utf8'), 'MUTATED_CONTENT\n');

    child.kill('SIGHUP');

    const [exitCode] = await new Promise((res) => {
      child.on('exit', (code, sig) => res([code, sig]));
    });

    assert.equal(exitCode, 1, 'process should exit 1 on SIGHUP restore');
    assert.equal(readFileSync(targetFile, 'utf8'), 'ORIGINAL_CONTENT\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGINT restores snapshot when process is interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-sigint-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    const readyFile = join(dir, 'ready.txt');
    writeFileSync(targetFile, 'ORIGINAL_CONTENT\n');

    const testCmd = `node -e "const fs = require('fs'); fs.writeFileSync('${targetFile}', 'MUTATED_CONTENT\\n'); fs.writeFileSync('${readyFile}', 'ready'); setTimeout(() => process.exit(1), 600);"`;

    const child = spawn(process.execPath, [
      BIN,
      '--test-cmd', testCmd,
      '--files', targetFile,
      '--allow-dirty',
    ], {
      cwd: dir,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'mock-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const start = Date.now();
    while (!existsSync(readyFile) && Date.now() - start < 5000) {
      await new Promise((res) => setTimeout(res, 50));
    }

    assert.ok(existsSync(readyFile), 'testCmd did not signal ready in time');
    assert.equal(readFileSync(targetFile, 'utf8'), 'MUTATED_CONTENT\n');

    child.kill('SIGINT');

    const [exitCode] = await new Promise((res) => {
      child.on('exit', (code, sig) => res([code, sig]));
    });

    assert.equal(exitCode, 1, 'process should exit 1 on SIGINT restore');
    assert.equal(readFileSync(targetFile, 'utf8'), 'ORIGINAL_CONTENT\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic writes destination file atomically via temp file in same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-atomic-write-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    writeFileSync(targetFile, 'INITIAL_DATA\n');

    writeFileAtomic(targetFile, 'UPDATED_DATA\n');
    assert.equal(readFileSync(targetFile, 'utf8'), 'UPDATED_DATA\n');

    // Ensure no leftover .tmp files remain in the directory
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic cleans up temp file if write fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-atomic-fail-'));
  try {
    // A directory path cannot be overwritten by renameSync with a file (EISDIR)
    const subDir = join(dir, 'subdir');
    mkdirSync(subDir);
    assert.throws(() => {
      writeFileAtomic(subDir, 'SHOULD_FAIL');
    });

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreSnapshot restores all files using atomic writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-restore-atomic-'));
  try {
    const f1 = join(dir, 'f1.mjs');
    const f2 = join(dir, 'f2.mjs');
    writeFileSync(f1, 'F1_ORIGINAL');
    writeFileSync(f2, 'F2_ORIGINAL');

    const snap = takeSnapshot([f1, f2]);
    writeFileSync(f1, 'F1_MUTATED');
    writeFileSync(f2, 'F2_MUTATED');

    restoreSnapshot(snap);

    assert.equal(readFileSync(f1, 'utf8'), 'F1_ORIGINAL');
    assert.equal(readFileSync(f2, 'utf8'), 'F2_ORIGINAL');

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyChanges applies hunks using atomic writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-apply-atomic-'));
  try {
    const f1 = join(dir, 'f1.mjs');
    writeFileSync(f1, 'line 1\nline 2\n');
    const snap = { [f1]: 'line 1\nline 2\n' };

    const changes = [{
      file: f1,
      hunks: [{ startLine: 2, endLine: 2, replacement: 'line 2 replaced' }],
    }];

    const result = applyChanges(changes, snap);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(f1, 'utf8'), 'line 1\nline 2 replaced\n');

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('winning candidate --apply writes atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-cli-apply-'));
  try {
    const targetFile = join(dir, 'target.mjs');
    writeFileSync(targetFile, 'export const val = 1;\n');

    const preload = join(dir, 'mock-llm.mjs');
    writeFileSync(preload, `
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              changes: [{
                file: ${JSON.stringify(targetFile)},
                hunks: [{ startLine: 1, endLine: 1, replacement: 'export const val = 2;' }]
              }]
            })
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    `);

    const testCmd = `node -e "const fs = require('fs'); const c = fs.readFileSync('${targetFile}', 'utf8'); if (!c.includes('val = 2')) process.exit(1);"`;

    const res = spawnSync(process.execPath, [
      '--import', preload,
      BIN,
      '--test-cmd', testCmd,
      '--files', targetFile,
      '--n', '1',
      '--allow-dirty',
      '--apply',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'mock-key' },
    });

    assert.equal(res.status, 0);
    assert.equal(readFileSync(targetFile, 'utf8'), 'export const val = 2;\n');

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic preserves file permissions (executable mode)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-atomic-mode-'));
  try {
    const targetFile = join(dir, 'script.sh');
    writeFileSync(targetFile, '#!/bin/sh\necho 1\n');
    chmodSync(targetFile, 0o755);

    writeFileAtomic(targetFile, '#!/bin/sh\necho 2\n');
    assert.equal(readFileSync(targetFile, 'utf8'), '#!/bin/sh\necho 2\n');
    assert.equal(statSync(targetFile).mode & 0o777, 0o755);

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic preserves symlinks and writes target content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-atomic-symlink-'));
  try {
    const realTarget = join(dir, 'real.mjs');
    const linkPath = join(dir, 'link.mjs');
    writeFileSync(realTarget, 'INITIAL\n');
    symlinkSync(realTarget, linkPath);

    writeFileAtomic(linkPath, 'UPDATED\n');

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readFileSync(realTarget, 'utf8'), 'UPDATED\n');
    assert.equal(readFileSync(linkPath, 'utf8'), 'UPDATED\n');

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyWinner rolls back already written files if subsequent write fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-rollback-'));
  try {
    const f1 = join(dir, 'f1.mjs');
    const f2 = join(dir, 'f2.mjs');
    writeFileSync(f1, 'F1_ORIGINAL\n');
    writeFileSync(f2, 'F2_ORIGINAL\n');

    const snap = {
      [f1]: 'F1_ORIGINAL\n',
      [f2]: 'F2_ORIGINAL\n',
    };

    // Replace f2 with a directory after snapshot so writeFileAtomic(f2) throws EISDIR
    rmSync(f2);
    mkdirSync(f2);

    const winnerChanges = [
      { file: f1, hunks: [{ startLine: 1, endLine: 1, replacement: 'F1_MODIFIED\n' }] },
      { file: f2, hunks: [{ startLine: 1, endLine: 1, replacement: 'F2_MODIFIED\n' }] },
    ];

    assert.throws(() => {
      applyWinner(winnerChanges, snap);
    });

    // f1 was written first, but then rolled back to F1_ORIGINAL!
    assert.equal(readFileSync(f1, 'utf8'), 'F1_ORIGINAL\n');

    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
