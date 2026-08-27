import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../bin/premortem.mjs', import.meta.url).pathname;

test('CLI: empty spec file exits 1 and writes zero manifest entries', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-cli-test-'));
  try {
    const specPath = join(tmpDir, 'empty.md');
    writeFileSync(specPath, '', 'utf8');

    const result = spawnSync(process.execPath, [
      CLI, specPath, '--prompt-only', '--record-verdict', '-', '--ticket', 'T1'
    ], { cwd: tmpDir, input: 'No failure modes found.\n', encoding: 'utf8' });

    assert.equal(result.status, 1, 'exits with code 1 for empty file');
    assert.ok(result.stderr.includes('empty or whitespace-only'), 'error message mentions empty');
    
    assert.equal(existsSync(join(tmpDir, '.adlc', 'manifest.jsonl')), false, 'no manifest file should be created');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: spec file with no letter or digit (zero-width, BOM, NUL, combining marks, fillers, punctuation) exits 1 and writes zero manifest entries', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-cli-test-'));
  try {
    const specPath = join(tmpDir, 'invisible.md');
    // BOM, zero-width spaces, NUL, word joiner, ZWJ, combining marks, Hangul
    // fillers (U+115F/U+1160/U+3164/U+FFA0), Braille blank, punctuation-only.
    writeFileSync(specPath, '\uFEFF\u200B\u200B\n\u0000\u2060 \u200D\n\u034F\u034F\u0301\n\u115F\u1160\u3164\uFFA0\n\u2800\u2800\n---\n#\n', 'utf8');

    const result = spawnSync(process.execPath, [
      CLI, specPath, '--prompt-only', '--record-verdict', '-', '--ticket', 'T1'
    ], { cwd: tmpDir, input: 'No failure modes found.\n', encoding: 'utf8' });

    assert.equal(result.status, 1, 'exits with code 1 for an invisible-only file');
    assert.ok(result.stderr.includes('empty or whitespace-only'), 'error message mentions empty');
    assert.equal(existsSync(join(tmpDir, '.adlc', 'manifest.jsonl')), false, 'no manifest file should be created');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: whitespace-only spec file exits 1 and writes zero manifest entries', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'premortem-cli-test-'));
  try {
    const specPath = join(tmpDir, 'whitespace.md');
    writeFileSync(specPath, '   \n  \t  \n', 'utf8');

    const result = spawnSync(process.execPath, [
      CLI, specPath, '--prompt-only', '--record-verdict', '-', '--ticket', 'T1'
    ], { cwd: tmpDir, input: 'No failure modes found.\n', encoding: 'utf8' });

    assert.equal(result.status, 1, 'exits with code 1 for whitespace file');
    assert.ok(result.stderr.includes('empty or whitespace-only'), 'error message mentions empty');
    
    assert.equal(existsSync(join(tmpDir, '.adlc', 'manifest.jsonl')), false, 'no manifest file should be created');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
