// observe-handoff-signals.test.mjs — unit coverage for the Codex scan
// budget logic (Phase 0 hotfix, context-rot-threshold-calibration spec
// §1.2.2), including genuine wall-clock-deadline enforcement via
// boundedTailRead's chunked reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { observeHandoffSignals, boundedTailRead } from '../adlc-handoff-gate.mjs';

const MAX_ACTIVE_CONTEXT_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_WALL_MS = 500;

function withTranscript(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'observe-handoff-'));
  try {
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, text);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a complete, fast read is NOT truncated', () => {
  withTranscript('{"type":"assistant","content":[{"type":"tool_use","name":"apply_patch"}]}\n'.repeat(2), (transcriptPath) => {
    const result = observeHandoffSignals(
      { transcript_path: transcriptPath },
      { maxActiveContextBytes: MAX_ACTIVE_CONTEXT_BYTES, maxScanWallMs: MAX_SCAN_WALL_MS },
    );
    assert.equal(result.truncated, false);
    assert.equal(result.observed.depth, 2);
  });
});

test('a byte-truncated read is truncated, and reports the accumulated window depth', () => {
  withTranscript('placeholder', (transcriptPath) => {
    const result = observeHandoffSignals(
      { transcript_path: transcriptPath },
      {
        maxActiveContextBytes: MAX_ACTIVE_CONTEXT_BYTES,
        maxScanWallMs: MAX_SCAN_WALL_MS,
        read: () => ({
          size: MAX_ACTIVE_CONTEXT_BYTES + 1,
          text: '{"type":"assistant","content":[{"type":"tool_use","name":"apply_patch"}]}',
          truncated: true,
        }),
      },
    );
    assert.equal(result.truncated, true);
    assert.equal(result.observed.depth, 1);
  });
});

test('a missing/invalid scan-budget parameter fails closed to NaN depth, not truncated', () => {
  withTranscript('{"type":"assistant","content":[{"type":"tool_use","name":"apply_patch"}]}\n', (transcriptPath) => {
    const result = observeHandoffSignals(
      { transcript_path: transcriptPath },
      { maxActiveContextBytes: MAX_ACTIVE_CONTEXT_BYTES, maxScanWallMs: Number.NaN },
    );
    assert.ok(Number.isNaN(result.observed.depth));
    assert.equal(result.truncated, false);
  });
});

// --- boundedTailRead: the real chunked, deadline-aware reader ---------------

