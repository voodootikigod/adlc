/**
 * Tests for runner.mjs logic — candidate validation, command running,
 * and end-to-end engine with injectable completeFn.
 * No network calls. Uses tmp dirs for file fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, validateCandidate, runConsensusFix } from '../lib/runner.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'consensus-fix-runner-test-'));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ─── runCommand ──────────────────────────────────────────────────────────────

test('runCommand captures exit 0', () => {
  const result = runCommand('exit 0');
  assert.equal(result.exitCode, 0);
});

test('runCommand captures non-zero exit code', () => {
  const result = runCommand('exit 42');
  assert.equal(result.exitCode, 42);
});

test('runCommand captures stdout output', () => {
  const result = runCommand('echo hello_world');
  assert.ok(result.output.includes('hello_world'));
});

// ─── validateCandidate ───────────────────────────────────────────────────────

test('validateCandidate accepts valid candidate', () => {
  const result = validateCandidate(
    { changes: [{ file: 'src/a.mjs', content: 'new content' }] },
    ['src/a.mjs']
  );
  assert.equal(result.valid, true);
  assert.equal(result.changes.length, 1);
});

test('validateCandidate rejects non-object', () => {
  const r = validateCandidate(null, ['a.mjs']);
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not an object'));
});

test('validateCandidate rejects missing changes array', () => {
  const r = validateCandidate({ changes: 'oops' }, ['a.mjs']);
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('"changes"'));
});

test('validateCandidate rejects file not in allowed list', () => {
  const r = validateCandidate(
    { changes: [{ file: 'evil.mjs', content: 'x' }] },
    ['allowed.mjs']
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not in the provided list'));
});

test('validateCandidate rejects change missing content', () => {
  const r = validateCandidate(
    { changes: [{ file: 'a.mjs' }] },
    ['a.mjs']
  );
  assert.equal(r.valid, false);
});

test('validateCandidate accepts empty changes array', () => {
  const r = validateCandidate({ changes: [] }, ['a.mjs']);
  assert.equal(r.valid, true);
  assert.equal(r.changes.length, 0);
});

// ─── runConsensusFix (full engine, no network) ────────────────────────────────

test('runConsensusFix throws when test already passes', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'target.mjs');
    writeFileSync(f, 'export const x = 1;');

    await assert.rejects(
      () => runConsensusFix({
        testCmd: 'exit 0',
        files: [f],
        n: 2,
        tier: 'mid',
        completeFn: async () => '{"changes": []}',
      }),
      (err) => {
        assert.ok(err.isOpError);
        assert.ok(err.message.includes('already passes'));
        return true;
      }
    );
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix discards candidate with invalid JSON', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'target.mjs');
    writeFileSync(f, 'export const x = 1;');

    let callCount = 0;
    const result = await runConsensusFix({
      testCmd: 'exit 1',
      files: [f],
      n: 2,
      tier: 'mid',
      completeFn: async () => {
        callCount++;
        return 'not json at all';
      },
    });

    assert.equal(callCount, 2);
    assert.equal(result.discarded.length, 2);
    assert.equal(result.survivors.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix discards candidate referencing file outside list', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'allowed.mjs');
    writeFileSync(f, 'export const x = 1;');

    const result = await runConsensusFix({
      testCmd: 'exit 1',
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () =>
        JSON.stringify({ changes: [{ file: '/etc/passwd', content: 'bad' }] }),
    });

    assert.equal(result.discarded.length, 1);
    assert.ok(result.discarded[0].reason.includes('not in the provided list'));
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: surviving candidate passes test, files restored after', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'broken.mjs');
    // File starts with broken content; fix makes test pass.
    writeFileSync(f, 'BROKEN');

    const sentinelFile = join(dir, 'sentinel.txt');
    writeFileSync(sentinelFile, 'no');

    // Test command: check if sentinel file contains 'yes'.
    const testCmd = `test "$(cat '${sentinelFile}')" = "yes"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () => {
        // The "fix" writes 'yes' to the sentinel via a side effect...
        // but we can't do that from changes (changes only affect listed files).
        // Instead: make the test always pass by writing the sentinel outside changes.
        writeFileSync(sentinelFile, 'yes');
        return JSON.stringify({ changes: [{ file: f, content: 'FIXED' }] });
      },
    });

    // After run, the snapshot should be restored.
    assert.equal(readFileSync(f, 'utf8'), 'BROKEN');
    // The fix candidate should have passed (sentinel was 'yes' during its run).
    // But sentinel gets restored? No — sentinel is not in the snapshot.
    // So the test will pass during the candidate run.
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].passed, true);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix restores files even when candidate test fails', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'file.mjs');
    writeFileSync(f, 'original content');

    const result = await runConsensusFix({
      testCmd: 'exit 1',  // always fails
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () =>
        JSON.stringify({ changes: [{ file: f, content: 'attempted fix' }] }),
    });

    // File should be restored to original.
    assert.equal(readFileSync(f, 'utf8'), 'original content');
    assert.equal(result.failed.length, 1);
    assert.equal(result.survivors.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix groups and selects winner across multiple candidates', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    let call = 0;
    const completeFn = async () => {
      call++;
      // Candidates 1 and 3 return the same fix; candidate 2 returns different.
      if (call === 2) {
        return JSON.stringify({ changes: [{ file: f, content: 'minority fix' }] });
      }
      return JSON.stringify({ changes: [{ file: f, content: 'majority fix' }] });
    };

    // We need the test to pass.  We'll use a test that checks what's in the file.
    // The check: if file contains 'majority fix' or 'minority fix' → exit 0.
    const testCmd = `test "$(cat '${f}')" != "original"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 3,
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.survivors.length, 3);
    assert.equal(result.groups.size, 2);  // two distinct fix texts
    const sel = result.selectionResult;
    assert.ok(sel);
    assert.equal(sel.largestGroupSize, 2);
    // Winner should come from the majority group (indices 0 and 2).
    assert.ok([0, 2].includes(sel.winner.index));

    // Files restored.
    assert.equal(readFileSync(f, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix all-divergent flag set correctly', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    let call = 0;
    const completeFn = async () => {
      call++;
      // Every candidate returns a unique fix.
      return JSON.stringify({ changes: [{ file: f, content: `fix${call}` }] });
    };

    const testCmd = `test "$(cat '${f}')" != "original"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 3,
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.survivors.length, 3);
    assert.equal(result.allDivergent, true);
  } finally {
    cleanup(dir);
  }
});
