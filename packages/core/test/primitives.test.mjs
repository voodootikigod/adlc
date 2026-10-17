import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../lib/test-kit.mjs';
import {
  writeFileAtomic,
  acquireDirLock,
  redactSecrets,
  readVerdictSource,
  recordPromptOnlyVerdict,
} from '../index.mjs';
import { readEntries } from '../lib/ledger.mjs';

function withOpErrorTrap(fn) {
  let exitCode = null;
  let errorMessage = '';
  const origExit = process.exit;
  const origError = console.error;
  try {
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`EXIT_${code}`);
    };
    console.error = (msg) => {
      errorMessage += String(msg);
    };
    fn();
    return { exitCode, errorMessage, called: false };
  } catch (err) {
    if (err.message === `EXIT_${exitCode}`) {
      return { exitCode, errorMessage, called: true };
    }
    throw err;
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
}

async function withOpErrorTrapAsync(fn) {
  let exitCode = null;
  let errorMessage = '';
  const origExit = process.exit;
  const origError = console.error;
  try {
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`EXIT_${code}`);
    };
    console.error = (msg) => {
      errorMessage += String(msg);
    };
    await fn();
    return { exitCode, errorMessage, called: false };
  } catch (err) {
    if (err.message === `EXIT_${exitCode}`) {
      return { exitCode, errorMessage, called: true };
    }
    throw err;
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
}

// ── writeFileAtomic ──────────────────────────────────────────────────────────

test('writeFileAtomic: writes a new file atomically with default mode 0o600', (t) => {
  const dir = tmp(t, 'wfa-new-');
  const file = join(dir, 'output.txt');
  writeFileAtomic(file, 'hello world\n');
  assert.equal(readFileSync(file, 'utf8'), 'hello world\n');
  const st = statSync(file);
  assert.equal(st.mode & 0o777, 0o600);
});

test('writeFileAtomic: writes a new file with custom options.mode', (t) => {
  const dir = tmp(t, 'wfa-mode-');
  const file = join(dir, 'script.sh');
  writeFileAtomic(file, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\n');
  const st = statSync(file);
  assert.equal(st.mode & 0o777, 0o755);
});

test('writeFileAtomic: preserves existing file mode when overwriting', (t) => {
  const dir = tmp(t, 'wfa-preserve-');
  const file = join(dir, 'exec.sh');
  writeFileAtomic(file, '#!/bin/sh\necho 1\n', { mode: 0o755 });
  assert.equal(statSync(file).mode & 0o777, 0o755);

  writeFileAtomic(file, '#!/bin/sh\necho 2\n');
  assert.equal(readFileSync(file, 'utf8'), '#!/bin/sh\necho 2\n');
  assert.equal(statSync(file).mode & 0o777, 0o755);
});

test('writeFileAtomic: accepts Uint8Array or Buffer content', (t) => {
  const dir = tmp(t, 'wfa-buf-');
  const file = join(dir, 'buf.bin');
  writeFileAtomic(file, Buffer.from([1, 2, 3]));
  assert.deepEqual(readFileSync(file), Buffer.from([1, 2, 3]));
});

test('writeFileAtomic: rejects writing through existing symlinks', (t) => {
  const dir = tmp(t, 'wfa-sym-');
  const realFile = join(dir, 'real.txt');
  writeFileSync(realFile, 'real content\n');
  const linkFile = join(dir, 'link.txt');
  symlinkSync(realFile, linkFile);

  assert.throws(
    () => writeFileAtomic(linkFile, 'new content\n'),
    (err) => err.message === `refusing to write through symlink: ${linkFile}`
  );
  assert.equal(readFileSync(realFile, 'utf8'), 'real content\n');
});

test('writeFileAtomic: cleans up sibling temp file if write fails midway', (t) => {
  const dir = tmp(t, 'wfa-fail-');
  const file = join(dir, 'fail.txt');

  assert.throws(() => writeFileAtomic(file, Symbol('unwritable')));
  assert.equal(existsSync(file), false);

  const siblingTemps = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.equal(siblingTemps.length, 0, 'no temp file left behind');
});

test('writeFileAtomic: cleans up temp file if renameSync fails', (t) => {
  const dir = tmp(t, 'wfa-rename-');
  const subDir = join(dir, 'dir-target');
  mkdirSync(subDir);

  // Renaming over an existing directory throws EISDIR (or EEXIST on Windows)
  assert.throws(() => writeFileAtomic(subDir, 'cannot overwrite dir'));

  const siblingTemps = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.equal(siblingTemps.length, 0, 'no temp file left behind');
});

// ── acquireDirLock ───────────────────────────────────────────────────────────

test('acquireDirLock: acquires lock, writes owner.json, and releases cleanly', (t) => {
  const dir = tmp(t, 'lock-basic-');
  const lockDir = join(dir, 'test.lock');

  const release = acquireDirLock(lockDir);
  assert.equal(existsSync(lockDir), true);

  const ownerPath = join(lockDir, 'owner.json');
  assert.equal(existsSync(ownerPath), true);
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.token, 'string');
  assert.ok(owner.token.length > 10);
  assert.equal(typeof owner.createdAt, 'number');

  release();
  assert.equal(existsSync(lockDir), false);
  assert.equal(existsSync(ownerPath), false);

  // Calling release a second time is safe and idempotent
  assert.doesNotThrow(() => release());
});

