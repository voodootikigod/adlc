// handoff-read-growth.test.mjs — issue #797.
//
// boundedHandoffRead marked a scan incomplete whenever the transcript's size
// differed before and after the read. Growth is not incompleteness: when the
// worker read the whole file from byte 0, a later append cannot hide an
// earlier record — only a SHRINK can. The spurious `truncated: true` reached
// the handoff gate as `scanTruncated` and denied every mutation while the
// observed depth was still below HANDOFF_DEPTH (`incomplete_scan_lower_bound`),
// exactly in the first tool calls of a session where appends are constant.
//
// The header-to-outcome mapping is now one pure function so the signals can be
// pinned without spawning anything (AC1/AC2/AC4). The end-to-end cases (AC3)
// import a verbatim copy of the hook modules from a fixture directory whose
// `tail-read-worker.mjs` is swapped: a DETERMINISTIC worker that grows or
// shrinks the file between its own two fstats (so the race is constructed,
// not awaited), and a TEE around the real worker for a bounded smoke run.
// `repoManifestChainIsSigned` shares the reader and must keep treating growth
// as inconclusive — pinned here with the same deterministic worker.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync, copyFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { boundedHandoffRead, readOutcomeFromHeader } from '../adlc-hook.mjs';

const EIGHT_MIB = 8 * 1024 * 1024;
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_WORKER = join(HOOKS_DIR, 'tail-read-worker.mjs');

// Every fixture directory this file mints is registered here and removed once,
// after the whole file — a helper that returns a path must register its own
// removal (scripts/test/tmp-fixture-boundary.test.mjs).
const FIXTURE_DIRS = new Set();
after(() => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
  FIXTURE_DIRS.clear();
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-read-growth-'));
  FIXTURE_DIRS.add(dir);
  return dir;
}

// --- AC1: growth after a complete read is not truncation ---------------------

test('AC1: a file that GREW after a complete read is reported complete, not truncated', () => {
  const outcome = readOutcomeFromHeader({ size: 1024, postSize: 4096, readSoFar: 1024 }, EIGHT_MIB);
  assert.deepEqual(outcome, {
    length: 1024,
    truncatedByBytes: false,
    shortRead: false,
    shrank: false,
    grew: true,
    truncated: false,
  });
});

// --- AC2: the three real incompleteness signals still fire ------------------

test('AC2: a file that SHRANK during the read is truncated (shrank: true)', () => {
  const outcome = readOutcomeFromHeader({ size: 1024, postSize: 512, readSoFar: 1024 }, EIGHT_MIB);
  assert.equal(outcome.shrank, true);
  assert.equal(outcome.grew, false);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.truncatedByBytes, false);
  assert.equal(outcome.shortRead, false);
});

test('AC2: a short read (fewer bytes than the window) is truncated', () => {
  const outcome = readOutcomeFromHeader({ size: 1024, postSize: 1024, readSoFar: 900 }, EIGHT_MIB);
  assert.equal(outcome.shortRead, true);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.shrank, false);
  assert.equal(outcome.grew, false);
});

test('AC2: a windowed read (size > maxBytes) is truncated even when postSize === size', () => {
  const outcome = readOutcomeFromHeader({ size: 1000, postSize: 1000, readSoFar: 50 }, 50);
  assert.equal(outcome.length, 50);
  assert.equal(outcome.truncatedByBytes, true);
  assert.equal(outcome.shortRead, false);
  assert.equal(outcome.shrank, false);
  assert.equal(outcome.truncated, true);
});

test('AC2: a windowed read that also grew stays truncated for the window, not for the growth', () => {
  const outcome = readOutcomeFromHeader({ size: 1000, postSize: 2000, readSoFar: 50 }, 50);
  assert.equal(outcome.truncatedByBytes, true);
  assert.equal(outcome.shrank, false);
  assert.equal(outcome.grew, true);
  assert.equal(outcome.truncated, true);
});

