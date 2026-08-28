// AC 124 / 126 / 127 / 138 / 143 / 147 (module halves) — the three git
// spawners: sanitized env on every git child, the bound identity table on
// network spawns only, NET_GIT as the only place network git runs, the
// pre-spawn revalidation, and the repository-identity assertion. Real
// temporary repositories with two bare remotes; file-path URLs stand in for
// the pinned SSH URLs (lib/remote.mjs rejects file paths, so the runner is
// driven with an explicit { remoteFetchUrl, remotePushUrl }).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner, GitError } from '../lib/git-runner.mjs';
import { writeNetGit, gitBaseEnv } from '../lib/git-env.mjs';
import { prepareSshMaterial } from '../lib/ssh.mjs';
import { createSpawner } from '../lib/spawn.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';
import { PINNED, REAL, realExec, GIT_ENV, git, makeFixture, codeOf } from './helpers/preflight-ctx.mjs';

/** Two bare remotes (pinned, evil), a primary repo whose origin is the pinned path, NET_GIT, real ssh material. */
async function world({ seeded = {} } = {}) {
  const fx = makeFixture();
  const pinnedBare = join(fx.root, 'pinned.git'); const evilBare = join(fx.root, 'evil.git');
  git(fx.root, ['init', '-q', '--bare', pinnedBare]); git(fx.root, ['init', '-q', '--bare', evilBare]);
  git(fx.repoRoot, ['remote', 'set-url', 'origin', pinnedBare]);
  const paths = autopilotPaths(fx.repoRoot);
  const { configSha256 } = writeNetGit({ netGit: paths.netGit, repoRoot: fx.repoRoot, remoteFetchUrl: pinnedBare, remotePushUrl: pinnedBare, sshWrapperPath: '/placeholder' });
  const recorder = [];
  const table = { [PINNED.git]: realExec(REAL.git), [PINNED['ssh-keygen']]: REAL.sshKeygen ? realExec(REAL.sshKeygen) : (a) => ({ stdout: a[0] === '-y' ? `${fx.pubLine}\n` : 'x SHA256:AAAA c\n', status: 0 }), [PINNED['ssh-add']]: () => ({ stdout: `${fx.pubLine}\n`, status: 0 }) };
  const { spawnImpl } = fakeSpawnImpl(table);
  const spawn = createSpawner({ recorder, spawnImpl });
  const ctx = {
    repoRoot: fx.repoRoot, paths, spawn, recorder, pinned: PINNED, uid: process.getuid(),
    env: { path: process.env.PATH, home: fx.home, base: { PATH: process.env.PATH, HOME: fx.home, LANG: 'C.UTF-8', TZ: 'UTC' } },
    inherited: { PATH: process.env.PATH, HOME: fx.home, ...seeded },
    netGit: paths.netGit, netGitConfigSha256: configSha256,
    remote: { remoteFetchUrl: pinnedBare, remotePushUrl: pinnedBare, observed: { fetch: pinnedBare, push: pinnedBare } },
    sleep: async () => {},
  };
  ctx.ssh = await prepareSshMaterial({ ctx, dir: join(fx.root, 'ssh-material'), mode: 'explicit', identityPath: fx.keyPath, knownHostsSource: paths.knownHosts, registeredKeys: [{ key: fx.pubLine }] });
  const runner = createGitRunner(ctx);
  const netSpawns = () => recorder.filter((r) => r.argv[0] === PINNED.git && r.argv[1]?.startsWith('--git-dir='));
  const refIn = (bare, ref) => { const r = spawnSync(REAL.git, ['--git-dir=' + bare, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV }); return r.status === 0 ? r.stdout.trim() : null; };
  return { fx, ctx, runner, pinnedBare, evilBare, recorder, netSpawns, refIn, cleanup: () => fx.cleanup() };
}

const SEEDED = {
  GIT_SSH_COMMAND: 'evil', GIT_SSH: 'evil', GIT_PROXY_COMMAND: 'evil', GIT_ASKPASS: 'evil', SSH_ASKPASS: 'evil', GIT_CONFIG_PARAMETERS: 'evil',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://evil/.insteadOf', GIT_CONFIG_VALUE_0: '/', http_proxy: 'p', HTTPS_PROXY: 'p', ALL_PROXY: 'p', GIT_TERMINAL_PROMPT: '1',
  GIT_DIR: '/decoy', GIT_WORK_TREE: '/decoy', GIT_INDEX_FILE: '/decoy', GIT_OBJECT_DIRECTORY: '/decoy', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/decoy', GIT_TRACE: '1', GIT_EDITOR: 'x',
};

