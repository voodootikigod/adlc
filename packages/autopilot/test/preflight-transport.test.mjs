// AC 130 / 131 / 137 / 142 (preflight halves) — the identity is OBSERVED with
// an unoverlaid --file read, the SSH transport survives a post-audit config
// race (real ssh:// push through the generated GIT_SSH wrapper into a logging
// pinned ssh), and the fetch/push URLs are byte-identical after
// canonicalization or the run is remote-url-split.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { phaseA } from '../lib/preflight.mjs';
import { createGitRunner } from '../lib/git-runner.mjs';
import { boundGitConfig, auditRepoConfig, shellQuote } from '../lib/git-env.mjs';
import { makeFixture, buildCtx, git, codeOf, netSpawns, PINNED, REAL } from './helpers/preflight-ctx.mjs';
import { world } from './helpers/preflight-world.mjs';

const PIN = 'git@github.com:o/r.git';
const observes = (recorder) => recorder.filter((r) => r.argv[0] === PINNED.git && r.argv.includes('config') && r.argv.includes('--get'));

export async function ac130_identityObservedUnoverlaid() {
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx); await phaseA(ctx);
    for (const o of observes(ctx.recorder)) {
      assert.deepEqual(o.argv.slice(1, 4), ['config', '--file', join(fx.repoRoot, '.git', 'config')], 'the identity read is `git config --file <REPO_ROOT>/.git/config --get …`');
      assert.equal(o.env.GIT_CONFIG_COUNT, undefined, 'NO GIT_CONFIG_COUNT in its env');
    }
    // Same fixture: .git/config is rewritten to another repo. A BOUND-env read still returns the pin …
    git(fx.repoRoot, ['remote', 'set-url', 'origin', 'git@github.com:evil/other.git']);
    const bound = spawnSync(REAL.git, ['-C', fx.repoRoot, 'config', '--get', 'remote.origin.url'], { env: ctx.git.overlayEnv(), encoding: 'utf8' });
    assert.equal(bound.stdout.trim(), PIN, 'a bound-env read echoes the pinned value back');
    // … but the unoverlaid observation sees the file, so phase A is repo-mismatch.
    assert.equal(await ctx.git.observe('remote.origin.url'), 'git@github.com:evil/other.git');
    assert.equal(await codeOf(() => phaseA(buildCtx(fx))), 'repo-mismatch', 'the observed identity, not the overlay, decides');
    // Every "immediately before" re-read (net() pre-spawn) uses the --file form and stops the operation.
    const before = ctx.recorder.length;
    assert.equal(await codeOf(() => ctx.git.net(['ls-remote', PIN, 'refs/heads/main'])), 'remote-url-changed');
    const reReads = observes(ctx.recorder.slice(before));
    assert.ok(reReads.length >= 1 && reReads.every((o) => o.argv[2] === '--file' && o.env.GIT_CONFIG_COUNT === undefined));
    assert.equal(netSpawns(ctx.recorder).length, 0, 'nothing was sent');
  } finally { fx.cleanup(); }
}
test('AC130: the identity is observed with git config --file <REPO_ROOT>/.git/config --get and no GIT_CONFIG_COUNT; a .git/config naming another repo is repo-mismatch even though a bound-env read returns the pin; every pre-spawn re-read uses the --file form', ac130_identityObservedUnoverlaid);

export async function ac131_sshTransportSurvivesConfigRace() {
  const w = await world({ transport: 'ssh' });
  try {
    const audit = auditRepoConfig(git(w.fx.repoRoot, ['config', '--file', join(w.fx.repoRoot, '.git', 'config'), '--list']));
    assert.equal(audit.ok, true, 'the audit passes BEFORE the race');
    git(w.fx.repoRoot, ['config', 'core.sshCommand', w.evilSsh]);                 // planted AFTER the audit
    git(w.fx.repoRoot, ['config', `url.${w.evilPrefix}.insteadOf`, w.prefix]);    // and a prefix rewrite of the pinned URL
    const runner = createGitRunner(w.ctx);
    const head = git(w.fx.repoRoot, ['rev-parse', 'HEAD']);
    const push = await runner.net(['push', w.pinnedUrl, `${head}:refs/heads/via-net-git`]);
    assert.equal(push.status, 0, push.stderr);
    const direct = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'push', w.pinnedUrl, `${head}:refs/heads/direct`], { env: runner.overlayEnv(), encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    const log = w.logOf(w.pinnedSshLog).split('\n').filter(Boolean);
    assert.ok(log.length > 0, 'the PINNED ssh executable ran');
    for (const opt of ['-F', '/dev/null', '-o', 'StrictHostKeyChecking=yes', `UserKnownHostsFile="${w.ctx.ssh.knownHostsPath}"`, 'IdentitiesOnly=yes', 'BatchMode=yes', 'IdentityAgent=none', '-i', w.ctx.ssh.identityPath]) assert.ok(log.includes(opt), `the pinned wrapper argv reached ssh: ${opt}`);
    assert.ok(log.some((l) => /^git-receive-pack '.*pinned\.git'$/.test(l)), 'the remote command names the pinned repository');
    assert.equal(w.logOf(w.evilSshLog), '', 'the evil core.sshCommand wrapper never ran');
    assert.equal(w.refIn(w.pinnedBare, 'refs/heads/via-net-git'), head); assert.equal(w.refIn(w.pinnedBare, 'refs/heads/direct'), head, 'both pushes landed in the pinned bare repo');
    assert.equal(w.refIn(w.evilBare, 'refs/heads/via-net-git'), null); assert.equal(w.refIn(w.evilBare, 'refs/heads/direct'), null);
    const env = runner.overlayEnv();
    assert.equal(env.GIT_CONFIG_COUNT, '7');
    assert.equal(env.GIT_CONFIG_KEY_6, 'core.sshCommand'); assert.equal(env.GIT_CONFIG_VALUE_6, shellQuote(w.ctx.ssh.wrapperPath), 'row 6 pins core.sshCommand to the same wrapper');
    assert.equal(env.GIT_SSH, w.ctx.ssh.wrapperPath);
    for (const r of w.netSpawns()) assert.equal(r.env.GIT_SSH, w.ctx.ssh.wrapperPath);
  } finally { w.cleanup(); }
}
test('AC131: with core.sshCommand=<evil> and url.<evil>.insteadOf=<prefix> written after the audit, a push under the bound env is executed by the PINNED ssh through the generated GIT_SSH wrapper (its log shows -F /dev/null … UserKnownHostsFile), the evil log is empty, the ref lands in the pinned bare repo, GIT_CONFIG_COUNT is 7 and row 6 pins core.sshCommand', ac131_sshTransportSurvivesConfigRace);

