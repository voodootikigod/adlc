// AC 11 / 20 / 31 / 86 / 116 / 117 / 119 / 120 / 124 / 129 / 133 / 136 / 145 /
// 148 / 153 / 158 / 159 — preflight phase A, the pinned baseline and phase B
// over a REAL temporary repository with fake gh/adlc/network-git children on
// the shared spawn recorder. The §14 spec-approval binding is in
// preflight-spec.test.mjs.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync, symlinkSync, unlinkSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { phaseA, resolveBaseline, phaseB, installedPluginVersion, tokenMargin, cleanupPreflight, checkKeyFile } from '../lib/preflight.mjs';
import { KEY_BEARING_ARGV } from '../lib/keys.mjs';
import { makeFixture, buildCtx, git, listenSocket, codeOf, netSpawns, gitSpawns, PINNED, exampleConfig } from './helpers/preflight-ctx.mjs';

const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const keyBearing = (rec) => rec.filter((r) => 'ADLC_MANIFEST_KEY' in r.env);
async function full(ctx, opts = {}) { await phaseA(ctx); await resolveBaseline(ctx); return phaseB(ctx, opts); }
const stat = (uid, mode) => ({ lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, uid, mode }), stat: () => ({ mode: 0o40755 }) });

export async function ac11_redFixturesPerItem() {
  const fx = makeFixture();
  try {
    const envLocal = join(fx.repoRoot, '.env.local');
    const cases = [
      ['symlink', () => { unlinkSync(envLocal); writeFileSync(join(fx.root, 'real.env'), 'x', { mode: 0o600 }); symlinkSync(join(fx.root, 'real.env'), envLocal); }, {}],
      ['mode 0640', () => chmodSync(envLocal, 0o640), {}],
      ['other uid (injected stat)', () => {}, { fs: stat(process.getuid() + 1, 0o100600) }],
      ['empty key', () => {}, { key: '' }],
    ];
    for (const [name, mutate, extra] of cases) {
      const ctx = buildCtx(fx, extra); if ('key' in extra) ctx.key = extra.key;
      mutate();
      assert.equal(await codeOf(() => phaseA(ctx)), 'key-file-insecure', name);
      assert.equal(keyBearing(ctx.recorder).length, 0, `${name}: zero key-bearing spawns`);
      assert.equal(ctx.recorder.filter((r) => r.argv[0] === PINNED.gh || r.argv[0] === PINNED.git).length, 0, `${name}: the key file is checked before any git/gh spawn`);
      unlinkSync(envLocal); writeFileSync(envLocal, 'ADLC_MANIFEST_KEY=x\n', { mode: 0o600 }); chmodSync(envLocal, 0o600);
    }
    assert.equal(checkKeyFile({ repoRoot: fx.repoRoot, key: 'k', uid: process.getuid(), stat: () => ({ mode: 0o40777 }) }) === true, false, 'never reached'); // group/world-writable parent throws
  } catch (e) { if (e.code !== 'key-file-insecure') throw e; }
  finally { fx.cleanup(); }
  const items = [
    [{ pluginVersion: '1.11.0', installedVersion: '1.7.0' }, {}, 'plugin-parity'],
    [{}, { gh: { labels: ['adlc:autopilot'] } }, 'labels-missing'],
    [{}, { local: { model: 'gpt-5' } }, 'model-unknown'],
    [{}, { local: { adapter: 'codex', adapterSupported: false } }, 'adapter-unsupported'],
    [{}, { local: { sshIdentity: null } }, 'ssh-auth-missing'],
    [{}, { gh: { permission: 'read' } }, 'principal-unauthorized'],
  ];
  for (const [fxOpts, ctxOpts, code] of items) {
    const f = makeFixture(fxOpts);
    try { const ctx = buildCtx(f, ctxOpts); assert.equal(await codeOf(() => full(ctx)), code, code); assert.equal(keyBearing(ctx.recorder).length, 0, `${code}: no key-bearing spawn`); }
    finally { f.cleanup(); }
  }
  const f2 = makeFixture();
  try {
    writeFileSync(join(f2.repoRoot, '.git', 'info', 'exclude'), '');
    assert.equal(await codeOf(() => phaseA(buildCtx(f2))), 'exclude-missing');
    unlinkSync(f2.paths.knownHosts);
    assert.equal(await codeOf(() => phaseA(buildCtx(f2))), 'known-hosts-missing');
  } finally { f2.cleanup(); }
  assert.equal(KEY_BEARING_ARGV.length, 7);
}
test('AC11: every §9 item has a red fixture naming it — a symlinked / 0640 / foreign-uid .env.local or an empty key → key-file-insecure with zero key-bearing spawns; plugin-parity 1.7.0 vs 1.11.0; labels-missing, exclude-missing, known-hosts-missing, model-unknown, adapter-unsupported, ssh-auth-missing, principal-unauthorized', ac11_redFixturesPerItem);

