// AC1 — the candidate tree participates in channel selection NOT AT ALL.
//
// This drives the real `fleet run --dry-run` CLI in a throwaway repo rather than
// unit-testing the loader: the claim under test is about what the DISPATCHER
// does, and a unit test of `loadRegistry` could pass while fleet quietly read the
// in-repo file anyway. The dry-run prints the argv produced by the adapter's own
// dispatch (capture-only exec), so asserting on it asserts on the command line
// the live run would use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadRegistry } from '../lib/load.mjs';

// Minimal adapter catalog for the direct loadRegistry tests below (the CLI path
// supplies the real one from fleet; quartermaster itself declares no deps).
const CATALOG = { opencode: { aliases: ['default'], forcesModel: true }, codex: { aliases: ['default'], forcesModel: true } };

const FLEET_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fleet', 'bin', 'fleet.mjs');

// A DAG with both a critical-path ticket (→ frontier) and a slack ticket
// (→ the assignment tier's channel), so the dry-run exercises TWO channels and
// a single hard-coded channel could not satisfy the assertions.
//
//   T900(3) ─┐
//            ├─→ T902(2)     float: T900=0, T901=2, T902=0
//   T901(1) ─┘
const TICKETS = {
  tickets: [
    {
      id: 'T900',
      title: 'ordinary feature on the critical path',
      category: 'feature',
      duration: 3,
      edges: [{ to: 'T902' }],
      rails: ['packages/x/lib/rail.mjs'],
      scope: ['packages/x/**', 'packages/y/**'],
      body: 'build the thing',
    },
    {
      id: 'T901',
      title: 'feature with slack',
      category: 'feature',
      duration: 1,
      edges: [{ to: 'T902' }],
      rails: ['packages/x/lib/rail.mjs'],
      scope: ['packages/a/**', 'packages/b/**', 'packages/c/**', 'packages/d/**'],
      body: 'build the other thing',
    },
    {
      id: 'T902',
      title: 'integration',
      category: 'feature',
      duration: 2,
      edges: [],
      rails: ['packages/x/lib/rail.mjs'],
      scope: ['packages/x/**', 'packages/y/**'],
      body: 'integrate',
    },
  ],
};

/** The operator's registry — mid is a CONCRETE model so the forced argv is checkable. */
function operatorRegistry() {
  return {
    version: 3,
    channels: {
      frontier: { adapter: 'opencode', model: 'operator/frontier-model', transport: 'subscription:anthropic-max', provider: 'anthropic' },
      'frontier-metered': { adapter: 'opencode', model: 'operator/frontier-model', transport: 'api:anthropic-batch', provider: 'anthropic' },
      mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
      cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
    },
    reviewerGroups: {
      'cross-model-routine': {
        quorum: 1,
        members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }],
      },
      'cross-model-trust-root': {
        quorum: 2,
        members: [
          { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
          { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
        ],
      },
    },
    modelProviders: {
      opencode: {
        'operator/frontier-model': 'anthropic',
        'zai/glm-5.2': 'zai',
        'deepseek/v4-flash': 'deepseek',
        'qwen/qwen3.7-coder': 'alibaba',
        'moonshot/kimi-k3': 'moonshot',
      },
      codex: { 'gpt-5.3-codex': 'openai' },
    },
  };
}

/**
 * A registry-shaped file the CANDIDATE TREE ships, pointing everything at a
 * cheap harness. If any of it ever reaches dispatch, the argv assertions below
 * fail loudly — that is the downgrade this rule exists to prevent.
 */
function inRepoDowngradeRegistry() {
  const registry = operatorRegistry();
  for (const name of Object.keys(registry.channels)) {
    registry.channels[name].adapter = 'codex';
    registry.channels[name].model = 'in-repo/downgraded-model';
  }
  return registry;
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'qm-repo-'));
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify(TICKETS, null, 2));
  // The candidate tree ships registry-shaped files in BOTH scanned locations.
  writeFileSync(join(repo, 'quartermaster.json'), JSON.stringify(inRepoDowngradeRegistry(), null, 2));
  writeFileSync(join(repo, '.adlc', 'quartermaster.json'), JSON.stringify(inRepoDowngradeRegistry(), null, 2));
  return repo;
}

