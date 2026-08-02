// The dry-run must not imply one fixed model for a ticket that can escalate
// (issue #401, AC4).
//
// Driven through the real `fleet run --dry-run` CLI in a throwaway repo, for
// the same reason registry-isolation.test.mjs is: the claim is about what the
// OPERATOR is shown before approving a run, and a unit test of the plan builder
// could pass while the CLI printed something else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FLEET_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fleet', 'bin', 'fleet.mjs');

// T-LADDER carries slack and dense rails → ladder mode starting on `cheap` (TWO rungs).
// T-MID carries slack at a lower rail density → ladder starting on `mid` (ONE rung).
// T-DIRECT is on the critical path → direct mode on `frontier`, no ladder.
//
// The one-rung case is not redundant with the two-rung one: it is the boundary
// where "has a ladder at all" and "has more than one rung" diverge, and a
// mid-start ladder is the ordinary case for a ticket with slack (assign.mjs
// starts at `mid` for any rail density below 0.5).
//
//   T-DIRECT(3) ─┐
//   T-LADDER(1) ─┼─→ T-SINK(2)
//   T-MID(1)    ─┘
const TICKETS = {
  tickets: [
    { id: 'T-DIRECT', title: 'critical path', category: 'feature', duration: 3, edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
    { id: 'T-LADDER', title: 'slack, dense rails', category: 'feature', duration: 1, edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
    // density 1/4 = 0.25 → in [floor, 0.5) → ladder starting on `mid`.
    { id: 'T-MID', title: 'slack, sparse rails', category: 'feature', duration: 1, edges: [{ to: 'T-SINK' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**', 'c/**', 'd/**'], body: 'x' },
    { id: 'T-SINK', title: 'integration', category: 'feature', duration: 2, edges: [], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
  ],
};

const REGISTRY = {
  version: 3,
  channels: {
    frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
    mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
  },
  reviewerGroups: {
    'cross-model-routine': { quorum: 1, members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }] },
    'cross-model-trust-root': {
      quorum: 2,
      members: [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ],
    },
  },
  modelProviders: {
    opencode: { 'zai/glm-5.2': 'zai', 'deepseek/v4-flash': 'deepseek', 'qwen/qwen3.7-coder': 'alibaba', 'moonshot/kimi-k3': 'moonshot' },
    'claude-code': { 'claude-opus-5': 'anthropic' },
    codex: { 'gpt-5.3-codex': 'openai' },
  },
};

const cleanup = [];
test.after(() => {
  for (const p of cleanup) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'esc-repo-'));
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify(TICKETS, null, 2));
  cleanup.push(repo);
  return repo;
}

function makeOperatorHome() {
  const home = mkdtempSync(join(tmpdir(), 'esc-home-'));
  const path = join(home, 'quartermaster.json');
  writeFileSync(path, JSON.stringify(REGISTRY, null, 2));
  cleanup.push(home);
  return path;
}

function dryRun(repo, registryPath, extraArgs = []) {
  // Strip any locally-exported registry so a developer's own environment can
  // neither satisfy nor break these assertions.
  const env = { ...process.env };
  delete env.ADLC_QUARTERMASTER_REGISTRY;
  const res = spawnSync(process.execPath, [FLEET_BIN, 'run', '--dry-run', ...extraArgs], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, ADLC_QUARTERMASTER_REGISTRY: registryPath },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function dryRunJson(repo, registryPath) {
  const { code, stdout, stderr } = dryRun(repo, registryPath, ['--json']);
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* non-JSON output is itself a finding */ }
  return { code, json, stdout, stderr };
}

test('the human dry-run names the rungs a ladder ticket may escalate to', () => {
  const repo = makeRepo();
  const { code, stdout, stderr } = dryRun(repo, makeOperatorHome());
  assert.equal(code, 0, `dry-run should succeed:\n${stderr}`);

  const line = stdout.split('\n').find((l) => l.includes('T-LADDER') && l.includes('channel='));
  assert.ok(line, `no plan line for T-LADDER:\n${stdout}`);
  assert.match(line, /channel=cheap/, 'the starting channel is stated');

  const escalationLine = stdout.split('\n').find((l) => l.includes('escalates on retry'));
  assert.ok(escalationLine, `the plan never says escalation may occur:\n${stdout}`);
  assert.match(escalationLine, /mid/, 'the mid rung is named');
  assert.match(escalationLine, /frontier/, 'the frontier rung is named');
  assert.match(escalationLine, /zai\/glm-5\.2/, 'the rung names the MODEL it would run, not just the channel');
  assert.match(escalationLine, /claude-opus-5/, 'including the top rung, which is a different harness');
});

test('a ladder with a SINGLE rung is still printed — "has a ladder" is not "has more than one rung"', () => {
  // A mid-start ladder has exactly one rung (frontier). Treating "print the
  // ladder" as "more than one rung" would silently hide escalation from the
  // ordinary slack ticket, and the plan would imply one fixed model for the
  // very case the ladder exists to serve. A surviving off-by-one mutant on the
  // print guard is what exposed this gap.
  const repo = makeRepo();
  const { stdout } = dryRun(repo, makeOperatorHome());
  const lines = stdout.split('\n');
  const midIdx = lines.findIndex((l) => l.includes('T-MID') && l.includes('channel='));
  assert.ok(midIdx >= 0, `no plan line for T-MID:\n${stdout}`);
  assert.match(lines[midIdx], /channel=mid/, 'the fixture really starts this one on mid');

  const following = lines.slice(midIdx, midIdx + 3).join('\n');
  assert.match(following, /escalates on retry/, 'a one-rung ladder must still be shown');
  assert.match(following, /frontier/, 'and it must name the rung');
  assert.ok(!/\bmid\b.*→/.test(following.split('escalates on retry')[1] ?? ''), 'the single rung is not a chain');
});

test('a direct-mode seat prints no ladder — its plan really is one fixed model', () => {
  const repo = makeRepo();
  const { stdout } = dryRun(repo, makeOperatorHome());
  const lines = stdout.split('\n');
  const directIdx = lines.findIndex((l) => l.includes('T-DIRECT') && l.includes('channel='));
  assert.ok(directIdx >= 0, `no plan line for T-DIRECT:\n${stdout}`);
  assert.match(lines[directIdx], /channel=frontier/);
  // The escalation line, when present, immediately follows the seat's argv line.
  const following = lines.slice(directIdx, directIdx + 3).join('\n');
  assert.ok(!following.includes('escalates on retry'), `a direct seat must not advertise a ladder:\n${following}`);
});

test('--json carries the ladder as data, so automation sees the same plan the human does', () => {
  const repo = makeRepo();
  const { code, json, stdout } = dryRunJson(repo, makeOperatorHome());
  assert.equal(code, 0, `dry-run --json should succeed:\n${stdout}`);
  const seats = json?.quartermaster?.seats ?? [];
  const ladder = seats.find((s) => s.id === 'T-LADDER');
  const direct = seats.find((s) => s.id === 'T-DIRECT');
  assert.ok(ladder, `no T-LADDER seat in the JSON plan: ${JSON.stringify(json)}`);
  assert.equal(ladder.channel, 'cheap');
  assert.deepEqual(
    ladder.escalation.map((r) => r.channel),
    ['mid', 'frontier'],
    'the JSON plan lists the rungs in climb order',
  );
  assert.equal(ladder.escalation[1].adapter, 'claude-code');
  assert.equal(ladder.escalation[1].model, 'claude-opus-5');
  assert.deepEqual(direct.escalation, [], 'a direct seat carries an empty ladder, not a missing key');

  const mid = seats.find((s) => s.id === 'T-MID');
  assert.equal(mid.channel, 'mid');
  assert.deepEqual(mid.escalation.map((r) => r.channel), ['frontier'], 'a mid-start ladder has exactly one rung');
});
