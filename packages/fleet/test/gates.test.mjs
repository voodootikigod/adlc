import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeViolations, checkFlail, runGates } from '../lib/gates.mjs';
import { Sandbox, SANDBOX_MODES } from '../lib/sandbox.mjs';

const T = (scope) => ({ id: 'T1', scope });

test('scopeViolations flags paths outside the ticket scope (§8.3c)', async () => {
  const t = T(['packages/fleet/**']);
  assert.deepEqual(scopeViolations(['packages/fleet/lib/x.mjs'], t), []);
  assert.deepEqual(scopeViolations(['packages/fleet/lib/x.mjs', 'packages/core/index.mjs'], t), ['packages/core/index.mjs']);
});

test('scopeViolations fails closed when no scope is declared', async () => {
  assert.deepEqual(scopeViolations(['any/file.js'], T([])), ['any/file.js']);
});

test('runGates runs build then test through the sandbox and stops at first failure', async () => {
  const ran = [];
  const sandbox = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' }, worktree: '/wt', syntheticHome: '/wt/.home',
    exec: (argv) => {
      const cmd = argv[argv.length - 1];
      ran.push(cmd);
      if (cmd.includes('fail')) { const e = new Error('boom'); e.stderr = 'test failed'; throw e; }
      return 'ok';
    },
  });
  const good = await runGates(sandbox, { build: 'npm run build', test: 'npm test' }, { PATH: '/usr/bin' });
  assert.equal(good.ok, true);
  assert.deepEqual(ran, ['npm run build', 'npm test']);

  ran.length = 0;
  const bad = await runGates(sandbox, { build: 'npm run build fail', test: 'npm test' }, {});
  assert.equal(bad.ok, false);
  assert.deepEqual(ran, ['npm run build fail'], 'must stop at the first failing gate');
});

test('checkFlail returns the detector verdict', async () => {
  // The detector's real document shape — see flail-contract.test.mjs, which
  // pins this against the actual binary rather than a mock.
  const doc = JSON.stringify({ verdict: 'flail', signals: [{ type: 'repeated-error' }], bytes: 20 });
  const r = checkFlail('/log', ['src/**'], {
    exec: () => { const e = new Error('Command failed'); e.status = 2; e.stdout = doc; throw e; },
  });
  assert.equal(r.flail, true);
  assert.deepEqual(r.signals, [{ type: 'repeated-error' }]);
});

test('checkFlail FAILS OPEN on any error (§12 backstop)', async () => {
  const r = checkFlail('/log', [], { exec: () => { throw new Error('adlc not found'); } });
  assert.equal(r.flail, false);
  assert.equal(r.failedOpen, true);
});