export async function ac119_identityIsOperatorLocal() {
  const fx = makeFixture();
  try {
    const none = buildCtx(fx, { local: { repo: null } });
    assert.equal(await codeOf(() => phaseA(none)), 'repo-unbound');
    assert.equal(none.recorder.length, 0, 'repo-unbound before ANY git or gh spawn');
    const ctx = buildCtx(fx);
    await phaseA(ctx);
    assert.deepEqual([ctx.remote.remoteFetchUrl, ctx.remote.remotePushUrl, ctx.remote.host, ctx.remote.repo], ['git@github.com:o/r.git', 'git@github.com:o/r.git', 'github.com', 'o/r']);
    const observe = ctx.recorder.filter((r) => r.argv[0] === PINNED.git && r.argv[1] === 'config');
    assert.ok(observe.length >= 2 && observe.every((r) => r.argv.includes('--file') && r.env.GIT_CONFIG_COUNT === undefined), 'the identity is observed with the unoverlaid --file read');
    const other = makeFixture({ config: exampleConfig('o/other') }); // the pinned blob's autopilot.repo differs from the operator-local value
    try { const c2 = buildCtx(other); await phaseA(c2); await resolveBaseline(c2); assert.equal(await codeOf(() => phaseB(c2)), 'repo-mismatch', 'repo-mismatch in phase B'); }
    finally { other.cleanup(); }
  } finally { fx.cleanup(); }
}
test('AC119: without --repo/ADLC_AUTOPILOT_REPO phase A exits repo-unbound before any spawn; with it the observed URLs are bound; a pinned-blob autopilot.repo that differs → repo-mismatch in phase B', ac119_identityIsOperatorLocal);

export async function ac117_phasesAreOrdered() {
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx);
    const r = await full(ctx);
    assert.equal(r.complete, true, JSON.stringify(r.incomplete));
    const argvs = ctx.recorder.map((x) => x.argv);
    const ls = argvs.findIndex((a) => a[0] === PINNED.git && a[2] === 'ls-remote');
    const fetch = argvs.findIndex((a) => a[0] === PINNED.git && a[2] === 'fetch');
    const shows = argvs.map((a, i) => [a, i]).filter(([a]) => a[0] === PINNED.git && a[3] === 'show');
    assert.ok(ls > 0 && fetch > ls && shows.length >= 3);
    const phaseAKinds = ['config', 'auth', 'api', 'repo'];
    for (let i = 0; i < ls; i++) assert.ok(phaseAKinds.some((k) => argvs[i].includes(k)) || /ssh-/.test(argvs[i][0]), `spawn ${i} is a phase-A check: ${argvs[i].slice(0, 3).join(' ')}`);
    for (const [a, i] of shows) { assert.ok(i > fetch, 'every phase-B git show comes after the fetch'); assert.ok(a[4].startsWith(`${fx.baseOid}:`), `reads ${a[4]} at the ls-remote OID`); }
    const noBase = buildCtx(fx); await phaseA(noBase);
    assert.equal(await codeOf(() => phaseB(noBase)), 'base-unresolved');
    assert.equal(noBase.recorder.filter((x) => x.argv[3] === 'show').length, 0, 'no baseline → zero reads, never the working tree');
    const failing = buildCtx(fx, { net: (a) => (a[0] === 'ls-remote' ? { stdout: '', status: 2 } : undefined) });
    await phaseA(failing);
    assert.equal(await codeOf(() => resolveBaseline(failing)), 'base-unresolved');
    assert.equal(failing.recorder.filter((x) => x.argv[3] === 'show' || x.argv[0] === PINNED.adlc).length, 0, 'an ls-remote failure yields zero phase-B reads and zero dispatches');
  } finally { fx.cleanup(); }
}
test('AC117: every phase-A spawn precedes the ls-remote and every phase-B git show <oid>:… follows the fetch with the ls-remote OID; phase B without a baseline throws base-unresolved; an ls-remote failure yields zero phase-B reads', ac117_phasesAreOrdered);

