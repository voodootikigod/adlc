import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { normalizeChecks, EXPECTED_MATRIX_COUNTS, watchCi } from '../lib/ci.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { lockfileCacheKey, cloneCachedNodeModules } from '../lib/deps.mjs';

const row = (name, bucket, state, workflow = 'CI') => ({ bucket, name, state, workflow });
const allPlatformLegs = () => {
  const legs = [];
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    for (const node of ['18', '20', '22']) {
      legs.push(row(`ticket-store-platform (${os}, ${node})`, 'pass', 'SUCCESS', 'Ticket store platform'));
    }
  }
  return legs;
};
const fullGreen = () => [
  row('test (18)', 'pass', 'SUCCESS'),
  row('test (20)', 'pass', 'SUCCESS'),
  row('test (22)', 'pass', 'SUCCESS'),
  row('rails-guard', 'pass', 'SUCCESS'),
  row('mutation-gate', 'pass', 'SUCCESS'),
  row('gate', 'pass', 'SUCCESS', 'cross-model-gate'),
  ...allPlatformLegs(),
];

test('R5: skipped is red across ALL blocking prefixes (not only test (*)) and respects ci.skippedIsPass seam', async () => {
  assert.equal(normalizeChecks(fullGreen()).verdict, 'pass');

  for (const name of ['rails-guard', 'mutation-gate', 'test (20)']) {
    const skipped = fullGreen().map((r) => (r.name === name ? { ...r, bucket: 'skipping', state: 'SKIPPED' } : r));
    const res = normalizeChecks(skipped);
    assert.equal(res.verdict, 'red', `skipped ${name} must be red`);
    assert.deepEqual(res.red, [name]);

    await withMutation('ci.skippedIsPass', () => {
      const seamRes = normalizeChecks(skipped);
      assert.equal(seamRes.verdict, 'pass', `ci.skippedIsPass seam allows skipped ${name}`);
    });
  }
});

test('R5: matrix prefixes require expected leg count before passing', () => {
  assert.equal(EXPECTED_MATRIX_COUNTS['ticket-store-platform ('], 9);
  // Only 1 of 9 legs present -> wait, then red on clockExpired
  const partial = fullGreen().filter((r) => !r.name.startsWith('ticket-store-platform ('));
  partial.push(row('ticket-store-platform (ubuntu-latest, 18)', 'pass', 'SUCCESS', 'Ticket store platform'));

  const waitRes = normalizeChecks(partial);
  assert.equal(waitRes.verdict, 'wait');
  assert.deepEqual(waitRes.missing, ['ticket-store-platform ( (1/9)']);

  const expiredRes = normalizeChecks(partial, { clockExpired: true });
  assert.equal(expiredRes.verdict, 'red');
  assert.deepEqual(expiredRes.red, ['missing: ticket-store-platform ( (1/9)']);
});

test('R4: watchCi invokes ctx.lock.heartbeat() on every poll iteration', async () => {
  let beats = 0;
  let polls = 0;
  const record = { issue: 9, prNumber: 99, state: 'pr-open', ciRoundsUsed: 0 };
  const ctx = {
    now: () => 1000 + polls * 1000,
    config: { autopilot: { ciWatchMinutes: 30 } },
    lock: { heartbeat: () => { beats++; return true; } },
    records: {
      load: () => record,
      update: (_n, patch) => Object.assign(record, patch),
    },
    gh: {
      json: async () => ({ headRefOid: 'a'.repeat(40) }),
      run: async () => {
        polls++;
        const rows = polls === 1
          ? fullGreen().map((r) => (r.name === 'rails-guard' ? { ...r, bucket: 'pending', state: 'PENDING' } : r))
          : fullGreen();
        return { stdout: JSON.stringify(rows), status: 0, truncated: false };
      },
    },
  };
  const res = await watchCi({
    ctx,
    record,
    attestedHead: 'a'.repeat(40),
    poll: 1,
    sleep: async () => {},
    runFixRound: async () => ({ ok: true, attestedHead: 'a'.repeat(40) }),
  });
  assert.equal(res.outcome, 'done');
  assert.equal(beats, 2, 'heartbeat called once per poll iteration');
});

test('P4: lockfileCacheKey hashes package-lock.json and cloneCachedNodeModules clones cached trees', (t) => {
  const root = tmp(t, 'ap-deps-cache-');
  const dir = join(root, 'work');
  const src = join(root, 'cache-nm');
  const dest = join(root, 'cloned-nm');
  mkdirSync(dir, { recursive: true });
  assert.equal(lockfileCacheKey(dir), null);
  writeFileSync(join(dir, 'package-lock.json'), '{"name":"demo","lockfileVersion":3}\n');
  const key = lockfileCacheKey(dir);
  assert.match(key, /^[0-9a-f]{64}$/);

  mkdirSync(join(src, 'pkg'), { recursive: true });
  writeFileSync(join(src, 'pkg', 'index.js'), 'export const x = 1;\n');
  assert.equal(cloneCachedNodeModules(src, dest), true);
  assert.equal(existsSync(join(dest, 'pkg', 'index.js')), true);
});
