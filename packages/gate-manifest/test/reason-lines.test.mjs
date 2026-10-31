// reason-lines.test.mjs — a refused spec-approval record prints its reasons
// one per indented line, not joined with "; " on one line.
// Runs the real binary; offline, temp dirs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, runBin } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/gate-manifest.mjs', import.meta.url));

function scratch(t) {
  const dir = tmp(t, 'gm-reason-lines-');
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, 'spec.md'), '# Spec\n## Acceptance Criteria\n- ok: `true`\n');
  return dir;
}

test('spec-approval refusal prints one reason per line', (t) => {
  const dir = scratch(t);
  const r = runBin(
    BIN,
    ['record', 'spec-approval', '--ticket', 'T1', '--files', 'spec.md', '--data', '{}'],
    { cwd: dir },
  );
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines[0], 'error: spec-approval record refused:');
  assert.ok(lines.length >= 3, `expected several reasons, got:\n${r.stderr}`);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith('  P1 evidence is '), `not an indented reason line: ${line}`);
    assert.equal(line.split('; P1 evidence').length, 1, `reasons joined on one line: ${line}`);
  }
  assert.ok(lines.includes('  P1 evidence is incomplete: spec-approval missing a non-empty approver'), r.stderr);
  // Refused before the write: nothing was recorded.
  assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false);
  assert.deepEqual(readdirSync(join(dir, '.adlc')), []);
});