export async function ac31_baselineByOid() {
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx); await phaseA(ctx);
    const oid = await resolveBaseline(ctx);
    assert.equal(oid, fx.baseOid); assert.equal(ctx.baseOid, oid);
    const g = gitSpawns(ctx.recorder).map((r) => r.argv.slice(1)).filter((a) => ['ls-remote', 'fetch', 'cat-file'].includes(a[1]) || ['ls-remote', 'fetch', 'cat-file'].includes(a[2]));
    assert.deepEqual(g[0], [`--git-dir=${ctx.netGit}`, 'ls-remote', '--exit-code', 'git@github.com:o/r.git', 'refs/heads/main']);
    assert.deepEqual(g[1], [`--git-dir=${ctx.netGit}`, 'fetch', '--no-tags', 'git@github.com:o/r.git', oid], 'fetch BY OID through NET_GIT');
    assert.deepEqual(g[2], ['-C', fx.repoRoot, 'fetch', '--no-tags', ctx.netGit, oid], 'the local file-transport import');
    assert.deepEqual(g[3].slice(2), ['cat-file', '-e', `${oid}^{commit}`]);
    for (const r of netSpawns(ctx.recorder)) assert.ok(!r.argv.includes('main') && !r.argv.includes('FETCH_HEAD') && !r.argv.includes('origin'), 'never main / FETCH_HEAD / origin');
    const dry = buildCtx(fx, { dryRun: true }); await phaseA(dry); await resolveBaseline(dry);
    assert.deepEqual(netSpawns(dry.recorder).map((r) => r.argv[2]), ['ls-remote'], 'dry-run: ls-remote only, no fetch'); cleanupPreflight(dry);
  } finally { fx.cleanup(); }
}
test('AC31: the baseline is --git-dir=<NET_GIT> ls-remote --exit-code <url> refs/heads/main → fetch --no-tags <url> <40-hex> → -C <REPO_ROOT> fetch --no-tags <NET_GIT> <40-hex> → cat-file; never main/FETCH_HEAD/origin; dry-run stops after ls-remote', ac31_baselineByOid);

export async function ac20_baselineFailureIsUnresolved() {
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx, { net: (a) => (a[0] === 'fetch' ? { stdout: '', stderr: 'refused', status: 128 } : undefined) });
    await phaseA(ctx);
    assert.equal(await codeOf(() => resolveBaseline(ctx)), 'base-unresolved');
    assert.equal(ctx.baseOid, undefined, 'no baseline is recorded on failure');
    assert.equal(ctx.recorder.filter((r) => r.argv.includes('worktree') || r.argv[0] === PINNED.adlc).length, 0, 'zero worktree/dispatch calls');
  } finally { fx.cleanup(); }
}
test('AC20: a failed baseline fetch is base-unresolved with no recorded baseOid and zero worktree/dispatch calls', ac20_baselineFailureIsUnresolved);

export async function ac86_parityReadsBaseline() {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.repoRoot, 'plugins/adlc-claude-code/.claude-plugin/plugin.json'), '{"version":"9.9.9"}');
    git(fx.repoRoot, ['commit', '-qam', 'bump']); git(fx.repoRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const ctx = buildCtx(fx); const r = await full(ctx);
    assert.deepEqual(r.checks.pluginParity, { installed: '1.11.0', repo: '1.11.0' }, 'a local origin/main and working tree at 9.9.9 do not affect the verdict');
    const show = ctx.recorder.find((x) => x.argv[3] === 'show' && /plugin\.json$/.test(x.argv[4]));
    assert.deepEqual(show.argv.slice(3), ['show', `${fx.baseOid}:plugins/adlc-claude-code/.claude-plugin/plugin.json`]);
    assert.equal(installedPluginVersion({ plugins: { 'adlc@adlc': { version: '1.7.0' } } }), '1.7.0');
    assert.equal(installedPluginVersion({ plugins: [{ name: 'adlc@adlc', version: '1.7.0' }] }), '1.7.0');
    assert.equal(installedPluginVersion({ plugins: { 'adlc@adlc': [{ scope: 'user', version: '1.7.0' }, { scope: 'project', version: '1.11.0' }] } }), null, 'scopes that disagree are not a version');
    assert.equal(installedPluginVersion({ plugins: {} }), null);
    const mismatch = makeFixture({ installedVersion: '1.7.0', installedShape: 'array' });
    try { assert.equal(await codeOf(() => full(buildCtx(mismatch))), 'plugin-parity'); } finally { mismatch.cleanup(); }
  } finally { fx.cleanup(); }
}
test('AC86: plugin parity reads show <BASE_OID>:plugins/adlc-claude-code/.claude-plugin/plugin.json; a moved origin/main or working tree does not affect the verdict; both installed_plugins.json shapes are read; a mismatch → plugin-parity', ac86_parityReadsBaseline);

