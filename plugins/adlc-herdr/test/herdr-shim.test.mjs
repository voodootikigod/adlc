// RAIL (t-herdr-1): frozen contract for lib/herdr.mjs — the single shim every
// herdr CLI call goes through.
//
// Invariants (plan §6.2, §6.5): fixed argv arrays only, never shell
// interpolation; the binary comes from HERDR_BIN_PATH or the literal "herdr",
// never from repo config or observed state; unknown/malformed output fails
// soft ({ok:false}), never throws into a caller; malformed requests fail
// closed before anything spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrArgv, runHerdr, runHerdrJson, paneInfoArgs, makeCachedReader } from '../lib/herdr.mjs';

test('herdrArgv builds [bin, ...args] from HERDR_BIN_PATH, defaulting to "herdr"', () => {
  const argv = herdrArgv(['pane', 'list'], { env: { HERDR_BIN_PATH: '/opt/herdr' } });
  assert.deepEqual(argv, ['/opt/herdr', 'pane', 'list']);
  assert.deepEqual(herdrArgv(['status'], { env: {} }), ['herdr', 'status']);
});

test('herdrArgv fails closed on non-array, empty, or non-string args', () => {
  assert.throws(() => herdrArgv('pane list', { env: {} }));
  assert.throws(() => herdrArgv([], { env: {} }));
  assert.throws(() => herdrArgv(['pane', 42], { env: {} }));
  assert.throws(() => herdrArgv([null], { env: {} }));
});

test('herdrArgv respects any non-empty HERDR_BIN_PATH, even one character', () => {
  assert.deepEqual(herdrArgv(['x'], { env: { HERDR_BIN_PATH: 'h' } }), ['h', 'x']);
});

test('runHerdr invokes the executor with an argv array and shell disabled', async () => {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const res = await runHerdr(['agent', 'list'], { env: { HERDR_BIN_PATH: '/opt/herdr' }, exec });
  assert.equal(res.ok, true);
  assert.equal(res.stdout, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/opt/herdr');
  assert.deepEqual(calls[0].args, ['agent', 'list']);
  assert.ok(Array.isArray(calls[0].args), 'args must be an argv array');
  assert.ok(!calls[0].opts?.shell, 'shell must never be enabled');
});

test('runHerdr applies a finite timeout to the executor', async () => {
  let seen;
  const exec = async (_file, _args, opts) => { seen = opts; return { code: 0, stdout: '', stderr: '' }; };
  await runHerdr(['status'], { env: {}, exec });
  assert.ok(Number.isFinite(seen.timeout) && seen.timeout > 0, 'a finite positive timeout is required');
});

test('runHerdr fails soft on non-zero exit and on executor throw', async () => {
  const failExec = async () => ({ code: 2, stdout: '', stderr: 'boom' });
  const res1 = await runHerdr(['x'], { env: {}, exec: failExec });
  assert.equal(res1.ok, false);

  const throwExec = async () => { throw new Error('spawn ENOENT'); };
  const res2 = await runHerdr(['x'], { env: {}, exec: throwExec });
  assert.equal(res2.ok, false);
});

test('runHerdrJson parses JSON stdout and fails soft on malformed output', async () => {
  const goodExec = async () => ({ code: 0, stdout: '{"a":1}', stderr: '' });
  const good = await runHerdrJson(['api', 'snapshot'], { env: {}, exec: goodExec });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { a: 1 });

  const badExec = async () => ({ code: 0, stdout: 'not json {', stderr: '' });
  const bad = await runHerdrJson(['api', 'snapshot'], { env: {}, exec: badExec });
  assert.equal(bad.ok, false);
  // Positive failure contract: no value leaks, and the error is the specific
  // malformed-JSON message (a stale/attacker value on the failure path fails).
  assert.equal(bad.value, undefined);
  assert.equal(bad.error, 'malformed JSON from herdr');
});

test('shim never throws into callers for runtime failures (fail soft end-to-end)', async () => {
  const throwExec = async () => { throw new Error('killed'); };
  await assert.doesNotReject(runHerdrJson(['api', 'snapshot'], { env: {}, exec: throwExec }));
});

test('runHerdr preserves a string errno (ENOENT) so a missing binary is distinguishable', async () => {
  // Real spawn of a nonexistent binary via the default executor.
  const res = await runHerdr(['status'], { env: { HERDR_BIN_PATH: '/nonexistent/adlc-herdr-binary' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ENOENT', `expected ENOENT, got ${JSON.stringify(res)}`);
});

test('paneInfoArgs builds the exact pane-get argv and fails closed without an id', () => {
  assert.deepEqual(paneInfoArgs('w4:p2'), ['pane', 'get', 'w4:p2']);
  assert.throws(() => paneInfoArgs(''));
  assert.throws(() => paneInfoArgs(undefined));
});

test('makeCachedReader serves fresh within TTL, re-reads after expiry and invalidate', async () => {
  let clock = 1000;
  let reads = 0;
  const reader = makeCachedReader(async (key) => { reads += 1; return `${key}#${reads}`; }, 100, () => clock);
  assert.equal(await reader('a'), 'a#1');
  clock += 50;
  assert.equal(await reader('a'), 'a#1'); // within TTL — cached
  clock += 100;
  assert.equal(await reader('a'), 'a#2'); // expired — re-read
  reader.invalidate('a');
  assert.equal(await reader('a'), 'a#3'); // invalidated — re-read
});
