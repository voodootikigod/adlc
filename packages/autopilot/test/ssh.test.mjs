// AC 129 / 136 / 139 / 145 / 146 / 147 / 148 / 151 / 153 / 159 — the SSH
// material directory, the wrapper template, the key-match rule and
// revalidation. Real `ssh -G` / `ssh-keygen` when present (skipped loudly
// otherwise); every child goes through the spawn wrapper's recorder.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  resolveAuthMode, canonicalKeyLine, matchKey, wrapperScript, knownHostsFromMeta, prepareSshMaterial, revalidateSshMaterial,
  fetchRegisteredKeys, createDryRunSshDir, removeSshDir, sha256,
} from '../lib/ssh.mjs';
import { createSpawner } from '../lib/spawn.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';
import { PINNED, REAL, realExec, makeFixture, codeOf } from './helpers/preflight-ctx.mjs';

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILCIZMUVuVYs6hh1OOH/Mhz1TCJNs2O32J5Hl0Qt1JaP';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const skip = (why) => { console.warn(`SKIPPED (loudly): ${why}`); return null; };

/** A light ctx: the recorder, real ssh-keygen (or a fake), a fake ssh-add offering `agentLines`. */
function sshCtx(fx, { agentLines = [fx.pubLine], keygen = null } = {}) {
  const recorder = [];
  const table = {
    [PINNED['ssh-keygen']]: keygen ?? (REAL.sshKeygen ? realExec(REAL.sshKeygen) : (a) => ({ stdout: a[0] === '-y' ? `${fx.pubLine}\n` : `256 SHA256:${'A'.repeat(43)} c (ED25519)\n`, status: 0 })),
    [PINNED['ssh-add']]: () => ({ stdout: agentLines.join('\n') + '\n', status: 0 }),
    'ssh-keygen': () => ({ stdout: '', stderr: 'unpinned', status: 1 }), 'ssh-add': () => ({ stdout: '', stderr: 'unpinned', status: 1 }),
  };
  const { spawnImpl } = fakeSpawnImpl(table);
  const spawn = createSpawner({ recorder, spawnImpl });
  return { spawn, recorder, pinned: PINNED, env: { base: { PATH: '/usr/bin', HOME: fx.home } }, uid: process.getuid() };
}
const prep = (ctx, fx, dir, extra = {}) => prepareSshMaterial({ ctx, dir, mode: 'explicit', identityPath: fx.keyPath, knownHostsSource: fx.paths.knownHosts, registeredKeys: [{ id: 1, key: fx.pubLine }], ...extra });

export function ac136_authModeExclusive() {
  assert.equal(resolveAuthMode({ sshIdentity: '/k', sshAuthSock: null }), 'explicit');
  assert.equal(resolveAuthMode({ sshIdentity: null, sshAuthSock: '/s', socketExists: () => true }), 'agent');
  assert.equal(codeOfSync(() => resolveAuthMode({ sshIdentity: '/k', sshAuthSock: '/s', socketExists: () => true })), 'ssh-mode-ambiguous', 'both set → ambiguous, never a silent preference');
  assert.equal(codeOfSync(() => resolveAuthMode({ sshIdentity: null, sshAuthSock: null })), 'ssh-auth-missing');
  assert.equal(codeOfSync(() => resolveAuthMode({ sshIdentity: null, sshAuthSock: '/gone', socketExists: () => false })), 'ssh-auth-missing', 'a socket path that does not exist is not agent mode');
  const agent = wrapperScript({ sshPath: '/usr/bin/ssh', knownHostsPath: '/d/known_hosts', mode: 'agent', identityPath: '/d/identity.pub', agentSock: '/run/agent.sock' });
  assert.match(agent, /-o 'IdentityAgent="\/run\/agent\.sock"' -i '\/d\/identity\.pub'/);
  const explicit = wrapperScript({ sshPath: '/usr/bin/ssh', knownHostsPath: '/d/known_hosts', mode: 'explicit', identityPath: '/d/identity' });
  assert.match(explicit, /-o IdentityAgent=none -i '\/d\/identity'/);
  for (const t of [agent, explicit]) assert.ok(!t.includes('IdentityAgent= '), 'the string "IdentityAgent=" followed by a space never appears');
}
const codeOfSync = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
test('AC136: explicit XOR agent — both → ssh-mode-ambiguous, neither → ssh-auth-missing; the wrapper carries IdentityAgent=<sock> -i <dir>/identity.pub or IdentityAgent=none -i <dir>/identity', ac136_authModeExclusive);