export async function ac137_splitPushUrlIsRefused() {
  for (const pushurl of ['git@ghe.example.com:o/r.git', 'ssh://git@ghe.example.com/o/r.git']) {
    const fx = makeFixture();
    try {
      git(fx.repoRoot, ['config', 'remote.origin.pushurl', pushurl]);
      const ctx = buildCtx(fx);
      assert.equal(await codeOf(() => phaseA(ctx)), 'remote-url-split', pushurl);
      assert.equal(netSpawns(ctx.recorder).length, 0, 'before any network operation');
      const pushRead = observes(ctx.recorder).find((o) => o.argv.includes('remote.origin.pushurl'));
      assert.ok(pushRead && pushRead.argv[2] === '--file' && pushRead.env.GIT_CONFIG_COUNT === undefined, 'the pushurl is observed with the unoverlaid --file read');
    } finally { fx.cleanup(); }
  }
}
test('AC137: a repository whose pushurl canonicalizes to a different host than url is remote-url-split in phase A, before any network spawn', ac137_splitPushUrlIsRefused);

export async function ac142_fetchAndPushUrlsAreOneString() {
  const fx = makeFixture();
  try {
    git(fx.repoRoot, ['config', 'remote.origin.pushurl', 'ssh://git@github.com/o/r.git']);
    const ctx = buildCtx(fx); await phaseA(ctx);
    assert.equal(ctx.remote.remoteFetchUrl, PIN); assert.equal(ctx.remote.remotePushUrl, PIN, 'both forms canonicalize to one string and are accepted');
    const { rows } = boundGitConfig({ remoteFetchUrl: ctx.remote.remoteFetchUrl, remotePushUrl: ctx.remote.remotePushUrl, sshWrapperPath: ctx.ssh.wrapperPath });
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[5], [`url.${PIN}.insteadOf`, PIN], 'the table carries url.<pushUrl>.insteadOf as its own row');
    assert.equal(ctx.git.overlayEnv().GIT_CONFIG_COUNT, '7');
    for (const [pushurl, why] of [['git@github.com:o/other.git', 'different repo'], ['git@github.com:someone/r.git', 'different owner'], ['ssh://git@ghe.example.com/o/r.git', 'different host']]) {
      git(fx.repoRoot, ['config', 'remote.origin.pushurl', pushurl]);
      assert.equal(await codeOf(() => phaseA(buildCtx(fx))), 'remote-url-split', why);
    }
  } finally { fx.cleanup(); }
  // The race: a post-audit url.<prefix>.insteadOf against the post-push ls-remote still resolves to the pinned endpoint.
  const w = await world();
  try {
    const runner = createGitRunner(w.ctx);
    const head = git(w.fx.repoRoot, ['rev-parse', 'HEAD']);
    assert.equal((await runner.net(['push', w.pinnedUrl, `${head}:refs/heads/x`])).status, 0);
    git(w.fx.repoRoot, ['config', `url.${w.evilPrefix}.insteadOf`, w.prefix]); // planted between the push and its verification
    assert.equal(await runner.lsRemoteOid(w.pinnedUrl, 'refs/heads/x'), head, 'the post-push ls-remote reads the PINNED endpoint');
    assert.equal(w.refIn(w.evilBare, 'refs/heads/x'), null);
    const plain = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'ls-remote', '--get-url', w.pinnedUrl], { env: { PATH: process.env.PATH, HOME: w.fx.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
    assert.equal(plain.stdout.trim(), `${w.evilPrefix}pinned.git`, 'without the identity rows the same fixture redirects to the evil remote');
    const bound = spawnSync(REAL.git, ['-C', w.fx.repoRoot, 'ls-remote', '--get-url', w.pinnedUrl], { env: runner.overlayEnv(), encoding: 'utf8' });
    assert.equal(bound.stdout.trim(), w.pinnedUrl, 'under the bound table the exact-URL identity row wins');
  } finally { w.cleanup(); }
}
test('AC142: url=git@github.com:o/r.git with pushurl=ssh://git@github.com/o/r.git canonicalize to one string and are accepted; a different owner, repo or host is remote-url-split; the bound table has seven rows including url.<pushUrl>.insteadOf; a post-audit prefix rewrite against the post-push ls-remote still resolves to the pinned endpoint', ac142_fetchAndPushUrlsAreOneString);