export async function ac116_configFromBlob() {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.repoRoot, '.adlc', 'config.json'), '{"autopilot":{"restMinutes":"nope"},"fleet":{}}');
    git(fx.repoRoot, ['commit', '-qam', 'break config']); git(fx.repoRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const ctx = buildCtx(fx); await phaseA(ctx); await resolveBaseline(ctx); const r = await phaseB(ctx);
    assert.equal(r.checks.config.repo, 'o/r');
    const show = ctx.recorder.find((x) => x.argv[3] === 'show' && /config\.json$/.test(x.argv[4]));
    assert.deepEqual(show.argv.slice(3), ['show', `${fx.baseOid}:.adlc/config.json`]);
    assert.equal(ctx.config.autopilot.restMinutes, 10);
    const bad = makeFixture({ config: { ...exampleConfig('o/r'), fleet: { gate: {} } } });
    try { const c = buildCtx(bad); assert.equal(await codeOf(() => full(c)), 'bad-config'); assert.equal(c.recorder.filter((x) => x.argv[0] === PINNED.adlc).length, 0, 'zero dispatches'); } finally { bad.cleanup(); }
  } finally { fx.cleanup(); }
}
test('AC116: the config read is show <baseOid>:.adlc/config.json; an invalid working-tree / origin/main config does not change the verdict; a blob failing either schema → bad-config with zero dispatches', ac116_configFromBlob);

export async function ac120_fleetDryRunWorktree() {
  const fx = makeFixture();
  try {
    const wt = fx.paths.preflightWorktree(fx.baseOid);
    mkdirSync(wt, { recursive: true }); writeFileSync(join(wt, 'stale'), 'leftover from a crash');
    writeFileSync(join(fx.repoRoot, '.adlc', 'config.json'), '{"fleet":"invalid working tree"}');
    const ctx = buildCtx(fx); await phaseA(ctx); await resolveBaseline(ctx); const r = await phaseB(ctx);
    assert.deepEqual(r.checks.fleetDryRun, { baseSha: fx.baseOid });
    const add = ctx.recorder.find((x) => x.argv[3] === 'worktree' && x.argv[4] === 'add');
    assert.deepEqual(add.argv.slice(3), ['worktree', 'add', '--detach', wt, fx.baseOid]);
    const fleet = ctx.recorder.find((x) => x.argv[0] === PINNED.adlc && x.argv[1] === 'fleet');
    assert.equal(fleet.cwd, wt, 'fleet dry-run runs with cwd = the preflight worktree');
    assert.equal(fleet.env.ADLC_MANIFEST_KEY, undefined); assert.equal(fleet.env.GIT_CONFIG_KEY_0, 'remote.origin.url', 'fleet inherits the bound git env');
    assert.equal(existsSync(wt), false, 'the temporary worktree is removed afterwards');
    const removes = ctx.recorder.filter((x) => x.argv[3] === 'worktree' && x.argv[4] === 'remove').map((x) => ctx.recorder.indexOf(x));
    assert.ok(removes[0] < ctx.recorder.indexOf(add), 'a stale worktree is removed BEFORE the add');
  } finally { fx.cleanup(); }
}
test('AC120: the fleet dry-run runs with cwd = <runs>/preflight-<baseOid> created by worktree add --detach … <baseOid>; an invalid working-tree config is irrelevant; a stale worktree is removed first and the worktree is removed afterwards', ac120_fleetDryRunWorktree);

export async function ac133_fleetDryRunBoundToOid() {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.repoRoot, 'moved'), 'x'); git(fx.repoRoot, ['add', 'moved']); git(fx.repoRoot, ['commit', '-qm', 'main moved']);
    assert.notEqual(git(fx.repoRoot, ['rev-parse', 'main']), fx.baseOid);
    const ctx = buildCtx(fx); await phaseA(ctx); await resolveBaseline(ctx); const r = await phaseB(ctx);
    const fleet = ctx.recorder.find((x) => x.argv[0] === PINNED.adlc && x.argv[1] === 'fleet');
    assert.deepEqual(fleet.argv.slice(1), ['fleet', 'run', '--dry-run', '--base', fx.baseOid, '--json']);
    assert.equal(r.checks.fleetDryRun.baseSha, fx.baseOid, 'main pointing elsewhere still reports baseSha == baseOid');
    const wrong = buildCtx(fx, { adlc: { override: (a) => (a[0] === 'fleet' ? { stdout: JSON.stringify({ baseSha: 'f'.repeat(40) }), status: 0 } : undefined) } });
    assert.equal(await codeOf(() => full(wrong)), 'fleet-dry-run-mismatch');
    assert.equal(existsSync(fx.paths.preflightWorktree(fx.baseOid)), false, 'removed even on failure');
  } finally { fx.cleanup(); }
}
test('AC133: the fleet dry-run argv carries --base <baseOid>; a moved main still reports baseSha == baseOid; a fake reporting another baseSha fails phase B', ac133_fleetDryRunBoundToOid);

