// --limit and --min accept only a plain positive decimal integer. Anything
// else exits 1 before any network call, so a typo never becomes a silently
// different cap on how many PRs are mined or how large a cluster must be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePositiveInt } from '../lib/int-flag.mjs';

const BIN = fileURLToPath(new URL('../bin/rejection-mining.mjs', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args, '--prompt-only'], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

for (const flag of ['--limit', '--min']) {
  for (const bad of ['1e3', '50x', '0', '-3', ' 5', '5 ', '2.5', '', '0x10', '+4', '99999999999999999999']) {
    test(`${flag} ${JSON.stringify(bad)} is refused with exit 1`, () => {
      const res = run([`${flag}=${bad}`]);
      assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
      assert.match(res.stderr, new RegExp(`${flag} must be a positive integer`));
    });
  }

  test(`${flag} with a plain positive integer is accepted`, () => {
    const res = run([flag, '25']);
    assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  });
}

test('parsePositiveInt returns the exact value for a plain decimal', () => {
  assert.deepEqual(parsePositiveInt('1'), { ok: true, value: 1 });
  assert.deepEqual(parsePositiveInt('1000'), { ok: true, value: 1000 });
  assert.deepEqual(parsePositiveInt(String(Number.MAX_SAFE_INTEGER)), { ok: true, value: Number.MAX_SAFE_INTEGER });
});

test('parsePositiveInt refuses non-strings and unsafe integers', () => {
  assert.equal(parsePositiveInt(undefined).ok, false);
  assert.equal(parsePositiveInt(5).ok, false);
  assert.equal(parsePositiveInt('9007199254740993').ok, false);
});
