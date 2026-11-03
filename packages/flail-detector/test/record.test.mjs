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
    assert.equal(entry.logFile, 'clean.log');
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

test('#628: --help exit-code table documents ledger-write failure under exit code 1', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1\s+operational error.*ledger-write failure/);
});

test('#628: a failed --record ledger append exits 1 via opError without printing CLEAN on stdout or a raw stack trace', () => {
  const brokenDir = mkdtempSync(join(tmpdir(), 'flail-detector-record-broken-'));
  try {
    const logFile = join(brokenDir, 'clean.log');
    writeFileSync(logFile, 'Build started\nAll tests passed.\n');
    const adlcDir = join(brokenDir, ADLC_DIR);
    // Write a corrupt manifest chain so appendManifestEntry throws
    spawnSync('mkdir', ['-p', adlcDir]);
    writeFileSync(join(adlcDir, 'manifest' + '.jsonl'), '{"seq":99,"prev":"bad"}\n');

    const result = runBin([logFile, '--record', '--ticket', 'T1'], brokenDir);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '', 'stdout must not claim CLEAN when --record failed');
    assert.match(result.stderr, /^error: could not record to manifest ledger: /m);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

test('#629: --record normalizes inside-repo logFile to relative path and omits outside-repo logFile', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'flail-detector-rel-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'flail-detector-outside-'));
  try {
    const insideLog = join(repoDir, 'inside.log');
    writeFileSync(insideLog, 'Build started\nAll good.\n');
    const r1 = runBin([insideLog, '--record', '--ticket', 'T1'], repoDir);
    assert.equal(r1.status, 0, r1.stderr);
    const entries1 = readEntries('manifest', join(repoDir, ADLC_DIR)).entries;
    assert.equal(entries1[entries1.length - 1].logFile, 'inside.log');

    const outsideLog = join(outsideDir, 'outside.log');
    writeFileSync(outsideLog, 'Build started\nAll good.\n');
    const r2 = runBin([outsideLog, '--record', '--ticket', 'T2'], repoDir);
    assert.equal(r2.status, 0, r2.stderr);
    const entries2 = readEntries('manifest', join(repoDir, ADLC_DIR)).entries;
    assert.equal('logFile' in entries2[entries2.length - 1], false, 'outside-repo logFile must be omitted');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('#627: --record warns on stderr when signing key is unset and stays quiet when set', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'flail-detector-keywarn-'));
  try {
    const logFile = join(repoDir, 'clean.log');
    writeFileSync(logFile, 'Build started\nAll good.\n');
    const envNoKey = { ...process.env };
    delete envNoKey['ADLC_MANIFEST_KEY'];
    const rUnsigned = spawnSync(process.execPath, [BIN, logFile, '--record', '--ticket', 'T1'], {
      cwd: repoDir, encoding: 'utf8', env: envNoKey,
    });
    assert.equal(rUnsigned.status, 0, rUnsigned.stderr);
    assert.match(rUnsigned.stderr, /flail-detector: warning: recording UNSIGNED manifest entry/);

    const repoDir2 = mkdtempSync(join(tmpdir(), 'flail-detector-keysigned-'));
    try {
      const logFile2 = join(repoDir2, 'clean.log');
      writeFileSync(logFile2, 'Build started\nAll good.\n');
      const envWithKey = { ...process.env, 'ADLC_MANIFEST_KEY': 'test-signing-key-627' };
      const rSigned = spawnSync(process.execPath, [BIN, logFile2, '--record', '--ticket', 'T1'], {
        cwd: repoDir2, encoding: 'utf8', env: envWithKey,
      });
      assert.equal(rSigned.status, 0, rSigned.stderr);
      assert.doesNotMatch(rSigned.stderr, /recording UNSIGNED manifest entry/);
    } finally {
      rmSync(repoDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