test('acquireDirLock: throws EEXIST when lock is already held without staleMs', (t) => {
  const dir = tmp(t, 'lock-held-');
  const lockDir = join(dir, 'test.lock');

  const release = acquireDirLock(lockDir);
  try {
    assert.throws(
      () => acquireDirLock(lockDir),
      (err) => err.code === 'EEXIST'
    );
  } finally {
    release();
  }
});

test('acquireDirLock: does not remove lock if owner.token does not match', (t) => {
  const dir = tmp(t, 'lock-token-mismatch-');
  const lockDir = join(dir, 'test.lock');

  const release = acquireDirLock(lockDir);
  const ownerPath = join(lockDir, 'owner.json');

  // Tamper with owner token
  const tamperedOwner = { pid: process.pid, token: 'foreign-token-uuid', createdAt: Date.now() };
  writeFileSync(ownerPath, JSON.stringify(tamperedOwner), 'utf8');

  release();
  assert.equal(existsSync(lockDir), true, 'lock directory remains intact when token does not match');
  assert.equal(existsSync(ownerPath), true);

  // Cleanup tampered test lock
  rmSync(lockDir, { recursive: true, force: true });
});

test('acquireDirLock: throws EEXIST if lock is held and staleMs is not exceeded', (t) => {
  const dir = tmp(t, 'lock-not-stale-');
  const lockDir = join(dir, 'test.lock');

  const release = acquireDirLock(lockDir);
  try {
    assert.throws(
      () => acquireDirLock(lockDir, { staleMs: 60000 }),
      (err) => err.code === 'EEXIST'
    );
  } finally {
    release();
  }
});

