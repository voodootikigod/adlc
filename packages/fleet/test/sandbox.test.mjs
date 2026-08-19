import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_MODES,
  detectBackend,
  resolveSandboxMode,
  buildSandboxArgv,
  Sandbox,
  NETWORK,
  READ_POLICY,
} from '../lib/sandbox.mjs';

test('detectBackend accepts only FS-isolating backends (bwrap/seatbelt), NOT unshare (C2)', async () => {
  const bwrap = detectBackend('linux', (c) => c === 'bwrap');
  assert.equal(bwrap.name, 'bubblewrap');
  const seatbelt = detectBackend('darwin', (c) => c === 'sandbox-exec');
  assert.equal(seatbelt.name, 'seatbelt');
  // unshare-only host: NOT a full backend (unshare gives no filesystem isolation),
  // so the fleet fails closed rather than claiming containment it cannot deliver.
  assert.equal(detectBackend('linux', (c) => c === 'unshare'), null);
  assert.equal(detectBackend('linux', () => false), null);
});

test('fail closed: no backend + no override → refused (AC14 i)', async () => {
  const r = resolveSandboxMode({ backend: null, operatorOverride: false });
  assert.equal(r.refused, true);
  assert.equal(r.mode, null);
});

test('operator-local override downgrades to env-scrub-only with a loud warning (AC14 ii)', async () => {
  const r = resolveSandboxMode({ backend: null, operatorOverride: true });
  assert.equal(r.refused, false);
  assert.equal(r.mode, SANDBOX_MODES.ENV_SCRUB_ONLY);
  assert.ok(r.warnings.some((w) => /ENV-SCRUB-ONLY/i.test(w)), 'must warn which mode is active');
});

test('repo-committed config CANNOT enable the override — still fails closed (AC14 iii / N1)', async () => {
  const r = resolveSandboxMode({ backend: null, operatorOverride: false, repoConfigOverride: true });
  assert.equal(r.refused, true, 'repo config must not be able to disable the sandbox');
  assert.equal(r.mode, null);
  assert.ok(r.warnings.some((w) => /N1|CANNOT disable/i.test(w)), 'must warn that repo config is ignored');
});

test('detected backend → full sandbox mode', async () => {
  const r = resolveSandboxMode({ backend: { name: 'bubblewrap', platform: 'linux' } });
  assert.equal(r.mode, SANDBOX_MODES.SANDBOX);
  assert.equal(r.refused, false);
});

test('buildSandboxArgv (bubblewrap) denies network and binds worktree, NOT the real home (K1)', async () => {
  const argv = buildSandboxArgv(
    { name: 'bubblewrap' },
    ['npm', 'test'],
    { worktree: '/wt', syntheticHome: '/wt/.home', readOnlyPaths: ['/usr'] }
  );
  const s = argv.join(' ');
  assert.ok(s.includes('--unshare-net'), 'network must be denied');
  assert.ok(s.includes('--bind /wt /wt'), 'worktree must be bound read-write');
  assert.ok(s.includes('--ro-bind /usr /usr'), 'runtime path read-only');
  assert.ok(!s.includes('/home/real'), 'the operator real home must not be bound');
  assert.ok(s.endsWith('-- npm test'), 'inner command is appended after --');
});

test('Sandbox.canRead/canWrite enforce the worktree boundary in sandbox mode (K1)', async () => {
  const sb = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend: { name: 'bubblewrap' },
    worktree: '/wt',
    syntheticHome: '/wt/.home',
    readOnlyPaths: ['/usr'],
  });
  assert.equal(sb.canRead('/wt/src/a.js'), true);
  assert.equal(sb.canRead('/usr/lib/node'), true, 'read-only runtime path allowed');
  assert.equal(sb.canRead('/home/real/.aws/credentials'), false, 'host secret read blocked');
  assert.equal(sb.canWrite('/wt/out.txt'), true);
  assert.equal(sb.canWrite('/home/real/.ssh/authorized_keys'), false, 'out-of-worktree write blocked');
  assert.equal(sb.canWrite('/usr/lib/x'), false, 'read-only path is not writable');
  assert.equal(sb.networkAllowed, false);
});

test('env-scrub-only mode performs no OS read/write enforcement (operator-contained)', async () => {
  const sb = new Sandbox({ mode: SANDBOX_MODES.ENV_SCRUB_ONLY, worktree: '/wt' });
  assert.equal(sb.canRead('/home/real/.aws/credentials'), true);
  assert.equal(sb.canWrite('/anywhere'), true);
});

test('Sandbox.run wraps the command through the backend and records via injected exec (M1 seam)', async () => {
  const calls = [];
  const sb = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX,
    backend: { name: 'bubblewrap' },
    worktree: '/wt',
    syntheticHome: '/wt/.home',
    exec: (argv, opts) => { calls.push({ argv, opts }); return 'ok'; },
  });
  const out = await sb.run(['npm', 'install'], { env: { PATH: '/usr/bin' } });
  assert.equal(out, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[0], 'bwrap', 'command routed through the sandbox wrapper');
  assert.ok(calls[0].argv.includes('npm'));
  assert.equal(calls[0].opts.cwd, '/wt');
});