export async function ac145_keyMatchRule() {
  assert.equal(canonicalKeyLine(`${KEY_A}   some comment with  spaces`), KEY_A);
  assert.equal(canonicalKeyLine(`  ${KEY_A}\n`), KEY_A);
  assert.equal(canonicalKeyLine('not a key'), null);
  assert.equal(canonicalKeyLine('ssh-ed25519 not*base64'), null);
  const registered = [{ id: 1, key: `${KEY_A} laptop` }];
  assert.deepEqual(matchKey({ candidates: [`${KEY_B} agent-b`, `${KEY_A} agent-a`], registered }), { line: KEY_A, index: 1 }, 'comment differences do not matter; A is matched');
  assert.equal(matchKey({ candidates: [`${KEY_B} only-b`], registered }), null, 'an agent offering only B is unbound');
  assert.equal(matchKey({ candidates: [KEY_A], registered: [{ id: 1, fingerprint: 'SHA256:abc' }] }), null, 'a fingerprint field with no key line never matches');
  assert.equal(matchKey({ candidates: [KEY_A], registered: [] }), null, 'an empty response is unbound');
  assert.equal(matchKey({ candidates: [], registered }), null);
  assert.equal(matchKey({ candidates: ['garbage'], registered: [{ key: 'garbage' }] }), null, 'unparseable lines never match, even byte-equal ones');
  // Pagination: the SECOND page carries A; a failing second page is unbound.
  const pages = { 1: Array.from({ length: 100 }, (_, i) => ({ id: i, key: `${KEY_B} b${i}` })), 2: [{ id: 200, key: `${KEY_A} laptop` }] };
  const gh = (fail2) => ({ json: async (args) => { const p = Number(/[?&]page=(\d+)/.exec(args[1])[1]); if (fail2 && p === 2) throw new Error('HTTP 500'); return pages[p]; } });
  const ok = await fetchRegisteredKeys(gh(false));
  assert.equal(ok.ok, true); assert.equal(ok.keys.length, 101);
  assert.deepEqual(matchKey({ candidates: [`${KEY_A} agent`], registered: ok.keys }), { line: KEY_A, index: 0 }, 'matched across ALL pages');
  const bad = await fetchRegisteredKeys(gh(true));
  assert.equal(bad.ok, false, 'a page fetch failure is never a pass');
}
test('AC145: the key-match rule is byte equality of canonical <type> <blob> forms across all pages; comment/whitespace variants match, fingerprint-only, empty or failing pages never do', ac145_keyMatchRule);