test('AC2: the exact boundary — postSize === size is neither growth nor shrink', () => {
  const same = readOutcomeFromHeader({ size: 700, postSize: 700, readSoFar: 700 }, EIGHT_MIB);
  assert.equal(same.shrank, false);
  assert.equal(same.grew, false);
  assert.equal(same.truncated, false);
  // One byte less IS a shrink and IS truncation.
  const less = readOutcomeFromHeader({ size: 700, postSize: 699, readSoFar: 700 }, EIGHT_MIB);
  assert.equal(less.shrank, true);
  assert.equal(less.grew, false);
  assert.equal(less.truncated, true);
  // One byte more is growth and is NOT truncation.
  const more = readOutcomeFromHeader({ size: 700, postSize: 701, readSoFar: 700 }, EIGHT_MIB);
  assert.equal(more.shrank, false);
  assert.equal(more.grew, true);
  assert.equal(more.truncated, false);
});

test('AC2: length is exactly min(size, maxBytes) on both sides of the boundary', () => {
  assert.equal(readOutcomeFromHeader({ size: 49, postSize: 49, readSoFar: 49 }, 50).length, 49);
  assert.equal(readOutcomeFromHeader({ size: 50, postSize: 50, readSoFar: 50 }, 50).length, 50);
  assert.equal(readOutcomeFromHeader({ size: 51, postSize: 51, readSoFar: 50 }, 50).length, 50);
  // readSoFar one short of the window is a short read; equal to it is not.
  assert.equal(readOutcomeFromHeader({ size: 50, postSize: 50, readSoFar: 49 }, 50).shortRead, true);
  assert.equal(readOutcomeFromHeader({ size: 50, postSize: 50, readSoFar: 50 }, 50).shortRead, false);
});

// --- AC4: purity ------------------------------------------------------------

test('AC4: readOutcomeFromHeader is pure — same inputs give deep-equal outputs and the header is not mutated', () => {
  const header = Object.freeze({ size: 1024, postSize: 4096, readSoFar: 1024 });
  const before = { ...header };
  const a = readOutcomeFromHeader(header, EIGHT_MIB);
  const b = readOutcomeFromHeader(header, EIGHT_MIB);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'a fresh object per call, never a shared one');
  assert.deepEqual(header, before);
  assert.deepEqual(Object.keys(a).sort(), ['grew', 'length', 'shortRead', 'shrank', 'truncated', 'truncatedByBytes']);
});

// --- AC3: end to end through the hook's real spawn/frame path ----------------

/**
 * A verbatim copy of the hook modules in a fixture directory, with
 * `tail-read-worker.mjs` replaced by `workerSource`. The hook resolves its
 * worker next to its own module, so importing the copy routes
 * `boundedHandoffRead` — and everything built on it, `repoManifestChainIsSigned`
 * included — through the swapped worker while the hook's own spawn, frame
 * parsing, validation and outcome mapping run unchanged. No production code
 * changes shape for this, and a mutation of adlc-hook.mjs is copied in, so the
 * end-to-end cases still catch it (verified by restoring `!==` locally).
 * The directory's bounded spawn helper is copied too, so a swapped worker that
 * must spawn the real one does it through `spawnHook`, never a raw spawn.
 */
async function hookCopyWithWorker(workerSource) {
  const dir = fixtureDir();
  for (const name of readdirSync(HOOKS_DIR)) {
    if (name.endsWith('.mjs')) copyFileSync(join(HOOKS_DIR, name), join(dir, name));
  }
  copyFileSync(join(HOOKS_DIR, 'test', 'helpers', 'run-hook.mjs'), join(dir, 'run-hook.mjs'));
  writeFileSync(join(dir, 'tail-read-worker.mjs'), workerSource);
  return import(pathToFileURL(join(dir, 'adlc-hook.mjs')).href);
}