export async function ac124_everyGitSpawnIsSanitized() {
  const w = await world({ seeded: SEEDED });
  const runner = createGitRunner(w.ctx); // the three spawners under test, bound to the same ctx
  try {
    await runner.observe('remote.origin.url');
    await runner.localOut(w.fx.repoRoot, ['rev-parse', 'HEAD']);
    await runner.net(['ls-remote', w.pinnedBare, 'refs/heads/main']);
    const gits = w.recorder.filter((r) => r.argv[0] === PINNED.git);
    assert.ok(gits.length >= 5, 'observe, rev-parse, the two pre-spawn observe reads and the ls-remote were recorded');
    for (const r of gits) {
      assert.equal(r.env.GIT_CONFIG_GLOBAL, '/dev/null', r.argv.join(' ')); assert.equal(r.env.GIT_CONFIG_SYSTEM, '/dev/null'); assert.equal(r.env.GIT_CONFIG_NOSYSTEM, '1');
      for (const k of Object.keys(SEEDED)) if (!(k === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_/.test(k) || k === 'GIT_SSH' || k === 'GIT_TERMINAL_PROMPT')) assert.equal(r.env[k], undefined, `${k} absent from ${r.argv.slice(1, 3).join(' ')}`);
      assert.equal(r.env.GIT_TERMINAL_PROMPT, '0');
      if (r.env.GIT_CONFIG_COUNT) assert.notEqual(r.env.GIT_CONFIG_KEY_0, SEEDED.GIT_CONFIG_KEY_0, 'the inherited table never survives');
    }
  } finally { w.cleanup(); }
}
test('AC124: every recorded git spawn carries the config-isolation trio and none of the seeded §9.1b variables', ac124_everyGitSpawnIsSanitized);

export async function ac126_netCarriesBoundTableOnly() {
  const w = await world({ seeded: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y' } });
  const runner = createGitRunner(w.ctx); // the three spawners under test, bound to the same ctx
  try {
    await runner.net(['ls-remote', w.pinnedBare, 'refs/heads/main']);
    const net = w.netSpawns();
    assert.equal(net.length, 1);
    assert.equal(net[0].env.GIT_CONFIG_COUNT, '7');
    assert.equal(net[0].env.GIT_CONFIG_KEY_0, 'remote.origin.url'); assert.equal(net[0].env.GIT_CONFIG_VALUE_0, w.pinnedBare);
    assert.equal(net[0].env.GIT_CONFIG_KEY_1, 'remote.origin.pushurl'); assert.equal(net[0].env.GIT_CONFIG_VALUE_1, w.pinnedBare);
    assert.equal(net[0].env.GIT_SSH, w.ctx.ssh.wrapperPath);
    const observes = w.recorder.filter((r) => r.argv[0] === PINNED.git && r.argv[1] === 'config');
    assert.ok(observes.length >= 2);
    for (const o of observes) { assert.equal(o.env.GIT_CONFIG_COUNT, undefined, 'observation reads never carry the overlay'); assert.ok(o.argv.includes('--file')); }
    // Inside a child started with the bound env, origin resolves to the pin even after .git/config is rewritten.
    git(w.fx.repoRoot, ['remote', 'set-url', 'origin', w.evilBare]);
    const r = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'config', '--get', 'remote.origin.url'], { env: runner.overlayEnv(), encoding: 'utf8' });
    assert.equal(r.stdout.trim(), w.pinnedBare, 'the env-supplied row wins over the rewritten file');
    assert.equal(await runner.observe('remote.origin.url'), w.evilBare, 'the unoverlaid observe sees the file');
    assert.equal(await codeOf(() => runner.net(['ls-remote', w.pinnedBare, 'refs/heads/main'])), 'remote-url-changed', 'a changed observed URL stops the next network spawn');
    assert.equal(w.netSpawns().length, 1, 'zero further network spawns');
  } finally { w.cleanup(); }
}
test('AC126: every network git spawn env carries GIT_CONFIG_KEY_0=remote.origin.url / KEY_1=pushurl with the pinned value, inherited GIT_CONFIG_* is dropped, observe() never carries the overlay, and a rewritten origin is remote-url-changed', ac126_netCarriesBoundTableOnly);

