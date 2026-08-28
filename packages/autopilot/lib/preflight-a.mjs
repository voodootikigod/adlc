// Preflight phase A (spec §9.1, §9.1a, §9.1b, §9.1c, §9.3, §9.4a, §9.5;
// AC 11, 119, 124, 129, 136, 145, 148, 153, 159).
//
// Phase A needs no baseline and runs BEFORE `BASE_OID` is resolved: it is
// what makes the fetch itself trustworthy — pinned tools, a secure key file,
// the operator-local repository identity, the observed remote bound to it,
// the gh host/principal, the repo-local config audit, NET_GIT, the SSH
// material, the labels and the exclude entries. Every failure is a
// PreflightError whose `code` is the spec's reason; nothing network-bound
// has been spawned when phase A fails.

import { lstatSync, statSync, readFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pinToolchain } from './tools.mjs';
import { createGh } from './github.mjs';
import { bindRemote, verifyGhHost, assertHostMatches, assertPrincipalAuthorized } from './remote.mjs';
import { auditRepoConfig, verifyNetGit } from './git-env.mjs';
import { createGitRunner } from './git-runner.mjs';
import { resolveAuthMode, prepareSshMaterial, fetchRegisteredKeys, createDryRunSshDir } from './ssh.mjs';
import { missingLabels } from './labels.mjs';
import { EXCLUDE_ENTRIES } from './paths.mjs';
import { validateToken } from './input.mjs';
import { PreflightError, asPreflightError } from './preflight-common.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'preflight.skipKeyFileCheck',    // .env.local is never inspected
  'preflight.skipConfigAudit',     // the repo-local config audit is skipped
  'preflight.skipHostBinding',     // gh host / principal binding is skipped
  'preflight.ignoreMissingLabels', // absent labels do not fail phase A
  'preflight.ignoreExclude',       // missing .git/info/exclude entries do not fail phase A
  'preflight.anyModelFamily',      // an underivable model family passes
  'preflight.trustInheritedTools', // tools are taken from the first PATH hit with no trust check
]);

const PERM = (m) => m & 0o7777;
export const MODEL_FAMILIES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);

/** The model family of an alias or full id, or null (§3.1 → `model-unknown`). */
export function modelFamily(model) {
  const s = String(model ?? '').toLowerCase();
  return MODEL_FAMILIES.find((f) => s === f || s.includes(f)) ?? null;
}

/**
 * §9.3: `<REPO_ROOT>/.env.local` is a regular file (not a symlink), owned by
 * the invoking uid, mode exactly 0600, its parent not group/world-writable,
 * and the key value non-empty. Otherwise `key-file-insecure`.
 */
export function checkKeyFile({ repoRoot, key, uid, lstat = lstatSync, stat = statSync }) {
  if (active('preflight.skipKeyFileCheck')) return true;
  const fail = (d) => { throw new PreflightError('key-file-insecure', d); };
  if (typeof key !== 'string' || key.length === 0) fail('ADLC_MANIFEST_KEY is empty');
  const p = join(repoRoot, '.env.local');
  let st;
  try { st = lstat(p); } catch (e) { fail(`${p}: ${e.message}`); }
  if (st.isSymbolicLink()) fail(`${p} is a symlink`);
  if (!st.isFile()) fail(`${p} is not a regular file`);
  if (st.uid !== uid) fail(`${p} is owned by uid ${st.uid}, not ${uid}`);
  if (PERM(st.mode) !== 0o600) fail(`${p} mode is ${PERM(st.mode).toString(8)}, expected 600`);
  let parent;
  try { parent = stat(repoRoot); } catch (e) { fail(`${repoRoot}: ${e.message}`); }
  if (parent.mode & (constants.S_IWGRP | constants.S_IWOTH)) fail(`${repoRoot} is group- or world-writable`);
  return true;
}

/** `.git/info/exclude` must carry every EXCLUDE_ENTRIES line (§10). */
export function checkExclude({ repoRoot, readFile = (p) => readFileSync(p, 'utf8') }) {
  if (active('preflight.ignoreExclude')) return [];
  let text = '';
  try { text = readFile(join(repoRoot, '.git', 'info', 'exclude')); } catch { text = ''; }
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  const missing = EXCLUDE_ENTRIES.filter((e) => !lines.has(e));
  if (missing.length) throw new PreflightError('exclude-missing', missing.join(', '));
  return missing;
}