/**
 * A DETERMINISTIC worker speaking the real worker's frame protocol
 * (`{ ok, size, postSize, readSoFar }` header line, then the bytes, exit 0)
 * that mutates the file BETWEEN its pre-read fstat and its post-read fstat
 * according to `<path>.between.json`: `{ "append": "<text>" }` grows it,
 * `{ "truncateTo": <n> }` shrinks it, `{}` leaves it alone. This constructs
 * the exact interleaving a concurrent host append produces, instead of hoping
 * a scheduler produces it.
 */
const DETERMINISTIC_WORKER = `
import { openSync, fstatSync, readSync, closeSync, appendFileSync, truncateSync, readFileSync, existsSync } from 'node:fs';
const [, , path, maxBytesArg] = process.argv;
const maxBytes = Number(maxBytesArg);
const fd = openSync(path, 'r');
const size = fstatSync(fd).size;
const length = Math.min(size, maxBytes);
const buf = Buffer.alloc(length);
let readSoFar = 0;
while (readSoFar < length) {
  const got = readSync(fd, buf, readSoFar, length - readSoFar, size - length + readSoFar);
  if (got <= 0) break;
  readSoFar += got;
}
const between = existsSync(path + '.between.json') ? JSON.parse(readFileSync(path + '.between.json', 'utf8')) : {};
if (typeof between.append === 'string') appendFileSync(path, between.append);
if (Number.isInteger(between.truncateTo)) truncateSync(path, between.truncateTo);
const postSize = fstatSync(fd).size;
closeSync(fd);
let pending = 2;
const done = () => { pending -= 1; if (pending === 0) process.exit(0); };
process.stdout.write(JSON.stringify({ ok: true, size, postSize, readSoFar }) + '\\n', done);
process.stdout.write(buf.subarray(0, readSoFar), done);
`;

/**
 * A TEE around the REAL worker: same argv, stdout forwarded byte-for-byte,
 * exit status unchanged, header line copied to `<path>.last-header.json` so a
 * test can see the frame the hook actually consumed for THIS call.
 */
const TEE_WORKER = [
  "import { writeFileSync } from 'node:fs';",
  "import { spawnHook } from './run-hook.mjs';",
  'const [, , path, maxBytes] = process.argv;',
  `const real = ${JSON.stringify(REAL_WORKER)};`,
  "const r = spawnHook([real, path, maxBytes], { encoding: 'buffer', timeout: 20_000, maxBuffer: Number(maxBytes) + 4096 });",
  'if (r.status === 0 && Buffer.isBuffer(r.stdout)) {',
  '  const nl = r.stdout.indexOf(0x0a);',
  '  if (nl !== -1) writeFileSync(`${path}.last-header.json`, r.stdout.subarray(0, nl));',
  '}',
  'const code = r.status ?? 1;',
  'if (Buffer.isBuffer(r.stdout) && r.stdout.length > 0) process.stdout.write(r.stdout, () => process.exit(code));',
  'else process.exit(code);',
  '',
].join('\n');

const LINE = '{"type":"assistant","content":[{"type":"tool_use","name":"Edit"}]}\n';

test('AC3: an append between the worker\'s two fstats (deterministic) is a complete read — truncated: false, grew: true', async () => {
  const hook = await hookCopyWithWorker(DETERMINISTIC_WORKER);
  const dir = fixtureDir();
  const transcript = join(dir, 'transcript.jsonl');
  const original = LINE.repeat(50);
  writeFileSync(transcript, original);
  writeFileSync(`${transcript}.between.json`, JSON.stringify({ append: LINE.repeat(3) }));

  const result = hook.boundedHandoffRead(transcript, { maxBytes: EIGHT_MIB, deadlineMs: 10_000 });

  assert.notEqual(result, null);
  assert.equal(result.size, original.length, 'size is the pre-read fstat');
  assert.equal(result.text, original, 'the read returned exactly what existed at its fstat');
  assert.equal(result.grew, true, 'the worker saw postSize > size');
  assert.equal(result.truncated, false, 'growth after a complete read is not truncation');
  assert.equal(statSync(transcript).size, original.length + LINE.length * 3, 'the append really landed');
});

