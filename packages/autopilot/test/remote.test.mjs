// AC 53 / 112 / 130 / 132 / 137 / 142 / 148 — remote identity binding.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { canonicalizeRemoteUrl, bindRemote, verifyGhHost, assertHostMatches, assertPrincipalAuthorized, RemoteError } from '../lib/remote.mjs';

const code = (fn, c) => { let e = null; try { fn(); } catch (err) { e = err; } assert.ok(e instanceof RemoteError, `expected RemoteError, got ${e && e.message}`); assert.equal(e.code, c); assert.equal(e.exitCode, 1); };

export function ac132_sshOnlyForms() {
  assert.equal(canonicalizeRemoteUrl('git@github.com:o/r.git').canonical, 'git@github.com:o/r.git');
  assert.equal(canonicalizeRemoteUrl('git@github.com:o/r').canonical, 'git@github.com:o/r.git');
  assert.equal(canonicalizeRemoteUrl('ssh://git@github.com/o/r.git').canonical, 'git@github.com:o/r.git', 'both SSH forms canonicalize to one string');
  assert.equal(canonicalizeRemoteUrl('ssh://git@GitHub.com/o/r.git').host, 'github.com');
  code(() => canonicalizeRemoteUrl('https://github.com/o/r.git'), 'remote-url-scheme');
  code(() => canonicalizeRemoteUrl('ssh://alice@github.com/o/r.git'), 'remote-url-credentials');
  code(() => canonicalizeRemoteUrl('alice@github.com:o/r.git'), 'remote-url-credentials');
}
test('AC132: git@host:o/r.git and ssh://git@host/o/r.git are accepted and canonicalize identically; https → remote-url-scheme; other userinfo → remote-url-credentials', ac132_sshOnlyForms);

export function ac112_credentialsNeverEscape() {
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8S9t0';
  let err = null;
  try { canonicalizeRemoteUrl(`https://x:${token}@github.com/o/r.git`); } catch (e) { err = e; }
  assert.equal(err.code, 'remote-url-credentials');
  assert.ok(!err.message.includes(token), 'the token string appears in no error message');
  let bound = null;
  try { bound = bindRemote({ expectedRepo: 'o/r', observedFetchUrl: `https://x:${token}@github.com/o/r.git` }); } catch (e) { err = e; }
  assert.equal(bound, null); assert.ok(!String(err.message).includes(token));
}
test('AC112: an origin URL with userinfo is remote-url-credentials, exit 1, and the token appears in no message', ac112_credentialsNeverEscape);

export function ac53_repoAndPushBinding() {
  const ok = bindRemote({ expectedRepo: 'voodootikigod/adlc', observedFetchUrl: 'git@github.com:voodootikigod/adlc.git', observedPushUrl: 'ssh://git@github.com/voodootikigod/adlc.git' });
  assert.deepEqual(ok, { remoteFetchUrl: 'git@github.com:voodootikigod/adlc.git', remotePushUrl: 'git@github.com:voodootikigod/adlc.git', host: 'github.com', repo: 'voodootikigod/adlc' });
  for (const other of ['git@github.com:other/adlc.git', 'ssh://git@github.com/voodootikigod/other.git', 'git@github.com:voodootikigod/adlc-fork.git']) {
    code(() => bindRemote({ expectedRepo: 'voodootikigod/adlc', observedFetchUrl: other }), 'repo-mismatch');
  }
  code(() => bindRemote({ expectedRepo: 'voodootikigod/adlc', observedFetchUrl: 'git@github.com:voodootikigod/adlc.git', observedPushUrl: 'git@github.com:voodootikigod/other.git' }), 'remote-url-split');
  code(() => bindRemote({ expectedRepo: 'voodootikigod/adlc', observedFetchUrl: 'git@github.com:voodootikigod/adlc.git', observedPushUrl: 'git@ghe.example.com:voodootikigod/adlc.git' }), 'remote-url-split');
  code(() => bindRemote({ expectedRepo: null, observedFetchUrl: 'git@github.com:o/r.git' }), 'repo-unbound');
}
test('AC53/137/142: origin for another repo (each URL form) → repo-mismatch; a push URL with a different repo or host → remote-url-split; no --repo → repo-unbound', ac53_repoAndPushBinding);

export function ac148_ghHostBinding() {
  const good = { hosts: { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: 'voodootikigod' }] } };
  assert.equal(verifyGhHost({ authStatusJson: JSON.stringify(good), host: 'github.com', principalLogin: 'voodootikigod' }), true);
  code(() => verifyGhHost({ authStatusJson: { hosts: {} }, host: 'github.com', principalLogin: 'v' }), 'gh-host-unbound');
  code(() => verifyGhHost({ authStatusJson: { hosts: { 'github.com': [{ state: 'error', active: true, login: 'v' }] } }, host: 'github.com', principalLogin: 'v' }), 'gh-host-unbound');
  code(() => verifyGhHost({ authStatusJson: { hosts: { 'github.com': [{ state: 'success', active: true, login: 'someone' }] } }, host: 'github.com', principalLogin: 'v' }), 'gh-host-unbound');
  code(() => verifyGhHost({ authStatusJson: 'not json', host: 'github.com', principalLogin: 'v' }), 'gh-host-unbound');
  code(() => assertHostMatches('ghe.example.com', 'github.com'), 'remote-host-mismatch');
  assert.equal(assertHostMatches('github.com', 'GitHub.com'), true);
  assert.equal(assertPrincipalAuthorized('write'), true);
  code(() => assertPrincipalAuthorized('read'), 'principal-unauthorized');
  code(() => assertPrincipalAuthorized(null), 'principal-unauthorized');
}
test('AC148/53: gh auth status must show one success+active entry whose login is the principal; a GHES remote against a github.com auth → remote-host-mismatch; read permission → principal-unauthorized', ac148_ghHostBinding);

export async function ac132_nonDefaultSshPortIsRefused() {
  // The host-key binding (`gh api meta`) attests port 22 only: another port is REFUSED explicitly, never dropped.
  assert.throws(() => canonicalizeRemoteUrl('ssh://git@github.com:2222/o/r.git'), (e) => e instanceof RemoteError && e.code === 'remote-url-port');
  assert.equal(canonicalizeRemoteUrl('ssh://git@github.com:22/o/r.git').canonical, 'git@github.com:o/r.git', 'the default port is the default');
  assert.equal(canonicalizeRemoteUrl('ssh://git@github.com/o/r.git').canonical, 'git@github.com:o/r.git');
}
test('AC132: an ssh remote on a non-default port is refused (remote-url-port) — the endpoint the host-key binding cannot attest is never silently rewritten to port 22', ac132_nonDefaultSshPortIsRefused);