function pinTools(ctx) {
  if (ctx.pinned && ctx.env.path) return;
  const uid = ctx.uid ?? process.getuid();
  let r;
  const opts = { pathValue: ctx.inherited?.PATH ?? '', repoRoot: ctx.repoRoot, uid, trustedBinDirs: ctx.local?.trustedBinDirs ?? null, ...(ctx.toolchain ?? {}) };
  // Mutation seam `preflight.trustInheritedTools`: the sanitized search list and the ownership check are skipped.
  if (active('preflight.trustInheritedTools')) opts.repoRoot = null, opts.stat = () => ({ uid, mode: 0o755 }), opts.realpath = (p) => p;
  try { r = pinToolchain(opts); }
  catch (e) { throw asPreflightError(e, 'untrusted-tool'); }
  ctx.pinned = { ...r.pinned, specLintBin: join(ctx.repoRoot, 'packages', 'spec-lint', 'bin', 'spec-lint.mjs') };
  ctx.env.path = r.path;
  ctx.env.base = { ...(ctx.env.base ?? {}), PATH: r.path, HOME: ctx.env.home };
}

async function bindRepository(ctx) {
  const expectedRepo = ctx.local?.repo ?? null;
  if (!expectedRepo) throw new PreflightError('repo-unbound', '--repo / ADLC_AUTOPILOT_REPO is required before any git or gh spawn');
  const fetch = await ctx.git.observe('remote.origin.url');
  const push = await ctx.git.observe('remote.origin.pushurl');
  let bound;
  try { bound = bindRemote({ expectedRepo, observedFetchUrl: fetch, observedPushUrl: push ?? fetch }); }
  catch (e) { throw asPreflightError(e, 'repo-mismatch'); }
  ctx.remote = { ...bound, observed: { fetch, push: push ?? fetch }, principal: null };
}

