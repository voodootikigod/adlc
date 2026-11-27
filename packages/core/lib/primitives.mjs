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
import { pidAlive, procStartTimeOf, thisHost } from './proc.mjs';
import { INLINE_ASSIGNMENT, SECRET_PATTERNS } from './secret-shapes.mjs';
import { writeFileAtomic as ticketsWriteFileAtomic } from '@adlc/tickets/lib/durability.mjs';

const SECRET_REDACT_RULES = SECRET_PATTERNS.map(([pattern]) => [
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
  pattern === INLINE_ASSIGNMENT ? '$1[REDACTED]' : '[REDACTED]',
]);

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/**
 * Write a file atomically via a unique sibling temporary file and rename.
 *
 * @param {string} filePath
 * @param {string|Buffer|Uint8Array} content
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomic(filePath, content, options = {}) {
  return ticketsWriteFileAtomic(filePath, content, options);
}

/**
 * Refresh the heartbeat timestamp of a held directory lock if the token still matches.
 *
 * @param {string} lockDir
 * @param {string} token
 * @param {{ now?: () => number }} [options]
 * @returns {boolean} true if updated, false if the lock is no longer owned by `token`
 */
export function heartbeat(lockDir, token, options = {}) {
  const now = options.now ?? Date.now;
  const ownerPath = join(lockDir, 'owner.json');
  try {
    const current = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (!current || current.token !== token) return false;
    const ts = now();
    const updated = { ...current, createdAt: ts, heartbeatAt: ts };
    writeFileAtomic(ownerPath, JSON.stringify(updated), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an advisory directory lock using atomic staging-dir rename, with
 * optional bounded retry and stale-lock recovery. A live same-host owner is
 * never evicted on age alone.
 *
 * @param {string} lockDir
 * @param {{
 *   staleMs?: number;
 *   retries?: number;
 *   delayMs?: number;
 *   now?: () => number;
 *   isPidAlive?: (pid: number) => boolean;
 *   procStartTime?: (pid: number) => string | null;
 *   host?: string;
 * }} [options]
 * @returns {(() => void) & { heartbeat: () => boolean; token: string }} release function
 */
export function acquireDirLock(lockDir, options = {}) {
  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const procStartTime = options.procStartTime ?? procStartTimeOf;
  const currentHost = options.host ?? thisHost();
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const delayMs = typeof options.delayMs === 'number' && options.delayMs >= 0 ? options.delayMs : 10;

  const tryAcquire = () => {
    const owner = {
      pid: process.pid,
      pidStartTime: procStartTime(process.pid),
      hostname: currentHost,
      token: randomUUID(),
      createdAt: now(),
    };
    const stageDir = `${lockDir}.stage-${process.pid}-${randomUUID()}`;
    mkdirSync(stageDir, { mode: 0o700 });
    try {
      writeFileSync(join(stageDir, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
      // POSIX rename(2) overwrites an empty destination directory; reject any
      // pre-existing lockDir (even empty) with EEXIST so stale checks run cleanly.
      let alreadyExists = false;
      try {
        lstatSync(lockDir);
        alreadyExists = true;
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
      }
      if (alreadyExists) {
        const existErr = new Error(`EEXIST: file already exists, mkdir '${lockDir}'`);
        existErr.code = 'EEXIST';
        throw existErr;
      }
      renameSync(stageDir, lockDir);
    } catch (err) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {}
      if (err.code === 'ENOTEMPTY' || err.code === 'EPERM') {
        const existErr = new Error(`EEXIST: file already exists, mkdir '${lockDir}'`);
        existErr.code = 'EEXIST';
        throw existErr;
      }
      throw err;
    }

    const ownerPath = join(lockDir, 'owner.json');
    const { ino } = lstatSync(lockDir);
    const release = () => {
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
    release.token = owner.token;
    release.heartbeat = () => heartbeat(lockDir, owner.token, { now });
    return release;
  };

  const checkStaleAndRecover = () => {
    if (options.staleMs === undefined) return false;
    let isStale = false;
    const ownerPath = join(lockDir, 'owner.json');
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      const timestamp = typeof owner.heartbeatAt === 'number' ? owner.heartbeatAt : owner.createdAt;
      const ageExceeded = typeof timestamp === 'number' && now() - timestamp > options.staleMs;
      if (ageExceeded) {
        const sameHost = !owner.hostname || owner.hostname === currentHost;
        if (sameHost && typeof owner.pid === 'number') {
          if (!isPidAlive(owner.pid)) {
            isStale = true;
          } else if (owner.pidStartTime != null) {
            const liveStart = procStartTime(owner.pid);
            if (liveStart != null && String(liveStart) !== String(owner.pidStartTime)) {
              isStale = true;
            }
          }
          // Live same-host process with matching start time is NEVER evicted on age alone.
        } else if (!sameHost) {
          isStale = true;
        }
      }
    } catch (readErr) {
      if (readErr.code === 'ENOENT') {
        try {
          const st = lstatSync(lockDir);
          if (now() - st.mtimeMs > options.staleMs) {
            isStale = true;
          }
        } catch {}
      }
    }
    if (!isStale) return false;
    const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(lockDir, staleDir);
      rmSync(staleDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return tryAcquire();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (checkStaleAndRecover()) {
        try {
          return tryAcquire();
        } catch (retryErr) {
          if (retryErr.code !== 'EEXIST' || attempt >= retries) throw retryErr;
        }
      } else if (attempt >= retries) {
        throw err;
      }
      sleepSync(delayMs);
    }
  }
}

/**
 * Execute `fn` while holding an advisory directory lock, guaranteeing release
 * on both synchronous completion/throw and async Promise settlement.
 *
 * @template T
 * @param {string} lockDir
 * @param {(ctx: { release: () => void; heartbeat: () => boolean }) => T} fn
 * @param {Parameters<typeof acquireDirLock>[1]} [options]
 * @returns {T}
 */
export function withDirLock(lockDir, fn, options = {}) {
  const release = acquireDirLock(lockDir, options);
  try {
    const result = fn({ release, heartbeat: release.heartbeat });
    if (result && typeof result.then === 'function') {
      return result.finally(() => release());
    }
    release();
    return result;
  } catch (err) {
    release();
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
    let out = input;
    for (const [pattern, replacement] of SECRET_REDACT_RULES) {
      out = out.replace(pattern, replacement);
    }
    return out;
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
 * Record a prompt-only verdict via the caller-supplied gate-manifest writer.
 *
 * `recordFn` is required: writing raw unsequenced JSON via `appendEntry('manifest')`
 * bypasses `.adlc/manifest.d/` segment routing and breaks hash-chain verification.
 * All in-repo callers (`@adlc/coldstart`, `@adlc/parallax`, and `@adlc/premortem`
 * `verdict.mjs`) pass `@adlc/gate-manifest`'s `record` callback.
 *
 * @param {object} options
 * @param {string} [options.gate]
 * @param {string} [options.ticket]
 * @param {string} options.verdict
 * @param {Record<string, unknown>} [options.extra]
 * @param {string} [options.dir]
 * @param {(params: { gate?: string; ticket?: string; rawData: string; dir?: string }) => unknown} options.recordFn
 * @returns {unknown}
 */
export const VALID_ATTESTATION_MODES = Object.freeze(['self-context', 'headless-cli', 'api']);

export function recordPromptOnlyVerdict({ gate, ticket, verdict, extra = {}, dir, recordFn } = {}) {
  if (typeof recordFn !== 'function') {
    throw new TypeError('recordPromptOnlyVerdict requires a recordFn from @adlc/gate-manifest');
  }
  const data = {
    ...extra,
    promptOnly: true,
    executionWitnessed: false,
    attestationMode: 'self-context',
    usageStatus: 'unreported',
    verdict,
  };
  return recordFn({ gate, ticket, rawData: JSON.stringify(data), dir });
}

/**
 * Escape backslashes and double quotes in a path for safe inclusion inside a
 * macOS Seatbelt (`sandbox-exec -p`) SBPL double-quoted string literal, and
 * refuse NUL or line-terminator characters that could truncate C strings or
 * break profile parsing.
 *
 * @param {string} pathValue
 * @returns {string}
 */
export function escapeSeatbeltPath(pathValue) {
  const str = String(pathValue);
  if (/[\0\r\n]/.test(str)) {
    throw new Error('Seatbelt path cannot contain NUL or line-terminator characters');
  }
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
