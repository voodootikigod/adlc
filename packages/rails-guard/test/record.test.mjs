// Tests for --record flag: the bin must write a manifest entry on a clean pass.
// Spins up a scratch git repo, invokes bin/rails-guard.mjs directly, and
// reads back the manifest to verify the entry shape.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readEntries, AIDLC_DIR } from '../../core/index.mjs';

const BIN = fileURLToPath(new URL('../bin/rails-guard.mjs', import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rails-guard-record-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  return dir;
}

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(full.substring(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

function commit(dir, msg) {
  git(['add', '-A'], dir);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', msg], dir);
}

/** Invoke the bin in a given cwd and return { status, stdout, stderr }. */
function runBin(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return result;
}

describe('--record: bin writes manifest entry on clean pass', () => {
  let dir;

  before(() => {
    dir = setupRepo();
    // A rail file and a source file committed on main
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => {});\n');
    writeFile(dir, 'src/auth.ts', 'export function login() {}\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('--record writes a manifest entry when no violations', () => {
    // Modify only a non-rail file so we have a clean pass
    writeFile(dir, 'src/auth.ts', 'export function login() { return true; }\n');

    const result = runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);
    assert.equal(result.status, 0, `bin exited ${result.status}; stderr: ${result.stderr}`);

    const aidlcDir = join(dir, AIDLC_DIR);
    assert.ok(existsSync(join(aidlcDir, 'manifest.jsonl')), 'manifest.jsonl should exist after --record');

    const { entries, skipped } = readEntries('manifest', aidlcDir);
    assert.equal(skipped.length, 0, 'no malformed lines expected');
    assert.ok(entries.length >= 1, 'at least one entry should be written');

    const e = entries[entries.length - 1];
    assert.equal(e.type, 'rails-check');
    assert.equal(e.base, 'HEAD');
    assert.equal(e.railsDiffEmpty, true);
    assert.equal(e.suppressionsClean, true);
    assert.ok(typeof e.ts === 'string', 'ts must be a string');
    assert.ok(typeof e.railFiles === 'object', 'railFiles must be an object');

    // restore
    git(['checkout', '--', 'src/auth.ts'], dir);
  });

  test('--record does NOT write entry when violations exist (rail edited)', () => {
    // Modify the rail file to trigger a violation
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => { it("added"); });\n');

    const result = runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);
    assert.equal(result.status, 2, `expected exit 2 for violations, got ${result.status}`);

    const aidlcDir = join(dir, AIDLC_DIR);
    // Count entries before — may have entries from prior test, but no new one should be added
    const before_entries = existsSync(join(aidlcDir, 'manifest.jsonl'))
      ? readEntries('manifest', aidlcDir).entries.length
      : 0;

    // Run again with the violation present and count
    const result2 = runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);
    assert.equal(result2.status, 2);

    const after_entries = existsSync(join(aidlcDir, 'manifest.jsonl'))
      ? readEntries('manifest', aidlcDir).entries.length
      : 0;

    assert.equal(after_entries, before_entries, '--record must not append when violations exist');

    // restore
    git(['checkout', '--', 'test/auth.test.ts'], dir);
  });

  test('--record entry includes railFiles hash of matching rail files', () => {
    // Clean working tree — no changes to anything
    const result = runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);
    assert.equal(result.status, 0, `bin exited ${result.status}; stderr: ${result.stderr}`);

    const aidlcDir = join(dir, AIDLC_DIR);
    const { entries } = readEntries('manifest', aidlcDir);
    const e = entries[entries.length - 1];

    // test/auth.test.ts matches the glob and should have a sha256 entry
    const hashKeys = Object.keys(e.railFiles);
    assert.ok(hashKeys.length > 0, 'railFiles should contain at least one entry');
    // Each value must be a 64-char hex string (sha256) or null for missing files
    for (const val of Object.values(e.railFiles)) {
      if (val !== null) {
        assert.equal(typeof val, 'string');
        assert.equal(val.length, 64);
      }
    }
  });

  test('--record accumulates multiple entries across invocations', () => {
    const aidlcDir = join(dir, AIDLC_DIR);
    const before_count = existsSync(join(aidlcDir, 'manifest.jsonl'))
      ? readEntries('manifest', aidlcDir).entries.length
      : 0;

    // Two clean-pass invocations
    runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);
    runBin(['--rails', 'test/**', '--record', '--base', 'HEAD'], dir);

    const { entries } = readEntries('manifest', aidlcDir);
    assert.equal(entries.length, before_count + 2, 'each clean run should append one entry');
  });
});

describe('--record: no entry written without --record flag', () => {
  let dir;

  before(() => {
    dir = setupRepo();
    writeFile(dir, 'src/main.ts', 'export const x = 1;\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('clean pass without --record writes no manifest', () => {
    const result = runBin(['--rails', 'test/**', '--base', 'HEAD'], dir);
    assert.equal(result.status, 0);

    const aidlcDir = join(dir, AIDLC_DIR);
    assert.ok(
      !existsSync(join(aidlcDir, 'manifest.jsonl')),
      'manifest.jsonl must not be created without --record'
    );
  });
});