test('AC3: a shrink between the worker\'s two fstats (deterministic) is still truncated', async () => {
  const hook = await hookCopyWithWorker(DETERMINISTIC_WORKER);
  const dir = fixtureDir();
  const transcript = join(dir, 'transcript.jsonl');
  const original = LINE.repeat(50);
  writeFileSync(transcript, original);
  writeFileSync(`${transcript}.between.json`, JSON.stringify({ truncateTo: original.length - 1 }));

  const result = hook.boundedHandoffRead(transcript, { maxBytes: EIGHT_MIB, deadlineMs: 10_000 });

  assert.notEqual(result, null);
  assert.equal(result.grew, false);
  assert.equal(result.truncated, true, 'a shrink can hide a record the read never saw');
});

test('AC3: no change between the fstats (deterministic) is complete, and a windowed read is still truncated', async () => {
  const hook = await hookCopyWithWorker(DETERMINISTIC_WORKER);
  const dir = fixtureDir();
  const transcript = join(dir, 'transcript.jsonl');
  const original = LINE.repeat(50);
  writeFileSync(transcript, original);
  writeFileSync(`${transcript}.between.json`, '{}');

  const complete = hook.boundedHandoffRead(transcript, { maxBytes: EIGHT_MIB, deadlineMs: 10_000 });
  assert.equal(complete.truncated, false);
  assert.equal(complete.grew, false);
  assert.equal(complete.text, original);

  const windowed = hook.boundedHandoffRead(transcript, { maxBytes: 20, deadlineMs: 10_000 });
  assert.equal(windowed.truncated, true);
  assert.equal(windowed.text.length, 20);
});

test('AC3 guard: repoManifestChainIsSigned keeps treating growth as inconclusive — a signed entry appended between the fstats is never read as "unsigned"', async () => {
  const hook = await hookCopyWithWorker(DETERMINISTIC_WORKER);
  const repo = fixtureDir();
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  const manifest = join(repo, '.adlc', 'manifest.jsonl');
  const unsigned = `${JSON.stringify({ seq: 1, gate: 'coldstart', prev: null })}\n`;
  writeFileSync(manifest, unsigned);

  // Control: the chain really is unsigned when nothing moves.
  writeFileSync(`${manifest}.between.json`, '{}');
  assert.equal(hook.repoManifestChainIsSigned(repo), false, 'an unsigned, static manifest is provably unsigned');

  // The race: a SIGNED entry lands between the worker's two fstats. The text the
  // scanner receives omits it, so the only safe answer is "cannot prove unsigned".
  writeFileSync(manifest, unsigned);
  writeFileSync(`${manifest}.between.json`, JSON.stringify({ append: `${JSON.stringify({ seq: 2, gate: 'coldstart', prev: 'x', sig: 'deadbeef' })}\n` }));
  assert.equal(hook.repoManifestChainIsSigned(repo), true, 'growth during the scan must fail closed to "signed"');

  // And a shrink during the scan is inconclusive too (unchanged behaviour).
  writeFileSync(manifest, unsigned);
  writeFileSync(`${manifest}.between.json`, JSON.stringify({ truncateTo: unsigned.length - 1 }));
  assert.equal(hook.repoManifestChainIsSigned(repo), true, 'a shrink during the scan must fail closed to "signed"');
});

/**
 * Append one `chunkBytes` record to `path` roughly every millisecond from a
 * WORKER THREAD until the test flips `stop`, or until `maxBytes` of growth —
 * the resource deadline, never the test's clock. A thread, not a child
 * process: `boundedHandoffRead` is synchronous (spawnSync blocks this
 * thread), so only another thread of this process can keep the file growing
 * while it runs, and plugin tests may not spawn raw child processes
 * (hook-spawn-timeout-drift). The byte cap keeps every read far below the
 * read window and protects a tmpfs.
 */
