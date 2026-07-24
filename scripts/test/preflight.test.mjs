// preflight — the single local entry point for the gates that block a PR.
//
// The bug this defends against is documentation drift: CONTRIBUTING said to run
// `npm test`, CI enforced three gates, and nothing connected the two. So the
// load-bearing property is not "the script runs" — it is that the gate LIST
// stays identical to what CI actually requires. A preflight that silently drops
// a gate is worse than none, because it reads as full clearance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGates, parseBase, refreshBase } from '../preflight.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO, 'scripts/preflight.mjs');
const src = readFileSync(SCRIPT, 'utf8');
const ci = readFileSync(resolve(REPO, '.github/workflows/ci.yml'), 'utf8');
const flat = (g) => [g.argv[0], ...g.argv[1]].join(' ');

// gate -> (how CI invokes it, what preflight must run). Kept as a pair so the
// assertion fails loudly if CI stops running a gate OR preflight stops matching.
const GATES = [
  { gate: 'tests',                ci: 'npm test',                                  preflight: 'scripts/run-tests.mjs' },
  { gate: 'rail-freeze',          ci: 'scripts/rails-guard-ci.mjs',                preflight: 'scripts/rails-guard-ci.mjs' },
  { gate: 'mutation-gate',        ci: 'scripts/mutation-gate.mjs',                 preflight: 'scripts/mutation-gate.mjs' },
  { gate: 'findings-append-only', ci: 'scripts/guard-findings-ledger-append-only.mjs', preflight: 'scripts/guard-findings-ledger-append-only.mjs' },
];

test('preflight runs every gate CI blocks a PR on', async () => {
  for (const { gate, ci: marker, preflight } of GATES) {
    assert.ok(ci.includes(marker), `precondition: CI must still run ${gate} via "${marker}"`);
    assert.ok(src.includes(preflight), `preflight must run ${gate} — CI blocks the PR on it`);
  }
});

test('preflight is registered as an npm script', async () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8'));

  assert.equal(pkg.scripts.preflight, 'node scripts/preflight.mjs');
});

test('CONTRIBUTING points contributors at preflight, not just npm test', async () => {
  const doc = readFileSync(resolve(REPO, 'CONTRIBUTING.md'), 'utf8');

  assert.match(doc, /npm run preflight/, 'the PR process must name the command that matches CI');
});

test('every gate is invoked EXACTLY as ci.yml invokes it', async () => {
  // The failure this pins: mutation-gate reads its base as the first NON-FLAG
  // positional and defaults to origin/main, so `--base main` silently diffs
  // against a different ref than CI. A grep for the script name cannot see that.
  const [tests, rail, mutation] = buildGates('main');
  const appendOnly = buildGates('main').find((g) => g.name === 'findings-append-only');

  assert.deepEqual(tests.argv[1], ['scripts/run-tests.mjs']);
  assert.deepEqual(rail.argv[1], ['scripts/rails-guard-ci.mjs', 'origin/main']);
  assert.deepEqual(mutation.argv[1], ['scripts/mutation-gate.mjs', 'origin/main', '--max', '12']);
  assert.deepEqual(appendOnly.argv[1], ['scripts/guard-findings-ledger-append-only.mjs', 'origin/main']);

  // ...and CI really does use the positional + --max form.
  assert.match(ci, /mutation-gate\.mjs "origin\/\$BASE_REF" --max 12/);
  assert.match(ci, /rails-guard-ci\.mjs "origin\/\$BASE_REF"/);
  assert.match(ci, /guard-findings-ledger-append-only\.mjs "origin\/\$BASE_REF"/);
});

test('the findings gates name their ADR basis (pins the ADR 0014 reference against drift)', async () => {
  const gates = buildGates('main');
  assert.match(gates.find((g) => g.name === 'findings-ledger').why, /ADR 0014/, 'findings-ledger cites ADR 0014');
  assert.match(gates.find((g) => g.name === 'findings-append-only').why, /ADR 0014/, 'findings-append-only cites ADR 0014');
});

test('--base selects the ref every diff-based gate compares against', async () => {
  assert.equal(parseBase(['node', 'preflight.mjs', '--base', 'release-2']), 'release-2');
  assert.equal(parseBase(['node', 'preflight.mjs']), 'main', 'defaults to main');
  assert.equal(parseBase(['node', 'preflight.mjs', '--base']), 'main', 'a dangling --base is not a ref');

  // Only the DIFF-based gates compare against the base. `tests` runs the whole suite
  // and `findings-ledger` scans the entire committed ledger — both are base-independent
  // by design, so they must NOT carry an origin/<base> ref. `findings-append-only` IS
  // diff-based: it proves the ledger was only extended relative to the base.
  const DIFF_BASED = new Set(['rail-freeze', 'mutation-gate', 'findings-append-only']);
  for (const g of buildGates('release-2').filter((x) => DIFF_BASED.has(x.name))) {
    assert.ok(flat(g).includes('origin/release-2'), `${g.name} must honor --base`);
  }
  for (const g of buildGates('release-2').filter((x) => !DIFF_BASED.has(x.name))) {
    assert.ok(!flat(g).includes('origin/release-2'), `${g.name} is base-independent and must not carry a base ref`);
  }
});

test('refreshBase reports success only when the fetch actually succeeded', async () => {
  // Both diff gates compare against origin/<base>. Reporting success on a failed
  // fetch would let them run against a stale ref and pass for the wrong reason —
  // the "green locally, red in CI" gap this script exists to close.
  const calls = [];
  assert.equal(refreshBase('main', (b) => calls.push(b)), true);
  assert.deepEqual(calls, ['main'], 'the requested base is what gets fetched');

  assert.equal(refreshBase('main', () => { throw new Error('no such ref'); }), false);
});

test('preflight refreshes the base ref before diffing against it', async () => {
  // Both diff-based gates compare against origin/<base>. A stale remote ref
  // makes them compare against the wrong tree and pass for the wrong reason —
  // the same "green locally, red in CI" gap preflight exists to close.
  assert.match(src, /git['"],\s*\[['"]fetch['"]/, 'preflight must fetch the base ref');
});

test('preflight stops at the first failing gate with a non-zero exit', async () => {
  // Drive the real script with a base ref that cannot resolve: the fetch guard
  // must refuse rather than silently proceeding to compare against nothing.
  const r = spawnSync(process.execPath, [SCRIPT, '--base', 'no-such-branch-xyz'], { cwd: REPO, encoding: 'utf8' });

  assert.notEqual(r.status, 0, 'an unresolvable base must fail, not pass vacuously');
  assert.match(`${r.stderr}${r.stdout}`, /stale base|could not fetch/i);
});

test('preflight names the rail-freeze/adlc rails-guard distinction on failure', async () => {
  // The near-miss that motivated this: `adlc rails-guard` reported "all checks
  // passed" while the stricter CI gate rejected the branch. If preflight ever
  // fails that gate, it must say why the friendlier command disagreed.
  assert.match(src, /STRICTER than `adlc rails-guard`/);
});
