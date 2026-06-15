#!/usr/bin/env node
// ADLC advisory hooks — one helper, three modes:
//   preflight  (SessionStart)  → environment readiness before fan-out
//   flail      (PostToolUse)    → flail-detection over the session transcript
//   manifest   (Stop)           → gate-evidence chain integrity audit
//
// CONTRACT: these hooks are ADVISORY ONLY. They must NEVER block a tool call,
// fail a session, or surface an error of their own. Every path ends in exit 0,
// and the helper stays SILENT unless there is something worth flagging. If the
// toolkit is not installed or the repo is not ADLC-initialized, it no-ops.
//
// Output: when there is something to say, print ONE JSON object using fields
// Claude Code recognizes for non-blocking messages (`systemMessage`, and
// `hookSpecificOutput.additionalContext` for SessionStart). No output = no-op.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const MODE = process.argv[2];

// Flail detection only needs the RECENT window of a session — flailing is a
// "looping right now" signal, not a whole-history property. Cap the scan so a
// long session's growing transcript can never turn this synchronous PostToolUse
// hook into a repeated full-history reparse.
const MAX_SCAN_BYTES = 256 * 1024;

/** Read the entire hook payload from stdin (fd 0). Never throws. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Print one advisory JSON object. Caller then exits 0. */
function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch {
    /* ignore — advisory output is best-effort */
  }
}

/**
 * Run an `adlc` subcommand. Returns the spawn result, or null when the toolkit
 * is not on PATH (ENOENT) — the signal to no-op rather than error.
 */
function runAdlc(args) {
  const r = spawnSync('adlc', args, { encoding: 'utf8' });
  if (r.error) return null;
  return r;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function main() {
  const input = parseJson(readStdin()) ?? {};

  // Operate in the project root so the tools resolve `.adlc/` correctly.
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try {
    process.chdir(dir);
  } catch {
    return; // cannot reach the project dir — nothing to do
  }

  if (MODE === 'preflight') return preflight();
  if (MODE === 'flail') return flail(input);
  if (MODE === 'manifest') return manifest();
  // unknown mode → no-op
}

// SessionStart — surface only genuine environment failures, stay silent when ready.
function preflight() {
  if (!existsSync('.adlc')) return; // not an ADLC repo
  const r = runAdlc(['preflight', '--json']);
  if (!r || !r.stdout) return; // toolkit absent / no output
  const res = parseJson(r.stdout);
  if (!res) return;
  const failed = res.failedNames ?? [];
  if (failed.length === 0) return; // ready → silent
  const msg =
    `ADLC preflight: ${failed.length} environment check(s) failing before fan-out: ` +
    `${failed.join(', ')}. Run \`adlc preflight\` for detail.`;
  emit({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
    systemMessage: msg,
  });
}

// PostToolUse — flag flailing over the transcript; dedupe so the same signal set
// is not re-reported on every subsequent tool call within a session.
/** File size in bytes, or -1 on error. Closes the fd. */
function fileSize(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    return fstatSync(fd).size;
  } catch {
    return -1;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read at most the last `maxBytes` of a file without loading the whole thing,
 * dropping a leading partial line so the result is clean JSONL/text. Returns
 * null on any error (caller then no-ops).
 */
function tailBytes(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1); // drop the partial first line
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function flail(input) {
  if (!existsSync('.adlc')) return; // not an ADLC repo — same no-op guard as the other modes
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) return;

  // Bound the work: scan the original file when small, otherwise a recent-window
  // copy in the temp dir so cost stays O(MAX_SCAN_BYTES) no matter how long the
  // session runs.
  let scanPath = tp;
  let tmpScan = null;
  if (fileSize(tp) > MAX_SCAN_BYTES) {
    const tail = tailBytes(tp, MAX_SCAN_BYTES);
    if (tail == null) return;
    try {
      const key = createHash('sha1').update(tp).digest('hex').slice(0, 16);
      tmpScan = join(tmpdir(), `adlc-flail-scan-${key}.jsonl`);
      writeFileSync(tmpScan, tail);
      scanPath = tmpScan;
    } catch {
      return; // cannot stage the bounded copy — skip rather than full-scan
    }
  }

  const r = runAdlc(['flail-detector', scanPath, '--json']);
  if (tmpScan) {
    try {
      unlinkSync(tmpScan);
    } catch {
      /* best-effort cleanup */
    }
  }
  if (!r || !r.stdout) return;
  const res = parseJson(r.stdout);
  if (!res || res.verdict !== 'flail') return;

  const summary = (res.signals ?? []).map((s) => s.type).join(', ');
  // Dedupe state lives in the OS temp dir, NOT the worktree — keyed by the
  // (per-session) transcript path. This keeps the advisory hook from ever
  // creating repo-local files, so it cannot dirty the tree regardless of the
  // project's .gitignore.
  const key = createHash('sha1').update(tp).digest('hex').slice(0, 16);
  const stateFile = join(tmpdir(), `adlc-flail-${key}.state`);
  let prev = '';
  try {
    prev = readFileSync(stateFile, 'utf8');
  } catch {
    /* no prior state */
  }
  if (prev.trim() === summary.trim()) return; // already reported this signal set
  try {
    writeFileSync(stateFile, summary);
  } catch {
    /* state is best-effort; still surface the advisory */
  }

  const msg =
    `ADLC flail-detector: possible flailing this session (${summary || 'signals detected'}). ` +
    `Consider stopping and banking the dead-ends rather than retrying.`;
  emit({ systemMessage: msg });
}

// Stop — audit the gate-evidence chain; warn only if it is broken.
function manifest() {
  if (!existsSync(join('.adlc', 'manifest.jsonl'))) return; // nothing recorded yet
  const r = runAdlc(['gate-manifest', 'verify', '--json']);
  if (!r || !r.stdout) return;
  const res = parseJson(r.stdout);
  if (!res || res.valid) return; // intact → silent
  const msg =
    `ADLC gate-manifest: evidence chain INVALID — ${res.message}. ` +
    `The gate ledger may have been tampered with or truncated.`;
  emit({ systemMessage: msg });
}

try {
  main();
} catch {
  /* advisory hooks never surface their own errors */
}
process.exit(0);
