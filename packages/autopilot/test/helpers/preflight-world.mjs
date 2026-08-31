// A transport "world" for the git-runner / preflight-transport suites: a
// primary repository (from preflight-ctx's makeFixture), a PINNED bare remote
// and an EVIL bare remote laid out so a prefix rewrite of the pinned URL
// lands in the evil one, NET_GIT, real SSH material bound to the fixture key,
// and a git runner over the shared spawn recorder.
//
// transport 'file': the pinned URL is the bare path (git never invokes ssh).
// transport 'ssh':  the pinned URL is ssh://git@localhost<bare path>; the PINNED
//                   `ssh` executable is a logging shell script that records its
//                   argv and runs the remote command locally, so a push really
//                   travels through the generated GIT_SSH wrapper. An "evil"
//                   ssh script with its own log stands in for core.sshCommand.

import { mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createSpawner } from '../../lib/spawn.mjs';
import { writeNetGit } from '../../lib/git-env.mjs';
import { prepareSshMaterial } from '../../lib/ssh.mjs';
import { createGitRunner } from '../../lib/git-runner.mjs';
import { autopilotPaths } from '../../lib/paths.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';
import { PINNED, REAL, realExec, GIT_ENV, git, makeFixture } from './preflight-ctx.mjs';

/** A logging ssh stand-in: appends its argv to `log`, then runs the remote command (the last argument) locally. */
export function writeFakeSsh(path, log) {
  const execPath = spawnSync(REAL.git, ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nfor last; do :; done\nexport PATH='${execPath}':"$PATH"\neval "exec $last"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  writeFileSync(log, '');
  return path;
}

export async function world({ seeded = {}, transport = 'file' } = {}) {
  const fx = makeFixture();
  const pinnedBare = join(fx.root, 'pinned.git');
  const evilDir = join(fx.root, 'evil'); const evilBare = join(evilDir, 'pinned.git');
  mkdirSync(evilDir);
  git(fx.root, ['init', '-q', '--bare', pinnedBare]); git(fx.root, ['init', '-q', '--bare', evilBare]);
  // No detached receive-side auto-gc: it keeps writing after a push returns and races the teardown rm (CI ENOTEMPTY flake).
  for (const b of [pinnedBare, evilBare]) { git(fx.root, ['--git-dir', b, 'config', 'gc.auto', '0']); git(fx.root, ['--git-dir', b, 'config', 'gc.autoDetach', 'false']); }
  const ssh = transport === 'ssh';
  const pinnedUrl = ssh ? `ssh://git@localhost${pinnedBare}` : pinnedBare;
  const prefix = ssh ? `ssh://git@localhost${fx.root}/` : `${fx.root}/`; // a prefix of the pinned URL
  const evilPrefix = `${evilDir}/`;                                          // rewriting the prefix lands in evil/pinned.git
  git(fx.repoRoot, ['remote', 'set-url', 'origin', pinnedUrl]);
  const paths = autopilotPaths(fx.repoRoot);
  const { configSha256 } = writeNetGit({ netGit: paths.netGit, repoRoot: fx.repoRoot, remoteFetchUrl: pinnedUrl, remotePushUrl: pinnedUrl, sshWrapperPath: '/placeholder' });
  const pinnedSshLog = join(fx.root, 'pinned-ssh.log'); const evilSshLog = join(fx.root, 'evil-ssh.log');
  const pinned = ssh ? { ...PINNED, ssh: writeFakeSsh(join(fx.root, 'pinned-ssh'), pinnedSshLog) } : PINNED;
  const evilSsh = ssh ? writeFakeSsh(join(fx.root, 'evil-ssh'), evilSshLog) : null;
  const recorder = [];
  const table = { [pinned.git]: realExec(REAL.git), [pinned['ssh-keygen']]: REAL.sshKeygen ? realExec(REAL.sshKeygen) : (a) => ({ stdout: a[0] === '-y' ? `${fx.pubLine}\n` : 'x SHA256:AAAA c\n', status: 0 }), [pinned['ssh-add']]: () => ({ stdout: `${fx.pubLine}\n`, status: 0 }) };
  const { spawnImpl } = fakeSpawnImpl(table);
  const spawn = createSpawner({ recorder, spawnImpl });
  const ctx = {
    repoRoot: fx.repoRoot, paths, spawn, recorder, pinned, uid: process.getuid(),
    env: { path: process.env.PATH, home: fx.home, base: { PATH: process.env.PATH, HOME: fx.home, LANG: 'C.UTF-8', TZ: 'UTC' } },
    inherited: { PATH: process.env.PATH, HOME: fx.home, ...seeded },
    netGit: paths.netGit, netGitConfigSha256: configSha256,
    remote: { remoteFetchUrl: pinnedUrl, remotePushUrl: pinnedUrl, observed: { fetch: pinnedUrl, push: pinnedUrl } },
    sleep: async () => {},
  };
  ctx.ssh = await prepareSshMaterial({ ctx, dir: join(fx.root, 'ssh-material'), mode: 'explicit', identityPath: fx.keyPath, knownHostsSource: paths.knownHosts, registeredKeys: [{ key: fx.pubLine }] });
  const runner = createGitRunner(ctx);
  const netSpawns = () => recorder.filter((r) => r.argv[0] === pinned.git && r.argv[1]?.startsWith('--git-dir='));
  const refIn = (bare, ref) => { const r = spawnSync(REAL.git, ['--git-dir=' + bare, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8', env: GIT_ENV }); return r.status === 0 ? r.stdout.trim() : null; };
  const logOf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { fx, ctx, runner, pinned, pinnedBare, pinnedUrl, evilBare, prefix, evilPrefix, evilSsh, pinnedSshLog, evilSshLog, logOf, recorder, netSpawns, refIn, cleanup: () => fx.cleanup() };
}