export async function ac127_identityRewriteBeatsPrefix() {
  const w = await world();
  try {
    const prefix = w.pinnedBare.slice(0, w.pinnedBare.length - 'pinned.git'.length); // the directory prefix of the pinned URL
    git(w.fx.repoRoot, ['config', `url.${w.evilBare}/.insteadOf`, prefix]); // planted AFTER the audit
    const env = w.runner.overlayEnv();
    assert.equal(env.GIT_CONFIG_COUNT, '7');
    assert.equal(env.GIT_CONFIG_KEY_3, `url.${w.pinnedBare}.insteadOf`); assert.equal(env.GIT_CONFIG_VALUE_3, w.pinnedBare);
    assert.equal(env.GIT_CONFIG_KEY_5, `url.${w.pinnedBare}.insteadOf`);
    const resolved = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'ls-remote', '--get-url', w.pinnedBare], { env, encoding: 'utf8' });
    assert.equal(resolved.stdout.trim(), w.pinnedBare, 'under the bound env the full-URL identity row beats the planted prefix rewrite');
    const plain = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'ls-remote', '--get-url', w.pinnedBare], { env: gitBaseEnv({ path: process.env.PATH, home: w.fx.home }), encoding: 'utf8' });
    assert.ok(plain.stdout.trim().startsWith(w.evilBare), 'without the identity rows the prefix rewrite redirects (the rows are load-bearing)');
    const head = git(w.fx.repoRoot, ['rev-parse', 'HEAD']);
    const push = await w.runner.net(['push', w.pinnedBare, `${head}:refs/heads/adlc/autopilot/issue-1`]);
    assert.equal(push.status, 0, push.stderr);
    assert.equal(w.refIn(w.pinnedBare, 'refs/heads/adlc/autopilot/issue-1'), head, 'the ref landed in the pinned bare repo');
    assert.equal(w.refIn(w.evilBare, 'refs/heads/adlc/autopilot/issue-1'), null, 'and never in the evil one');
    assert.equal(await w.runner.lsRemoteOid(w.pinnedBare, 'refs/heads/adlc/autopilot/issue-1'), head, 'post-push ls-remote reports the pushed OID');
    assert.equal(await w.runner.lsRemoteOid(w.pinnedBare, 'refs/heads/absent'), null);
  } finally { w.cleanup(); }
}
test('AC127: with url.<evil>.insteadOf=<prefix of pinned> planted after the audit, the bound table (count 7, identity rows 3–5) still resolves the pinned URL, the push lands only in the pinned bare repo, and ls-remote reads back the OID', ac127_identityRewriteBeatsPrefix);