function makeOperatorHome(registry = operatorRegistry()) {
  const home = mkdtempSync(join(tmpdir(), 'qm-home-'));
  const path = join(home, 'quartermaster.json');
  writeFileSync(path, JSON.stringify(registry, null, 2));
  return { home, path };
}

function dryRunJson(repo, envOverrides = {}, extraArgs = []) {
  const env = { ...process.env };
  delete env.ADLC_QUARTERMASTER_REGISTRY;
  const res = spawnSync(process.execPath, [FLEET_BIN, 'run', '--dry-run', '--json', ...extraArgs], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout ?? ''); } catch { /* non-JSON output is itself a finding */ }
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json: parsed };
}

function dryRun(repo, envOverrides = {}, extraArgs = []) {
  // Start from an env with the registry variable REMOVED, so a developer who
  // happens to export it locally cannot make these assertions pass or fail for
  // reasons that have nothing to do with the fixture.
  const env = { ...process.env };
  delete env.ADLC_QUARTERMASTER_REGISTRY;
  const res = spawnSync(process.execPath, [FLEET_BIN, 'run', '--dry-run', ...extraArgs], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const cleanup = [];
test.after(() => {
  for (const p of cleanup) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('an in-repo registry is IGNORED while the operator registry drives dispatch', () => {
  const repo = makeRepo();
  const operator = makeOperatorHome();
  cleanup.push(repo, operator.home);

  const { code, stdout, stderr } = dryRun(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path });
  assert.equal(code, 0, `dry-run should succeed:\n${stderr}`);

  // The operator's registry is the one that was read.
  assert.match(stdout, new RegExp(`quartermaster registry: ${operator.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // Dispatched argv: the operator's adapter and its model, forced explicitly —
  // and the ROUTE decides which model, so both channels must show up.
  assert.match(stdout, /T900\s+job=build\.critical-path channel=frontier/);
  assert.match(stdout, /T901\s+job=build\.ladder-start channel=mid/);
  assert.match(stdout, /argv: opencode \[/);
  assert.match(stdout, /"-m","operator\/frontier-model"/, 'critical-path work is forced onto the frontier model (§4c)');
  assert.match(stdout, /"-m","zai\/glm-5\.2"/, 'slack work is forced onto the mid model (§4c)');

  // Nothing from the candidate tree reached the command line.
  assert.doesNotMatch(stdout, /in-repo\/downgraded-model/, 'the in-repo registry must never reach dispatch');
  assert.doesNotMatch(stdout, /argv: codex/, 'the in-repo adapter must never reach dispatch');

  // And the ignore was announced, naming both files.
  assert.match(stderr, /IGNORED registry-shaped file inside the repo under review/);
  assert.match(stderr, new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/quartermaster\\.json`));
  assert.match(stderr, /\.adlc\/quartermaster\.json/);
});

test('an operator path pointing INSIDE the repo disables loading and fails closed', () => {
  const repo = makeRepo();
  cleanup.push(repo);

  const { code, stdout, stderr } = dryRun(repo, { ADLC_QUARTERMASTER_REGISTRY: join(repo, 'quartermaster.json') });
  assert.notEqual(code, 0, 'dispatch must fail closed, not fall back to the in-repo file');
  assert.match(stderr, /registry loading DISABLED/);
  assert.match(stderr, /points INSIDE the repo under review/);
  assert.doesNotMatch(stdout, /in-repo\/downgraded-model/);
  assert.doesNotMatch(stdout, /argv:/, 'nothing may be planned for dispatch once loading is disabled');
});

test('a RELATIVE operator path is disabled too — it would resolve against the repo cwd', () => {
  const repo = makeRepo();
  cleanup.push(repo);

  const { code, stderr } = dryRun(repo, { ADLC_QUARTERMASTER_REGISTRY: 'quartermaster.json' });
  assert.notEqual(code, 0);
  assert.match(stderr, /registry loading DISABLED/);
  assert.match(stderr, /RELATIVE path/);
});

test('a configured-but-absent operator registry fails closed rather than defaulting', () => {
  const repo = makeRepo();
  const operator = makeOperatorHome();
  cleanup.push(repo, operator.home);

  const { code, stderr } = dryRun(repo, { ADLC_QUARTERMASTER_REGISTRY: join(operator.home, 'does-not-exist.json') });
  assert.notEqual(code, 0);
  assert.match(stderr, /no registry at/);
  assert.match(stderr, /there are no default channels/);
});

test('an INVALID operator registry fails closed naming the rule it broke', () => {
  const broken = operatorRegistry();
  broken.channels['frontier-metered'].transport = broken.channels.frontier.transport; // rule 3
  const repo = makeRepo();
  const operator = makeOperatorHome(broken);
  cleanup.push(repo, operator.home);

  const { code, stderr } = dryRun(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path });
  assert.notEqual(code, 0);
  assert.match(stderr, /rule 3/);
});

// --json is the format automation uses as a pre-dispatch check, so it must be
// the STRICTER of the two, never the laxer. A JSON dry-run that skipped
// validation would report success for a registry the live run then rejects.

test('--json carries the resolved seats and the argv, not just the legacy plan', () => {
  const repo = makeRepo();
  const operator = makeOperatorHome();
  cleanup.push(repo, operator.home);

  const { code, json } = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path });
  assert.equal(code, 0);
  assert.ok(json, 'output must be valid JSON');
  assert.equal(json.quartermaster.engaged, true);
  assert.equal(json.quartermaster.registryPath, operator.path);

  const byId = Object.fromEntries(json.quartermaster.seats.map((s) => [s.id, s]));
  assert.equal(byId.T900.channel, 'frontier');
  assert.equal(byId.T900.model, 'operator/frontier-model');
  // `--format json` is load-bearing (T152): it is the only opencode mode that
  // emits the step_finish token events the P4 usage parser reads. The dry-run
  // argv must mirror the live argv exactly, or automation pre-checks a command
  // the real dispatch does not run.
  assert.deepEqual(byId.T900.argv.args, ['run', '--format', 'json', '-m', 'operator/frontier-model', '<prompt>']);
  assert.equal(byId.T901.channel, 'mid');
  assert.equal(byId.T901.model, 'zai/glm-5.2');
  // The legacy scheduler plan is still there — this is an addition, not a swap.
  assert.deepEqual(json.readyNow.sort(), ['T900', 'T901']);
});

