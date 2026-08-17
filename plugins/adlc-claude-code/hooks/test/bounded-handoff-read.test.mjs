// bounded-handoff-read.test.mjs — unit coverage for boundedHandoffRead
// (Phase 0 hotfix, context-rot-threshold-calibration spec §1.2.2), the CC
// twin of the Codex adapter's boundedTailRead
// (plugins/adlc-codex/hooks/test/observe-handoff-signals.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { boundedHandoffRead } from '../adlc-hook.mjs';

const MAX_SCAN_WALL_MS = 500;

function withTranscript(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-handoff-read-'));
  try {
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, text);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fast, small, within-budget read is complete and NOT truncated', () => {
  withTranscript('{"type":"assistant","content":[{"type":"tool_use","name":"Edit"}]}\n'.repeat(3), (transcriptPath) => {
    const result = boundedHandoffRead(transcriptPath, { maxBytes: 8 * 1024 * 1024, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, false);
    assert.match(result.text, /tool_use/);
  });
});

test('exceeding maxBytes truncates and reads only the tail window', () => {
  const bigText = 'x'.repeat(1000) + '{"type":"assistant","content":[{"type":"tool_use","name":"Edit"}]}';
  withTranscript(bigText, (transcriptPath) => {
    const result = boundedHandoffRead(transcriptPath, { maxBytes: 50, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 50);
    assert.equal(result.size, bigText.length);
  });
});

test('a deadline that is never exceeded reads the whole window', () => {
  const text = 'B'.repeat(640);
  withTranscript(text, (transcriptPath) => {
    const result = boundedHandoffRead(transcriptPath, { maxBytes: 8 * 1024 * 1024, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, false);
    assert.equal(result.text.length, text.length);
  });
});

test('an unopenable path returns null rather than throwing', () => {
  const result = boundedHandoffRead('/definitely/does/not/exist.jsonl', { maxBytes: 100, deadlineMs: MAX_SCAN_WALL_MS });
  assert.equal(result, null);
});

test('tail-read-worker.mjs exits exactly 1 on any failure — its own stable contract, not an accident of "some nonzero code"', () => {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'tail-read-worker.mjs');
  let status = 0;
  try {
    execFileSync(process.execPath, [workerPath, '/definitely/does/not/exist.jsonl', '100'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = e.status ?? 1;
  }
  assert.equal(status, 1);
});

test('size is read fresh each call, never cached across independent reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-handoff-read-shrink-'));
  try {
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, 'D'.repeat(200));
    const first = boundedHandoffRead(p, { maxBytes: 1000, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(first.size, 200);
    writeFileSync(p, 'E'.repeat(50));
    const second = boundedHandoffRead(p, { maxBytes: 1000, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(second.size, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round-16 review (T-01M03J291182MXD1KEKM2PRKTS): a genuinely BLOCKING read
// (a FIFO with no writer) must not hang the hook past its deadline. openSync
// on a read-mode FIFO blocks the CALLING PROCESS until a writer opens it —
// real, OS-level blocking I/O — so this proves boundedHandoffRead's
// subprocess + spawnSync timeout can actually preempt it. Twin of the
// identical Codex test.
test(
  'a FIFO with no writer (genuine OS-level block) is preempted by the real timeout, not hung indefinitely',
  { skip: process.platform === 'win32' ? "mkfifo is POSIX-only, matching this exception's own disclosed platform scope" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-handoff-read-fifo-'));
    const fifoPath = join(dir, 'blocking.jsonl');
    try {
      execFileSync('mkfifo', [fifoPath]);
      const startedAt = Date.now();
      const result = boundedHandoffRead(fifoPath, { maxBytes: 1000, deadlineMs: 500 });
      const elapsedMs = Date.now() - startedAt;
      assert.deepEqual(result, { size: 0, text: '', truncated: true });
      assert.ok(elapsedMs < 5000, `expected preemption well under 5s, took ${elapsedMs}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