async function bindPrincipal(ctx) {
  const { host, repo } = ctx.remote;
  ctx.gh = ctx.gh ?? createGh({ spawn: ctx.spawn, gh: ctx.pinned.gh, host, repo, env: ctx.env.base, cwd: ctx.repoRoot, sleep: ctx.sleep });
  if (active('preflight.skipHostBinding')) { ctx.remote.principal = 'unbound'; return; }
  const auth = await ctx.gh.run(['auth', 'status', '--hostname', host, '--active', '--json', 'hosts']);
  if (auth.status !== 0) throw new PreflightError('gh-host-unbound', `gh auth status exited ${auth.status}`);
  let user;
  try { user = await ctx.gh.json(['api', 'user']); } catch (e) { throw new PreflightError('gh-host-unbound', `gh api user: ${e.message}`); }
  const login = typeof user?.login === 'string' ? user.login : null;
  if (!login) throw new PreflightError('gh-host-unbound', 'gh api user returned no login');
  // The URL's host must be the host gh is authenticated against: an auth document that carries a live entry
  // for ANOTHER host but none for the pinned one is a host mismatch, not merely an unbound gh.
  let doc = null;
  try { doc = JSON.parse(auth.stdout); } catch { doc = null; }
  const live = Object.entries(doc?.hosts ?? {}).filter(([, v]) => Array.isArray(v) && v.some((e) => e?.state === 'success' && e?.active === true)).map(([h]) => h.toLowerCase());
  if (live.length && !live.includes(host.toLowerCase())) throw new PreflightError('remote-host-mismatch', `pinned URL host ${host} is not the authenticated gh host (${live.join(', ')})`);
  try { verifyGhHost({ authStatusJson: auth.stdout, host, principalLogin: login }); assertHostMatches(ctx.remote.host, host); }
  catch (e) { throw asPreflightError(e, 'gh-host-unbound'); }
  let perm;
  try { perm = await ctx.gh.json(['api', `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`]); } catch (e) { throw new PreflightError('principal-unauthorized', e.message); }
  try { assertPrincipalAuthorized(perm?.permission); } catch (e) { throw asPreflightError(e, 'principal-unauthorized'); }
  let view;
  try { view = await ctx.gh.json(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']); } catch (e) { throw new PreflightError('repo-mismatch', e.message); }
  if (String(view?.nameWithOwner ?? '').toLowerCase() !== repo.toLowerCase()) throw new PreflightError('repo-mismatch', `gh repo view reports ${view?.nameWithOwner}, expected ${repo}`);
  if (view?.defaultBranchRef?.name !== 'main') throw new PreflightError('repo-mismatch', `default branch is ${view?.defaultBranchRef?.name}, expected main`);
  ctx.remote.principal = login;
  ctx.remote.permission = perm.permission;
}

async function auditConfig(ctx) {
  if (active('preflight.skipConfigAudit')) return;
  const list = await ctx.git.local(ctx.repoRoot, ['config', '--file', join(ctx.repoRoot, '.git', 'config'), '--list'], { label: 'git config --list' });
  if (list.status !== 0) throw new PreflightError('git-config-untrusted', 'repo-local config unreadable');
  const audit = auditRepoConfig(list.stdout);
  if (!audit.ok) throw new PreflightError('git-config-untrusted', audit.offending.join(', '));
  const net = verifyNetGit({ netGit: ctx.netGit, expectedConfigSha256: ctx.netGitConfigSha256, repoRoot: ctx.repoRoot });
  if (!net.ok) throw new PreflightError(net.code, net.detail);
}

async function bindSsh(ctx) {
  const sock = ctx.inherited?.SSH_AUTH_SOCK ?? null;
  const isSocket = (p) => { try { return lstatSync(p).isSocket(); } catch { return false; } };
  let mode;
  try { mode = resolveAuthMode({ sshIdentity: ctx.local?.sshIdentity ?? null, sshAuthSock: sock, socketExists: ctx.fs?.socketExists ?? isSocket }); }
  catch (e) { throw asPreflightError(e, 'ssh-auth-missing'); }
  const registered = await fetchRegisteredKeys(ctx.gh);
  if (!registered.ok) throw new PreflightError('ssh-identity-unbound', registered.detail);
  let dir;
  if (ctx.dryRun) { const t = createDryRunSshDir({ env: ctx.inherited ?? {}, repoRoot: ctx.repoRoot, runsDir: ctx.paths.runsDir }); ctx.sshDryRunParent = t.parent; dir = t.dir; }
  else dir = ctx.paths.sshDir(validateToken(ctx.iterationToken, 'iteration-token'));
  try {
    ctx.ssh = await prepareSshMaterial({ ctx, dir, mode, identityPath: ctx.local?.sshIdentity ?? null, agentSock: mode === 'agent' ? sock : null, knownHostsSource: ctx.paths.knownHosts, registeredKeys: registered.keys });
  } catch (e) { throw asPreflightError(e, 'ssh-identity-unbound'); }
  ctx.log?.(`ssh: ${mode} mode, bound key ${ctx.ssh.fingerprint}`);
}

/** Phase A. Mutates and returns ctx; throws PreflightError. */
export async function phaseA(ctx) {
  const uid = ctx.uid ?? process.getuid();
  pinTools(ctx);
  checkKeyFile({ repoRoot: ctx.repoRoot, key: ctx.key, uid, lstat: ctx.fs?.lstat, stat: ctx.fs?.stat });
  if (!active('preflight.anyModelFamily') && !modelFamily(ctx.local?.model)) throw new PreflightError('model-unknown', String(ctx.local?.model));
  if (!ctx.local?.adapterSupported) throw new PreflightError('adapter-unsupported', String(ctx.local?.adapter));
  ctx.netGit = ctx.netGit ?? ctx.paths.netGit;
  ctx.git = ctx.git ?? createGitRunner(ctx);
  await bindRepository(ctx);
  await bindPrincipal(ctx);
  await auditConfig(ctx);
  await bindSsh(ctx);
  let missing;
  try { missing = await missingLabels(ctx.gh); } catch (e) { throw asPreflightError(e, 'labels-missing'); }
  if (missing.length && !active('preflight.ignoreMissingLabels')) throw new PreflightError('labels-missing', missing.join(', '));
  checkExclude({ repoRoot: ctx.repoRoot, readFile: ctx.fs?.readFile });
  ctx.phaseA = { ok: true, remote: ctx.remote, sshMode: ctx.ssh.mode, fingerprint: ctx.ssh.fingerprint };
  return ctx;
}