test('boundedTailRead: a fast, small, within-budget read is complete and NOT truncated', () => {
  withTranscript('{"type":"assistant","content":[{"type":"tool_use","name":"apply_patch"}]}\n'.repeat(3), (transcriptPath) => {
    const result = boundedTailRead(transcriptPath, { maxBytes: MAX_ACTIVE_CONTEXT_BYTES, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, false);
    assert.match(result.text, /tool_use/);
  });
});

test('boundedTailRead: exceeding maxBytes truncates and reads only the tail window', () => {
  const bigText = 'x'.repeat(1000) + '{"type":"assistant","content":[{"type":"tool_use","name":"apply_patch"}]}';
  withTranscript(bigText, (transcriptPath) => {
    const result = boundedTailRead(transcriptPath, { maxBytes: 50, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 50);
    assert.equal(result.size, bigText.length);
  });
});

test('boundedTailRead: a deadline that is never exceeded reads the whole window', () => {
  const text = 'B'.repeat(640);
  withTranscript(text, (transcriptPath) => {
    const result = boundedTailRead(transcriptPath, {
      maxBytes: MAX_ACTIVE_CONTEXT_BYTES,
      deadlineMs: MAX_SCAN_WALL_MS,
    });
    assert.equal(result.truncated, false);
    assert.equal(result.text.length, text.length);
  });
});

// Round-16 review: a genuinely BLOCKING read (a FIFO with no writer — the
// exact class of stall named in the finding: "a stalled network mount, a
// FIFO with no writer, a hung device file") must not hang the hook past its
// deadline. openSync on a read-mode FIFO blocks the CALLING PROCESS until a
// writer opens it — this is real, OS-level blocking I/O, not a simulation —
// so this test proves boundedTailRead's subprocess + spawnSync timeout can
// actually preempt it, which no fake-clock unit test inside a single process
// ever could (the old in-process implementation had no way to interrupt this
// at all; it would have hung for the lifetime of the test run).
test(
  'boundedTailRead: a FIFO with no writer (genuine OS-level block) is preempted by the real timeout, not hung indefinitely',
  { skip: process.platform === 'win32' ? 'mkfifo is POSIX-only, matching this exception\'s own disclosed platform scope' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'observe-handoff-fifo-'));
    const fifoPath = join(dir, 'blocking.jsonl');
    try {
      execFileSync('mkfifo', [fifoPath]);
      const startedAt = Date.now();
      const result = boundedTailRead(fifoPath, { maxBytes: 1000, deadlineMs: 500 });
      const elapsedMs = Date.now() - startedAt;
      assert.deepEqual(result, { size: 0, text: '', truncated: true });
      // Generous ceiling (not a tight timing assertion — CI machines vary):
      // proves this returned promptly rather than hanging for the test
      // runner's own much longer default timeout.
      assert.ok(elapsedMs < 5000, `expected preemption well under 5s, took ${elapsedMs}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('boundedTailRead: an unopenable path returns null rather than throwing', () => {
  const result = boundedTailRead('/definitely/does/not/exist.jsonl', { maxBytes: 100, deadlineMs: MAX_SCAN_WALL_MS });
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

// --- resolveTrustedBinary: node_modules exclusion ---------------------------

test('resolveTrustedBinary skips a node_modules PATH entry and finds the real binary further down PATH', async () => {
  const { resolveTrustedBinary } = await import('../adlc-handoff-gate.mjs');
  const dir1 = mkdtempSync(join(tmpdir(), 'resolve-trusted-nm-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'resolve-trusted-real-'));
  try {
    const fakeDir = join(dir1, 'node_modules', '.bin');
    mkdirSync(fakeDir, { recursive: true });
    const fakeBin = join(fakeDir, 'adlc');
    writeFileSync(fakeBin, '#!/bin/sh\necho fake\n');
    const realBin = join(dir2, 'adlc');
    writeFileSync(realBin, '#!/bin/sh\necho real\n');
    const pathEnv = [fakeDir, dir2].join(':');
    const resolved = resolveTrustedBinary('adlc', pathEnv);
    assert.equal(resolved, realBin, 'must skip the node_modules candidate and resolve the real one');
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('resolveTrustedBinary returns null when every candidate is inside node_modules', async () => {
  const { resolveTrustedBinary } = await import('../adlc-handoff-gate.mjs');
  const dir1 = mkdtempSync(join(tmpdir(), 'resolve-trusted-nm-only-'));
  try {
    const fakeDir = join(dir1, 'node_modules', '.bin');
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(join(fakeDir, 'adlc'), '');
    assert.equal(resolveTrustedBinary('adlc', fakeDir), null);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
  }
});

test('boundedTailRead: a normal complete read exactly matches file size, unaffected by the short-read/grow-shrink guards', () => {
  // Regression sanity for the fix in this same function: the added
  // `readSoFar < length` and post-read fstat comparison must not produce a
  // false positive on the ordinary happy path (no short read, no
  // concurrent change) — this is NOT a test of the guards actually firing
  // (that needs OS-level race injection this suite doesn't attempt), only
  // that they stay silent when nothing is actually wrong.
  const text = 'C'.repeat(200);
  withTranscript(text, (transcriptPath) => {
    const result = boundedTailRead(transcriptPath, { maxBytes: text.length, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(result.truncated, false);
    assert.equal(result.text.length, text.length);
  });
});

test('boundedTailRead: size is read fresh each call, never cached across independent reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'observe-handoff-shrink-'));
  try {
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, 'D'.repeat(200));
    const first = boundedTailRead(p, { maxBytes: 1000, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(first.size, 200);
    writeFileSync(p, 'E'.repeat(50));
    const second = boundedTailRead(p, { maxBytes: 1000, deadlineMs: MAX_SCAN_WALL_MS });
    assert.equal(second.size, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- recordRecoveryUnderBand: never forwards the manifest signing key ------

test('recordRecoveryUnderBand never forwards ADLC_MANIFEST_KEY or ADLC_ADMIN_KEY to the spawned recorder', async () => {
  const { recordRecoveryUnderBand } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'record-recovery-strip-'));
  const cwdBefore = process.cwd();
  try {
    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // adlcBinPath must be an executable spawnSync can run directly; use node
    // itself with the script as an arg by wrapping via a tiny shell script.
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    // No .adlc/ under `dir` at all -> repoManifestChainIsSigned(dir) is
    // false, so this test isolates the secret-stripping property from the
    // separate signed-chain guard (covered by its own tests below).
    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, ADLC_MANIFEST_KEY: 'super-secret-key', ADLC_ADMIN_KEY: 'super-secret-admin' },
      adlcBinPath: fakeAdlc,
    });

    const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'));
    assert.equal(dumped.ADLC_MANIFEST_KEY, undefined, 'ADLC_MANIFEST_KEY must never reach the spawned recorder');
    assert.equal(dumped.ADLC_ADMIN_KEY, undefined, 'ADLC_ADMIN_KEY must never reach the spawned recorder');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRecoveryUnderBand forwards only the env allowlist — an unresolvable-provenance binary cannot exfiltrate unrelated credentials', async () => {
  // Round-4 review: resolveTrustedBinary's PATH search cannot fully verify
  // the resolved executable's provenance, so a denylist of only the two
  // manifest/admin keys still hands a possibly-malicious binary everything
  // else the operator's shell exports (e.g. cloud credentials). This proves
  // the fix is a genuine allowlist, not merely a bigger denylist: a
  // plausible third-party credential var is stripped, while an allowlisted
  // var (PATH) still reaches the child.
  const { recordRecoveryUnderBand } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'record-recovery-allowlist-'));
  const cwdBefore = process.cwd();
  try {
    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    // No .adlc/ under `dir` -> repoManifestChainIsSigned(dir) is false; this
    // test isolates env-allowlist scoping from the separate signed-chain guard.
    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, AWS_SECRET_ACCESS_KEY: 'not-on-the-allowlist' },
      adlcBinPath: fakeAdlc,
    });

    const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'));
    assert.equal(dumped.AWS_SECRET_ACCESS_KEY, undefined, 'a non-allowlisted credential var must never reach the spawned recorder');
    assert.equal(dumped.PATH, process.env.PATH, 'an allowlisted var (PATH) must still reach the spawned recorder');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- repoManifestChainIsSigned / recordRecoveryUnderBand: signed-chain guard (Round-5) ---

test('repoManifestChainIsSigned: false for a repo with no manifest at all', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-none-'));
  try {
    assert.equal(repoManifestChainIsSigned(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: false for a root manifest with only unsigned entries', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-unsigned-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    assert.equal(repoManifestChainIsSigned(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: true for a root manifest with a signed entry', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-root-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now', sig: 'deadbeef' })}\n`);
    assert.equal(repoManifestChainIsSigned(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: true for a signed entry inside .adlc/manifest.d/ (segmented/forest repo)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-segment-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'manifest.d', 'some-branch-01ABCDEF.jsonl'),
      `${JSON.stringify({ seq: 1, gate: 'ticket-update', ts: 'now', sig: 'deadbeef' })}\n`,
    );
    assert.equal(repoManifestChainIsSigned(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRecoveryUnderBand refuses to spawn the recorder at all when the chain is already signed', async () => {
  // Round-5 review (confirmed against this exact repo's own manifest.d
  // segment, which already has a signed seq:1 entry): gate-manifest record
  // does NOT fail closed on a missing key — key:null is a legal, silently
  // unsigned append. Without this guard, recordRecoveryUnderBand would
  // append an unsigned entry directly after a signed one, corrupting the
  // chain for every later key-aware verification. Proven here by asserting
  // the fake recorder's env-dump file (proof the child ran at all) is never
  // created when the chain is signed.
  const { recordRecoveryUnderBand } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'record-recovery-signed-chain-'));
  const cwdBefore = process.cwd();
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now', sig: 'deadbeef' })}\n`);

    const envDumpPath = join(dir, 'env-dump.json');
    const fakeAdlc = join(dir, 'fake-adlc.mjs');
    writeFileSync(
      fakeAdlc,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));\n`,
    );
    // recordRecoveryUnderBand now invokes via process.execPath directly
    // (Round-5 fix) rather than executing adlcBinPath as a shebang script,
    // so the fake recorder can just be the plain .mjs module itself.

    process.chdir(dir);
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: process.env,
      adlcBinPath: fakeAdlc,
    });

    assert.equal(existsSync(envDumpPath), false, 'the recorder child must never run against a signed chain');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRecoveryUnderBand never lets a PATH-planted "node" shim run (Round-5 Finding 2: shebang/env second lookup)', async () => {
  const { recordRecoveryUnderBand } = await import('../adlc-handoff-gate.mjs');
  // adlc is itself a `#!/usr/bin/env node` script. Executing adlcBinPath
  // directly (spawnSync(adlcBinPath, ...)) would let the OS hand off to
  // `/usr/bin/env`, which does its OWN PATH lookup for `node` using the
  // child's PATH — a lookup resolveTrustedBinary's node_modules exclusion
  // does NOT cover, since that exclusion only applies when THIS code
  // searches for `adlc`. Prove the fix: even with a malicious
  // node_modules/.bin/node planted ahead of the real interpreter on PATH,
  // and a REAL `#!/usr/bin/env node` shebang on the fake recorder script,
  // the malicious shim never runs.
  const dir = mkdtempSync(join(tmpdir(), 'record-recovery-no-shebang-hijack-'));
  const cwdBefore = process.cwd();
  try {
    const maliciousMarker = join(dir, 'malicious-ran.marker');
    const safeMarker = join(dir, 'safe-ran.marker');

    const maliciousNodeDir = join(dir, 'node_modules', '.bin');
    mkdirSync(maliciousNodeDir, { recursive: true });
    const maliciousNode = join(maliciousNodeDir, 'node');
    writeFileSync(maliciousNode, `#!/bin/sh\ntouch "${maliciousMarker}"\nexit 1\n`, { mode: 0o755 });

    // adlcBinPath itself carries a REAL shebang — proving the fix bypasses
    // it structurally (by invoking via process.execPath + argument), not
    // merely because the fixture happens to lack one.
    const adlcBinPath = join(dir, 'fake-adlc-with-shebang.mjs');
    writeFileSync(
      adlcBinPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(safeMarker)}, 'ran');\n`,
      { mode: 0o755 },
    );

    const hijackPath = [maliciousNodeDir, dirname(process.execPath)].join(':');

    process.chdir(dir); // no .adlc/ here -> repoManifestChainIsSigned(dir) is false
    recordRecoveryUnderBand({
      subcommand: 'bypass',
      sessionId: 'sess-a',
      trustedEnv: { ...process.env, PATH: hijackPath },
      adlcBinPath,
    });

    assert.equal(existsSync(maliciousMarker), false, 'the PATH-planted node shim must never run');
    assert.equal(existsSync(safeMarker), true, 'the real recorder must still have run, via process.execPath directly');
  } finally {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- repoManifestChainIsSigned: bounded scan (Round-5 Finding 5) -----------

test('repoManifestChainIsSigned: a file larger than the per-file byte cap is treated as signed (truncated -> inconclusive -> fail closed), not fully read', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-oversized-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // 2 MiB of UNSIGNED entries — bigger than MANIFEST_SCAN_MAX_BYTES_PER_FILE
    // (1 MiB). Genuinely unsigned content must still fail closed once it
    // cannot be read within bounds.
    const line = `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`;
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), line.repeat(Math.ceil((2 * 1024 * 1024) / line.length)));
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true, 'an oversized file cannot be proven unsigned within bounds -> treat as signed');
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: more segment files than the fan-out cap is treated as signed, without opening any of them', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-fanout-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    for (let i = 0; i < 501; i += 1) {
      writeFileSync(
        join(dir, '.adlc', 'manifest.d', `seg-${i}.jsonl`),
        `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`,
      );
    }
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true);
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: a symlinked manifest file is rejected outright, never followed', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-symlink-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'chain-signed-symlink-target-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // The symlink's TARGET is genuinely unsigned — proving the rejection is
    // about the symlink itself, not incidentally about signed content.
    const target = join(targetDir, 'real.jsonl');
    writeFileSync(target, `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    symlinkSync(target, join(dir, '.adlc', 'manifest.jsonl'));
    assert.equal(repoManifestChainIsSigned(dir), true, 'a symlinked manifest file must be rejected, not followed and read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: a symlinked manifest.d DIRECTORY is rejected outright, never listed (Round-5 Finding 4)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-dir-symlink-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'chain-signed-dir-symlink-target-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // The target directory's content is genuinely unsigned — proving the
    // rejection is about the symlinked DIRECTORY itself, not its content.
    writeFileSync(join(targetDir, 'real.jsonl'), `${JSON.stringify({ seq: 1, gate: 'x', ts: 'now' })}\n`);
    symlinkSync(targetDir, join(dir, '.adlc', 'manifest.d'));
    assert.equal(repoManifestChainIsSigned(dir), true, 'a symlinked manifest.d directory must be rejected, not listed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('repoManifestChainIsSigned: many NON-.jsonl entries still trip the fan-out cap (Round-9 Finding 5)', async () => {
  const { repoManifestChainIsSigned } = await import('../adlc-handoff-gate.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'chain-signed-nonjsonl-fanout-'));
  try {
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    // 501 entries, NONE of them .jsonl — files.length alone would never
    // trip the cap since it only grows for .jsonl-suffixed names.
    for (let i = 0; i < 501; i += 1) {
      writeFileSync(join(dir, '.adlc', 'manifest.d', `junk-${i}.tmp`), 'x');
    }
    const start = Date.now();
    const result = repoManifestChainIsSigned(dir);
    const elapsedMs = Date.now() - start;
    assert.equal(result, true, 'a directory dominated by non-.jsonl entries must still be bounded');
    assert.ok(elapsedMs < 2000, `expected a bounded, fast return; took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
