// SSH transport material (spec §9.1b, §9.4a, §0 dry-run; AC 129, 136, 139,
// 145, 146, 147, 151, 153, 159).
//
// Everything the SSH transport depends on lives in ONE exclusive per-iteration
// directory: the `GIT_SSH` wrapper (a fixed template that execs the PINNED
// `ssh` with `-F /dev/null` and the pinned known_hosts, so no ambient
// ssh_config can rewrite the host), the known_hosts copy, and the identity —
// a `0600` COPY of the operator's key (explicit mode) or the matched agent
// key's public line (agent mode). The key that authenticates is bound to the
// gh-verified principal AFTER it is under the orchestrator's control, and
// every file is re-stat'd and re-hashed immediately before each network spawn.

import {
  mkdirSync, mkdtempSync, chmodSync, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, rmSync, constants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellQuote } from './git-env.mjs';
import { DEADLINES } from './spawn.mjs';
import { isUnder } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'ssh.preferAgentWhenAmbiguous', // both --ssh-identity and SSH_AUTH_SOCK → agent instead of ssh-mode-ambiguous
  'ssh.acceptFirstCandidate',     // no registered match → the first candidate is bound anyway
  'ssh.wrapperOmitOptions',       // the wrapper drops -F /dev/null and the host-key/batch options
  'ssh.noShellQuote',             // embedded paths are written bare (spaces/quotes break the wrapper)
  'ssh.fingerprintOriginal',      // explicit mode derives the public key from the ORIGINAL path, not the copy
  'ssh.skipRevalidation',         // revalidateSshMaterial reports ok without re-checking
  'ssh.wrapperNamesOriginal',     // explicit-mode wrapper carries -i <original> instead of the copy
  'ssh.knownHostsAnyHost',        // known_hosts is written for every host in the meta document
  'ssh.unpinnedTools',            // ssh-add / ssh-keygen are spawned by bare name
  'ssh.acceptInsecureIdentity',   // a 0644 / foreign-uid identity file is copied anyway
  'ssh.acceptAnyKnownHosts',      // a missing / 0644 known_hosts source is accepted
  'ssh.dryRunUnderRepo',          // the dry-run material directory is created under REPO_ROOT
]);

export class SshError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const KEY_TYPE_RE = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PERM = (mode) => mode & 0o7777;

/** Exactly one authentication mode (§9.1b): explicit XOR agent. */
export function resolveAuthMode({ sshIdentity, sshAuthSock, socketExists = () => false }) {
  const explicit = typeof sshIdentity === 'string' && sshIdentity.length > 0;
  const sockSet = typeof sshAuthSock === 'string' && sshAuthSock.length > 0;
  if (explicit && sockSet) {
    if (active('ssh.preferAgentWhenAmbiguous')) return 'agent';
    throw new SshError('ssh-mode-ambiguous', '--ssh-identity and SSH_AUTH_SOCK are both set; unset one');
  }
  if (explicit) return 'explicit';
  if (sockSet && socketExists(sshAuthSock)) return 'agent';
  throw new SshError('ssh-auth-missing', sockSet ? 'SSH_AUTH_SOCK names no socket' : 'neither --ssh-identity nor SSH_AUTH_SOCK is set');
}

/** `<type> <blob>` with the comment dropped and one space, or null when unparseable. */
export function canonicalKeyLine(line) {
  if (typeof line !== 'string') return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !KEY_TYPE_RE.test(parts[0]) || !B64_RE.test(parts[1])) return null;
  return `${parts[0]} ${parts[1]}`;
}

/**
 * The key-match rule (§9.1b): byte equality of canonical forms between the
 * candidates (agent / derived) and the registered `key` lines, across ALL pages.
 * Returns { line, index } (index into candidates) or null.
 */
export function matchKey({ candidates, registered }) {
  if (!Array.isArray(candidates) || !Array.isArray(registered) || registered.length === 0) return null;
  const wanted = new Set(registered.map((r) => canonicalKeyLine(typeof r === 'string' ? r : r?.key)).filter(Boolean));
  if (wanted.size === 0) return null;
  for (let i = 0; i < candidates.length; i++) {
    const c = canonicalKeyLine(candidates[i]);
    if (c && wanted.has(c)) return { line: c, index: i };
  }
  if (active('ssh.acceptFirstCandidate')) { const c = canonicalKeyLine(candidates[0]); return c ? { line: c, index: 0 } : null; }
  return null;
}

