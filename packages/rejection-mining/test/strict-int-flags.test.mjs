// --limit and --min accept only a plain positive decimal integer. Anything
// else exits 1 before any network call, so a typo never becomes a silently
// different cap on how many PRs are mined or how large a cluster must be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
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

test('the parsed --limit and --min values drive the run', (t) => {
  const dir = tmp(t, 'rm-int-flags-');
  const log = join(dir, 'gh-args.log');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('gh version 2.40.0'); process.exit(0); }
if (args[1] === 'list') { console.log(JSON.stringify([{ number: 1, title: 'a' }, { number: 2, title: 'b' }])); process.exit(0); }
console.log(JSON.stringify({ reviews: [
  { body: "don't expose raw errors to clients", author: { login: 'a' } },
  { body: 'never expose raw errors in responses', author: { login: 'b' } },
], comments: [] }));
`, { mode: 0o755 });
  const runWith = (min) => spawnSync(process.execPath, [BIN, '--limit', '7', '--min', min, '--json'], {
    cwd: dir, encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });

  const two = runWith('2');
  assert.equal(two.status, 0, two.stderr);
  const list = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[1] === 'list');
  assert.equal(list[list.indexOf('--limit') + 1], '7');
  assert.equal(JSON.parse(two.stdout).lensCount, 1);

  const tooBig = runWith('99');
  assert.equal(tooBig.status, 0, tooBig.stderr);
  assert.equal(JSON.parse(tooBig.stdout).lensCount, 0);
});