test('--json fails closed on a disabled registry path instead of reporting success', () => {
  const repo = makeRepo();
  cleanup.push(repo);

  const { code, stderr, json } = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: join(repo, 'quartermaster.json') });
  assert.notEqual(code, 0, 'automation must not be told the run is fine');
  assert.equal(json, null, 'no success document may be emitted');
  assert.match(stderr, /registry loading DISABLED/);
});

test('--json fails closed on an invalid registry', () => {
  const broken = operatorRegistry();
  broken.channels.mid.transport = 'proxy:shared'; // rule 4
  const repo = makeRepo();
  const operator = makeOperatorHome(broken);
  cleanup.push(repo, operator.home);

  const { code, stderr, json } = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path });
  assert.notEqual(code, 0);
  assert.equal(json, null);
  assert.match(stderr, /rule 4/);
});

// CPM float is a property of the WHOLE active DAG. If `--tickets` filtered the
// graph before routing, the dry-run would predict channels the live run never
// uses — and the dry-run's only job is to predict the live run.
//
// The fixture is chosen so the bug WOULD show: T901 has float 2 in the full DAG
// (ladder-start -> mid), but float 0 if T900 is dropped (critical-path ->
// frontier). A filtered graph therefore flips its channel.

test('--tickets routes against the FULL DAG, not the selected subset', () => {
  const repo = makeRepo();
  const operator = makeOperatorHome();
  cleanup.push(repo, operator.home);

  const full = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path });
  const subset = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path }, ['--tickets', 'T901,T902']);
  assert.equal(subset.code, 0, `subset dry-run should succeed:\n${subset.stderr}`);

  const seatOf = (r, id) => r.json.quartermaster.seats.find((s) => s.id === id);
  assert.equal(seatOf(full, 'T901').channel, 'mid', 'precondition: T901 has slack in the full DAG');
  assert.deepEqual(
    { channel: seatOf(subset, 'T901').channel, model: seatOf(subset, 'T901').model },
    { channel: seatOf(full, 'T901').channel, model: seatOf(full, 'T901').model },
    'a --tickets selection must not change the channel a ticket routes to'
  );

  // Only the SELECTED tickets are reported, even though all of them were routed.
  assert.deepEqual(subset.json.quartermaster.seats.map((s) => s.id).sort(), ['T901', 'T902']);
});

