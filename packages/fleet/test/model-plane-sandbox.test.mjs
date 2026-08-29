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
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { parseFlags } from '../bin/fleet.mjs';
import { dirname } from 'node:path';

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

// ── Cross-model review findings (agy, #395 round 1) ──────────────────────────
// All three were runtime-execution hazards: the profile contained the write
// boundary correctly and would have broken real runs getting there. Each is
// pinned by the behaviour it broke, not by the shape of the fix.

test('a contained command can still write /dev/null (review finding 2)', { skip: backend ? false : 'no sandbox backend on this host (bwrap/sandbox-exec)' }, async () => {
  // The Seatbelt HOST profile denies file-write* as a blanket and re-allows the
  // write roots. /dev/null is a file, so `cmd 2>/dev/null` — ordinary in build and
  // gate commands — failed under it. bwrap covers this with --dev-bind; Seatbelt
  // had to be told. A worker that cannot redirect to /dev/null cannot run.
  const root = scratch('mp-devnull-');
  try {
    const worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    const res = await runContained({ worktree, script: 'printf hello 2>/dev/null > out.txt; printf bye > /dev/null' });
    assert.equal(res.status, 0, `writing /dev/null must succeed: ${res.stderr}`);
    assert.equal(readFileSync(join(worktree, 'out.txt'), 'utf8'), 'hello');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canWrite agrees with the profile about the device tree (review finding 2)', () => {
  // A predicate that disagreed with the profile would be the thing tests trust
  // while the sandbox does something else.
  const model = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'seatbelt' }, worktree: '/wt',
    network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST,
  });
  assert.equal(model.canWrite('/dev/null'), true);
  assert.equal(model.canWrite('/h/.config/adlc/quartermaster.json'), false,
    'granting the device tree must not widen anything that persists');

  // The repo-command profile is unchanged: it never granted /dev and still does not.
  const repo = new Sandbox({ mode: SANDBOX_MODES.SANDBOX, backend: { name: 'seatbelt' }, worktree: '/wt' });
  assert.equal(repo.canWrite('/dev/null'), false);
});

test('the temp dir is granted even when TMPDIR is unset (review finding 1)', () => {
  // TMPDIR is usually UNSET on Linux. Passing it straight through left /tmp with
  // no write grant while `--ro-bind / /` had already made it read-only — so every
  // harness that allocates a temp file would fail, on exactly the platform
  // bubblewrap serves. The deps layer resolves it through os.tmpdir(); this pins
  // the policy layer's half: a resolved temp dir is always granted.
  const resolved = realpathSync(tmpdir());
  const { writablePaths } = modelPlaneFilesystem({ adapters: [], home: '/nonexistent-home', tmpDir: resolved });
  assert.ok(writablePaths.includes(resolved), 'the temp dir must be writable on the model plane');
});

