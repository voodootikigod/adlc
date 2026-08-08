import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
// Reclaim is host-scoped: a PID only means anything on the host that minted it.
const LOCAL_HOST = hostname();

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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** A pid that is not running on this host, so reclaim can be asserted. */
function pickDeadPid() {
  for (const candidate of [2147483646, process.pid + 1000000, 2147483000]) {
    if (!isAlive(candidate)) return candidate;
  }
  assert.fail('no dead pid candidate available on this host');
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
      host: LOCAL_HOST,
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
      host: LOCAL_HOST,
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
    const deadPid = pickDeadPid();

    const lock = {
      pid: deadPid,
      started_at: '2026-01-01T00:00:00.000Z',
      host: LOCAL_HOST,
      nonce: 'nonce-ok',
    };
    seedLock(cwd, 'lock-dead', lock);
    assert.equal(isAlive(deadPid), false, `test requires dead pid ${deadPid}`);

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

test('unlock refuses a lock minted on another host even with a locally dead PID (exit 2)', () => {
  withTempRepo((cwd) => {
    const lock = {
      pid: pickDeadPid(),
      started_at: '2026-01-01T00:00:00.000Z',
      host: `${LOCAL_HOST}-elsewhere`,
      nonce: 'nonce-foreign',
    };
    seedLock(cwd, 'lock-foreign', lock);

    // Every operator-supplied field matches the lock: only the host check stands
    // between a foreign session and a reclaimed lock.
    const r = run(
      [
        'unlock',
        '--session',
        'lock-foreign',
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
    assert.match(r.stderr, /not this host/);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'lock-foreign.lock')), true);
  });
});
