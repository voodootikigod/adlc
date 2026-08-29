// The autopilot CLI dispatcher: exit codes are load-bearing for fleet and for operators' scripts.
import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { dispatch } from '../lib/cli.mjs';

test('an unknown subcommand exits 1 (operational error, never the gate-fail code 2) and names the subcommand', async () => {
  const r = await dispatch(['bogus-subcommand'], { env: { PATH: process.env.PATH }, cwd: process.cwd() });
  assert.equal(r.exitCode, 1);
  assert.match(String(r.text), /unknown subcommand: bogus-subcommand/);
});