/** An ssh_config option value: double-quoted for ssh's own tokenizer, then sh-quoted. */
const sshOpt = (name, value) => (active('ssh.noShellQuote') ? `${name}=${value}` : shellQuote(`${name}="${value}"`));
const q = (s) => (active('ssh.noShellQuote') ? String(s) : shellQuote(s));

/** The fixed wrapper template (§9.1b). `identityPath` is the copy (explicit) or the matched .pub (agent). */
export function wrapperScript({ sshPath, knownHostsPath, mode, identityPath, agentSock }) {
  const head = active('ssh.wrapperOmitOptions') ? '' : ` -F /dev/null -o StrictHostKeyChecking=yes -o ${sshOpt('UserKnownHostsFile', knownHostsPath)} -o IdentitiesOnly=yes -o BatchMode=yes`;
  const auth = mode === 'agent'
    ? ` -o ${sshOpt('IdentityAgent', agentSock)} -i ${q(identityPath)}`
    : ` -o IdentityAgent=none -i ${q(identityPath)}`;
  return `#!/bin/sh\nexec ${q(sshPath)}${head}${auth} "$@"\n`;
}

/**
 * known_hosts text from `gh api meta` (`ssh_keys: ["<type> <blob>", …]`) for
 * exactly `host`: a bare key line is bound to the pinned host; a line that
 * already names a host is kept only when it names the pinned host.
 */