export async function ac158_tokenMargin() {
  const now = Date.now();
  const short = makeFixture({ credentialsExpiresInMs: 100 * 60_000, now });
  try {
    const ctx = buildCtx(short, { now: () => now }); const r = await full(ctx);
    assert.equal(r.tokenShort, true, '100 min away vs a 90-min wall clock + 30 min margin is short');
    assert.equal(ctx.recorder.filter((x) => x.argv[0] === PINNED.claude).length, 0, 'phase B records tokenShort and spawns nothing');
    assert.equal(tokenMargin({ credentialsText: JSON.stringify({ claudeAiOauth: { expiresAt: now + 8 * 3_600_000 } }), now, wallClockMs: 90 * 60_000 }).tokenShort, false, '8 hours left');
    assert.equal(tokenMargin({ credentialsText: 'garbage', now, wallClockMs: 1 }).reason, 'credentials-unreadable', 'unreadable is short (fail closed)');
    assert.equal(tokenMargin({ credentialsText: JSON.stringify({ claudeAiOauth: { expiresAt: now + 120 * 60_000 } }), now, wallClockMs: 90 * 60_000 }).tokenShort, false, 'exactly wall + 30 is enough');
  } finally { short.cleanup(); }
}
test('AC158: a credential fixture expiring in 100 minutes with a 90-minute wall clock → phase B records tokenShort and spawns nothing; 8 hours → not short; an unreadable file is short', ac158_tokenMargin);

export async function ac148_hostBindingInPhaseA() {
  const ghe = makeFixture({ originUrl: 'git@ghe.example.com:o/r.git' });
  try { assert.equal(await codeOf(() => phaseA(buildCtx(ghe))), 'remote-host-mismatch'); } finally { ghe.cleanup(); }
  const fx = makeFixture();
  try {
    const variants = [{ hosts: {} }, { hosts: { 'github.com': [{ state: 'error', active: true, login: 'octo' }] } }, { hosts: { 'github.com': [{ state: 'success', active: true, login: 'someone' }] } }];
    for (const v of variants) {
      const ctx = buildCtx(fx, { gh: { override: (a) => (a[0] === 'auth' ? { stdout: JSON.stringify(v), status: 0 } : undefined) } });
      assert.equal(await codeOf(() => phaseA(ctx)), 'gh-host-unbound', JSON.stringify(v));
      assert.equal(netSpawns(ctx.recorder).length, 0);
    }
    const ok = buildCtx(fx); await phaseA(ok);
    const auth = ok.recorder.find((x) => x.argv[0] === PINNED.gh && x.argv[1] === 'auth');
    assert.deepEqual(auth.argv.slice(1), ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts']);
    assert.equal(ok.remote.principal, 'octo');
  } finally { fx.cleanup(); }
}
test('AC148: git@ghe.example.com against a github.com auth → remote-host-mismatch; empty hosts, state error or a mismatched login → gh-host-unbound before any network spawn; the accepted argv is auth status --hostname <host> --active --json hosts', ac148_hostBindingInPhaseA);

export async function ac124_auditBeforeLsRemote() {
  for (const [k, v] of [['url.https://evil/.insteadOf', 'git@github.com:'], ['core.sshCommand', 'ssh -o ProxyCommand=x'], ['credential.helper', 'store'], ['http.proxy', 'http://p'], ['includeIf.gitdir:/x.path', '/y'], ['http.sslVerify', 'false']]) {
    const fx = makeFixture();
    try {
      git(fx.repoRoot, ['config', k, v]);
      const ctx = buildCtx(fx);
      assert.equal(await codeOf(() => phaseA(ctx)), 'git-config-untrusted', k);
      assert.equal(netSpawns(ctx.recorder).length, 0, `${k}: before any ls-remote`);
    } finally { fx.cleanup(); }
  }
}
test('AC124/129: url.*.insteadOf, core.sshCommand, credential.helper, http.proxy, includeIf and http.sslVerify in the repo-local config → git-config-untrusted before any ls-remote', ac124_auditBeforeLsRemote);

export async function ac129_knownHostsAndWrapperOnNetSpawn() {
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx); await phaseA(ctx); await resolveBaseline(ctx);
    for (const r of netSpawns(ctx.recorder)) {
      assert.equal(r.env.GIT_SSH, ctx.ssh.wrapperPath); assert.equal(r.env.GIT_SSH_COMMAND, undefined);
      const text = readFileSync(r.env.GIT_SSH, 'utf8');
      assert.ok(text.includes(`exec '${PINNED.ssh}' -F /dev/null -o StrictHostKeyChecking=yes -o 'UserKnownHostsFile="${ctx.ssh.knownHostsPath}"' -o IdentitiesOnly=yes -o BatchMode=yes`));
    }
    chmodSync(fx.paths.knownHosts, 0o644);
    assert.equal(await codeOf(() => phaseA(buildCtx(fx))), 'known-hosts-missing', 'a 0644 known_hosts');
  } finally { fx.cleanup(); }
}
test('AC129: every network spawn carries GIT_SSH naming the generated wrapper (pinned ssh, -F /dev/null, StrictHostKeyChecking, UserKnownHostsFile=<SSH_DIR>/known_hosts, IdentitiesOnly, BatchMode); a 0644 known_hosts → known-hosts-missing', ac129_knownHostsAndWrapperOnNetSpawn);