export function ac129_wrapperTemplate() {
  const t = wrapperScript({ sshPath: '/opt/ssh', knownHostsPath: '/d/known_hosts', mode: 'explicit', identityPath: '/d/identity' });
  assert.ok(t.startsWith('#!/bin/sh\nexec \'/opt/ssh\' -F /dev/null'), 'execs the PINNED ssh with -F /dev/null');
  for (const opt of ['-o StrictHostKeyChecking=yes', "-o 'UserKnownHostsFile=\"/d/known_hosts\"'", '-o IdentitiesOnly=yes', '-o BatchMode=yes', '"$@"']) assert.ok(t.includes(opt), opt);
  assert.ok(!/GIT_SSH_COMMAND|ProxyCommand|HostName/.test(t));
  assert.equal(knownHostsFromMeta({ ssh_keys: [`${KEY_A}`, 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=']}, 'github.com'), `github.com ${KEY_A}\ngithub.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=\n`);
}
test('AC129: the wrapper execs the pinned ssh with -F /dev/null, StrictHostKeyChecking=yes, UserKnownHostsFile=<SSH_DIR>/known_hosts, IdentitiesOnly=yes, BatchMode=yes and forwards $@', ac129_wrapperTemplate);

export async function ac139_wrapperOddPathsRealSsh() {
  const fx = makeFixture();
  try {
    const odd = join(fx.root, "odd dir $(x)'q");
    mkdirSync(odd);
    const kh = join(odd, 'known hosts'); copyFileSync(fx.paths.knownHosts, kh); chmodSync(kh, 0o600);
    const key = join(odd, "id $(k)'s"); copyFileSync(fx.keyPath, key); chmodSync(key, 0o600);
    const ctx = sshCtx(fx);
    const m = await prepareSshMaterial({ ctx, dir: join(odd, 'ssh-material'), mode: 'explicit', identityPath: key, knownHostsSource: kh, registeredKeys: [{ key: fx.pubLine }] });
    assert.equal(statSync(m.wrapperPath).mode & 0o7777, 0o500);
    assert.equal(m.wrapperSha256, sha256(readFileSync(m.wrapperPath)), 'the recorded sha256 matches the file');
    assert.ok(!readFileSync(m.wrapperPath, 'utf8').includes('GIT_SSH_COMMAND'));
    if (!REAL.ssh || !REAL.sshKeygen) return skip('ssh / ssh-keygen not installed: the real `ssh -G` clause of AC 139 did not run');
    const home = join(fx.root, 'home2'); mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'config'), 'Host github.com\n  HostName evil.example.com\n  IdentityFile ~/.ssh/evil\n');
    const r = spawnSync(m.wrapperPath, ['-G', 'github.com'], { encoding: 'utf8', env: { PATH: '/usr/bin', HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const lines = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
    assert.equal(lines.userknownhostsfile, m.knownHostsPath, 'known_hosts path with a space, $( and a quote resolves intact');
    assert.equal(lines.identityfile, m.identityPath, 'identity path resolves intact');
    assert.equal(lines.hostname, 'github.com', 'the ~/.ssh/config HostName rewrite is NOT consulted (-F /dev/null)');
    assert.equal(lines.identityagent, 'none');
    chmodSync(m.wrapperPath, 0o700); writeFileSync(m.wrapperPath, readFileSync(m.wrapperPath, 'utf8') + '# tampered\n'); chmodSync(m.wrapperPath, 0o500);
    const v = revalidateSshMaterial(m);
    assert.equal(v.code, 'ssh-wrapper-tampered');
  } finally { fx.cleanup(); }
}
test('AC139: with REPO_ROOT, known_hosts and identity paths containing a space, $( and a single quote, real ssh -G reports the exact paths; wrapper 0500, sha recorded, modified → ssh-wrapper-tampered', ac139_wrapperOddPathsRealSsh);

export async function ac146_bindingUsesCopy() {
  const fx = makeFixture();
  try {
    if (!REAL.sshKeygen) return skip('ssh-keygen not installed: AC 146 real derivation did not run');
    // A mismatched .pub sidecar beside the ORIGINAL changes nothing: the public key is derived from the copy.
    writeFileSync(`${fx.keyPath}.pub`, `${KEY_B} sidecar\n`);
    const ctx = sshCtx(fx);
    const m = await prep(ctx, fx, join(fx.root, 'm1'));
    assert.equal(m.boundKeyLine, canonicalKeyLine(fx.pubLine));
    assert.match(readFileSync(m.wrapperPath, 'utf8'), new RegExp(`IdentityAgent=none -i '${m.identityPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), 'the wrapper names the COPY, never the original');
    const keygen = ctx.recorder.filter((r) => r.argv[0] === PINNED['ssh-keygen'] && r.argv[1] === '-y');
    assert.equal(keygen.length, 1); assert.equal(keygen[0].argv[3], m.identityPath, 'ssh-keygen -y runs on the copy');
    assert.ok(!ctx.recorder.some((r) => r.argv.includes(fx.keyPath)), 'the original path is never named in any argv');
    // Swapping the original between the copy and the fingerprint step has no effect.
    const other = join(fx.root, 'other'); spawnSync(REAL.sshKeygen, ['-t', 'ed25519', '-N', '', '-q', '-f', other]);
    const swapping = (args, o) => { if (args[0] === '-y') renameSync(other, fx.keyPath); return realExec(REAL.sshKeygen)(args, o); };
    const ctx2 = sshCtx(fx, { keygen: swapping });
    const m2 = await prep(ctx2, fx, join(fx.root, 'm2'));
    assert.equal(m2.boundKeyLine, canonicalKeyLine(fx.pubLine), 'the copy is what was fingerprinted and what is used');
    assert.equal(revalidateSshMaterial(m2).ok, true);
    // Agent mode: the wrapper carries IdentityAgent=<socket> -i <dir>/identity.pub holding ONLY the matched key.
    const sock = join(fx.root, 'sock'); writeFileSync(sock, '');
    const ctx3 = sshCtx(fx, { agentLines: [`${KEY_B} other`, fx.pubLine] });
    const m3 = await prepareSshMaterial({ ctx: ctx3, dir: join(fx.root, 'm3'), mode: 'agent', agentSock: sock, knownHostsSource: fx.paths.knownHosts, registeredKeys: [{ key: fx.pubLine }] });
    assert.equal(readFileSync(m3.identityPubPath, 'utf8'), `${canonicalKeyLine(fx.pubLine)}\n`);
    assert.match(readFileSync(m3.wrapperPath, 'utf8'), /IdentityAgent="[^"]+\/sock"' -i '[^']+\/m3\/identity\.pub'/);
    assert.equal(codeOfSync(() => resolveAuthMode({ sshIdentity: fx.keyPath, sshAuthSock: sock, socketExists: () => true })), 'ssh-mode-ambiguous');
    // The live clause: a REAL agentless push through the generated wrapper against a local sshd.
    // A fresh operator key for the live clause (the swap case above replaced the fixture's key file).
    const liveKey = join(fx.root, 'live_key'); spawnSync(REAL.sshKeygen, ['-t', 'ed25519', '-N', '', '-q', '-C', 'live@laptop', '-f', liveKey]);
    const livePub = readFileSync(`${liveKey}.pub`, 'utf8').trim();
    await withLocalSshd(fx, livePub, async ({ port, hostLine, user }) => {
      writeFileSync(fx.paths.knownHosts, `${hostLine}\n`);
      const ctx4 = sshCtx(fx, { agentLines: [livePub] });
      const m4 = await prep(ctx4, fx, join(fx.root, 'm4'), { identityPath: liveKey, registeredKeys: [{ id: 9, key: livePub }] });
      const bare = join(fx.root, 'live.git'); spawnSync('git', ['init', '-q', '--bare', bare]);
      const src = join(fx.root, 'live-src'); mkdirSync(src);
      const g = (args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: src, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      g(['init', '-q', '-b', 'main']); writeFileSync(join(src, 'f.txt'), 'live\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'live']);
      const head = g(['rev-parse', 'HEAD']).stdout.trim();
      const push = spawnSync('git', ['push', '-q', `ssh://${user}@127.0.0.1:${port}${bare}`, 'HEAD:refs/heads/live'], { cwd: src, encoding: 'utf8', env: { ...process.env, GIT_SSH: m4.wrapperPath, SSH_AUTH_SOCK: '' } });
      assert.equal(push.status, 0, `the live agentless push over the generated wrapper succeeds: ${push.stderr}`);
      assert.equal(spawnSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/live'], { encoding: 'utf8' }).stdout.trim(), head, 'the bare remote holds the pushed commit');
      assert.match(readFileSync(m4.wrapperPath, 'utf8'), /IdentityAgent=none/, 'the push was agentless by construction');
    });
  } finally { fx.cleanup(); }
}
test('AC146: explicit mode copies the key (O_NOFOLLOW, 0600) BEFORE fingerprinting from the copy; a mismatched .pub sidecar or a swapped original changes nothing; agent mode writes only the matched key to identity.pub', ac146_bindingUsesCopy);


/**
 * A local, unprivileged sshd for the live clause of AC 146: random loopback port, its own host key,
 * the fixture's operator key in authorized_keys, key auth only. Skips loudly when sshd is absent
 * or cannot start (the rest of the criterion still ran).
 */
async function withLocalSshd(fx, authorizedPub, fn) {
  const SSHD = '/usr/sbin/sshd';
  if (!existsSync(SSHD) || !REAL.sshKeygen) return skip('no sshd / ssh-keygen: the live agentless push clause of AC 146 did not run');
  const dir = join(fx.root, 'sshd'); mkdirSync(dir, { recursive: true });
  spawnSync(REAL.sshKeygen, ['-t', 'ed25519', '-N', '', '-q', '-f', join(dir, 'host_key')]);
  writeFileSync(join(dir, 'authorized_keys'), `${authorizedPub}\n`, { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(join(dir, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host_key')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
    'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'PidFile none', 'LogLevel ERROR'].join('\n') + '\n');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const net = await import('node:net');
  const child = spawn(SSHD, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  let exited = false; child.on('exit', () => { exited = true; });
  const up = await new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (exited) return resolve(false);
      if (Date.now() - started > 8000) return resolve(false);
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); setTimeout(tick, 100); });
    };
    tick();
  });
  if (!up) { try { child.kill('SIGTERM'); } catch { /* gone */ } return skip(`local sshd did not start (${err.trim().slice(0, 200)}): the live agentless push clause of AC 146 did not run`); }
  const hostPub = readFileSync(join(dir, 'host_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  try { return await fn({ port, hostLine: `[127.0.0.1]:${port} ${hostPub}`, user: os.userInfo().username }); }
  finally { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}

export async function ac147_revalidation() {
  const fx = makeFixture();
  try {
    const ctx = sshCtx(fx);
    const dir = join(fx.root, 'ssh-tok');
    const m = await prep(ctx, fx, dir);
    assert.equal(statSync(dir).mode & 0o7777, 0o700);
    assert.deepEqual(m.files.map((f) => f.path.slice(dir.length + 1)).sort(), ['identity', 'identity.pub', 'known_hosts', 'wrapper']);
    for (const f of m.files) for (const k of ['sha256', 'size', 'uid', 'mode', 'ino', 'dev']) assert.ok(f[k] !== undefined, `${k} recorded`);
    assert.equal(revalidateSshMaterial(m).ok, true, 'unchanged material passes');
    assert.equal(await codeOf(() => prep(ctx, fx, dir)), 'ssh-dir-exists', 'a pre-existing directory of the same name is never reused');
    const cases = [
      ['same-size different known_hosts', (x) => { const alt = Buffer.from(readFileSync(x.knownHostsPath)); alt[alt.length - 2] = alt[alt.length - 2] === 0x41 ? 0x42 : 0x41; writeFileSync(x.knownHostsPath, alt); }],
      ['chmod 0644 on the private-key copy', (x) => chmodSync(x.identityPath, 0o644)],
      ['new inode with identical bytes', (x) => { const tmp = `${x.identityPath}.new`; writeFileSync(tmp, readFileSync(x.identityPath), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, x.identityPath); }],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [name, mutate] = cases[i];
      const mN = await prep(sshCtx(fx), fx, join(fx.root, `d-${i}`));
      assert.equal(revalidateSshMaterial(mN).ok, true, `${name}: passes before the mutation`);
      mutate(mN);
      assert.equal(revalidateSshMaterial(mN).code, 'ssh-material-tampered', name);
    }
    // Agent mode: an agent that stops offering the bound key.
    const sock = join(fx.root, 'sock'); writeFileSync(sock, '');
    const ma = await prepareSshMaterial({ ctx: sshCtx(fx), dir: join(fx.root, 'agent-dir'), mode: 'agent', agentSock: sock, knownHostsSource: fx.paths.knownHosts, registeredKeys: [{ key: fx.pubLine }] });
    assert.equal(revalidateSshMaterial(ma, { agentKeyLines: [fx.pubLine] }).ok, true);
    assert.equal(revalidateSshMaterial(ma, { agentKeyLines: [`${KEY_B} other`] }).code, 'ssh-material-tampered', 'the agent no longer offers the bound fingerprint');
    assert.equal(revalidateSshMaterial(ma, {}).code, 'ssh-material-tampered', 'agent keys not re-enumerated is never a pass');
  } finally { fx.cleanup(); }
}
test('AC147: ssh-<token>/ is 0700 with wrapper, known_hosts and key material; same-size known_hosts change, chmod 0644 on the copy, an inode swap with identical bytes, or an agent dropping the key → ssh-material-tampered; a pre-existing dir → ssh-dir-exists', ac147_revalidation);

export async function ac151_explicitKeyIsCopy() {
  const fx = makeFixture();
  try {
    const ctx = sshCtx(fx);
    const dir = join(fx.paths.runsDir, `ssh-${'b'.repeat(64)}`);
    const m = await prep(ctx, fx, dir);
    assert.equal(m.identityPath, join(dir, 'identity'));
    assert.match(readFileSync(m.wrapperPath, 'utf8'), new RegExp(`-i '${join(dir, 'identity').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), 'the -i names <runs>/ssh-<token>/identity');
    assert.ok(!readFileSync(m.wrapperPath, 'utf8').includes(fx.keyPath), 'never the --ssh-identity path');
    writeFileSync(fx.keyPath, 'replaced original\n', { mode: 0o600 });
    assert.equal(revalidateSshMaterial(m).ok, true, 'replacing the original after phase A changes nothing');
    writeFileSync(m.identityPath, 'replaced copy\n', { mode: 0o600 }); chmodSync(m.identityPath, 0o600);
    assert.equal(revalidateSshMaterial(m).code, 'ssh-material-tampered', 'replacing the copy is tamper');
  } finally { fx.cleanup(); }
}
test('AC151: in explicit mode the wrappers -i names <REPO_ROOT>/.adlc/autopilot-runs/ssh-<token>/identity; replacing the original changes nothing; replacing the copy → ssh-material-tampered', ac151_explicitKeyIsCopy);

export function ac148_knownHostsFromMeta() {
  const meta = { ssh_keys: [KEY_A, `ghe.example.com ${KEY_B}`, 'garbage'] };
  assert.equal(knownHostsFromMeta(meta, 'github.com'), `github.com ${KEY_A}\n`, 'a key line naming any other host, and an unparseable line, are ignored');
  assert.equal(knownHostsFromMeta(meta, 'ghe.example.com'), `ghe.example.com ${KEY_A}\nghe.example.com ${KEY_B}\n`, 'bare lines belong to the queried host; a line naming that host is kept');
  assert.equal(knownHostsFromMeta({ ssh_keys: ['garbage'] }, 'github.com'), '');
  assert.equal(knownHostsFromMeta(JSON.stringify({ ssh_keys: [`${KEY_A} comment`] }), 'GitHub.com'), `github.com ${KEY_A}\n`, 'JSON text is accepted; the host is lower-cased; comments dropped');
}
test('AC148: known_hosts is written from gh api meta of exactly the pinned host; a key for any other host is ignored', ac148_knownHostsFromMeta);

export async function ac153_pinnedSshTools() {
  const fx = makeFixture();
  try {
    const ctx = sshCtx(fx);
    await prep(ctx, fx, join(fx.root, 'p1'));
    const sock = join(fx.root, 'sock'); writeFileSync(sock, '');
    await prepareSshMaterial({ ctx, dir: join(fx.root, 'p2'), mode: 'agent', agentSock: sock, knownHostsSource: fx.paths.knownHosts, registeredKeys: [{ key: fx.pubLine }] });
    const keygen = ctx.recorder.filter((r) => /ssh-keygen/.test(r.argv[0])); const add = ctx.recorder.filter((r) => /ssh-add/.test(r.argv[0]));
    assert.ok(keygen.length >= 2 && add.length === 1);
    for (const r of [...keygen, ...add]) assert.ok(r.argv[0] === PINNED['ssh-keygen'] || r.argv[0] === PINNED['ssh-add'], `${r.argv[0]} is the pinned absolute path`);
    assert.equal(add[0].env.SSH_AUTH_SOCK, sock, 'ssh-add -L runs over the recorded socket');
  } finally { fx.cleanup(); }
}
test('AC153: the agent-enumeration (ssh-add -L) and key-derivation (ssh-keygen -y/-lf) spawns use the pinned absolute paths', ac153_pinnedSshTools);

export async function ac159_dryRunDirOutsideRepo() {
  const fx = makeFixture();
  try {
    const xdg = join(fx.root, 'xdg');
    const { parent, dir } = createDryRunSshDir({ env: { XDG_RUNTIME_DIR: xdg }, repoRoot: fx.repoRoot, runsDir: fx.paths.runsDir });
    assert.ok(parent.startsWith(xdg + '/'), 'mkdtemp under $XDG_RUNTIME_DIR');
    assert.ok(!parent.startsWith(fx.repoRoot), 'never under REPO_ROOT');
    assert.equal(statSync(parent).mode & 0o7777, 0o700);
    const stale = join(fx.paths.runsDir, 'ssh-stale'); mkdirSync(stale); writeFileSync(join(stale, 'known_hosts'), 'stale\n');
    const m = await prep(sshCtx(fx), fx, dir);
    const text = readFileSync(m.wrapperPath, 'utf8');
    assert.ok(!text.includes(fx.repoRoot), 'the dry-run wrapper names no path under REPO_ROOT');
    assert.ok(text.includes(`UserKnownHostsFile="${m.knownHostsPath}"`) && m.knownHostsPath.startsWith(parent));
    assert.equal(readFileSync(m.knownHostsPath, 'utf8'), readFileSync(fx.paths.knownHosts, 'utf8'), 'the copy comes from .adlc/autopilot-known_hosts, not a stale ssh-*/known_hosts');
    assert.ok(text.includes('-F /dev/null'));
    removeSshDir(parent);
    assert.equal(existsSync(parent), false, 'gone at exit');
    const t2 = createDryRunSshDir({ env: {}, repoRoot: fx.repoRoot });
    assert.ok(!t2.parent.startsWith(fx.repoRoot)); removeSshDir(t2.parent);
  } finally { fx.cleanup(); }
}
test('AC159: dry-run material is a 0700 mkdtemp under $XDG_RUNTIME_DIR outside REPO_ROOT, its wrapper names only temporary paths, a stale ssh-*/known_hosts is never used, -F /dev/null is present, and the directory is gone at exit', ac159_dryRunDirOutsideRepo);
