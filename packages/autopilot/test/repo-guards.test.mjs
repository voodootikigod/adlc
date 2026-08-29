// Repository-level guards the spec binds to this package (AC 14, 16, 156):
// the docs registry guard suites, the build ticket's gate records in this
// repository's manifest, and fleet's synthetic-HOME contract suite.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '../lib/paths.mjs';
import { readManifestAtBaseline, newestSpecApproval } from '../lib/spec-approval.mjs';
import { BUILD_TICKET_ID } from '../lib/preflight-common.mjs';
import { buildFleetArgv } from '../lib/fleet-args.mjs';
import { makeCtx } from './helpers/gates-ctx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', cwd: opts.cwd ?? HERE, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).stdout.trim();
const TOP = git(['rev-parse', '--show-toplevel']);
// lib/paths.mjs refuses a linked worktree by design (AC 24); the injected git reports THIS checkout as the main worktree.
const probe = (args) => (args.includes('--show-toplevel') ? TOP : args[0] === 'worktree' ? `worktree ${TOP}\nHEAD 0\n` : git(args));
const REPO = resolveRepoRoot({ cwd: HERE, git: probe });
// A CHILD test run must not inherit the parent runner's context (NODE_TEST_CONTEXT makes a child report on an internal channel, not stdout).
const childEnvFor = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST') && k !== 'NODE_OPTIONS'));
const nodeTest = (files, { timeoutMs = 180_000 } = {}) => spawnSync(process.execPath, ['--test', ...files], { cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: childEnvFor() });

export function ac14_registryGuards() {
  const repo = resolveRepoRoot({ cwd: HERE, git: probe });
  assert.equal(repo, REPO, `the repository root resolved (${REPO})`);
  const r = nodeTest(['apps/docs/test/toolkit-packages.test.mjs', 'apps/docs/test/toolkit-usage-dispatcher.test.mjs']);
  assert.equal(r.status, 0, `the docs registry guards are green for the autopilot slug:\n${(r.stdout + r.stderr).slice(-2000)}`);
  assert.match(r.stdout, /(# pass|ℹ pass) [1-9]/, `a TAP summary (status ${r.status}, signal ${r.signal}): ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
}
test('AC14: the docs registry guards (toolkit-packages bijective + toolkit-usage-dispatcher) are green for the new autopilot slug', { timeout: 240_000 }, ac14_registryGuards);

export async function ac16_gateRecordsForTheBuildTicket() {
  const ctx = makeCtx({ repoRoot: REPO });
  const head = git(['rev-parse', 'HEAD'], { cwd: REPO });
  const entries = await readManifestAtBaseline(ctx, head);
  const mine = entries.filter((e) => e.ticket === BUILD_TICKET_ID);
  const gates = new Set(mine.map((e) => e.gate));
  assert.ok(gates.has('spec-lint'), `the manifest segment bound to ${BUILD_TICKET_ID} holds a spec-lint record (gates: ${[...gates].join(', ')})`);
  assert.ok(gates.has('coldstart'), 'and a coldstart record');
  assert.ok(newestSpecApproval(entries, BUILD_TICKET_ID), 'and the spec approval that gates the build');
}
test('AC16: this repository\'s manifest holds the spec-lint and coldstart records bound to the build ticket (the code-level cross-model approve is recorded at PR time via prosecute record-cross-model; verify: prosecute tier-check on the PR)', { timeout: 60_000 }, ac16_gateRecordsForTheBuildTicket);

export async function ac156_syntheticHomeContract() {
  // The contract itself is fleet's real-bwrap suite (skips loudly without bwrap); this package REQUESTS the synthetic HOME through the bounded plane.
  const ctx = makeCtx({ repoRoot: REPO });
  const argv = buildFleetArgv({ ctx: { ...ctx, local: { model: 'opus' }, config: { autopilot: {} }, iterationId: 'it', lock: { token: 'x'.repeat(64) }, charterPath: '/c', git: { overlayEnv: () => ({}) } }, issue: 7, ticketId: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', budget: { strikes: 1, wallClockMinutes: 1 }, mirror: '/m', workerDeps: '/w' });
  assert.equal(argv[argv.indexOf('--model-plane-read') + 1], 'bounded', 'the bounded plane carries the synthetic HOME');
  const r = nodeTest(['packages/fleet/test/synthetic-home-bwrap.test.mjs', 'packages/fleet/test/synthetic-home.test.mjs']);
  assert.equal(r.status, 0, `fleet's synthetic-HOME suites are green:\n${(r.stdout + r.stderr).slice(-2000)}`);
  // Green is not enough: the isolation tests must have EXECUTED (a host that skips every bwrap clause proves nothing).
  const out = r.stdout + r.stderr;
  const passed = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0); const skipped = Number(/ℹ skipped (\d+)/.exec(out)?.[1] ?? 0);
  assert.ok(passed >= 5, `at least five synthetic-HOME tests ran and passed (${passed})`);
  const { detectBackend } = await import('@adlc/fleet/lib/sandbox.mjs');
  const { spawnSync: probeSpawn } = await import('node:child_process');
  const backend = detectBackend();
  const usable = backend?.name === 'bubblewrap' && probeSpawn(backend.path ?? 'bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--die-with-parent', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  if (usable) { assert.equal(skipped, 0, 'with a usable bwrap nothing is skipped'); assert.ok(!/SKIPPED/.test(out), 'no clause skipped loudly either'); }
  else console.warn('SKIPPED (loudly): no usable bwrap — the AC 156 isolation clauses did not execute on this host');
}
test('AC156: the synthetic HOME contract — fleet\'s real-bwrap suite (skipped loudly without bwrap) is green and this package requests it through the bounded model plane', { timeout: 240_000 }, ac156_syntheticHomeContract);
