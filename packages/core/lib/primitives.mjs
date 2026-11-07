// Core shared primitives: atomic filesystem operations, directory locking,
// credential redaction, and prompt-only verdict handling.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { opError, readStdin } from './cli.mjs';
import { appendEntry } from './ledger.mjs';
import { procStartTimeOf } from './proc.mjs';

const SECRET_REGEX =
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|Bearer\s+[A-Za-z0-9._~+/-]{20,}=*|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;

/**
 * Write a file atomically via a unique sibling temporary file and rename.
 *
 * @param {string} filePath
 * @param {string|Buffer|Uint8Array} content
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomic(filePath, content, options = {}) {
  let st = null;
  try {
    st = lstatSync(filePath);
  } catch {}
  if (st && st.isSymbolicLink()) {
    throw new Error('refusing to write through symlink: ' + filePath);
  }
  const mode = options.mode ?? (st ? (st.mode & 0o777) : 0o600);
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  let closed = false;
  try {
    fd = openSync(tmpPath, 'wx', mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null && !closed) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Acquire an advisory directory lock with optional stale detection.
 *
 * @param {string} lockDir
 * @param {{ staleMs?: number }} [options]
 * @returns {() => void} release function
 */
export function acquireDirLock(lockDir, options = {}) {
  const tryAcquire = () => {
    mkdirSync(lockDir);
    const owner = {
      pid: process.pid,
      pidStartTime: procStartTimeOf(process.pid),
      token: randomUUID(),
      createdAt: Date.now(),
    };
    const ownerPath = join(lockDir, 'owner.json');
    try {
      writeFileSync(ownerPath, JSON.stringify(owner), 'utf8');
    } catch (writeErr) {
      try {
        rmdirSync(lockDir);
      } catch {}
      throw writeErr;
    }
    const { ino } = lstatSync(lockDir);
    return () => {
      try {
        if (lstatSync(lockDir).ino !== ino) return;
        const current = JSON.parse(readFileSync(ownerPath, 'utf8'));
        if (current && current.token === owner.token) {
          try {
            unlinkSync(ownerPath);
          } catch {}
          try {
            rmdirSync(lockDir);
          } catch {}
        }
      } catch {}
    };
  };

  try {
    return tryAcquire();
  } catch (err) {
    if (err.code === 'EEXIST' && options.staleMs !== undefined) {
      let isStale = false;
      const ownerPath = join(lockDir, 'owner.json');
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
        if (typeof owner.createdAt === 'number' && Date.now() - owner.createdAt > options.staleMs) {
          try {
            process.kill(owner.pid, 0);
            if (owner.pidStartTime != null) {
              const liveStart = procStartTimeOf(owner.pid);
              if (liveStart != null && String(liveStart) !== String(owner.pidStartTime)) {
                isStale = true;
              }
            }
          } catch (killErr) {
            if (killErr.code === 'ESRCH') {
              isStale = true;
            }
          }
        }
      } catch (readErr) {
        if (readErr.code === 'ENOENT') {
          try {
            const st = lstatSync(lockDir);
            if (Date.now() - st.mtimeMs > options.staleMs) {
              isStale = true;
            }
          } catch {}
        }
      }
      if (isStale) {
        const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
        try {
          renameSync(lockDir, staleDir);
          rmSync(staleDir, { recursive: true, force: true });
        } catch {
          throw err;
        }
        return tryAcquire();
      }
    }
    throw err;
  }
}

/**
 * Redact common credential patterns from a string, or recursively within objects/arrays.
 *
 * @template T
 * @param {T} input
 * @returns {T}
 */
export function redactSecrets(input) {
  if (typeof input === 'string') {
    return input.replace(SECRET_REGEX, '[REDACTED]');
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item));
  }
  if (input instanceof Error) {
    const cloned = new Error(redactSecrets(input.message));
    if (typeof input.stack === 'string') {
      cloned.stack = redactSecrets(input.stack);
    }
    return cloned;
  }
  if (
    input !== null &&
    typeof input === 'object' &&
    !Buffer.isBuffer(input) &&
    !(input instanceof Date) &&
    !(input instanceof RegExp)
  ) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return input;
}

/**
 * Read trimmed verdict text from stdin ('-') or a file.
 *
 * @param {string} source
 * @returns {Promise<string>}
 */
export async function readVerdictSource(source) {
  if (source === '-') {
    const text = (await readStdin()).trim();
    if (!text) opError('--record-verdict - : stdin was empty');
    return text;
  }

  let text;
  try {
    text = readFileSync(source, 'utf8');
  } catch (err) {
    opError(`cannot read verdict file '${source}': ${err.message}`);
  }
  text = text.trim();
  if (!text) opError(`--record-verdict ${source}: file was empty`);
  return text;
}

/**
 * Record a prompt-only verdict into .adlc/manifest.jsonl.
 *
 * @param {object} options
 * @param {string} [options.gate]
 * @param {string} [options.ticket]
 * @param {string} options.verdict
 * @param {Record<string, unknown>} [options.extra]
 * @param {string} [options.dir]
 * @param {(params: { gate?: string; ticket?: string; rawData: string; dir?: string }) => unknown} [options.recordFn]
 * @returns {unknown}
 */
export function recordPromptOnlyVerdict({ gate, ticket, verdict, extra = {}, dir, recordFn } = {}) {
  const data = { ...extra, promptOnly: true, usageStatus: 'unreported', verdict };
  if (recordFn) {
    return recordFn({ gate, ticket, rawData: JSON.stringify(data), dir });
  }
  return appendEntry('manifest', { gate, ticket, data }, dir);
}

/**
 * Read a REGULAR file without blocking or following symlinks: open with
 * O_RDONLY | O_NOFOLLOW | O_NONBLOCK, fstat the open fd to verify regular file
 * and size cap, and read at most maxBytes.
 *
 * @param {string} path
 * @param {number} [maxBytes=8388608]
 * @param {{ openSync?: typeof openSync; fstatSync?: typeof fstatSync; readSync?: typeof readSync; closeSync?: typeof closeSync }} [deps]
 * @returns {string}
 */
export function readBoundedRegularFile(
  path,
  maxBytes = 8 * 1024 * 1024,
  { openSync: open = openSync, fstatSync: fstat = fstatSync, readSync: read = readSync, closeSync: close = closeSync } = {},
) {
  const fd = open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = fstat(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > maxBytes) throw new Error(`${st.size} bytes exceeds ${maxBytes}`);
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = read(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`more than ${maxBytes} bytes (the file grew while it was read)`);
      if (total === buf.length) break;
    }
    return buf.subarray(0, total).toString('utf8');
  } finally {
    try { close(fd); } catch {}
  }
}
