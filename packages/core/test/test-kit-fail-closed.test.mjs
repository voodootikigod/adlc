// The test-kit fixture factories fail closed: a directory is minted only when
// its removal is registered on a context that can run it. A missing, null,
// string, options-shaped or describe-level (SuiteContext) first argument is a
// programming error that throws before anything touches the filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmp, gitRepo, withScopedContext, createScope, FIXTURE_RM_OPTIONS } from '../lib/test-kit.mjs';

const MARK = `adlc-failclosed-${process.pid}-`;
const minted = () => readdirSync(tmpdir()).filter((name) => name.startsWith(MARK));

const CONTEXTLESS = [
  ['no argument', []],
  ['null', [null, MARK]],
  ['undefined', [undefined, MARK]],
  ['a prefix string', [MARK]],
  ['an options object', [{ prefix: MARK }]],
  ['a SuiteContext-shaped object (no .after)', [{ name: 'suite', signal: null }, MARK]],
  ['an object whose .after is not a function', [{ after: true }, MARK]],
];

for (const [label, args] of CONTEXTLESS) {
  test(`tmp() throws on ${label} and creates nothing`, () => {
    const before = minted().length;
    assert.throws(() => tmp(...args), { name: 'TypeError', message: /tmp\(\) requires a test context/ });
    assert.equal(minted().length, before, 'no directory may be minted without a registered removal');
  });

  test(`gitRepo() throws on ${label} and creates nothing`, () => {
    const before = minted().length;
    const [first, second] = args;
    const call = args.length === 0 ? () => gitRepo() : () => gitRepo(first, typeof second === 'string' ? { prefix: second } : second);
    assert.throws(call, { name: 'TypeError', message: /gitRepo\(\) requires a test context/ });
    assert.equal(minted().length, before, 'no repository may be minted without a registered removal');
  });
}

test('tmp() registers exactly one removal hook and that hook deletes a non-empty tree', () => {
  const hooks = [];
  const dir = tmp({ after: (fn) => hooks.push(fn) }, MARK);
  writeFileSync(join(dir, 'f.txt'), 'x');
  assert.equal(hooks.length, 1);
  assert.ok(existsSync(dir));
  hooks[0]();
  assert.equal(existsSync(dir), false);
});

test('fixture removal retries transient failures instead of failing on the first one', () => {
  assert.equal(FIXTURE_RM_OPTIONS.recursive, true);
  assert.equal(FIXTURE_RM_OPTIONS.force, true);
  assert.ok(FIXTURE_RM_OPTIONS.maxRetries >= 5, `maxRetries is ${FIXTURE_RM_OPTIONS.maxRetries}`);
  assert.ok(FIXTURE_RM_OPTIONS.retryDelay > 0, `retryDelay is ${FIXTURE_RM_OPTIONS.retryDelay}`);
  assert.ok(Object.isFrozen(FIXTURE_RM_OPTIONS));
});

test('gitRepo() disables automatic and detached gc so no maintenance child outlives the test', (t) => {
  const { git } = gitRepo(t, { prefix: MARK });
  assert.equal(git('config', '--get', 'gc.auto').trim(), '0');
  assert.equal(git('config', '--get', 'gc.autoDetach').trim(), 'false');
  assert.equal(git('config', '--get', 'commit.gpgsign').trim(), 'false');
});

test('gitRepo() still honours a string prefix and an options bag after the context', (t) => {
  const a = gitRepo(t, `${MARK}str-`);
  assert.ok(a.dir.includes(`${MARK}str-`));
  const b = gitRepo(t, { prefix: `${MARK}opt-`, branch: 'feat/x' });
  assert.ok(b.dir.includes(`${MARK}opt-`));
  assert.equal(b.git('symbolic-ref', '--short', 'HEAD').trim(), 'feat/x');
});

test('withScopedContext() hands fn a context whose hooks run after fn, last-registered first', async () => {
  const order = [];
  let dir;
  const value = await withScopedContext(async (ctx) => {
    ctx.after(() => order.push('first'));
    dir = tmp(ctx, MARK);
    ctx.after(() => order.push('last'));
    assert.ok(existsSync(dir), 'the fixture exists while fn runs');
    assert.deepEqual(order, [], 'no hook runs before fn settles');
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(order, ['last', 'first']);
  assert.equal(existsSync(dir), false, 'the scoped fixture is removed once fn settles');
});

test('withScopedContext() still cleans up when fn throws, and rethrows fn\'s error', async () => {
  let dir;
  await assert.rejects(
    withScopedContext((ctx) => { dir = tmp(ctx, MARK); throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(existsSync(dir), false);
});

test('withScopedContext() surfaces a failing cleanup hook instead of swallowing it', async () => {
  const ran = [];
  await assert.rejects(
    withScopedContext((ctx) => {
      ctx.after(() => ran.push('a'));
      ctx.after(() => { throw new Error('cleanup broke'); });
      return 'ok';
    }),
    /cleanup broke/,
  );
  assert.deepEqual(ran, ['a'], 'a failing hook does not stop the remaining hooks');
});

test('withScopedContext() reports fn\'s error, not a later cleanup error, when both fail', async () => {
  await assert.rejects(
    withScopedContext((ctx) => {
      ctx.after(() => { throw new Error('cleanup broke'); });
      throw new Error('primary');
    }),
    /primary/,
  );
});

test('withScopedContext() rejects a non-function', async () => {
  await assert.rejects(withScopedContext(null), TypeError);
});

test('createScope() is a context whose dispose() removes every fixture registered on it', async () => {
  const scope = createScope();
  const a = tmp(scope, MARK);
  const { dir: b } = gitRepo(scope, { prefix: MARK });
  assert.ok(existsSync(a) && existsSync(b));
  await scope.dispose();
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), false);
});

test('createScope() refuses registrations after dispose() so nothing is minted unowned', async () => {
  const scope = createScope();
  await scope.dispose();
  const before = minted().length;
  assert.throws(() => scope.after(() => {}), /disposed/);
  assert.throws(() => tmp(scope, MARK), /disposed/);
  assert.equal(minted().length, before);
});

test('createScope().dispose() runs every hook, last first, and rethrows the first failure', async () => {
  const scope = createScope();
  const ran = [];
  scope.after(() => ran.push('a'));
  scope.after(() => { throw new Error('hook failed'); });
  scope.after(() => ran.push('c'));
  await assert.rejects(scope.dispose(), /hook failed/);
  assert.deepEqual(ran, ['c', 'a']);
});