export function knownHostsFromMeta(metaJson, host) {
  const doc = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
  const h = String(host).toLowerCase();
  const lines = [];
  for (const raw of Array.isArray(doc?.ssh_keys) ? doc.ssh_keys : []) {
    if (typeof raw !== 'string') continue;
    const parts = raw.trim().split(/\s+/);
    const named = parts.length >= 3 && !KEY_TYPE_RE.test(parts[0]) ? parts[0].toLowerCase() : null;
    const c = canonicalKeyLine(named ? parts.slice(1).join(' ') : raw);
    if (!c) continue;
    if (named && named !== h && !active('ssh.knownHostsAnyHost')) continue;
    lines.push(`${named ?? h} ${c}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** The six recorded properties of a material file (§9.4a) plus its path. */
export function fileRecord(path, { lstat = lstatSync } = {}) {
  const st = lstat(path);
  return { path, sha256: sha256(readFileSync(path)), size: st.size, uid: st.uid, mode: PERM(st.mode), ino: st.ino, dev: st.dev };
}

const dirRecord = (path, lstat) => { const st = lstat(path); return { path, uid: st.uid, mode: PERM(st.mode), ino: st.ino, dev: st.dev }; };

const tool = (pinned, name) => (active('ssh.unpinnedTools') ? name : pinned[name]);

/** `ssh-add -L` over the recorded socket with the pinned executable. */
export async function listAgentKeys({ spawn, pinned, agentSock, env }) {
  const res = await spawn({ argv: [tool(pinned, 'ssh-add'), '-L'], cwd: '/', env: { ...env, SSH_AUTH_SOCK: agentSock }, deadlineMs: DEADLINES.git, label: 'ssh-add -L' });
  if (res.status !== 0) return { ok: false, lines: [], detail: `ssh-add -L exited ${res.status}` };
  return { ok: true, lines: res.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
}

/** `gh api user/keys` across ALL pages, one page per call; any failure → { ok:false }. */
export async function fetchRegisteredKeys(gh, { perPage = 100, maxPages = 50 } = {}) {
  const keys = [];
  for (let page = 1; page <= maxPages; page++) {
    let arr;
    try { arr = await gh.json(['api', `user/keys?per_page=${perPage}&page=${page}`]); } catch (e) { return { ok: false, keys: [], detail: `page ${page}: ${e.message}` }; }
    if (!Array.isArray(arr)) return { ok: false, keys: [], detail: `page ${page} is not an array` };
    keys.push(...arr);
    if (arr.length < perPage) return { ok: true, keys };
  }
  return { ok: false, keys: [], detail: 'too many pages' };
}

function copyIdentity(identityPath, copyPath, { uid, fstat = fstatSync }) {
  let fd;
  try { fd = openSync(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { throw new SshError('key-file-insecure', `identity: ${e.code === 'ELOOP' ? 'is a symlink' : e.message}`); }
  try {
    const st = fstat(fd);
    if (!active('ssh.acceptInsecureIdentity')) {
      if (!st.isFile()) throw new SshError('key-file-insecure', 'identity is not a regular file');
      if (st.uid !== uid) throw new SshError('key-file-insecure', `identity is owned by uid ${st.uid}, not ${uid}`);
      if (PERM(st.mode) !== 0o600) throw new SshError('key-file-insecure', `identity mode is ${PERM(st.mode).toString(8)}, expected 600`);
    }
    const bytes = readFileSync(fd);
    const out = openSync(copyPath, 'wx', 0o600);
    try { writeFileSync(out, bytes); } finally { closeSync(out); }
    chmodSync(copyPath, 0o600);
  } finally { closeSync(fd); }
}

function checkKnownHostsSource(src, { uid, lstat }) {
  if (active('ssh.acceptAnyKnownHosts')) return;
  let st;
  try { st = lstat(src); } catch { throw new SshError('known-hosts-missing', `${src} is missing; run init --write`); }
  if (!st.isFile()) throw new SshError('known-hosts-missing', `${src} is not a regular file`);
  if (st.uid !== uid) throw new SshError('known-hosts-missing', `${src} is owned by uid ${st.uid}`);
  if (PERM(st.mode) !== 0o600) throw new SshError('known-hosts-missing', `${src} mode is ${PERM(st.mode).toString(8)}, expected 600`);
}

async function derivePublicKey({ spawn, pinned, env, from }) {
  const res = await spawn({ argv: [tool(pinned, 'ssh-keygen'), '-y', '-f', from], cwd: '/', env, deadlineMs: DEADLINES.git, label: 'ssh-keygen -y' });
  if (res.status !== 0) throw new SshError('ssh-identity-unbound', `ssh-keygen -y failed: ${String(res.stderr).trim().slice(0, 200)}`);
  return res.stdout.trim();
}

async function fingerprintOf({ spawn, pinned, env, pubPath }) {
  const res = await spawn({ argv: [tool(pinned, 'ssh-keygen'), '-lf', pubPath], cwd: '/', env, deadlineMs: DEADLINES.git, label: 'ssh-keygen -lf' });
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(res.stdout ?? '');
  if (res.status !== 0 || !m) throw new SshError('ssh-identity-unbound', 'ssh-keygen -lf could not fingerprint the matched key');
  return m[1];
}

/**
 * Create the material directory (§9.4a) and bind the authenticating key.
 * @returns the material record every later revalidation checks.
 */
export async function prepareSshMaterial({ ctx, dir, mode, identityPath = null, agentSock = null, knownHostsSource, registeredKeys, spawn = ctx.spawn }) {
  const uid = ctx.uid ?? process.getuid();
  const lstat = ctx.fs?.lstat ?? lstatSync;
  const fstat = ctx.fs?.fstat ?? fstatSync;
  const env = ctx.env.base;
  const pinned = ctx.pinned;
  let exists = false;
  try { lstat(dir); exists = true; } catch { /* absent — expected */ }
  if (exists) throw new SshError('ssh-dir-exists', dir);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  checkKnownHostsSource(knownHostsSource, { uid, lstat });
  const knownHostsPath = join(dir, 'known_hosts');
  writeFileSync(knownHostsPath, readFileSync(knownHostsSource), { mode: 0o600 });
  chmodSync(knownHostsPath, 0o600);
  let candidates;
  const identityCopy = join(dir, 'identity');
  if (mode === 'explicit') {
    copyIdentity(identityPath, identityCopy, { uid, fstat });
    candidates = [await derivePublicKey({ spawn, pinned, env, from: active('ssh.fingerprintOriginal') ? identityPath : identityCopy })];
  } else if (mode === 'agent') {
    const agent = await listAgentKeys({ spawn, pinned, agentSock, env });
    if (!agent.ok) throw new SshError('ssh-identity-unbound', agent.detail);
    candidates = agent.lines;
  } else throw new SshError('ssh-auth-missing', `unknown mode ${mode}`);
  const match = matchKey({ candidates, registered: registeredKeys });
  if (!match) throw new SshError('ssh-identity-unbound', `none of ${candidates.length} candidate key(s) is registered for the principal`);
  const identityPubPath = join(dir, 'identity.pub');
  writeFileSync(identityPubPath, `${match.line}\n`, { mode: 0o600 });
  chmodSync(identityPubPath, 0o600);
  const fingerprint = await fingerprintOf({ spawn, pinned, env, pubPath: identityPubPath });
  const wrapperIdentity = mode === 'agent' ? identityPubPath : (active('ssh.wrapperNamesOriginal') ? identityPath : identityCopy);
  const wrapperPath = join(dir, 'wrapper');
  const text = wrapperScript({ sshPath: pinned.ssh, knownHostsPath, mode, identityPath: wrapperIdentity, agentSock });
  writeFileSync(wrapperPath, text, { mode: 0o500 });
  chmodSync(wrapperPath, 0o500);
  const paths = [knownHostsPath, ...(mode === 'explicit' ? [identityCopy] : []), identityPubPath, wrapperPath];
  const files = paths.map((p) => fileRecord(p, { lstat }));
  const socket = mode === 'agent' ? (() => { const st = lstat(agentSock); return { path: agentSock, ino: st.ino, dev: st.dev }; })() : null;
  return {
    dir, mode, uid, wrapperPath, wrapperSha256: sha256(text), knownHostsPath,
    identityPath: mode === 'explicit' ? identityCopy : null, identityPubPath, boundKeyLine: match.line, fingerprint,
    files, dirRecord: dirRecord(dir, lstat), agentSock, socket,
  };
}

/**
 * Re-stat + re-hash every file, the directory and (agent mode) the socket and
 * the agent's offered keys, immediately before a network spawn (§9.4a).
 * @returns {{ ok, code: 'ssh-material-tampered'|'ssh-wrapper-tampered'|null, detail }}
 */
export function revalidateSshMaterial(material, { agentKeyLines = null, lstat = lstatSync } = {}) {
  if (active('ssh.skipRevalidation')) return { ok: true, code: null, detail: null };
  const bad = (code, detail) => ({ ok: false, code, detail });
  let d;
  try { d = dirRecord(material.dir, lstat); } catch (e) { return bad('ssh-material-tampered', `dir: ${e.message}`); }
  const r = material.dirRecord;
  if (d.mode !== 0o700 || d.uid !== r.uid || d.ino !== r.ino || d.dev !== r.dev) return bad('ssh-material-tampered', 'directory mode/owner/inode changed');
  for (const rec of material.files) {
    const code = rec.path === material.wrapperPath ? 'ssh-wrapper-tampered' : 'ssh-material-tampered';
    let cur;
    try { cur = fileRecord(rec.path, { lstat }); } catch (e) { return bad(code, `${rec.path}: ${e.message}`); }
    for (const k of ['sha256', 'size', 'uid', 'mode', 'ino', 'dev']) if (cur[k] !== rec[k]) return bad(code, `${rec.path}: ${k} changed`);
  }
  if (material.mode === 'agent') {
    let st;
    try { st = lstat(material.agentSock); } catch (e) { return bad('ssh-material-tampered', `socket: ${e.message}`); }
    if (st.ino !== material.socket.ino || st.dev !== material.socket.dev) return bad('ssh-material-tampered', 'agent socket inode changed');
    if (!Array.isArray(agentKeyLines)) return bad('ssh-material-tampered', 'agent keys were not re-enumerated');
    if (!agentKeyLines.some((l) => canonicalKeyLine(l) === material.boundKeyLine)) return bad('ssh-material-tampered', 'agent no longer offers the bound key');
  }
  return { ok: true, code: null, detail: null };
}

/** Dry-run material lives under mkdtemp in $XDG_RUNTIME_DIR (else $TMPDIR), never under REPO_ROOT (§0, AC 159). */
export function createDryRunSshDir({ env = {}, repoRoot, runsDir = null }) {
  const base = active('ssh.dryRunUnderRepo') && runsDir ? runsDir : (env.XDG_RUNTIME_DIR || env.TMPDIR || tmpdir());
  if (!active('ssh.dryRunUnderRepo') && repoRoot && isUnder(repoRoot, base)) throw new SshError('ssh-dir-exists', `temporary base ${base} lies under REPO_ROOT`);
  mkdirSync(base, { recursive: true });
  const parent = mkdtempSync(join(base, 'adlc-autopilot-ssh-'));
  chmodSync(parent, 0o700);
  return { parent, dir: join(parent, 'material') };
}

export function removeSshDir(dir) { rmSync(dir, { recursive: true, force: true }); }
