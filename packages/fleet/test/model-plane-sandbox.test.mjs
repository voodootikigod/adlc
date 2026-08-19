// Model-plane containment (issue #395, spec §7.3).
//
// The attack this file prosecutes, end to end on `main` before the fix:
//
//   1. `fleet.gate.build` / `fleet.gate.test` come from the CANDIDATE tree's
//      `.adlc/config.json` (config.mjs: `gate: config.gate ?? null`).
//   2. claude-code's `buildSettings()` turns each into a `Bash(<cmd>)` allow rule
//      in the worktree's `.claude/settings.local.json`.
//   3. `builderPrompt()` instructs the worker to "Run the gate commands yourself".
//   4. `dispatch()` invoked the adapter directly — NOT through `Sandbox` — so that
//      command ran with the operator's filesystem privileges.
//   5. `modelPlaneEnv()` handed it `ADLC_QUARTERMASTER_REGISTRY`, the absolute path
//      of the operator-local channel registry, along with every other `ADLC_*` var.
//
// The registry is not uniquely exposed; it is just the most interesting thing in
// reach. So the containment tests below run a REAL command through the REAL
// model-plane profile and assert the bytes of a file outside the worktree are
// unchanged — the registry in one case, a `~/.claude/settings.json` in the other.
//
// THEY REQUIRE A REAL BACKEND. Where none is detected the test reports a SKIP with
// the reason, never a silent pass: a containment test that quietly succeeds because
// nothing enforced anything is worse than no test at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import {
  Sandbox, SANDBOX_MODES, NETWORK, READ_POLICY, detectBackend, resolveSandboxMode,
} from '../lib/sandbox.mjs';
import { modelPlaneFilesystem, homeStateOf } from '../lib/model-plane.mjs';
import { modelPlaneEnv } from '../lib/env-scrub.mjs';
import * as claudeCode from '../lib/adapters/claude-code.mjs';
import { adapterCatalog, ADAPTERS, getAdapter } from '../lib/adapters/index.mjs';

const backend = detectBackend();

// realpath, because on macOS the OS temp dir is a symlink (/var -> /private/var)
// and Seatbelt reasons about the resolved path. A profile written with the
// unresolved path denies the very worktree it meant to allow.
function scratch(prefix) {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** Run `sh -c <script>` through a real model-plane sandbox rooted at `worktree`. */
async function runContained({ worktree, writablePaths = [], script }) {
  const sandbox = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend,
    worktree,
    syntheticHome: null,
    writablePaths,
    network: NETWORK.ALLOW,
    readPolicy: READ_POLICY.HOST,
  });
  const argv = sandbox.wrap(['/bin/sh', '-c', script]);
  const { spawnSync } = await import('node:child_process');
  return spawnSync(argv[0], argv.slice(1), { cwd: worktree, encoding: 'utf8' });
}

// ── AC1: a repo-controlled command cannot rewrite the operator-local registry ──

