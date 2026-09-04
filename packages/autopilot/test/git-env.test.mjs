// AC 124 / 126 / 127 / 138 / 143 (module-level halves) — sanitized git
// transport env, the bound GIT_CONFIG table, the repo-config audit, and the
// network repository NET_GIT. The spawn-list halves (every recorded git spawn
// carries these) are asserted in the sequence suites.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitBaseEnv, stripGitVars, isStrippedGitVar, boundGitConfig, networkGitEnv, auditRepoConfig, writeNetGit, verifyNetGit, netGitArgv, classifyGitSpawn, shellQuote,
} from '../lib/git-env.mjs';

const URL = 'git@github.com:voodootikigod/adlc.git';

export function ac124_sanitizedGitEnv() {
  const base = gitBaseEnv({ path: '/usr/bin', home: '/home/op' });
  assert.equal(base.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(base.GIT_CONFIG_SYSTEM, '/dev/null'); assert.equal(base.GIT_CONFIG_NOSYSTEM, '1');
  // Table-driven over the §9.1b list, seeded in an orchestrator env.
  const seeded = {
    PATH: '/x', HOME: '/h', GIT_SSH_COMMAND: 'evil', GIT_SSH: 'evil', GIT_PROXY_COMMAND: 'evil', GIT_ASKPASS: 'evil', SSH_ASKPASS: 'evil',
    GIT_CONFIG_PARAMETERS: 'evil', GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y', http_proxy: 'p', HTTPS_PROXY: 'p', ALL_PROXY: 'p',
    GIT_TERMINAL_PROMPT: '1', GIT_DIR: '/decoy', GIT_WORK_TREE: '/decoy', GIT_COMMON_DIR: '/decoy', GIT_INDEX_FILE: '/decoy', GIT_OBJECT_DIRECTORY: '/decoy',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/decoy', GIT_NAMESPACE: 'n', GIT_CEILING_DIRECTORIES: '/', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1', GIT_EXEC_PATH: '/decoy',
    GIT_TEMPLATE_DIR: '/decoy', GIT_EXTERNAL_DIFF: 'x', GIT_EDITOR: 'x', GIT_SEQUENCE_EDITOR: 'x', GIT_PAGER: 'x', GIT_TRACE: '1', GIT_TRACE_PACKET: '1', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1',
  };
  const stripped = stripGitVars(seeded);
  for (const k of Object.keys(seeded)) {
    if (k === 'PATH' || k === 'HOME') { assert.equal(stripped[k], seeded[k]); continue; }
    assert.equal(stripped[k], undefined, `${k} is removed`);
    assert.equal(isStrippedGitVar(k), true, `${k} is classified as stripped`);
  }
  assert.equal(isStrippedGitVar('LANG'), false);
}
test('AC124: every §9.1b variable seeded in the orchestrator env is absent from the git env, and the config-isolation trio is set', ac124_sanitizedGitEnv);

export function ac126_boundTableIsSevenRowsInOrder() {
  const { rows, env } = boundGitConfig({ remoteFetchUrl: URL, remotePushUrl: URL, sshWrapperPath: '/run/ssh-x/wrapper' });
  assert.equal(env.GIT_CONFIG_COUNT, '7');
  assert.deepEqual(rows.map((r) => r[0]), ['remote.origin.url', 'remote.origin.pushurl', 'core.hooksPath', `url.${URL}.insteadOf`, `url.${URL}.pushInsteadOf`, `url.${URL}.insteadOf`, 'core.sshCommand']);
  assert.equal(env.GIT_CONFIG_KEY_0, 'remote.origin.url'); assert.equal(env.GIT_CONFIG_VALUE_0, URL);
  assert.equal(env.GIT_CONFIG_KEY_1, 'remote.origin.pushurl'); assert.equal(env.GIT_CONFIG_VALUE_1, URL);
  assert.equal(env.GIT_CONFIG_VALUE_2, '/dev/null');
  assert.equal(env.GIT_CONFIG_VALUE_6, "'/run/ssh-x/wrapper'", 'row 6 pins core.sshCommand to the single-quoted wrapper path');
  const net = networkGitEnv({ base: gitBaseEnv({ path: '/usr/bin', home: '/h' }), remoteFetchUrl: URL, remotePushUrl: URL, sshWrapperPath: '/run/ssh-x/wrapper' });
  assert.equal(net.GIT_SSH, '/run/ssh-x/wrapper'); assert.equal(net.GIT_SSH_COMMAND, undefined, 'GIT_SSH, never GIT_SSH_COMMAND');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
}
test('AC126/127: GIT_CONFIG_COUNT is 7, rows 0/1 bind origin, rows 3–5 are the identity rewrites, row 6 pins core.sshCommand, GIT_SSH names the wrapper', ac126_boundTableIsSevenRowsInOrder);

export function ac126_boundEnvBeatsRewrittenFile() {
  // A real repository whose .git/config is rewritten to another URL mid-run: a
  // child started with the bound env still resolves origin to the pinned value.
  const dir = mkdtempSync(join(tmpdir(), 'ap-gitenv-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:evil/other.git']);
    const env = networkGitEnv({ base: { ...gitBaseEnv({ path: process.env.PATH, home: dir }) }, remoteFetchUrl: URL, remotePushUrl: URL, sshWrapperPath: '/nonexistent/wrapper' });
    const r = spawnSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { env, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), URL, 'the env-supplied row wins over .git/config');
    const plain = spawnSync('git', ['-C', dir, 'config', '--file', join(dir, '.git', 'config'), '--get', 'remote.origin.url'], { env: gitBaseEnv({ path: process.env.PATH, home: dir }), encoding: 'utf8' });
    assert.equal(plain.stdout.trim(), 'git@github.com:evil/other.git', 'the UNOVERLAID --file read observes the file (AC130)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC126: inside a child started with the bound env `git config --get remote.origin.url` is the pinned value even after .git/config was rewritten; the --file read sees the file', ac126_boundEnvBeatsRewrittenFile);

export function ac124_repoConfigAudit() {
  const ok = auditRepoConfig('core.repositoryformatversion=0\nremote.origin.url=git@github.com:o/r.git\nbranch.main.remote=origin\n');
  assert.equal(ok.ok, true);
  for (const line of ['url.https://evil/.insteadOf=git@github.com:', 'core.sshCommand=ssh -o ProxyCommand=x', 'credential.helper=store', 'http.proxy=http://p', 'includeIf.gitdir:/x.path=/y', 'core.hooksPath=/tmp/hooks', 'http.sslVerify=false', 'remote.origin.uploadpack=/evil', 'url.x.pushInsteadOf=y', 'core.gitProxy=/p', 'remote.origin.proxy=http://p', 'include.path=/x']) {
    const r = auditRepoConfig(`core.bare=false\n${line}\n`);
    assert.equal(r.ok, false, line); assert.equal(r.code, 'git-config-untrusted', line);
  }
}
test('AC124/129: url.*.insteadOf, core.sshCommand, credential.*, http.*, includeIf and core.hooksPath in the repo-local config → git-config-untrusted', ac124_repoConfigAudit);

export function ac143_netGitTemplateAndVerify() {
  const root = mkdtempSync(join(tmpdir(), 'ap-netgit-'));
  try {
    const repoRoot = join(root, 'repo'); mkdirSync(join(repoRoot, '.git', 'objects'), { recursive: true });
    const netGit = join(root, 'net.git');
    const { configSha256 } = writeNetGit({ netGit, repoRoot, remoteFetchUrl: URL, remotePushUrl: URL, sshWrapperPath: '/w' });
    const cfg = readFileSync(join(netGit, 'config'), 'utf8');
    assert.match(cfg, /bare = true/); assert.match(cfg, /hooksPath = \/dev\/null/); assert.match(cfg, new RegExp(`url = ${URL.replace(/[.]/g, '\\.')}`));
    assert.ok(!/insteadOf|credential|http\.|include/i.test(cfg), 'no url.*, credential.*, http.*, include*');
    assert.equal(readFileSync(join(netGit, 'objects', 'info', 'alternates'), 'utf8').trim(), join(repoRoot, '.git', 'objects'));
    assert.deepEqual(verifyNetGit({ netGit, expectedConfigSha256: configSha256, repoRoot }), { ok: true, code: null, detail: null });
    assert.ok(!existsSync(join(netGit, 'refs', 'heads')), 'no refs/heads of its own');
    writeFileSync(join(netGit, 'config'), cfg + '[url "https://evil/"]\n\tinsteadOf = git@github.com:\n');
    assert.equal(verifyNetGit({ netGit, expectedConfigSha256: configSha256, repoRoot }).code, 'net-config-tampered');
    assert.deepEqual(netGitArgv('/usr/bin/git', netGit, 'ls-remote', '--exit-code', URL, 'refs/heads/main'), ['/usr/bin/git', `--git-dir=${netGit}`, 'ls-remote', '--exit-code', URL, 'refs/heads/main']);
    // A real git accepts the template: ls-remote against a local bare fixture via NET_GIT resolves.
    const bare = join(root, 'origin.git'); spawnSync('git', ['init', '-q', '--bare', bare]); spawnSync('git', ['--git-dir', bare, 'config', 'gc.auto', '0']); spawnSync('git', ['--git-dir', bare, 'config', 'gc.autoDetach', 'false']);
    writeNetGit({ netGit: join(root, 'net2.git'), repoRoot, remoteFetchUrl: bare, remotePushUrl: bare, sshWrapperPath: '/w' });
    const ls = spawnSync('git', [`--git-dir=${join(root, 'net2.git')}`, 'ls-remote', bare], { encoding: 'utf8', env: gitBaseEnv({ path: process.env.PATH, home: root }) });
    assert.equal(ls.status, 0, ls.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC143: NET_GIT is written from the fixed template (bare, hooksPath /dev/null, alternates → the primary objects, no url.*/credential.*), a modified config is net-config-tampered, and real git accepts it', ac143_netGitTemplateAndVerify);

export function ac31_gitSpawnClassifier() {
  const net = classifyGitSpawn(['/usr/bin/git', `--git-dir=/r/.adlc/autopilot-runs/net.git`, 'fetch', '--no-tags', URL, 'a'.repeat(40)]);
  assert.equal(net.network, true); assert.equal(net.verb, 'fetch'); assert.equal(net.gitDir, '/r/.adlc/autopilot-runs/net.git'); assert.equal(net.remoteArg, URL);
  const bad = classifyGitSpawn(['/usr/bin/git', '-C', '/r', 'fetch', 'origin']);
  assert.equal(bad.network, true); assert.equal(bad.gitDir, null); assert.equal(bad.remoteArg, 'origin', 'a remote NAME as the argument is what the recorder rejects');
  const local = classifyGitSpawn(['/usr/bin/git', '-C', '/r', 'rev-parse', 'HEAD']);
  assert.equal(local.network, false); assert.equal(local.verb, 'rev-parse');
  const imp = classifyGitSpawn(['/usr/bin/git', '-C', '/r', 'fetch', '--no-tags', '/r/.adlc/autopilot-runs/net.git', 'b'.repeat(40)]);
  assert.equal(imp.remoteArg, '/r/.adlc/autopilot-runs/net.git', 'the local file-transport import names a PATH, not a remote name');
}
test('AC31: the spawn classifier flags ls-remote/fetch/push, extracts --git-dir and the remote argument (name vs URL vs path)', ac31_gitSpawnClassifier);