test('acquireDirLock: throws EEXIST if staleMs is exceeded but owner process is still alive', (t) => {
  const dir = tmp(t, 'lock-alive-');
  const lockDir = join(dir, 'test.lock');

  mkdirSync(lockDir);
  const ownerPath = join(lockDir, 'owner.json');
  // Stale timestamp but current alive pid
  writeFileSync(
    ownerPath,
    JSON.stringify({ pid: process.pid, token: 'old-token', createdAt: Date.now() - 100000 })
  );

  try {
    assert.throws(
      () => acquireDirLock(lockDir, { staleMs: 1000 }),
      (err) => err.code === 'EEXIST'
    );
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test('acquireDirLock: recovers stale lock when staleMs is exceeded and owner PID is dead', (t) => {
  const dir = tmp(t, 'lock-stale-dead-');
  const lockDir = join(dir, 'test.lock');

  mkdirSync(lockDir);
  const ownerPath = join(lockDir, 'owner.json');
  // Find a dead PID where kill(pid, 0) throws ESRCH
  let deadPid = 9999999;
  for (let p = 9999990; p < 9999999; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if (e.code === 'ESRCH') {
        deadPid = p;
        break;
      }
    }
  }

  writeFileSync(
    ownerPath,
    JSON.stringify({ pid: deadPid, token: 'dead-token', createdAt: Date.now() - 50000 })
  );

  const release = acquireDirLock(lockDir, { staleMs: 1000 });
  try {
    assert.equal(existsSync(lockDir), true);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, 'dead-token');
  } finally {
    release();
  }
});

test('acquireDirLock: throws EEXIST if existing lock owner.json is corrupted', (t) => {
  const dir = tmp(t, 'lock-corrupt-');
  const lockDir = join(dir, 'test.lock');

  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), 'NOT_JSON');

  try {
    assert.throws(
      () => acquireDirLock(lockDir, { staleMs: 1000 }),
      (err) => err.code === 'EEXIST'
    );
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

// ── redactSecrets ────────────────────────────────────────────────────────────

test('redactSecrets: redacts OpenAI API key shapes (sk-...)', () => {
  const input = 'sk-12345678901234567890 and sk-proj-12345678901234567890';
  assert.equal(redactSecrets(input), '[REDACTED] and [REDACTED]');
});

test('redactSecrets: redacts GitHub tokens (ghp, gho, ghu, ghs, ghr)', () => {
  const input =
    'ghp_12345678901234567890 gho_12345678901234567890 ghu_12345678901234567890 ghs_12345678901234567890 ghr_12345678901234567890';
  assert.equal(
    redactSecrets(input),
    '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]'
  );
});

test('redactSecrets: redacts AWS access key ID (AKIA...)', () => {
  assert.equal(redactSecrets('key is AKIA1234567890ABCDEF here'), 'key is [REDACTED] here');
});

test('redactSecrets: redacts Google API key (AIza...)', () => {
  const key = 'AIzaSyD-1234567890abcdefghijklmnopqrstu';
  assert.equal(key.length, 39); // 'AIza' + 35 chars
  assert.equal(redactSecrets(`key: ${key}`), 'key: [REDACTED]');
});

test('redactSecrets: redacts Bearer tokens', () => {
  assert.equal(
    redactSecrets('Bearer abcdefghijklmnopqrst12345'),
    '[REDACTED]'
  );
  assert.equal(
    redactSecrets('Bearer   my-token-value_1234567890'),
    '[REDACTED]'
  );
});

test('redactSecrets: does not redact benign identifiers', () => {
  assert.equal(redactSecrets('sk-short'), 'sk-short');
  assert.equal(redactSecrets('ghx_12345678901234567890'), 'ghx_12345678901234567890');
  assert.equal(redactSecrets('AKIA123'), 'AKIA123');
  assert.equal(redactSecrets('akia1234567890abcdef'), 'akia1234567890abcdef');
});

test('redactSecrets: recursively redacts arrays and nested objects', () => {
  const data = {
    plain: 'safe string',
    count: 42,
    flag: true,
    empty: null,
    secretKey: 'sk-12345678901234567890',
    list: [
      'safe',
      'ghp_12345678901234567890',
      { nestedSecret: 'Bearer secret_token_value_12345' },
    ],
  };

  const redacted = redactSecrets(data);
  assert.deepEqual(redacted, {
    plain: 'safe string',
    count: 42,
    flag: true,
    empty: null,
    secretKey: '[REDACTED]',
    list: [
      'safe',
      '[REDACTED]',
      { nestedSecret: '[REDACTED]' },
    ],
  });
});

test('redactSecrets: passes through non-string primitives', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(123), 123);
  assert.equal(redactSecrets(true), true);
  assert.equal(redactSecrets(false), false);
});

// ── readVerdictSource ────────────────────────────────────────────────────────

async function withForbiddenStdin(fn) {
  const origIterator = process.stdin[Symbol.asyncIterator];
  process.stdin[Symbol.asyncIterator] = async function* () {
    throw new Error('stdin must not be read when source !== "-"');
  };
  try {
    return await fn();
  } finally {
    process.stdin[Symbol.asyncIterator] = origIterator;
  }
}

test('readVerdictSource: reads and trims text from existing file', async (t) => {
  const dir = tmp(t, 'rvs-file-');
  const file = join(dir, 'verdict.txt');
  writeFileSync(file, '  \n  clear pass \n\t');

  const result = await withForbiddenStdin(() => readVerdictSource(file));
  assert.equal(result, 'clear pass');
});

test('readVerdictSource: calls opError when file does not exist', async (t) => {
  const dir = tmp(t, 'rvs-missing-');
  const file = join(dir, 'nonexistent.txt');

  const { called, exitCode, errorMessage } = await withForbiddenStdin(() =>
    withOpErrorTrapAsync(async () => {
      await readVerdictSource(file);
    })
  );
  assert.equal(called, true);
  assert.equal(exitCode, 1);
  assert.match(errorMessage, /cannot read verdict file/);
});

test('readVerdictSource: calls opError when file is empty or only whitespace', async (t) => {
  const dir = tmp(t, 'rvs-empty-');
  const file = join(dir, 'empty.txt');
  writeFileSync(file, '   \n \t ');

  const { called, exitCode, errorMessage } = await withForbiddenStdin(() =>
    withOpErrorTrapAsync(async () => {
      await readVerdictSource(file);
    })
  );
  assert.equal(called, true);
  assert.equal(exitCode, 1);
  assert.match(errorMessage, /file was empty/);
});

test('readVerdictSource: reads and trims text from stdin (source === "-")', async () => {
  const origIterator = process.stdin[Symbol.asyncIterator];
  process.stdin[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('  \n  audited approved  \n');
  };

  try {
    const result = await readVerdictSource('-');
    assert.equal(result, 'audited approved');
  } finally {
    process.stdin[Symbol.asyncIterator] = origIterator;
  }
});