export async function ac136_modesInPhaseA() {
  const fx = makeFixture();
  const sock = await listenSocket(fx.root);
  try {
    const agent = buildCtx(fx, { local: { sshIdentity: null }, inherited: { SSH_AUTH_SOCK: sock.path } });
    await phaseA(agent);
    assert.match(readFileSync(agent.ssh.wrapperPath, 'utf8'), new RegExp(`IdentityAgent="${sock.path}"' -i '${agent.ssh.identityPubPath}'`));
    const explicit = buildCtx(fx); await phaseA(explicit);
    assert.match(readFileSync(explicit.ssh.wrapperPath, 'utf8'), new RegExp(`IdentityAgent=none -i '${explicit.ssh.dir}/identity'`));
    const neither = buildCtx(fx, { local: { sshIdentity: null } });
    assert.equal(await codeOf(() => phaseA(neither)), 'ssh-auth-missing'); assert.equal(netSpawns(neither.recorder).length, 0);
    const both = buildCtx(fx, { inherited: { SSH_AUTH_SOCK: sock.path } });
    assert.equal(await codeOf(() => phaseA(both)), 'ssh-mode-ambiguous');
    chmodSync(fx.keyPath, 0o644);
    assert.equal(await codeOf(() => phaseA(buildCtx(fx))), 'key-file-insecure', 'a 0644 identity');
    for (const c of [agent, explicit]) for (const r of c.recorder) assert.ok(!r.argv.some((a) => /IdentityAgent= /.test(a)));
  } finally { await sock.close(); fx.cleanup(); }
}
test('AC136: SSH_AUTH_SOCK naming a live socket → IdentityAgent=<sock> -i <dir>/identity.pub; --ssh-identity → IdentityAgent=none -i <dir>/identity; neither → ssh-auth-missing before any network spawn; both → ssh-mode-ambiguous; a 0644 identity → key-file-insecure', ac136_modesInPhaseA);

export async function ac145_paginatedKeysInPhaseA() {
  const fx = makeFixture();
  const sock = await listenSocket(fx.root);
  try {
    const page = (n) => (n === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i, key: `${KEY_B} filler${i}` })) : [{ id: 999, key: `${fx.pubLine.split(' ').slice(0, 2).join(' ')} laptop-comment` }]);
    const paged = (a) => { const m = /user\/keys\?per_page=100&page=(\d+)/.exec(a[1] ?? ''); return m ? { stdout: JSON.stringify(page(Number(m[1]))), status: 0 } : undefined; };
    const ctx = buildCtx(fx, { local: { sshIdentity: null }, inherited: { SSH_AUTH_SOCK: sock.path }, gh: { override: paged }, handlers: { [PINNED['ssh-add']]: () => ({ stdout: `${fx.pubLine}\n${KEY_B} agent-b\n`, status: 0 }) } });
    const logs = []; ctx.log = (l) => logs.push(l);
    await phaseA(ctx);
    assert.equal(readFileSync(ctx.ssh.identityPubPath, 'utf8'), `${fx.pubLine.split(' ').slice(0, 2).join(' ')}\n`, 'identity.pub holds A only');
    assert.ok(logs.some((l) => l.includes(ctx.ssh.fingerprint) && /^SHA256:/.test(ctx.ssh.fingerprint)), 'the log names A\'s SHA256 fingerprint');
    const onlyB = buildCtx(fx, { local: { sshIdentity: null }, inherited: { SSH_AUTH_SOCK: sock.path }, handlers: { [PINNED['ssh-add']]: () => ({ stdout: `${KEY_B} b\n`, status: 0 }) } });
    assert.equal(await codeOf(() => phaseA(onlyB)), 'ssh-identity-unbound'); assert.equal(netSpawns(onlyB.recorder).length, 0);
    const unregistered = buildCtx(fx, { gh: { keys: [{ id: 1, key: KEY_B }] } });
    assert.equal(await codeOf(() => phaseA(unregistered)), 'ssh-identity-unbound', 'an explicit key whose derived public key is unregistered');
    for (const keys of [[{ id: 1, fingerprint: 'SHA256:x' }], []]) assert.equal(await codeOf(() => phaseA(buildCtx(fx, { gh: { keys } }))), 'ssh-identity-unbound');
    const failing = buildCtx(fx, { gh: { override: (a) => (/page=2/.test(a[1] ?? '') ? { stdout: '', stderr: 'HTTP 500', status: 1 } : /page=1/.test(a[1] ?? '') ? { stdout: JSON.stringify(page(1)), status: 0 } : undefined) } });
    assert.equal(await codeOf(() => phaseA(failing)), 'ssh-identity-unbound', 'a failing second page');
  } finally { await sock.close(); fx.cleanup(); }
}
test('AC145: a user/keys fake whose SECOND page carries key A (with another comment) and an agent offering A and B → identity.pub holds A only and the log names its fingerprint; only B, an unregistered explicit key, fingerprint-only, empty or a failing page → ssh-identity-unbound with zero network spawns', ac145_paginatedKeysInPhaseA);

