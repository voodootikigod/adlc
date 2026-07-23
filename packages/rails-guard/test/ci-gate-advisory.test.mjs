// `adlc rails-guard` passing is not full pre-merge clearance.
//
// This command answers "did the diff edit a frozen rail path?". The CI gate,
// scripts/rails-guard-ci.mjs, additionally rejects any change to an EXISTING
// ticket's contract in .adlc/tickets.json — the rail trust root. The two names
// are near-identical and the weaker check is the more discoverable one, which
// has already produced a branch reported as merge-ready off a clean
// `rails-guard` run and then rejected by CI.
//
// The advisory goes to STDERR so anything piping stdout is unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/rails-guard.mjs');
const REPO = resolve(HERE, '../../..');

/** A clean pass: comparing HEAD against itself can touch no rail. */
const ARGS = ['--base', 'HEAD', '--rails', 'no/such/path/**'];
const runClean = (extra = []) => spawnSync(process.execPath, [BIN, ...ARGS, ...extra], { cwd: REPO, encoding: 'utf8' });

test('a clean pass still points at the stricter CI gate', async () => {
  const r = runClean();

  assert.equal(r.status, 0, `precondition: this must be a clean pass (${r.stderr})`);
  assert.match(r.stdout, /all checks passed/);
  assert.match(r.stderr, /rails-guard-ci\.mjs/, 'the stricter CI gate must be named');
  assert.match(r.stderr, /stricter/i);
});

test('the advisory names the trust-root rule that differs', async () => {
  const r = runClean();

  // Naming the actual extra rule is the point — "run something else too" without
  // saying what it checks is what left the distinction invisible in the first place.
  assert.match(r.stderr, /\.adlc\/tickets\.json/);
  assert.match(r.stderr, /npm run preflight/, 'and the one command that covers both');
});

test('the advisory does not pollute stdout or the JSON contract', async () => {
  const human = runClean();
  assert.doesNotMatch(human.stdout, /rails-guard-ci/, 'stdout stays pipeable');

  const json = runClean(['--json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout); // must not throw — machine contract intact
  assert.equal(parsed.tool, 'rails-guard');
  assert.doesNotMatch(json.stderr, /rails-guard-ci/, 'machine mode stays silent');
});

test('preflight is a real script, so the advisory does not point at nothing', async () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));

  assert.ok(pkg.scripts?.preflight, 'the advisory tells the reader to run this');
});
