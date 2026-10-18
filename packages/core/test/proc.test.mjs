// packages/core/test/proc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import {
  thisHost,
  pidAlive,
  procStartTimeOf,
  selfProcessIdentity,
  defaultLockProbes,
} from '../index.mjs';
import * as procModule from '../lib/proc.mjs';

// Guard against off-by-one mutant turning process.kill(pid, 0) into process.kill(pid, 1) (SIGHUP).
process.on('SIGHUP', () => {});

test('re-exports: @adlc/core exports all proc helpers', () => {
  assert.strictEqual(thisHost, procModule.thisHost);
  assert.strictEqual(pidAlive, procModule.pidAlive);
  assert.strictEqual(procStartTimeOf, procModule.procStartTimeOf);
  assert.strictEqual(selfProcessIdentity, procModule.selfProcessIdentity);
  assert.strictEqual(defaultLockProbes, procModule.defaultLockProbes);
});

test('thisHost: returns os.hostname()', () => {
  const h = thisHost();
  assert.strictEqual(typeof h, 'string');
  assert.ok(h.length > 0);
  assert.strictEqual(h, hostname());
});

test('pidAlive: returns false for non-number pids without calling process.kill', (t) => {
  const origKill = process.kill;
  t.after(() => {
    process.kill = origKill;
  });
  process.kill = () => {
    throw new Error('process.kill must not be called for non-number pid');
  };

  assert.strictEqual(pidAlive(null), false);
  assert.strictEqual(pidAlive(undefined), false);
  assert.strictEqual(pidAlive('1234'), false);
  assert.strictEqual(pidAlive({}), false);
  assert.strictEqual(pidAlive([]), false);
  assert.strictEqual(pidAlive(true), false);
});

