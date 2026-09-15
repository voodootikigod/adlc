// cli.test.mjs — the CLI's observable contract.
//
// Exit codes are what a caller branches on, and a default that flips is a switch
// the operator never asked for. Both are asserted by running the binary, not by
// reading it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLAGS, parseOptions } from '../lib/usage.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'backlog-groom.mjs');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('an unknown flag exits 1 — the operational-error code, not a gate code', () => {
  // 2 is reserved for a gate failure across this toolkit. A read-only sweep has
  // no verdict to fail, so it must never exit 2.
  const r = run(['--not-a-flag']);
  assert.equal(r.status, 1);
  assert.notEqual(r.status, 2);
});

test('a threshold outside 0..1 exits 1 and names the value it got', () => {
  const r = run(['--threshold', '5']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /5/);
});

test('--help exits 0 and prints the usage block', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /never writes to GitHub/);
});

test('the parser options are derived from the flag table, so help cannot drift from it', () => {
  const options = parseOptions();
  assert.deepEqual(Object.keys(options).sort(), FLAGS.map((f) => f.name).sort());
  for (const f of FLAGS) {
    assert.equal(options[f.name].type, f.arg ? 'string' : 'boolean', `${f.name} has the wrong type`);
  }
});

test('every boolean flag defaults FALSE — a switch must not be on by omission', () => {
  // `--no-cache` defaulting true would silently disable the cache on every run,
  // and the operator would have no way to turn it back on by leaving it out.
  const options = parseOptions();
  for (const f of FLAGS.filter((x) => !x.arg)) {
    assert.equal(options[f.name].default, false, `--${f.name} must default false`);
  }
});

test('a documented default is the parser default — help must not promise what the parser does not do', () => {
  // `--threshold` says "(default 0.2)" in help. If the parser carries no
  // default, a plain run reads `undefined`, fails validation, and the CLI is
  // unusable without passing a flag help says is optional.
  const options = parseOptions();
  assert.equal(options.threshold.default, '0.2');
  for (const f of FLAGS.filter((x) => x.arg && x.default !== undefined)) {
    assert.equal(options[f.name].default, f.default, `--${f.name} default must match the table`);
  }
});

test('a value flag with no declared default carries no default key at all', () => {
  // Setting `default: undefined` is not the same as leaving it out: it makes the
  // parser report the key as present-but-empty, which reads as "the operator
  // passed it blank".
  const options = parseOptions();
  for (const f of FLAGS.filter((x) => x.arg && x.default === undefined)) {
    assert.equal(Object.hasOwn(options[f.name], 'default'), false, `--${f.name} must not declare a default`);
  }
});
