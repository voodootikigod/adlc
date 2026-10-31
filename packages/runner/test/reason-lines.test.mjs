// reason-lines.test.mjs — `adlc accept` and `adlc run` print several error
// reasons one per indented line, not joined with "; " on one line.
// Runs the real dispatcher binary; offline, temp dirs only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmp, gitRepo, runBin } from '@adlc/core/test-kit';

const ADLC = fileURLToPath(new URL('../../cli/bin/adlc.mjs', import.meta.url));

// A repository with one commit, so the revision resolves and every reason
// comes from the missing flags and evidence. (Outside git, one reason is
// "revision could not be resolved; pass --revision …", which carries its own
// "; " and is not this test's subject.)
function repo(t) {
  const { dir, git } = gitRepo(t, 'adlc-reason-lines-');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('accept prints one reason per line', (t) => {
  const r = runBin(ADLC, ['accept'], { cwd: repo(t) });
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines[0], 'error: P6 acceptance refused:');
  assert.ok(lines.length >= 3, `expected several reasons, got:\n${r.stderr}`);
  assert.ok(
    lines.slice(1).every((l) => l.startsWith('  ') && !l.includes('; ')),
    `expected one indented reason per line, got:\n${r.stderr}`,
  );
  assert.ok(lines.includes('  ticket is required for P6 acceptance evidence'), r.stderr);
  assert.ok(lines.includes('  packet is required for P6 acceptance evidence'), r.stderr);
});

test('accept --json output is unchanged: reasons stay an array', (t) => {
  const r = runBin(ADLC, ['accept', '--json'], { cwd: tmp(t) });
  assert.equal(r.status, 1, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.errors));
  assert.ok(parsed.errors.includes('ticket is required for P6 acceptance evidence'));
});

test('run with one operational reason keeps it on the heading line', (t) => {
  const r = runBin(ADLC, ['run', 'p1'], { cwd: tmp(t) });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.trim(), 'error: adlc p1: cannot check evidence: p1 requires --ticket');
});
