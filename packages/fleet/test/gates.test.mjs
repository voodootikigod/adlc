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

test('runGates forwards a remaining-wall-clock bound to the sandbox as `timeout` and passes nothing when unbounded (fleet-ext item 5, codex r2)', async () => {
  const seen = [];
  const sandbox = { run: async (argv, opts) => { seen.push(opts); return 'ok'; } };
  await runGates(sandbox, { build: 'b', test: 't' }, { PATH: '/usr/bin' }, { timeoutMs: 1234 });
  assert.deepEqual(seen.map((o) => o.timeout), [1234, 1234], 'both gate commands carry the bound');
  assert.deepEqual(seen[0].env, { PATH: '/usr/bin' });
  seen.length = 0;
  await runGates(sandbox, { build: 'b' }, {});
  assert.ok(!('timeout' in seen[0]), 'no bound → no timeout key at all');
});

test('a gate command ended by its timeout is a FAILURE carrying timedOut (never an empty success) (codex r5)', async () => {
  const sandbox = { run: async () => { const e = new Error('command timed out after 5 ms'); e.timedOut = true; e.stdout = 'partial'; throw e; } };
  const r = await runGates(sandbox, { build: 'b' }, {}, { timeoutMs: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].timedOut, true);
  assert.match(r.results[0].output, /timed out/);
});

test('runGates re-reads the remaining budget before EVERY command: the test command gets what the build left, never the stale figure (codex r10)', async () => {
  let left = 10_000; const seen = [];
  const sandbox = { run: async (argv, opts) => { seen.push(opts.timeout); left -= 6_000; return 'ok'; } };
  await runGates(sandbox, { build: 'b', test: 't' }, {}, { remaining: () => Math.max(1, left) });
  assert.deepEqual(seen, [10_000, 4_000]);
});
