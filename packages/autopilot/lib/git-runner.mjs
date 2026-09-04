// The three git spawners (spec §9.1b, §9.1c, §6.0; AC 31, 124, 126, 127, 138, 143).
//
//   local(cwd, args)   — `git -C <cwd> …` with the sanitized base env only (no overlay)
//   net(args)          — `git --git-dir=<NET_GIT> …` with the bound overlay + GIT_SSH;
//                        re-verifies NET_GIT, the SSH material and the observed
//                        remote URL immediately BEFORE the spawn and throws on tamper
//   observe(key)       — `git config --file <REPO_ROOT>/.git/config --get <key>`,
//                        the unoverlaid identity read (§9.1a)
//
// No network operation ever runs against the primary repository's own
// configuration, and no spawn ever inherits the orchestrator's environment.

import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { DEADLINES, withRetry } from './spawn.mjs';
import { gitBaseEnv, stripGitVars, networkGitEnv, boundGitConfig, verifyNetGit, netGitArgv } from './git-env.mjs';
import { revalidateSshMaterial, listAgentKeys } from './ssh.mjs';
import { validateOid, isUnder } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'gitRunner.inheritEnv',          // spawns inherit the orchestrator's (seeded) environment
  'gitRunner.noOverlay',           // net() carries no GIT_CONFIG_* identity table
  'gitRunner.identityRowsDropped', // the overlay omits the identity-rewrite rows entirely
  'gitRunner.skipRevalidation',    // net() skips the NET_GIT / ssh / remote-URL re-checks
  'gitRunner.skipIdentityCheck',   // assertIdentity never fails
  'gitRunner.overlayObserve',      // observe() reads with the overlay and without --file (echoes the pin back)
  'gitRunner.noGitSsh',            // net()/overlay carry neither GIT_SSH nor the core.sshCommand row
]);

export class GitError extends Error {
  constructor(code, detail, res = null) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.res = res; this.exitCode = 1; }
}

const NETWORK_VERBS = new Set(['ls-remote', 'fetch', 'push']);
const RETRIED_VERBS = new Set(['ls-remote', 'fetch']);

/**
 * @param ctx  needs: spawn, pinned.git, env.{path,home,base}, repoRoot, netGit,
 *             netGitConfigSha256, remote.{remoteFetchUrl,remotePushUrl,observed},
 *             ssh (material), inherited (the orchestrator env snapshot), sleep?
 */