test('a missing declared state file is reported ONCE per run, not once per dispatch (review finding 3)', () => {
  // A fleet runs many tickets and retries strikes. Repeating the warning dozens of
  // times trains the operator to scroll past the one message that explains why
  // their harness failed. modelPlaneFilesystem reports the full set every call —
  // the caller is what dedupes — so this asserts the reporting contract the
  // dedupe depends on: the same missing file is named every time it is asked.
  const root = scratch('mp-warn-');
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const first = modelPlaneFilesystem({ adapters: [claudeCode], home });
    const second = modelPlaneFilesystem({ adapters: [claudeCode], home });
    assert.deepEqual(second.missingStateFiles, first.missingStateFiles,
      'the policy is a pure function of the host — deduping is the caller\'s job, not a hidden latch here');
    assert.ok(first.missingStateFiles.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── Mutation-gate survivors (#395 round 1) ───────────────────────────────────
// The gate planted 16 mutants and 11 lived. None was equivalent: each removed a
// real write grant or a real CLI capability. What they had in common is that the
// model-plane policy is DATA — declared allow-lists and one flag declaration —
// and data with no assertion over it is unprosecuted by construction.

test('--model-plane-writable is REPEATABLE, so a second path does not replace the first', () => {
  // `multiple: true` on the parseArgs option is what makes the flag accumulate.
  // Flipped to false, `--model-plane-writable a --model-plane-writable b` keeps only
  // `b` — the operator silently loses a grant they asked for, and the harness fails
  // on a path they can see in their own command line. Driven through the real bin so
  // the assertion is about the CLI contract, not about a literal in the source.
  // Asserted on the PARSED RESULT, not on whether the parser errored: `multiple:
  // false` does not reject a repeated flag, it silently keeps the last value — so
  // an error-shaped assertion would pass against the broken behaviour.
  const flags = parseFlags(['--model-plane-writable', '/op/alpha', '--model-plane-writable', '/op/beta']);
  assert.deepEqual(flags['model-plane-writable'], ['/op/alpha', '/op/beta'],
    'both grants must survive — dropping one loses a path the operator can see in their own command line');
});

test('EVERY rung of an escalation ladder contributes its state dirs to the grant', () => {
  // A ladder can move a later strike onto a DIFFERENT harness, and the sandbox is
  // built per dispatch. Granting only the current rung works until the first
  // escalation and then fails there — the same failure provisioning already avoids
  // by covering every rung (#401). The ternary that collects them is one swap away
  // from returning [] whenever a seat exists, which is exactly the ladder case.
  const root = scratch('mp-ladder-');
  try {
    const home = join(root, 'home');
    // Create the state dirs of a harness that is NOT the dispatching one, so its
    // presence in the grant can only come from the ladder walk.
    const opencodeState = join(home, '.local', 'share', 'opencode');
    mkdirSync(opencodeState, { recursive: true });

    const rec = [];
    // The real entry shape: a starting `seat` plus `escalation` rungs, which is what
    // `ladderAdapters` walks.
    const seats = new Map([['T1', {
      mode: 'ladder',
      seat: { adapter: 'claude-code', model: 'haiku', transport: 'subscription' },
      escalation: [
        { seat: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'subscription' } },
      ],
    }]]);
    const deps = buildLiveDeps({
      repo: '/repo', statusDir: undefined,
      sandboxSpec: { mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' } },
      reviewRunner: () => ({ ok: true, findings: [] }),
      config: { gate: { test: 'true' }, timeoutMinutes: 1 },
      seats,
      io: {
        git: () => () => '', adlc: () => ({ status: 0, stdout: '{}' }), appendLog: () => {},
        adlcAsync: async () => ({ status: 0, stdout: '' }),
        spawnWorker: async (cmd, args, opts) => { rec.push({ cmd, args, env: opts?.env }); return { status: 0, stdout: 'TICKET-DONE', stderr: '' }; },
        readFile: () => undefined, exists: () => false, mkdirp: () => {}, writeJson: () => {},
        ensureGitignore: () => {}, hasGh: () => false,
        env: { PATH: '/usr/bin', HOME: home },
      },
    });

    return deps.dispatch({
      ticket: { id: 'T1', title: 'T1', scope: ['packages/fleet/**'], body: 'do', edges: [] },
      worktree: join(root, 'wt'), startSha: 'SHA', strike: 1, deadEnds: [],
    }).then(() => {
      const argv = rec.map((c) => [c.cmd, ...(c.args ?? [])].join(' ')).join('\n');
      assert.match(argv, new RegExp(`--bind ${opencodeState} ${opencodeState}`),
        'the LATER rung\'s harness state must be granted at strike 1, or the first escalation fails');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The declared allow-lists are a SECURITY CONTRACT, not incidental data: each entry
// is a path the model plane may write outside the worktree. Pinning them is the same
// species as pinning a workflow hash — a diff that widens or narrows the boundary has
// to say so out loud rather than ride along in an unrelated change. Without this,
// dropping an entry is invisible (the harness silently loses a grant) and ADDING one
// is invisible too (the boundary silently widens), which is the worse direction.
const DECLARED_HOME_STATE = {
  'claude-code': {
    dirs: ['.claude/projects', '.claude/todos', '.claude/statsig', '.claude/shell-snapshots',
      '.claude/file-history', '.claude/logs', '.claude/downloads', '.cache/claude-cli-nodejs'],
    files: ['.claude/.credentials.json', '.claude.json', '.claude.json.backup'],
  },
  codex: {
    dirs: ['.codex/sessions', '.codex/log', '.codex/archived_sessions', '.cache/codex'],
    files: ['.codex/auth.json', '.codex/history.jsonl'],
  },
  gemini: {
    dirs: ['.gemini/tmp', '.gemini/sessions', '.cache/gemini'],
    files: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'],
  },
  agy: {
    dirs: ['.antigravity', '.gemini/tmp', '.gemini/sessions', '.cache/gemini'],
    files: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'],
  },
  jetski: {
    dirs: ['.jetski', '.gemini/tmp', '.gemini/sessions', '.cache/gemini'],
    files: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'],
  },
  opencode: {
    dirs: ['.local/share/opencode', '.local/state/opencode', '.cache/opencode'],
    files: ['.config/opencode/auth.json'],
  },
  pi: {
    dirs: ['.pi/sessions', '.pi/logs', '.local/share/pi', '.cache/pi'],
    files: ['.pi/auth.json', '.config/pi/auth.json'],
  },
  cursor: {
    dirs: ['.local/share/cursor-agent', '.cache/cursor-agent', '.cursor/chats'],
    files: ['.local/share/cursor-agent/auth.json', '.cursor/cli-config.json'],
  },
  copilot: {
    dirs: ['.copilot/history-session-state', '.copilot/logs', '.cache/github-copilot'],
    files: ['.config/github-copilot/apps.json', '.config/github-copilot/hosts.json'],
  },
};

test('the declared write boundary is pinned per adapter, in both directions', () => {
  assert.deepEqual(Object.keys(DECLARED_HOME_STATE).sort(), [...ADAPTERS].sort(),
    'a NEW adapter must declare its boundary here too, or it ships unpinned');
  for (const name of ADAPTERS) {
    const state = homeStateOf(getAdapter(name));
    assert.deepEqual(state, DECLARED_HOME_STATE[name],
      `${name}'s model-plane write grant changed — widening or narrowing it is a security-boundary change`);
  }
});

test('every declared grant is actually honoured when the path exists', () => {
  // The pin above says WHAT is declared; this says the declaration is load-bearing.
  // Together they mean an entry cannot be dropped silently (the pin fails) nor kept
  // as decoration (this fails).
  const root = scratch('mp-honour-');
  try {
    const home = join(root, 'home');
    for (const name of ADAPTERS) {
      const state = homeStateOf(getAdapter(name));
      for (const d of state.dirs) mkdirSync(join(home, d), { recursive: true });
      for (const f of state.files) {
        mkdirSync(dirname(join(home, f)), { recursive: true });
        writeFileSync(join(home, f), '{}');
      }
      const { writablePaths, missingStateFiles } = modelPlaneFilesystem({ adapters: [getAdapter(name)], home });
      assert.deepEqual(missingStateFiles, [], `${name}: every declared file exists in this fixture`);
      for (const d of state.dirs) {
        assert.ok(writablePaths.includes(join(home, d)), `${name}: declared dir ${d} must be granted`);
      }
      for (const f of state.files) {
        assert.ok(writablePaths.includes(join(home, f)), `${name}: declared file ${f} must be granted`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canWrite: a read-only entry under HOME or the private tmp (an attested file leaf) is NOT writable, though its parent root is (agy fleet r7 c1)', async () => {
  const { BoundedModelSandbox, PRIVATE_TMP } = await import('../lib/bounded-model-plane.mjs');
  const home = '/tmp/fleet-home-x/home';
  const s = new BoundedModelSandbox({
    backend: { name: 'bubblewrap' }, worktree: '/wt', writableRoots: [], home,
    readOnlyPaths: ['/usr', `${home}/pinned.json`, `${PRIVATE_TMP}/ro-tool`], homeBinds: [], homeWritableFiles: [], homeScratchDirs: [],
    exec: async () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(s.canWrite(`${home}/scratch.txt`), true, 'HOME itself is writable');
  assert.equal(s.canWrite(`${home}/pinned.json`), false, 'a read-only leaf under HOME is not');
  assert.equal(s.canWrite(`${PRIVATE_TMP}/ro-tool`), false, 'a read-only leaf under the private tmp is not');
  assert.equal(s.canWrite(`${PRIVATE_TMP}/x`), true, 'the private tmp otherwise is');
});