// ── #395: network and filesystem are independent axes ────────────────────────
// K2's rationale — the worker must reach its provider — was implemented as "do
// not wrap the worker at all", which also gave up the filesystem bound it never
// needed to give up. These pin the two axes apart, on BOTH backends, so a future
// change cannot re-fuse them: a model-plane profile that denies egress breaks
// every run, and a repo-command profile that allows it reopens exfiltration.

test('model-plane profile: bubblewrap does NOT deny the network (#395 AC4)', () => {
  const argv = buildSandboxArgv(
    { name: 'bubblewrap' }, ['claude', '-p', 'do it'],
    { worktree: '/wt', writablePaths: ['/h/.claude/projects'], network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST }
  );
  const s = argv.join(' ');
  assert.ok(!s.includes('--unshare-net'), 'the worker must still reach its provider');
  assert.ok(s.includes('--bind /wt /wt'), 'the worktree is writable');
  assert.ok(s.includes('--bind /h/.claude/projects /h/.claude/projects'), 'declared harness state is writable');
  assert.ok(s.includes('--ro-bind / /'), 'everything else is visible but READ-ONLY');
  assert.ok(!s.includes('--setenv HOME'), 'HOME is NOT remapped — the worker reads its own session auth (K2)');
  assert.ok(s.endsWith('-- claude -p do it'));
});

test('model-plane profile: the Seatbelt profile allows network and denies writes by default (#395 AC4)', () => {
  const argv = buildSandboxArgv(
    { name: 'seatbelt' }, ['claude', '-p'],
    { worktree: '/wt', writablePaths: ['/h/.claude/projects'], network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST }
  );
  const profile = argv[2];
  assert.ok(profile.includes('(allow network*)'), 'egress preserved');
  assert.ok(!profile.includes('(deny network*)'));
  // Order is the policy: allow-default, then deny writes, then re-allow the roots.
  assert.ok(profile.indexOf('(deny file-write*)') < profile.indexOf('(allow file-write*'),
    'the blanket write denial must come BEFORE the roots that override it');
  assert.ok(profile.includes('(subpath "/wt")'));
  assert.ok(profile.includes('(subpath "/h/.claude/projects")'));
});

test('repo-command profile still denies the network on both backends (no regression)', () => {
  const bwrap = buildSandboxArgv({ name: 'bubblewrap' }, ['npm', 'test'],
    { worktree: '/wt', syntheticHome: '/wt/.home', readOnlyPaths: ['/usr'] }).join(' ');
  assert.ok(bwrap.includes('--unshare-net'));
  assert.ok(bwrap.includes('--setenv HOME /wt/.home'), 'and still redirects HOME away from the operator home');

  const seatbelt = buildSandboxArgv({ name: 'seatbelt' }, ['npm', 'test'],
    { worktree: '/wt', syntheticHome: '/wt/.home' })[2];
  assert.ok(seatbelt.includes('(deny network*)'));
  assert.ok(seatbelt.includes('(deny default)'), 'reads stay bounded on the repo-command plane');
});

test('networkAllowed reports the PROFILE, not the plane name', () => {
  const model = new Sandbox({ mode: SANDBOX_MODES.SANDBOX, backend: { name: 'seatbelt' }, worktree: '/wt', network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST });
  const repo = new Sandbox({ mode: SANDBOX_MODES.SANDBOX, backend: { name: 'seatbelt' }, worktree: '/wt' });
  assert.equal(model.networkAllowed, true);
  assert.equal(repo.networkAllowed, false);
});

test('canWrite bounds the model plane to the worktree plus declared state', () => {
  const s = new Sandbox({
    mode: SANDBOX_MODES.SANDBOX, backend: { name: 'seatbelt' }, worktree: '/wt',
    writablePaths: ['/h/.claude/projects'], network: NETWORK.ALLOW, readPolicy: READ_POLICY.HOST,
  });
  assert.equal(s.canWrite('/wt/src/a.mjs'), true);
  assert.equal(s.canWrite('/h/.claude/projects/x.json'), true);
  assert.equal(s.canWrite('/h/.config/adlc/quartermaster.json'), false, 'the registry is out of reach');
  assert.equal(s.canWrite('/h/.claude/settings.json'), false, 'so is the settings file beside the granted dir');
  // Reads are NOT bounded here, and the predicate says so rather than implying
  // a boundary the profile does not enforce (documented residual).
  assert.equal(s.canRead('/h/.ssh/id_ed25519'), true);
});

test('Sandbox.run forwards the whole option bag, not just {env, cwd}', () => {
  // The model plane passes `timeout` (the per-strike worker deadline) and `input`
  // (the stdin prompt transport). Dropping either turns a wrapped dispatch into
  // one that never times out or never receives its prompt.
  let seen = null;
  const s = new Sandbox({
    mode: SANDBOX_MODES.ENV_SCRUB_ONLY, worktree: '/wt',
    exec: (argv, opts) => { seen = opts; return 'ok'; },
  });
  return s.run(['claude'], { env: { A: '1' }, timeout: 1234, input: 'prompt' }).then(() => {
    assert.equal(seen.timeout, 1234);
    assert.equal(seen.input, 'prompt');
    assert.equal(seen.cwd, '/wt');
  });
});
