import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SANDBOX_MODES,
  detectBackend,
  resolveSandboxMode,
  buildSandboxArgv,
  Sandbox,
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
