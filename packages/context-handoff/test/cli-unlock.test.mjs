import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');

function run(args, { cwd, env = {}, expectOk = true } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const result = {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
    if (expectOk) {
      assert.fail(`handoff ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-unlock-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedLock(cwd, session, lock) {
  const dir = join(cwd, '.adlc', 'handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.lock`), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

test('unlock refuses live PID (exit 2)', () => {
  withTempRepo((cwd) => {
    const lock = {
      pid: process.pid,
      started_at: '2026-01-01T00:00:00.000Z',
      host: 'host-a',
      nonce: 'nonce-live',
    };
    seedLock(cwd, 'lock-live', lock);
    const r = run(
      [
        'unlock',
        '--session',
        'lock-live',
        '--pid',
        String(lock.pid),
        '--started-at',
        lock.started_at,
        '--host',
        lock.host,
        '--nonce',
        lock.nonce,
        '--write',
        '--json',
      ],
      { cwd, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /alive|pid/i);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'lock-live.lock')), true);
  });
});

test('unlock refuses nonce mismatch (exit 2)', () => {
  withTempRepo((cwd) => {
    const lock = {
      pid: 999999,
      started_at: '2026-01-01T00:00:00.000Z',
      host: 'host-a',
      nonce: 'nonce-correct',
    };
    seedLock(cwd, 'lock-mismatch', lock);
    const r = run(
      [
        'unlock',
        '--session',
        'lock-mismatch',
        '--pid',
        String(lock.pid),
        '--started-at',
        lock.started_at,
        '--host',
        lock.host,
        '--nonce',
        'nonce-WRONG',
        '--write',
        '--json',
      ],
      { cwd, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /mismatch/i);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'lock-mismatch.lock')), true);
  });
});

test('unlock dead PID + full match reclaims lock', () => {
  withTempRepo((cwd) => {
    // Pick a PID that cannot be alive on this host.
    let deadPid = 2147483646;
    try {
      process.kill(deadPid, 0);
      deadPid = 1; // fall back — still may be alive on some systems; prefer high unused
      // Use a pid that is almost certainly dead: current pid + large offset unlikely to wrap to live.
      deadPid = process.pid + 1000000;
      try {
        process.kill(deadPid, 0);
        // If somehow alive, skip reclaim assertion path by using another candidate.
        deadPid = 2147483000;
      } catch {
        // dead — good
      }
    } catch {
      // dead — good
    }

    const lock = {
      pid: deadPid,
      started_at: '2026-01-01T00:00:00.000Z',
      host: 'host-b',
      nonce: 'nonce-ok',
    };
    seedLock(cwd, 'lock-dead', lock);

    // Confirm dead before asserting reclaim.
    let alive = false;
    try {
      process.kill(deadPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `test requires dead pid ${deadPid}`);

    const r = run(
      [
        'unlock',
        '--session',
        'lock-dead',
        '--pid',
        String(lock.pid),
        '--started-at',
        lock.started_at,
        '--host',
        lock.host,
        '--nonce',
        lock.nonce,
        '--write',
        '--json',
      ],
      { cwd },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, false);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'lock-dead.lock')), false);
  });
});
