// adlc-hook-run wrapper — on a timeout or kill signal, enforcing modes must DENY
// (exit 2, the only code Claude Code treats as "block"); advisory modes exit 0.
// Seam 6 remediation (delta.md / PR #486): the wrapper exited 1 for enforcing modes,
// and exit 1 does NOT block in CC — a timed-out rails/buildgate/handoff hook failed OPEN.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, timeoutExitCode, ENFORCING_MODES } from '../adlc-hook-run.mjs';

const noop = () => {};
const spawnReturning = (result) => () => result;

describe('adlc-hook-run timeoutExitCode', () => {
  it('enforcing modes deny with exit 2 (CC blocks only on exit 2)', () => {
    for (const m of ['rails', 'buildgate', 'handoff']) assert.equal(timeoutExitCode(m), 2, m);
  });
  it('advisory and unknown modes exit 0 (never block the user)', () => {
    for (const m of ['review', 'flail', 'manifest', 'preflight', 'context', '', 'bogus']) {
      assert.equal(timeoutExitCode(m), 0, m);
    }
  });
  it('never exits 1 for an enforcing mode (exit 1 does not block in CC — the original bug)', () => {
    for (const m of ENFORCING_MODES) assert.notEqual(timeoutExitCode(m), 1);
  });
  it('the enforcing set is exactly the fail-closed hooks', () => {
    assert.deepEqual([...ENFORCING_MODES].sort(), ['buildgate', 'handoff', 'rails']);
  });
});

describe('adlc-hook-run dispatch — every exit path (injected spawn, no real timeout)', () => {
  const base = { exists: () => true, stderr: noop };

  it('TIMEOUT on an enforcing mode → deny (2)', () => {
    assert.equal(dispatch(['n', 's', 'rails'], { ...base, spawn: spawnReturning({ error: { code: 'ETIMEDOUT' } }) }), 2);
  });
  it('TIMEOUT on an advisory mode → allow (0)', () => {
    assert.equal(dispatch(['n', 's', 'review'], { ...base, spawn: spawnReturning({ error: { code: 'ETIMEDOUT' } }) }), 0);
  });
  it('KILL signal on an enforcing mode → deny (2)', () => {
    assert.equal(dispatch(['n', 's', 'buildgate'], { ...base, spawn: spawnReturning({ signal: 'SIGKILL' }) }), 2);
  });
  it('KILL signal on an advisory mode → allow (0)', () => {
    assert.equal(dispatch(['n', 's', 'flail'], { ...base, spawn: spawnReturning({ signal: 'SIGKILL' }) }), 0);
  });
  it('non-timeout spawn error → operational error (1)', () => {
    assert.equal(dispatch(['n', 's', 'rails'], { ...base, spawn: spawnReturning({ error: { code: 'ENOENT', message: 'x' } }) }), 1);
  });
  it('missing hook script → operational error (1)', () => {
    assert.equal(dispatch(['n', 's', 'rails'], { exists: () => false, stderr: noop, spawn: spawnReturning({}) }), 1);
  });
  it('clean child exit relays the child status (a child deny of 2 passes through)', () => {
    assert.equal(dispatch(['n', 's', 'rails'], { ...base, spawn: spawnReturning({ status: 2 }) }), 2);
    assert.equal(dispatch(['n', 's', 'rails'], { ...base, spawn: spawnReturning({ status: 0 }) }), 0);
  });
  it('undefined child status defaults to 0 (allow), not a block', () => {
    assert.equal(dispatch(['n', 's', 'rails'], { ...base, spawn: spawnReturning({}) }), 0);
  });

  it('forwards the mode and extra args to the child, dropping node/script argv', () => {
    let got;
    const spy = (_cmd, args) => {
      got = args;
      return { status: 0 };
    };
    dispatch(['node', '/x/adlc-hook-run.mjs', 'rails', '--flag'], { ...base, spawn: spy });
    assert.equal(got[1], 'rails'); // got[0] is the hook script path
    assert.equal(got[2], '--flag');
  });

  it('names the actual mode in the timeout message (not "(none)")', () => {
    let msg = '';
    dispatch(['n', 's', 'rails'], {
      exists: () => true,
      stderr: (s) => {
        msg += s;
      },
      spawn: spawnReturning({ error: { code: 'ETIMEDOUT' } }),
    });
    assert.match(msg, /rails/);
  });
});