export async function ac153_untrustedSshAdd() {
  const fx = makeFixture();
  try {
    const bin = join(fx.repoRoot, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
    const names = ['adlc', 'bwrap', 'claude', 'codex', 'adversarial-review', 'gh', 'git', 'ssh', 'ssh-add', 'ssh-keygen', 'npm', 'node'];
    const sys = '/opt/trusted';
    const exists = (p) => p === sys || p === bin || names.some((n) => p === join(sys, n) && n !== 'ssh-add') || p === join(bin, 'ssh-add');
    const ctx = buildCtx(fx, { inherited: { PATH: `${bin}:${sys}` }, toolchain: { exists, realpath: (p) => p, stat: () => ({ uid: process.getuid(), mode: 0o755 }) } });
    ctx.pinned = null; ctx.env.path = null;
    assert.equal(await codeOf(() => phaseA(ctx)), 'missing-tool:ssh-add', 'a repo-local ssh-add is never searched, so the tool is missing from the sanitized list');
    assert.equal(ctx.recorder.length, 0, 'zero spawns of any kind');
    const c2 = buildCtx(fx, { inherited: { PATH: sys }, toolchain: { exists: (p) => p === sys || names.some((n) => p === join(sys, n)), realpath: (p) => (p.endsWith('ssh-add') ? join(fx.repoRoot, 'ssh-add') : p), stat: () => ({ uid: process.getuid(), mode: 0o755 }) } });
    c2.pinned = null; c2.env.path = null;
    assert.equal(await codeOf(() => phaseA(c2)), 'untrusted-tool:ssh-add', 'an ssh-add resolving under REPO_ROOT');
    const ok = buildCtx(fx); await phaseA(ok);
    assert.ok(ok.recorder.filter((r) => r.argv[0] === PINNED['ssh-keygen']).length >= 2 && ok.recorder.every((r) => r.argv[0].startsWith('/')), 'derivation spawns use the pinned absolute paths');
  } finally { fx.cleanup(); }
}
test('AC153: an ssh-add under REPO_ROOT/node_modules is never searched (missing-tool) and one whose realpath lies under REPO_ROOT is untrusted-tool:ssh-add with zero spawns; the derivation spawns use the pinned absolute paths', ac153_untrustedSshAdd);

export async function ac159_dryRunTransport() {
  const fx = makeFixture();
  try {
    const stale = join(fx.paths.runsDir, 'ssh-stale'); mkdirSync(stale); writeFileSync(join(stale, 'known_hosts'), 'stale\n');
    mkdirSync(join(fx.home, '.ssh')); writeFileSync(join(fx.home, '.ssh', 'config'), 'Host github.com\n  HostName evil.example.com\n');
    const before = readdirSync(fx.paths.runsDir).sort();
    const ctx = buildCtx(fx, { dryRun: true }); await phaseA(ctx); await resolveBaseline(ctx);
    const [ls] = netSpawns(ctx.recorder);
    const real = realpathSync(ls.env.GIT_SSH);
    assert.ok(real.startsWith(realpathSync(ctx.inherited.XDG_RUNTIME_DIR)), 'the wrapper realpath is under mkdtemp in $XDG_RUNTIME_DIR'); assert.ok(!real.startsWith(fx.repoRoot));
    const text = readFileSync(ls.env.GIT_SSH, 'utf8');
    assert.ok(!text.includes(fx.repoRoot) && !ls.argv.some((a) => a.includes(ctx.ssh.dir)), 'the wrapper text and argv name no path under REPO_ROOT');
    assert.ok(text.includes('-F /dev/null') && readFileSync(ctx.ssh.knownHostsPath, 'utf8') !== 'stale\n');
    assert.deepEqual(readdirSync(fx.paths.runsDir).sort(), before, 'ls -A <runs> is unchanged');
    const parent = ctx.sshDryRunParent; cleanupPreflight(ctx);
    assert.equal(existsSync(parent), false, 'the temporary directory is gone at exit');
  } finally { fx.cleanup(); }
}
test('AC159: under --dry-run the ls-remote spawns GIT_SSH wrapper lives under mkdtemp in $XDG_RUNTIME_DIR, names no REPO_ROOT path, ignores a stale ssh-*/known_hosts and ~/.ssh/config, <runs> is unchanged, and the directory is gone at exit', ac159_dryRunTransport);

export async function ac148_freshContextIsPinned() {
  // A production context starts with `pinned: {}` (truthy) and the inherited PATH; phase A must still pin.
  const fx = makeFixture();
  try {
    const { dirname } = await import('node:path');
    const sys = dirname(PINNED.gh);                                        // the fake tools' directory
    const real = ['git', 'ssh', 'ssh-add', 'ssh-keygen'];                  // pinned to their REAL binaries (phase A spawns them)
    const fake = ['adlc', 'bwrap', 'claude', 'codex', 'adversarial-review', 'gh', 'npm', 'node'];
    const realDirs = [...new Set(real.map((n) => dirname(PINNED[n])))];
    const exists = (p) => p === sys || realDirs.includes(p) || fake.some((n) => p === join(sys, n)) || real.some((n) => p === PINNED[n]);
    const ctx = buildCtx(fx, { inherited: { PATH: [sys, ...realDirs].join(':') }, toolchain: { exists, realpath: (p) => p, stat: () => ({ uid: process.getuid(), mode: 0o755 }) } });
    ctx.pinned = {}; ctx.env.path = process.env.PATH ?? '/usr/bin';   // a production context before phase A: truthy `pinned`, PATH set
    await phaseA(ctx);
    assert.equal(ctx.pinned.gh, PINNED.gh, 'phase A pinned gh on a fresh context');
    assert.equal(ctx.pinned.adlc, PINNED.adlc, 'phase A pinned adlc on a fresh context');
    assert.equal(ctx.pinned.git, PINNED.git, 'git resolved to its real binary');
    assert.ok(ctx.recorder.every((r) => r.argv[0].startsWith('/')), 'every spawn after pinning uses an absolute pinned path');
  } finally { fx.cleanup(); }
}
test('AC148: phase A pins the toolchain on a FRESH context (pinned:{} + inherited PATH) — the re-entrance guard keys on concrete pins, never on object truthiness', ac148_freshContextIsPinned);

export async function ac128_dryRunRunsTheRealPreflight() {
  // The dry run goes through the REAL phase A, baseline and phase B and performs no mutation:
  // no worktree, no fleet dispatch, an incomplete report that names what needs a worktree.
  const fx = makeFixture();
  try {
    const ctx = buildCtx(fx, { dryRun: true });
    await phaseA(ctx);
    const oid = await resolveBaseline(ctx);
    const b = await phaseB(ctx, { dryRun: true });
    assert.equal(b.complete, false);
    assert.ok(b.incomplete.includes('fleet-dry-run-needs-worktree'), JSON.stringify(b.incomplete));
    assert.ok(b.checks.token, 'the credential margin was still computed');
    assert.ok(!ctx.recorder.some((r) => r.argv[0] === PINNED.adlc && r.argv[1] === 'fleet'), 'zero fleet spawns in a dry run');
    assert.ok(!ctx.recorder.some((r) => r.argv.includes('worktree') && r.argv.includes('add')), 'zero worktrees created in a dry run');
    assert.equal(git(fx.repoRoot, ['worktree', 'list']).split('\n').length, 1, 'the repository has only its main worktree');
    assert.ok(oid);
  } finally { fx.cleanup(); }
}
test('AC128: a dry run exercises the REAL phase A, baseline and phase B and performs no mutation (no worktree, no fleet dispatch), reporting what needs a worktree', ac128_dryRunRunsTheRealPreflight);
