// Repository and principal binding (spec §9.1a; AC 53, 112, 119, 130, 132,
// 137, 142, 148). The expected identity comes from an OPERATOR-LOCAL source
// (`--repo` / ADLC_AUTOPILOT_REPO); the repository's own remote configuration is
// OBSERVED with an unoverlaid `git config --file … --get` read and must
// canonicalize to that identity; v1 remotes are SSH-only and credential-free;
// fetch and push URLs must be byte-identical after canonicalization; the
// SSH host must be the host `gh` is authenticated against.

import { validateRepoSpec, validateHost, InputError } from './input.mjs';

export class RemoteError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/**
 * Canonicalize a remote URL. Returns { canonical, host, repo } for the two SSH
 * forms; throws RemoteError('remote-url-scheme') for https/other schemes and
 * ('remote-url-credentials') for any userinfo other than exactly `git`.
 */
export function canonicalizeRemoteUrl(url) {
  const s = String(url ?? '').trim();
  let m;
  if ((m = /^https?:\/\//i.exec(s))) {
    // Credentials are reported before the scheme so the token never reaches a log or argv.
    if (/^https?:\/\/[^/@]+@/i.test(s)) throw new RemoteError('remote-url-credentials', 'userinfo in URL');
    throw new RemoteError('remote-url-scheme', 'HTTPS remotes are not supported in v1');
  }
  if ((m = /^ssh:\/\/([^@/]+)@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(s))) {
    if (m[1] !== 'git') throw new RemoteError('remote-url-credentials', `userinfo "${m[1]}"`);
    return finish(m[2], m[3]);
  }
  if ((m = /^([^@:/]+)@([^:/]+):(.+?)(?:\.git)?$/i.exec(s))) {
    if (m[1] !== 'git') throw new RemoteError('remote-url-credentials', `userinfo "${m[1]}"`);
    return finish(m[2], m[3]);
  }
  throw new RemoteError('remote-url-scheme', 'unrecognized remote URL form');
}

function finish(host, path) {
  const h = validateHost(host, 'remote-host');
  const repo = validateRepoSpec(path, 'remote-repo');
  return { canonical: `git@${h}:${repo}.git`, host: h, repo };
}

/**
 * Bind the observed fetch/push URLs to the operator-local identity.
 * @returns { remoteFetchUrl, remotePushUrl, host, repo } (canonical, byte-identical)
 */
export function bindRemote({ expectedRepo, observedFetchUrl, observedPushUrl }) {
  if (!expectedRepo) throw new RemoteError('repo-unbound', '--repo / ADLC_AUTOPILOT_REPO is required');
  const expected = validateRepoSpec(expectedRepo, 'repo');
  const fetch = canonicalizeRemoteUrl(observedFetchUrl);
  const push = canonicalizeRemoteUrl(observedPushUrl ?? observedFetchUrl);
  if (fetch.repo.toLowerCase() !== expected.toLowerCase()) throw new RemoteError('repo-mismatch', `origin is ${fetch.repo}, expected ${expected}`);
  if (fetch.canonical !== push.canonical) throw new RemoteError('remote-url-split', `${fetch.canonical} vs ${push.canonical}`);
  return { remoteFetchUrl: fetch.canonical, remotePushUrl: push.canonical, host: fetch.host, repo: fetch.repo };
}

/**
 * `gh auth status --hostname <host> --active --json hosts` → exactly one entry
 * for <host> with state success + active, whose login equals the principal.
 */
export function verifyGhHost({ authStatusJson, host, principalLogin }) {
  let doc;
  try { doc = typeof authStatusJson === 'string' ? JSON.parse(authStatusJson) : authStatusJson; } catch { throw new RemoteError('gh-host-unbound', 'auth status is not JSON'); }
  const entries = doc?.hosts?.[host];
  if (!Array.isArray(entries) || entries.length !== 1) throw new RemoteError('gh-host-unbound', `expected exactly one entry for ${host}`);
  const e = entries[0];
  if (e?.state !== 'success' || e?.active !== true) throw new RemoteError('gh-host-unbound', `state=${e?.state} active=${e?.active}`);
  if (e?.login !== principalLogin) throw new RemoteError('gh-host-unbound', `login ${e?.login} != ${principalLogin}`);
  return true;
}

/** The SSH host of the pinned URL must equal the gh host exactly. */
export function assertHostMatches(remoteHost, ghHost) {
  if (remoteHost.toLowerCase() !== String(ghHost).toLowerCase()) throw new RemoteError('remote-host-mismatch', `${remoteHost} != ${ghHost}`);
  return true;
}

/** Principal permission must be admin/maintain/write (§9.1a). */
export function assertPrincipalAuthorized(permission) {
  if (!['admin', 'maintain', 'write'].includes(permission)) throw new RemoteError('principal-unauthorized', `permission ${permission ?? 'unknown'}`);
  return true;
}

export { InputError };