test('pidAlive: probes with signal 0 and handles live, dead (ESRCH), and EPERM processes', (t) => {
  const origKill = process.kill;
  t.after(() => {
    process.kill = origKill;
  });

  const signals = [];
  process.kill = (pid, sig) => {
    signals.push([pid, sig]);
    if (sig !== 0) {
      const err = new Error(`expected signal 0, got ${sig}`);
      err.code = 'EINVAL';
      throw err;
    }
    return origKill.call(process, pid, sig);
  };

  assert.strictEqual(pidAlive(process.pid), true);
  assert.deepStrictEqual(signals, [[process.pid, 0]]);

  // Simulated ESRCH (dead process)
  process.kill = () => {
    const err = new Error('No such process');
    err.code = 'ESRCH';
    throw err;
  };
  assert.strictEqual(pidAlive(999999), false);

  // Simulated EPERM (process exists under another user)
  process.kill = (pid, sig) => {
    if (sig !== 0) {
      const err = new Error('Wrong signal');
      err.code = 'EINVAL';
      throw err;
    }
    const err = new Error('Operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  assert.strictEqual(pidAlive(1), true);
});

test('procStartTimeOf: returns null for non-number pid', () => {
  let called = false;
  const spy = () => {
    called = true;
    return '';
  };
  assert.strictEqual(procStartTimeOf(null, { readFile: spy, execFile: spy }), null);
  assert.strictEqual(procStartTimeOf(undefined, { readFile: spy, execFile: spy }), null);
  assert.strictEqual(procStartTimeOf('123', { readFile: spy, execFile: spy }), null);
  assert.strictEqual(procStartTimeOf({}, { readFile: spy, execFile: spy }), null);
  assert.strictEqual(called, false);
});

test('procStartTimeOf: parses field 22 from Linux /proc/<pid>/stat with spaces and parens in comm', () => {
  // Fields after `(comm)`: index 0 is field 3 (state), ..., index 19 is field 22 (starttime).
  const afterFields = Array.from({ length: 25 }, (_, i) => (i === 19 ? '987654321' : `f${i + 3}`));
  afterFields[0] = 'S';
  const statContent = `4242 (my (weird) proc name) ${afterFields.join(' ')}\n`;

  const readCalls = [];
  const result = procStartTimeOf(4242, {
    platform: 'linux',
    readFile: (path, enc) => {
      readCalls.push([path, enc]);
      return statContent;
    },
    execFile: () => {
      throw new Error('execFile must not be called on linux');
    },
  });

  assert.strictEqual(result, '987654321');
  assert.deepStrictEqual(readCalls, [['/proc/4242/stat', 'utf8']]);
});

test('procStartTimeOf: slices at exact offset lastIndexOf(")") + 2 on Linux', () => {
  // When field 3 is empty (two spaces after ')'), slicing at +2 vs +3 shifts all field indices by 1.
  const afterFields = Array.from({ length: 22 }, (_, i) => (i === 19 ? 'exact-offset-token' : `v${i}`));
  afterFields[0] = '';
  const statContent = `101 (cmd) ${afterFields.join(' ')}`;

  const result = procStartTimeOf(101, {
    platform: 'linux',
    readFile: () => statContent,
  });
  assert.strictEqual(result, 'exact-offset-token');
});

test('procStartTimeOf: returns null on Linux when field 22 is empty or missing, or readFile throws', () => {
  // Empty string at index 19 -> returns null (not '')
  const emptyField22 = Array.from({ length: 22 }, (_, i) => (i === 19 ? '' : '1'));
  assert.strictEqual(
    procStartTimeOf(10, {
      platform: 'linux',
      readFile: () => `10 (app) ${emptyField22.join(' ')}`,
    }),
    null
  );

  // Truncated stat content (fewer than 20 fields after ')')
  assert.strictEqual(
    procStartTimeOf(10, {
      platform: 'linux',
      readFile: () => '10 (app) S 1 2 3',
    }),
    null
  );

  // readFile throws (e.g. ENOENT when process exited)
  assert.strictEqual(
    procStartTimeOf(10, {
      platform: 'linux',
      readFile: () => {
        throw new Error('ENOENT');
      },
    }),
    null
  );
});

test('procStartTimeOf: falls back to ps -o lstart= on non-Linux platforms', () => {
  const execCalls = [];
  const result = procStartTimeOf(555, {
    platform: 'darwin',
    readFile: () => {
      throw new Error('readFile must not be called on darwin');
    },
    execFile: (cmd, args, opts) => {
      execCalls.push([cmd, args, opts]);
      return '  Mon Oct 18 10:00:00 2026  \n';
    },
  });

  assert.strictEqual(result, 'Mon Oct 18 10:00:00 2026');
  assert.deepStrictEqual(execCalls, [['ps', ['-o', 'lstart=', '-p', '555'], { encoding: 'utf8' }]]);

  // Whitespace-only output returns null
  assert.strictEqual(
    procStartTimeOf(555, {
      platform: 'darwin',
      execFile: () => '   \n\t  ',
    }),
    null
  );

  // execFile throwing returns null
  assert.strictEqual(
    procStartTimeOf(555, {
      platform: 'darwin',
      execFile: () => {
        throw new Error('ps failed');
      },
    }),
    null
  );
});

test('procStartTimeOf: works with default options for current process.pid', () => {
  const start = procStartTimeOf(process.pid);
  assert.strictEqual(typeof start, 'string');
  assert.ok(start.length > 0);
});

test('selfProcessIdentity: returns pid, host, procStartTime, and pidStartTime for current process', () => {
  const id = selfProcessIdentity();
  const expectedStart = procStartTimeOf(process.pid);

  assert.strictEqual(id.pid, process.pid);
  assert.strictEqual(id.host, hostname());
  assert.strictEqual(typeof id.procStartTime, 'string');
  assert.ok(id.procStartTime.length > 0);
  assert.strictEqual(id.procStartTime, expectedStart);
  assert.strictEqual(id.pidStartTime, expectedStart);
});

test('defaultLockProbes: returns host, pidAlive, procStartTimeOf, and pidStartTimeOf alias', () => {
  const probes = defaultLockProbes();
  assert.strictEqual(probes.host, hostname());
  assert.strictEqual(probes.pidAlive, pidAlive);
  assert.strictEqual(probes.procStartTimeOf, procStartTimeOf);
  assert.strictEqual(probes.pidStartTimeOf, procStartTimeOf);
});