test('readVerdictSource: calls opError when stdin is empty (source === "-")', async () => {
  const origIterator = process.stdin[Symbol.asyncIterator];
  process.stdin[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('   \n\t  ');
  };

  try {
    const { called, exitCode, errorMessage } = await withOpErrorTrapAsync(async () => {
      await readVerdictSource('-');
    });
    assert.equal(called, true);
    assert.equal(exitCode, 1);
    assert.match(errorMessage, /--record-verdict - : stdin was empty/);
  } finally {
    process.stdin[Symbol.asyncIterator] = origIterator;
  }
});

// ── recordPromptOnlyVerdict ──────────────────────────────────────────────────

test('recordPromptOnlyVerdict: delegates to recordFn if provided', () => {
  let recordedArg = null;
  const result = recordPromptOnlyVerdict({
    gate: 'coldstart',
    ticket: 'T1',
    verdict: 'pass',
    extra: { confidence: 0.95 },
    dir: '/custom/dir',
    recordFn: (arg) => {
      recordedArg = arg;
      return { ok: true, custom: 123 };
    },
  });

  assert.deepEqual(result, { ok: true, custom: 123 });
  assert.equal(recordedArg.gate, 'coldstart');
  assert.equal(recordedArg.ticket, 'T1');
  assert.equal(recordedArg.dir, '/custom/dir');
  assert.deepEqual(JSON.parse(recordedArg.rawData), {
    promptOnly: true,
    usageStatus: 'unreported',
    verdict: 'pass',
    confidence: 0.95,
  });
});

test('recordPromptOnlyVerdict: appends to manifest ledger when recordFn is not provided', (t) => {
  const dir = tmp(t, 'rpov-manifest-');

  const entry = recordPromptOnlyVerdict({
    gate: 'premortem',
    ticket: 'T2',
    verdict: 'clear',
    extra: { reason: 'clean audit' },
    dir,
  });

  assert.equal(entry.gate, 'premortem');
  assert.equal(entry.ticket, 'T2');
  assert.deepEqual(entry.data, {
    promptOnly: true,
    usageStatus: 'unreported',
    verdict: 'clear',
    reason: 'clean audit',
  });

  const { entries } = readEntries('manifest', dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].gate, 'premortem');
  assert.equal(entries[0].ticket, 'T2');
  assert.equal(entries[0].data.promptOnly, true);
  assert.equal(entries[0].data.usageStatus, 'unreported');
  assert.equal(entries[0].data.verdict, 'clear');
  assert.equal(entries[0].data.reason, 'clean audit');
});

test('writeFileAtomic: explicit options.mode overrides existing file mode', (t) => {
  const dir = tmp(t, 'wfa-explicit-mode-');
  const file = join(dir, 'config.json');
  writeFileAtomic(file, '{}', { mode: 0o644 });
  assert.equal(statSync(file).mode & 0o777, 0o644);
  writeFileAtomic(file, '{"tight":true}', { mode: 0o600 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('acquireDirLock: recovers stale lock directory when owner.json is missing and mtime exceeds staleMs', (t) => {
  const dir = tmp(t, 'lock-missing-owner-');
  const lockDir = join(dir, 'test.lock');
  mkdirSync(lockDir);
  const release = acquireDirLock(lockDir, { staleMs: -1000 });
  try {
    assert.equal(existsSync(join(lockDir, 'owner.json')), true);
  } finally {
    release();
  }
});

test('redactSecrets: redacts Error message/stack and preserves Date/RegExp/Buffer instances', () => {
  const err = new Error('leaked sk-12345678901234567890 in error');
  const redactedErr = redactSecrets(err);
  assert.equal(redactedErr instanceof Error, true);
  assert.equal(redactedErr.message, 'leaked [REDACTED] in error');

  const d = new Date(0);
  const re = /abc/;
  const buf = Buffer.from('hello');
  assert.equal(redactSecrets(d), d);
  assert.equal(redactSecrets(re), re);
  assert.equal(redactSecrets(buf), buf);
});

test('recordPromptOnlyVerdict: canonical fields cannot be overwritten by extra', () => {
  let recorded = null;
  recordPromptOnlyVerdict({
    gate: 'coldstart',
    ticket: 'T1',
    verdict: 'real-verdict',
    extra: { promptOnly: false, usageStatus: 'reported', verdict: 'spoofed', custom: 1 },
    recordFn: (arg) => {
      recorded = JSON.parse(arg.rawData);
    },
  });
  assert.equal(recorded.promptOnly, true);
  assert.equal(recorded.usageStatus, 'unreported');
  assert.equal(recorded.verdict, 'real-verdict');
  assert.equal(recorded.custom, 1);
});

