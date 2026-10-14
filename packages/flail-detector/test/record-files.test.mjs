// test/record-files.test.mjs — --record --files binds the flail-check entry to
// the tree it vouches for (#759): a path -> sha256 map the P4 runner re-hashes.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readEntries, sha256, ADLC_DIR } from '../../core/index.mjs';

const BIN = fileURLToPath(new URL('../bin/flail-detector.mjs', import.meta.url));
const CLEAN_LOG = 'Build started\nDone in 2.3s\nAll tests passed.\n';

function runBin(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function recorded(dir) {
  const adlcDir = join(dir, ADLC_DIR);
  if (!existsSync(join(adlcDir, 'manifest.jsonl'))) return [];
  return readEntries('manifest', adlcDir).entries;
}

describe('--record --files', () => {
  let dir;
  let logFile;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'flail-detector-files-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'b.mjs'), 'export const b = 2;\n');
    logFile = join(dir, 'clean.log');
    writeFileSync(logFile, CLEAN_LOG);
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('records a files map of path -> sha256 on a clean verdict', () => {
    const result = runBin([logFile, '--record', '--ticket', 'T1', '--files', 'src/a.mjs, b.mjs'], dir);
    assert.equal(result.status, 0, result.stderr);
    const entry = recorded(dir).at(-1);
    assert.equal(entry.type, 'flail-check');
    assert.deepEqual(entry.files, {
      'src/a.mjs': sha256('export const a = 1;\n'),
      'b.mjs': sha256('export const b = 2;\n'),
    });
  });

  test('an unreadable --files path is an operational error and records nothing', () => {
    const before = recorded(dir).length;
    const result = runBin([logFile, '--record', '--ticket', 'T1', '--files', 'b.mjs,missing.mjs'], dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /missing\.mjs/);
    assert.equal(recorded(dir).length, before);
  });

  test('a --files list naming no paths is an operational error and records nothing', () => {
    const before = recorded(dir).length;
    const result = runBin([logFile, '--record', '--ticket', 'T1', '--files', ' , '], dir);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /named no paths/);
    assert.equal(recorded(dir).length, before);
  });

  test('--record without --files still records, binding no files', () => {
    const result = runBin([logFile, '--record', '--ticket', 'T2'], dir);
    assert.equal(result.status, 0, result.stderr);
    const entry = recorded(dir).at(-1);
    assert.equal(entry.ticket, 'T2');
    assert.deepEqual(Object.keys(entry.files ?? {}), [], 'no tree binding without --files');
  });

  test('a flail verdict still exits 2 and records nothing, files or not', () => {
    const flailLog = join(dir, 'flail.log');
    writeFileSync(flailLog, 'Error: boom at x.mjs\nError: boom at x.mjs\nError: boom at x.mjs\n');
    const before = recorded(dir).length;
    const result = runBin([flailLog, '--record', '--ticket', 'T1', '--files', 'b.mjs'], dir);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(recorded(dir).length, before);
  });

  test('--help documents --files', () => {
    const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\s+--files <a,b,c>\s+With --record: hash these changed files/m);
  });
});
