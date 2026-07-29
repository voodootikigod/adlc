// test/record.test.mjs — Tests for --record flag: the bin must write a
// flail-check manifest entry on a clean (non-flail) verdict, mirroring
// rails-guard's --record pattern (packages/rails-guard/test/record.test.mjs).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readEntries, sha256, ADLC_DIR } from '../../core/index.mjs';

const BIN = fileURLToPath(new URL('../bin/flail-detector.mjs', import.meta.url));

function runBin(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function manifestEntryCount(dir) {
  const adlcDir = join(dir, ADLC_DIR);
  return existsSync(join(adlcDir, 'manifest.jsonl'))
    ? readEntries('manifest', adlcDir).entries.length
    : 0;
}

test('--help documents --record and --ticket <id>', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--record\s+On a clean verdict, append a 'flail-check' manifest entry/);
  assert.match(result.stdout, /--ticket <id>\s+Ticket to scope the recorded manifest entry to/);
});

describe('--record: bin writes a flail-check manifest entry on a clean verdict', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'flail-detector-record-'));
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('--record --ticket writes a flail-check entry on clean verdict', () => {
    const logFile = join(dir, 'clean.log');
    writeFileSync(logFile, 'Build started\nDone in 2.3s\nAll tests passed.\n');

    const result = runBin([logFile, '--record', '--ticket', 'T1'], dir);
    assert.equal(result.status, 0, `expected clean pass; stderr: ${result.stderr}`);

    const adlcDir = join(dir, ADLC_DIR);
    assert.ok(existsSync(join(adlcDir, 'manifest.jsonl')), 'manifest.jsonl should exist after --record');

    const { entries, skipped } = readEntries('manifest', adlcDir);
    assert.equal(skipped.length, 0, 'no malformed lines expected');
    assert.ok(entries.length >= 1, 'at least one entry should be written');

    const entry = entries[entries.length - 1];
    assert.equal(entry.type, 'flail-check');
    assert.equal(entry.ticket, 'T1');
    assert.equal(entry.verdict, 'clean');
    assert.ok(typeof entry.ts === 'string', 'ts must be a string');
    assert.equal(entry.logFile, logFile);
    assert.equal(entry.logHash, sha256(readFileSync(logFile)), 'logHash must be the sha256 of the analyzed log content');
  });

  test('--record without --ticket still records, with ticket null', () => {
    const logFile = join(dir, 'clean2.log');
    writeFileSync(logFile, 'Build started\nDone.\n');

    const result = runBin([logFile, '--record'], dir);
    assert.equal(result.status, 0, `expected clean pass; stderr: ${result.stderr}`);

    const { entries } = readEntries('manifest', join(dir, ADLC_DIR));
    const entry = entries[entries.length - 1];
    assert.equal(entry.type, 'flail-check');
    assert.equal(entry.ticket, null);
  });

  test('--record does NOT write an entry when a flail signal fires', () => {
    const logFile = join(dir, 'flail.log');
    writeFileSync(logFile, 'Error: cannot connect\nError: cannot connect\n');

    const beforeCount = manifestEntryCount(dir);
    const result = runBin([logFile, '--record', '--ticket', 'T1'], dir);
    assert.equal(result.status, 2, `expected flail exit 2, got ${result.status}`);

    assert.equal(manifestEntryCount(dir), beforeCount, 'no new manifest entry should be written on a flail verdict');
  });

  test('without --record, no manifest entry is written on a clean verdict', () => {
    const logFile = join(dir, 'clean3.log');
    writeFileSync(logFile, 'Build succeeded.\n');

    const beforeCount = manifestEntryCount(dir);
    const result = runBin([logFile], dir);
    assert.equal(result.status, 0);

    assert.equal(manifestEntryCount(dir), beforeCount, 'no manifest entry should be written without --record');
  });
});
