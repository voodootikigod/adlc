// A credential VALUE must never reach the dry-run (#396).
//
// Transport now selects a credential, which means the plan-building path
// learned about secrets. Driven through the real `fleet run --dry-run` CLI in a
// throwaway repo with decoy secrets in the environment: the claim is about what
// an operator (and anyone they paste a plan to) can read, and a unit test of the
// plan builder could pass while the CLI printed something else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FLEET_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fleet', 'bin', 'fleet.mjs');

// Distinctive enough that a substring match cannot be a coincidence, and
// deliberately NOT shaped like a real provider key: a fixture that looks like a
// live `sk-…` trips secret scanners (this diff was refused by one) and models
// the wrong habit.
const DECOYS = Object.freeze({
  ANTHROPIC_API_KEY: 'DECOY-anthropic-credential-b7f3e9a1',
  OPENAI_API_KEY: 'DECOY-openai-credential-4f8c1e7b',
  ADLC_MANIFEST_KEY: 'DECOY-ledger-signing-key-91af',
});

const TICKETS = {
  tickets: [
    { id: 'T-A', title: 'critical', category: 'feature', duration: 3, edges: [{ to: 'T-C' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
    { id: 'T-B', title: 'slack', category: 'feature', duration: 1, edges: [{ to: 'T-C' }], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
    { id: 'T-C', title: 'sink', category: 'feature', duration: 2, edges: [], rails: ['a/r.mjs'], scope: ['a/**', 'b/**'], body: 'x' },
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
  const repo = mkdtempSync(join(tmpdir(), 'tp-repo-'));
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify(TICKETS, null, 2));
  cleanup.push(repo);
  return repo;
}

function makeOperatorHome() {
  const home = mkdtempSync(join(tmpdir(), 'tp-home-'));
  const path = join(home, 'quartermaster.json');
  writeFileSync(path, JSON.stringify(REGISTRY, null, 2));
  cleanup.push(home);
  return path;
}

function dryRun(repo, registryPath, extraArgs = []) {
  // The registry MUST be engaged, or there are no seats, no transports, and
  // "no secret appeared" would be vacuously true of an empty plan. Every
  // assertion below therefore also checks the plan is non-empty.
  const env = { ...process.env, ...DECOYS, ADLC_QUARTERMASTER_REGISTRY: registryPath };
  const res = spawnSync(process.execPath, [FLEET_BIN, 'run', '--dry-run', ...extraArgs], {
    cwd: repo, encoding: 'utf8', env,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('no credential VALUE reaches the human dry-run', () => {
  const { code, stdout, stderr } = dryRun(makeRepo(), makeOperatorHome());
  assert.equal(code, 0, `dry-run should succeed:\n${stderr}`);
  // Non-vacuity first: a plan that printed no seats would satisfy the secret
  // assertions trivially.
  assert.match(stdout, /transport=/, 'the plan actually resolved seats');
  const all = `${stdout}\n${stderr}`;
  for (const [name, value] of Object.entries(DECOYS)) {
    assert.ok(!all.includes(value), `the VALUE of ${name} leaked into the dry-run`);
  }
});

test('no credential VALUE reaches the --json plan either', () => {
  const { code, stdout, stderr } = dryRun(makeRepo(), makeOperatorHome(), ['--json']);
  assert.equal(code, 0, `dry-run --json should succeed:\n${stderr}`);
  const all = `${stdout}\n${stderr}`;
  for (const [name, value] of Object.entries(DECOYS)) {
    assert.ok(!all.includes(value), `the VALUE of ${name} leaked into the JSON plan`);
  }
  // The plan is not empty — otherwise "no secret in it" would be vacuously true.
  const plan = JSON.parse(stdout);
  assert.ok((plan?.quartermaster?.seats ?? []).length > 0, 'the plan actually contains seats');
});

test('the dry-run still reports the transport itself — it is context, not a secret', () => {
  const { stdout } = dryRun(makeRepo(), makeOperatorHome());
  assert.match(stdout, /transport=/, 'an operator can still see which transport a seat uses');
});