test('--tickets on a subset whose edges leave the selection still routes', () => {
  // T900 -> T902; selecting T900 alone would dereference the omitted T902 if the
  // graph were filtered before computeFloat.
  const repo = makeRepo();
  const operator = makeOperatorHome();
  cleanup.push(repo, operator.home);

  const { code, json, stderr } = dryRunJson(repo, { ADLC_QUARTERMASTER_REGISTRY: operator.path }, ['--tickets', 'T900']);
  assert.equal(code, 0, `a subset with outgoing edges must not abort:\n${stderr}`);
  assert.deepEqual(json.quartermaster.seats.map((s) => s.id), ['T900']);
  assert.equal(json.quartermaster.seats[0].channel, 'frontier');
});

test('with no operator registry at all, fleet keeps its pre-quartermaster behavior', () => {
  const repo = makeRepo();
  cleanup.push(repo);

  // XDG_CONFIG_HOME points at an empty dir, so the default path resolves to a
  // file that does not exist and the layer is simply not engaged.
  const emptyConfig = mkdtempSync(join(tmpdir(), 'qm-empty-'));
  cleanup.push(emptyConfig);
  const { code, stdout } = dryRun(repo, { XDG_CONFIG_HOME: emptyConfig });
  assert.equal(code, 0);
  assert.match(stdout, /quartermaster: not engaged/);
  assert.doesNotMatch(stdout, /argv:/);
});

test('the legacy dry-run rejects an unknown --adapter, exactly as live assembly does', () => {
  // Without this, a typo'd --adapter passes the dry-run and aborts the real run
  // at buildLiveDeps (fleet AC4) — the dry-run/live divergence this layer removes.
  const repo = makeRepo();
  const emptyConfig = mkdtempSync(join(tmpdir(), 'qm-empty-'));
  cleanup.push(repo, emptyConfig);

  const bad = dryRun(repo, { XDG_CONFIG_HOME: emptyConfig }, ['--adapter', 'no-such-harness']);
  assert.notEqual(bad.code, 0, 'an unknown adapter must not pass the dry-run');
  assert.match(bad.stderr, /unknown fleet worker adapter/);

  const ok = dryRun(repo, { XDG_CONFIG_HOME: emptyConfig }, ['--adapter', 'codex']);
  assert.equal(ok.code, 0, `a known adapter still passes:\n${ok.stderr}`);
});

test('the legacy dry-run rejects a --model the chosen adapter cannot force', () => {
  const repo = makeRepo();
  const emptyConfig = mkdtempSync(join(tmpdir(), 'qm-empty-'));
  cleanup.push(repo, emptyConfig);

  const bad = dryRun(repo, { XDG_CONFIG_HOME: emptyConfig }, ['--adapter', 'cursor', '--model', 'vendor/frontier']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /cannot be honoured by the "cursor" adapter/);
});

// ---- §8a: the registry digest binds a dispatch to the bytes that authorized it ----

test('loadRegistry returns a digest that CHANGES when the registry bytes change', () => {
  const a = makeOperatorHome();
  const changed = operatorRegistry();
  changed.channels.mid.model = 'zai/glm-5.3';   // an operator edits one channel
  changed.modelProviders.opencode['zai/glm-5.3'] = 'zai';  // ...validly
  const b = makeOperatorHome(changed);
  cleanup.push(a.home, b.home);

  const one = loadRegistry({ env: { ADLC_QUARTERMASTER_REGISTRY: a.path }, repoDir: '/repo', adapters: CATALOG });
  const two = loadRegistry({ env: { ADLC_QUARTERMASTER_REGISTRY: b.path }, repoDir: '/repo', adapters: CATALOG });

  assert.match(one.registryDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(one.registryDigest, two.registryDigest, 'a mutated registry must not reuse its predecessor\'s digest');
});

test('the digest is stable for identical bytes at a different path', () => {
  // It commits to CONTENT, not location — two operators running the same
  // registry must produce correlatable evidence.
  const a = makeOperatorHome();
  const b = makeOperatorHome();
  cleanup.push(a.home, b.home);
  assert.equal(
    loadRegistry({ env: { ADLC_QUARTERMASTER_REGISTRY: a.path }, repoDir: '/repo', adapters: CATALOG }).registryDigest,
    loadRegistry({ env: { ADLC_QUARTERMASTER_REGISTRY: b.path }, repoDir: '/repo', adapters: CATALOG }).registryDigest
  );
});