function startAppender(path, { chunkBytes, maxBytes }) {
  // CommonJS on purpose: an eval Worker is CommonJS on Node 18 and 20 (only
  // Node >= 22.7 detects ESM syntax in eval code), and CI runs all three.
  const script = `
    const { appendFileSync } = require('node:fs');
    const { workerData } = require('node:worker_threads');
    const { path, chunk, maxBytes, flags } = workerData;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let written = 0;
    while (Atomics.load(flags, 0) === 0 && written < maxBytes) {
      appendFileSync(path, chunk);
      written += chunk.length;
      Atomics.wait(pause, 0, 0, 1); // ~1 ms, without a timer
    }
  `;
  const flags = new Int32Array(new SharedArrayBuffer(4));
  const chunk = `{"type":"user","content":"${'x'.repeat(chunkBytes)}"}\n`;
  const worker = new Worker(script, { eval: true, workerData: { path, chunk, maxBytes, flags } });
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  return { exited, stop: () => Atomics.store(flags, 0, 1) };
}

test('AC3 smoke: the REAL worker under a live appender — every frame it reports as grown is complete (bounded, never fails for want of a race)', async (t) => {
  const hook = await hookCopyWithWorker(TEE_WORKER);
  const dir = fixtureDir();
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, LINE.repeat(120_000)); // ≈ 8 MiB: the read spans a few ms
  const sizeBefore = statSync(transcript).size;
  const CHUNK = 4096;
  const maxBytes = 512 * 1024 * 1024; // no read in this test is ever windowed
  const maxAttempts = 20;
  const deadline = Date.now() + 15_000;
  const lastHeader = () => JSON.parse(readFileSync(`${transcript}.last-header.json`, 'utf8'));

  const appender = startAppender(transcript, { chunkBytes: CHUNK, maxBytes: 64 * 1024 * 1024 });
  const truncatedGrownFrames = [];
  let grownFrames = 0;
  let attempts = 0;
  try {
    while (attempts < maxAttempts && Date.now() < deadline) {
      attempts += 1;
      const result = hook.boundedHandoffRead(transcript, { maxBytes, deadlineMs: 20_000 });
      assert.notEqual(result, null, 'the read must not fail outright');
      const header = lastHeader();
      assert.equal(header.size, result.size, 'the tee forwarded the frame of this very call');
      assert.equal(result.text.length, result.size, 'a complete read returns every byte that existed at its fstat');
      assert.equal(result.grew, header.postSize > header.size, '`grew` reflects the worker\'s own frame');
      if (!result.grew) continue;
      grownFrames += 1;
      if (result.truncated) truncatedGrownFrames.push({ attempt: attempts, size: header.size, postSize: header.postSize });
      if (grownFrames >= 5) break;
    }
  } finally {
    appender.stop();
    await appender.exited;
  }

  // The deterministic cases above are the regression pins; this run adds the
  // real worker's I/O. Whether the scheduler produced the race depends on the
  // appender thread getting CPU, so a grown frame is REQUIRED only when the
  // file provably grew by many records while the attempts ran — the appender
  // was live, every read spanned milliseconds, and still no frame saw growth
  // means the real worker no longer reports post-read growth. On a runner that
  // starved the appender the race is reported, not required, so it cannot red
  // a correct build for want of CPU.
  const grownBy = statSync(transcript).size - sizeBefore;
  const appenderWasLive = grownBy >= 50 * (CHUNK + 32);
  t.diagnostic(`real worker: ${grownFrames} grown frame(s) in ${attempts} attempt(s); file grew by ${grownBy} bytes`);
  if (appenderWasLive) {
    assert.ok(grownFrames > 0, `the appender wrote ${grownBy} bytes during ${attempts} reads, yet the real worker never reported postSize > size`);
  }
  assert.deepEqual(truncatedGrownFrames, [], 'no frame the real worker reported as grown may be reported truncated');
});