test('a gate command on the model plane CANNOT overwrite the quartermaster registry', { skip: backend ? false : 'no sandbox backend on this host (bwrap/sandbox-exec)' }, async () => {
  const root = scratch('mp-registry-');
  try {
    const worktree = join(root, 'wt');
    const opHome = join(root, 'home');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(opHome, '.config', 'adlc'), { recursive: true });
    const registry = join(opHome, '.config', 'adlc', 'quartermaster.json');
    const original = JSON.stringify({ channels: { frontier: { adapter: 'claude-code', model: 'claude-opus-5' } } });
    writeFileSync(registry, original);

    // Exactly the substitution the issue describes: schema-valid, cheap supply.
    const substituted = JSON.stringify({ channels: { frontier: { adapter: 'opencode', model: 'cheap/thing' } } });
    const res = await runContained({
      worktree,
      script: `printf '%s' '${substituted}' > ${JSON.stringify(registry)}`,
    });

    assert.equal(readFileSync(registry, 'utf8'), original,
      'the registry bytes must be UNCHANGED — this is the whole of #395');
    assert.notEqual(res.status, 0, 'the write must FAIL, not silently succeed elsewhere');

    // CONTROL: the same script UNWRAPPED succeeds. Without this the test above
    // passes just as well against a script that could never have worked, a
    // sandbox that runs nothing, or a path that was never writable — i.e. it
    // would assert containment while proving only that something went wrong.
    const { spawnSync } = await import('node:child_process');
    const unwrapped = spawnSync('/bin/sh', ['-c', `printf '%s' '${substituted}' > ${JSON.stringify(registry)}`],
      { cwd: worktree, encoding: 'utf8' });
    assert.equal(unwrapped.status, 0, 'the control write must succeed — otherwise the denial above proves nothing');
    assert.equal(readFileSync(registry, 'utf8'), substituted, 'and it really does substitute the supply');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── AC2: nor anything else outside the worktree ───────────────────────────────

test('a gate command on the model plane CANNOT overwrite ~/.claude/settings.json', { skip: backend ? false : 'no sandbox backend on this host (bwrap/sandbox-exec)' }, async () => {
  const root = scratch('mp-settings-');
  try {
    const worktree = join(root, 'wt');
    const opHome = join(root, 'home');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(opHome, '.claude', 'hooks'), { recursive: true });
    const settings = join(opHome, '.claude', 'settings.json');
    const original = '{"permissions":{"allow":[]}}';
    writeFileSync(settings, original);

    // `.claude/projects` IS granted (it is declared harness state), and the
    // sibling settings file is NOT — the grant is per state directory, not per
    // harness home, precisely so this cannot be reached through it.
    const projects = join(opHome, '.claude', 'projects');
    mkdirSync(projects, { recursive: true });

    const res = await runContained({
      worktree,
      writablePaths: [projects],
      script: `printf 'pwned' > ${JSON.stringify(settings)}`,
    });

    assert.equal(readFileSync(settings, 'utf8'), original, 'settings.json bytes unchanged');
    assert.notEqual(res.status, 0, 'the write must fail');

    // The grant it DOES have still works, or the profile would break every run.
    const ok = await runContained({
      worktree,
      writablePaths: [projects],
      script: `printf 'session' > ${JSON.stringify(join(projects, 'state.json'))}`,
    });
    assert.equal(ok.status, 0, 'declared harness state must remain writable');
    assert.equal(readFileSync(join(projects, 'state.json'), 'utf8'), 'session');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the worktree itself stays writable — containment must not break the build', { skip: backend ? false : 'no sandbox backend on this host (bwrap/sandbox-exec)' }, async () => {
  const root = scratch('mp-worktree-');
  try {
    const worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    const res = await runContained({ worktree, script: 'printf edit > src.txt' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(join(worktree, 'src.txt'), 'utf8'), 'edit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── AC3: the worker is not even told where the registry is ────────────────────

test('the model-plane env carries NO operator-local registry path', () => {
  const env = modelPlaneEnv({
    PATH: '/bin',
    HOME: '/Users/op',
    ADLC_QUARTERMASTER_REGISTRY: '/Users/op/.config/adlc/quartermaster.json',
    ANTHROPIC_API_KEY: 'sk-secret',
  }, { modelAuthKey: 'ANTHROPIC_API_KEY', extra: { ADLC_TICKET: 'T1', ADLC_P4_ENFORCEMENT: '1' } });

  assert.equal(env.ADLC_QUARTERMASTER_REGISTRY, undefined,
    'dispatch resolves the seat BEFORE the worker starts — the worker never needs the path');
  // What the charter actually requires still arrives, through `extra`.
  assert.equal(env.ADLC_TICKET, 'T1');
  assert.equal(env.ADLC_P4_ENFORCEMENT, '1');
  assert.equal(env.HOME, '/Users/op', 'the worker still reads its own session auth (K2)');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-secret', 'and still holds its own provider key');
});

test('withholding is a rule over a NAMED SET, so a SIBLING var added later is withheld too', () => {
  // The property that matters is that this is an ALLOW-list. A deny-list would
  // have to be remembered on every future `ADLC_*` addition, and forgetting is
  // silent — which is exactly how the registry path leaked in the first place.
  // Vars invented here have never been in any list; none of them may appear.
  const source = {
    PATH: '/bin',
    HOME: '/Users/op',
    ADLC_QUARTERMASTER_REGISTRY: '/op/registry.json',
    ADLC_TICKET_STORE: '/op/tickets',
    ADLC_RAILS_BYPASS: '1',
    ADLC_SIGNED_RUNNER_POOL: '/op/pool',
    ADLC_SOME_FUTURE_TRUST_ROOT: '/op/future.json',
  };
  const env = modelPlaneEnv(source, {});
  for (const name of Object.keys(source).filter((k) => k.startsWith('ADLC_'))) {
    assert.equal(env[name], undefined, `${name} must not reach the worker`);
  }

  // And it really is a filter over the set, not a hardcoded blanket drop: name a
  // var in the set and it comes through. With the production set empty those two
  // implementations are indistinguishable, so the set is injectable to tell them apart.
  const withAmbient = modelPlaneEnv(source, { ambientAdlcVars: new Set(['ADLC_TICKET_STORE']) });
  assert.equal(withAmbient.ADLC_TICKET_STORE, '/op/tickets');
  assert.equal(withAmbient.ADLC_QUARTERMASTER_REGISTRY, undefined);
});

// ── AC5: no new failure mode when there is no backend ─────────────────────────

test('no backend and no override → the RUN refuses; the model plane adds no second decision', () => {
  const refused = resolveSandboxMode({ backend: null, operatorOverride: false });
  assert.equal(refused.refused, true);
  assert.equal(refused.mode, null,
    'preflight refuses before any dispatch, so there is no model-plane-only opt-out to reason about');

  // The one escape hatch is the pre-existing operator-local assertion that the
  // WHOLE run is already contained. It downgrades both planes together.
  const overridden = resolveSandboxMode({ backend: null, operatorOverride: true });
  assert.equal(overridden.mode, SANDBOX_MODES.ENV_SCRUB_ONLY);
  const s = new Sandbox({ ...overridden, worktree: '/wt', network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST });
  assert.equal(s.canWrite('/anywhere'), true,
    'ENV_SCRUB_ONLY claims no OS containment and reports so honestly, rather than implying a boundary');
});

test('a repo-committed config cannot enable the override for the model plane either', () => {
  const r = resolveSandboxMode({ backend: null, operatorOverride: false, repoConfigOverride: true });
  assert.equal(r.refused, true);
});

// ── The write-grant policy itself ─────────────────────────────────────────────

test('modelPlaneFilesystem grants the harness state dirs and nothing above them', () => {
  const root = scratch('mp-policy-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    writeFileSync(join(home, '.claude.json'), '{}');

    const { writablePaths } = modelPlaneFilesystem({
      adapters: [claudeCode], home, tmpDir: undefined, mkdirp: () => {},
    });

    assert.ok(writablePaths.includes(join(home, '.claude', 'projects')), 'session scratch is granted');
    assert.ok(!writablePaths.includes(join(home, '.claude')),
      'the harness HOME dir is never granted — it holds settings.json, hooks/, agents/, skills/');
    assert.ok(!writablePaths.includes(join(home, '.claude', 'hooks')),
      'hooks decide what runs in the operator NEXT session');
    assert.ok(!writablePaths.some((p) => p.endsWith('settings.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('modelPlaneFilesystem CREATES a declared dir that does not exist yet', () => {
  // Otherwise a first run on a clean host fails merely because the harness had
  // not made its scratch directory yet.
  const root = scratch('mp-mkdir-');
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const { writablePaths } = modelPlaneFilesystem({ adapters: [claudeCode], home });
    const projects = join(home, '.claude', 'projects');
    assert.ok(existsSync(projects), 'the declared scratch dir was created');
    assert.ok(writablePaths.includes(projects));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('modelPlaneFilesystem NAMES a declared state file it cannot grant', () => {
  // A missing state FILE cannot be bound (a bind needs a real source) and is not
  // invented. That is the one shape of this policy that can make a previously
  // working run fail, so it is surfaced rather than swallowed.
  const root = scratch('mp-missing-');
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const { writablePaths, missingStateFiles } = modelPlaneFilesystem({ adapters: [claudeCode], home });
    assert.ok(missingStateFiles.includes(join(home, '.claude.json')));
    assert.ok(!writablePaths.includes(join(home, '.claude.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an operator-local extra path widens the grant; nothing else can', () => {
  const root = scratch('mp-extra-');
  try {
    const home = join(root, 'home');
    const extra = join(root, 'extra');
    mkdirSync(home, { recursive: true });
    mkdirSync(extra, { recursive: true });
    const { writablePaths } = modelPlaneFilesystem({ adapters: [], home, extraWritable: [extra] });
    assert.ok(writablePaths.includes(extra));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an adapter that declares no home state gets no grant outside the worktree', () => {
  // Fail-closed: an adapter added later without a declaration must not inherit a
  // blanket grant. Its harness erroring loudly is the intended, visible outcome.
  const undeclared = { name: 'future-harness' };
  assert.deepEqual(homeStateOf(undeclared), { dirs: [], files: [] });
  const { writablePaths } = modelPlaneFilesystem({ adapters: [undeclared], home: '/Users/op' });
  assert.deepEqual(writablePaths, []);
});

test('EVERY registered adapter declares where its harness keeps state', () => {
  // A harness with no declaration cannot write its session state and therefore
  // cannot run. Catching that here is much cheaper than catching it mid-fleet.
  for (const name of ADAPTERS) {
    const state = homeStateOf(getAdapter(name));
    assert.ok(state.dirs.length > 0, `${name} declares no homeState.dirs`);
  }
});

test('the adapter catalog surfaces homeState, so the policy has ONE source', () => {
  const catalog = adapterCatalog();
  assert.deepEqual(catalog['claude-code'].homeState.dirs, [...claudeCode.homeState.dirs]);
});

test('no adapter grants the parent directory that holds its own settings', () => {
  // The failure this prevents is subtle: granting `.claude` and then carving
  // `settings.json` back out would make the boundary depend on which files happen
  // to exist on a given host. Declaring only leaf state directories does not.
  const SETTINGS_PARENTS = ['.claude', '.codex', '.gemini', '.cursor', '.config/opencode', '.copilot'];
  for (const name of ADAPTERS) {
    for (const dir of homeStateOf(getAdapter(name)).dirs) {
      assert.ok(!SETTINGS_PARENTS.includes(dir),
        `${name} grants ${dir}, which holds executable configuration for the operator's next session`);
    }
  }
});