export function createGitRunner(ctx) {
  const git = () => ctx.pinned.git;
  const baseEnv = () => {
    const base = gitBaseEnv({ path: ctx.env.path, home: ctx.env.home, lang: ctx.env.base?.LANG, tz: ctx.env.base?.TZ });
    // Mutation seam `gitRunner.inheritEnv`: the orchestrator's environment leaks into every git child
    // (defence in depth strips the §9.1b names even then — the isolation trio itself is re-applied last).
    if (active('gitRunner.inheritEnv')) return { ...(ctx.inherited ?? {}), ...base };
    return { ...stripGitVars(ctx.env.base ?? {}), ...base };
  };
  const overlay = () => {
    const base = baseEnv();
    if (active('gitRunner.noOverlay')) return { ...base, GIT_SSH: ctx.ssh.wrapperPath };
    const env = networkGitEnv({ base, remoteFetchUrl: ctx.remote.remoteFetchUrl, remotePushUrl: ctx.remote.remotePushUrl, sshWrapperPath: ctx.ssh.wrapperPath });
    if (active('gitRunner.noGitSsh')) { delete env.GIT_SSH; delete env.GIT_CONFIG_KEY_6; delete env.GIT_CONFIG_VALUE_6; env.GIT_CONFIG_COUNT = '6'; }
    if (active('gitRunner.identityRowsDropped')) {
      const { rows } = boundGitConfig({ remoteFetchUrl: ctx.remote.remoteFetchUrl, remotePushUrl: ctx.remote.remotePushUrl, sshWrapperPath: ctx.ssh.wrapperPath });
      const kept = rows.filter((_, i) => i < 3 || i > 5);
      for (let i = 0; i < rows.length; i++) { delete env[`GIT_CONFIG_KEY_${i}`]; delete env[`GIT_CONFIG_VALUE_${i}`]; }
      env.GIT_CONFIG_COUNT = String(kept.length);
      kept.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    }
    return env;
  };

  function local(cwd, args, { deadlineMs = DEADLINES.git, stdinBytes, label, stdoutCap } = {}) {
    if (NETWORK_VERBS.has(args[0])) {
      // A local spawn may fetch ONLY from NET_GIT (the file-transport import of §6.0); every other
      // ls-remote/fetch/push must go through net(), never against the primary configuration.
      const remote = args.slice(1).find((a) => !a.startsWith('-'));
      if (args[0] !== 'fetch' || remote !== ctx.netGit) throw new GitError('network-op-outside-net-git', `${args[0]} ${remote ?? ''} must go through net()`);
    }
    return ctx.spawn({ argv: [git(), '-C', cwd, ...args], cwd, env: baseEnv(), deadlineMs, stdinBytes, stdoutCap, label: label ?? `git ${args[0]}` });
  }

  async function localOut(cwd, args, opts) {
    const res = await local(cwd, args, opts);
    if (res.status !== 0) throw new GitError('git-failed', `git ${args.join(' ')} exited ${res.status}: ${String(res.stderr ?? '').trim().slice(0, 300)}`, res);
    if (res.truncated) throw new GitError('git-failed', `git ${args.join(' ')}: stdout truncated`, res);
    return res.stdout.trim();
  }

  async function observe(key) {
    // Mutation seam `gitRunner.overlayObserve`: the read carries the bound overlay and no --file, so it echoes the pin back.
    const mutated = active('gitRunner.overlayObserve');
    const env = mutated ? overlay() : baseEnv();
    const argv = mutated ? [git(), '-C', ctx.repoRoot, 'config', '--get', key] : [git(), 'config', '--file', join(ctx.repoRoot, '.git', 'config'), '--get', key];
    const res = await ctx.spawn({ argv, cwd: ctx.repoRoot, env, deadlineMs: DEADLINES.git, label: `git config --get ${key}` });
    if (res.status === 0) return res.stdout.trim();
    if (res.status === 1) return null;
    throw new GitError('git-failed', `git config --get ${key} exited ${res.status}`, res);
  }

  /** The three "immediately before" checks of §9.1a/§9.1c/§9.4a. */
  async function preSpawnChecks() {
    if (active('gitRunner.skipRevalidation')) return;
    const v = verifyNetGit({ netGit: ctx.netGit, expectedConfigSha256: ctx.netGitConfigSha256, repoRoot: ctx.repoRoot });
    if (!v.ok) throw new GitError(v.code, v.detail);
    let agentKeyLines = null;
    if (ctx.ssh?.mode === 'agent') {
      const agent = await listAgentKeys({ spawn: ctx.spawn, pinned: ctx.pinned, agentSock: ctx.ssh.agentSock, env: baseEnv() });
      agentKeyLines = agent.ok ? agent.lines : [];
    }
    const s = revalidateSshMaterial(ctx.ssh, { agentKeyLines });
    if (!s.ok) throw new GitError(s.code, s.detail);
    const observed = ctx.remote?.observed;
    if (!observed || typeof observed.fetch !== 'string') throw new GitError('remote-url-changed', 'no observed remote URL was recorded at phase A');
    const fetchNow = await observe('remote.origin.url');
    const pushNow = (await observe('remote.origin.pushurl')) ?? fetchNow;
    if (fetchNow !== observed.fetch || pushNow !== (observed.push ?? observed.fetch)) throw new GitError('remote-url-changed', 'the repository remote configuration changed since phase A');
  }

  async function net(args, { retry = true, label } = {}) {
    const verb = args[0];
    if (!NETWORK_VERBS.has(verb)) throw new GitError('bad-net-verb', `${verb} is not a network operation`);
    await preSpawnChecks();
    const attempt = () => ctx.spawn({ argv: netGitArgv(git(), ctx.netGit, ...args), cwd: ctx.repoRoot, env: overlay(), deadlineMs: DEADLINES.gitNetwork, label: label ?? `git ${verb}` });
    if (verb === 'push' || retry === false || !RETRIED_VERBS.has(verb)) return attempt();
    return withRetry(attempt, { sleep: ctx.sleep });
  }

  /** `ls-remote <url> <ref>` → the OID at that ref, or null when absent. */
  async function lsRemoteOid(url, ref) {
    const res = await net(['ls-remote', url, ref]);
    if (res.status !== 0) throw new GitError('ls-remote-failed', String(res.stderr ?? '').trim().slice(0, 200), res);
    const line = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith(`\t${ref}`));
    return line ? validateOid(line.split('\t')[0], { field: 'ls-remote' }) : null;
  }

  /** §9.1b: `git -C <cwd> rev-parse --show-toplevel` equals the expected tree and the git dir lies under REPO_ROOT/.git. */
  async function assertIdentity(cwd, expectedTop) {
    if (active('gitRunner.skipIdentityCheck')) return true;
    const real = (p) => { try { return realpathSync(p); } catch { return p; } };
    const top = await localOut(cwd, ['rev-parse', '--show-toplevel']);
    if (real(top) !== real(expectedTop)) throw new GitError('repo-identity-mismatch', `${cwd} resolves to ${top}, expected ${expectedTop}`);
    const gitDir = await localOut(cwd, ['rev-parse', '--absolute-git-dir']);
    if (!isUnder(join(real(ctx.repoRoot), '.git'), real(gitDir))) throw new GitError('repo-identity-mismatch', `git dir ${gitDir} is not under ${ctx.repoRoot}/.git`);
    return true;
  }

  return { local, localOut, net, observe, overlayEnv: overlay, baseEnv, lsRemoteOid, assertIdentity };
}