export async function ac143_netGitIsolatesTransport() {
  const w = await world();
  try {
    git(w.fx.repoRoot, ['config', `url.${w.evilBare}.insteadOf`, w.pinnedBare]); // EXACT-URL rewrite, planted after the audit
    const head = git(w.fx.repoRoot, ['rev-parse', 'HEAD']);
    const push = await w.runner.net(['push', w.pinnedBare, `${head}:refs/heads/x`]);
    assert.equal(push.status, 0, push.stderr);
    assert.equal(w.refIn(w.pinnedBare, 'refs/heads/x'), head); assert.equal(w.refIn(w.evilBare, 'refs/heads/x'), null, 'through NET_GIT the exact-URL rewrite has no effect');
    for (const r of w.netSpawns()) assert.equal(r.argv[1], `--git-dir=${w.ctx.netGit}`, 'every network spawn names NET_GIT');
    // The same fixture against the primary repository's own configuration (no NET_GIT) DOES redirect: the isolation is load-bearing.
    const direct = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'push', w.pinnedBare, `${head}:refs/heads/y`], { env: gitBaseEnv({ path: process.env.PATH, home: w.fx.home }), encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(w.refIn(w.evilBare, 'refs/heads/y'), head, 'without NET_GIT the push was redirected to the evil remote');
    assert.equal(w.refIn(w.pinnedBare, 'refs/heads/y'), null);
    assert.deepEqual(readdirSync(join(w.ctx.netGit, 'hooks')), [], 'NET_GIT/hooks is empty');
    // A fetched OID reaches the main repository only through a local `git fetch <NET_GIT>` argv.
    const before = w.recorder.length;
    const imp = await w.runner.local(w.fx.repoRoot, ['fetch', '--no-tags', w.ctx.netGit, head]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.deepEqual(w.recorder[before].argv.slice(1), ['-C', w.fx.repoRoot, 'fetch', '--no-tags', w.ctx.netGit, head]);
    assert.equal(await codeOf(() => w.runner.local(w.fx.repoRoot, ['fetch', w.pinnedBare, head])), 'network-op-outside-net-git', 'a local fetch from anything but NET_GIT is refused');
    assert.equal(await codeOf(() => w.runner.local(w.fx.repoRoot, ['push', w.pinnedBare, 'HEAD'])), 'network-op-outside-net-git');
    // A modified NET_GIT config → net-config-tampered, zero network spawns.
    const n = w.netSpawns().length;
    writeFileSync(join(w.ctx.netGit, 'config'), readFileSync(join(w.ctx.netGit, 'config'), 'utf8') + `[url "${w.evilBare}"]\n\tinsteadOf = ${w.pinnedBare}\n`);
    assert.equal(await codeOf(() => w.runner.net(['ls-remote', w.pinnedBare, 'refs/heads/x'])), 'net-config-tampered');
    assert.equal(w.netSpawns().length, n, 'nothing was sent');
  } finally { w.cleanup(); }
}
test('AC143: every network spawn is --git-dir=<NET_GIT>; an exact-URL insteadOf planted in .git/config redirects a direct push but not one through NET_GIT; hooks empty; a fetched OID reaches main only via a local fetch <NET_GIT>; a modified NET_GIT config → net-config-tampered with zero network spawns', ac143_netGitIsolatesTransport);

export async function ac147_netRevalidatesMaterialBeforeSpawn() {
  const w = await world();
  try {
    assert.equal((await w.runner.net(['ls-remote', w.pinnedBare, 'refs/heads/main'])).status, 0, 'unchanged material → the spawn proceeds');
    const n = w.netSpawns().length;
    chmodSync(w.ctx.ssh.identityPath, 0o644);
    assert.equal(await codeOf(() => w.runner.net(['ls-remote', w.pinnedBare, 'refs/heads/main'])), 'ssh-material-tampered');
    assert.equal(w.netSpawns().length, n, 'zero network spawns after tamper');
    chmodSync(w.ctx.ssh.identityPath, 0o600);
    chmodSync(w.ctx.ssh.wrapperPath, 0o700); writeFileSync(w.ctx.ssh.wrapperPath, '#!/bin/sh\nexec ssh "$@"\n'); chmodSync(w.ctx.ssh.wrapperPath, 0o500);
    assert.equal(await codeOf(() => w.runner.net(['push', w.pinnedBare, 'HEAD:refs/heads/z'])), 'ssh-wrapper-tampered');
    assert.equal(w.netSpawns().length, n);
    assert.equal(await codeOf(() => w.runner.net(['rev-parse', 'HEAD'])), 'bad-net-verb', 'net() accepts only ls-remote/fetch/push');
    assert.ok(new GitError('x').exitCode === 1);
  } finally { w.cleanup(); }
}
test('AC147: net() re-validates the SSH material immediately before each spawn — a 0644 copy or a rewritten wrapper stops the operation with zero network spawns; unchanged material proceeds', ac147_netRevalidatesMaterialBeforeSpawn);

export async function ac138_identityAssertion() {
  const w = await world();
  const runner = createGitRunner(w.ctx); // the three spawners under test, bound to the same ctx
  try {
    assert.equal(await runner.assertIdentity(w.fx.repoRoot, w.fx.repoRoot), true);
    const decoy = mkdtempSync(join(tmpdir(), 'ap-decoy-'));
    try {
      git(decoy, ['init', '-q', '-b', 'main']);
      assert.equal(await codeOf(() => runner.assertIdentity(decoy, w.fx.repoRoot)), 'repo-identity-mismatch', 'a decoy cwd fails the identity assertion');
      // A nested worktree of the primary passes: its git dir lies under REPO_ROOT/.git.
      const wt = join(w.fx.root, 'wt'); git(w.fx.repoRoot, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
      assert.equal(await runner.assertIdentity(wt, wt), true);
      mkdirSync(join(w.fx.root, 'plain')); assert.equal(await codeOf(() => runner.assertIdentity(join(w.fx.root, 'plain'), w.fx.repoRoot)), 'git-failed');
      assert.ok(existsSync(wt)); rmSync(wt, { recursive: true, force: true });
    } finally { rmSync(decoy, { recursive: true, force: true }); }
  } finally { w.cleanup(); }
}
test('AC138: the identity assertion (rev-parse --show-toplevel / --absolute-git-dir under REPO_ROOT/.git) passes for the real repository and its worktrees and fails repo-identity-mismatch for a decoy', ac138_identityAssertion);
