#!/usr/bin/env node
// tail-read-worker.mjs — Round-16 review (T-01M03J291182MXD1KEKM2PRKTS): the
// deadline check in boundedHandoffRead (adlc-hook.mjs) only ran BETWEEN
// synchronous readSync calls — it could never preempt a single openSync or
// readSync that itself blocks (a stalled network mount, a FIFO with no
// writer, a hung device file at transcript_path), stalling the PreToolUse
// hook past MAX_SCAN_WALL_MS with no enforceable ceiling at all.
//
// This script performs the actual tail read in a SEPARATE PROCESS, spawned
// by boundedHandoffRead via `spawnSync(..., { timeout })`. The OS can
// forcibly kill this process if it does not finish in time — real
// preemption, which nothing in-process can offer against a blocking
// syscall. Keeping the read itself out-of-process also keeps
// boundedHandoffRead's own call signature and every existing caller/test
// fully synchronous; no async refactor needed. Twin of the identically
// protocol'd worker in plugins/adlc-codex/hooks/.
//
// Protocol: exit code is authoritative. Exit 0 means stdout carries the
// success frame (JSON header line `{ ok: true, size, postSize, readSoFar }`
// followed by the raw read bytes, exactly readSoFar of them, no encoding);
// any nonzero exit means failure and stdout carries nothing meaningful — the
// parent never inspects it in that case.

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';

const [, , path, maxBytesArg] = process.argv;
const maxBytes = Number(maxBytesArg);

// No fd-close-before-exit here: this worker calls process.exit() right
// after, and the OS reclaims every open fd on process exit regardless — an
// explicit close in this specific path has no observable effect, only a
// call site that KNOWS it holds an open fd (below) closes it itself.
// No stdout body on failure: the parent trusts the exit code as the
// authoritative failure signal (see boundedHandoffRead's own comment), so
// there is nothing for a header to say that isn't already said by dying
// with a nonzero status.
function fail() {
  process.exit(1);
}

if (typeof path !== 'string' || path === '' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
  fail();
}

let fd;
try {
  fd = openSync(path, 'r');
} catch {
  fail();
}

let size;
let readSoFar = 0;
let buf;
try {
  size = fstatSync(fd).size;
  const length = Math.min(size, maxBytes);
  const windowStart = size - length;
  buf = Buffer.alloc(length);
  const chunkBytes = 256 * 1024;
  while (readSoFar < length) {
    const want = Math.min(chunkBytes, length - readSoFar);
    let got;
    try {
      got = readSync(fd, buf, readSoFar, want, windowStart + readSoFar);
    } catch {
      break;
    }
    if (got <= 0) break;
    readSoFar += got;
  }
} catch {
  try {
    closeSync(fd);
  } catch {
    // best-effort — fail() is about to process.exit() regardless
  }
  fail();
}

let postSize = size;
try {
  postSize = fstatSync(fd).size;
} catch {
  // fall through — pre-read size still applies
}
try {
  closeSync(fd);
} catch {
  // best-effort
}

// A payload of any real size (the read window can be up to MAX_ACTIVE_
// CONTEXT_BYTES, 8 MiB) exceeds the OS pipe buffer (~64 KiB) that stdout is
// connected to under spawnSync. write() on a pipe queues asynchronously —
// calling process.exit() right after it, without waiting for the callback,
// truncates the write to whatever fit in the immediate OS buffer and
// silently drops the rest. Exit only once BOTH writes' callbacks confirm
// they finished draining.
let pending = 2;
function doneWriting() {
  pending -= 1;
  if (pending === 0) process.exit(0);
}
process.stdout.write(`${JSON.stringify({ ok: true, size, postSize, readSoFar })}\n`, doneWriting);
process.stdout.write(buf.subarray(0, readSoFar), doneWriting);
