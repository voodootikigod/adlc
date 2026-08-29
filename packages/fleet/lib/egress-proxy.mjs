// Model-plane egress proxy (issue-autopilot spec §6.4 "EGRESS", §14 item 13, AC 152).
//
// The model-plane worker runs under `bwrap --unshare-net`: a fresh network
// namespace with loopback only, so TCP cannot leave it. It still has to reach
// its model API. This module is the HOST side of the route out:
//
//   worker ──HTTPS_PROXY──▶ 127.0.0.1:<port> (bridge, in the sandbox)
//          ──unix socket──▶ this proxy (on the host)
//          ──CONNECT──────▶ ONLY an allowlisted host:port
//
// Unix sockets are filesystem objects, so a bind mount carries one across the
// namespace boundary where TCP cannot follow. Everything that is not a CONNECT
// to an allowlisted target is refused, recorded, and logged: a plain GET, an
// unlisted host, the right host on the wrong port, a malformed head. The
// allowlist is exact `host:port` pairs — no wildcard exists, implicit or
// otherwise — so the harness's OAuth token can reach exactly the service that
// issued it and nothing else.

import net from 'node:net';
import dns from 'node:dns';
import { chmodSync, unlinkSync } from 'node:fs';

/** Loopback port the in-sandbox bridge listens on unless fleet says otherwise. */
export const DEFAULT_BRIDGE_PORT = 8118;

/** Why a request was refused; each value appears verbatim in `refused` and the log. */
export const REFUSAL = Object.freeze({
  MALFORMED: 'malformed-head',
  METHOD: 'method-not-connect',
  NOT_ALLOWED: 'not-allowlisted',
  PRIVATE: 'private-destination',
});

const HEAD_TERMINATOR = '\r\n\r\n';
// A CONNECT head is a request line plus a handful of headers. Anything larger is
// not a proxy client we serve, and buffering it unbounded would let a worker pin
// host memory through the one socket it is allowed to touch.
const MAX_HEAD_BYTES = 8 * 1024;
/** A client that has not finished its CONNECT head within this window is dropped (codex r4). */
export const HEAD_TIMEOUT_MS = 10_000;
/** The most concurrent clients the proxy holds; the sandbox has one worker, not a fleet of them. */
export const MAX_CLIENTS = 64;
const IMPLICIT_PORT = 443;

const REPLY = Object.freeze({
  established: 'HTTP/1.1 200 Connection Established\r\n\r\n',
  forbidden: 'HTTP/1.1 403 Forbidden\r\n\r\n',
  badGateway: 'HTTP/1.1 502 Bad Gateway\r\n\r\n',
});

const NO_TARGET = Object.freeze({ method: null, host: null, port: null });

/** `host:port` or `[v6]:port` → `{ host, port }` (host lower-cased), else null. */
function parseAuthority(authority) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (m[1] ?? m[2]).toLowerCase(), port };
}

/**
 * Parse a complete request head (everything up to and including the first
 * `\r\n\r\n`). Returns `{ method, host, port }`; for a well-formed non-CONNECT
 * request `host`/`port` are null (the caller refuses it by method); for a head
 * that is not `METHOD target HTTP/1.x` — or a CONNECT whose target is not a
 * `host:port` authority — returns null.
 */
export function parseConnectTarget(requestHead) {
  if (typeof requestHead !== 'string') return null;
  const end = requestHead.indexOf(HEAD_TERMINATOR);
  if (end === -1) return null;
  const requestLine = requestHead.slice(0, end).split('\r\n')[0];
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!m) return null;
  const [, method, target] = m;
  if (method !== 'CONNECT') return { method, host: null, port: null };
  const authority = parseAuthority(target);
  return authority ? { method, ...authority } : null;
}

/**
 * One allowlist entry → `{ host, port }` or null when it is not an entry this
 * proxy can honour. A bare host means port 443 and ONLY 443; a `*` anywhere is
 * rejected rather than interpreted, so no spelling of an entry widens the list.
 */
function parseAllowEntry(entry) {
  if (typeof entry !== 'string' || entry.includes('*')) return null;
  const explicit = parseAuthority(entry);
  if (explicit) return explicit;
  return /^[a-z0-9.-]+$/i.test(entry) ? { host: entry.toLowerCase(), port: IMPLICIT_PORT } : null;
}

/** Validate and normalise an allowlist; throws on any entry it cannot honour (fail closed). */
export function normalizeAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) throw new TypeError('egress allowlist must be an array of host:port strings');
  return allowlist.map((entry) => {
    const parsed = parseAllowEntry(entry);
    if (!parsed) throw new Error(`invalid egress allowlist entry: ${JSON.stringify(entry)} (expected host:port, no wildcards)`);
    return parsed;
  });
}

/** True only for a CONNECT whose host (case-insensitively) and port both match one entry exactly. */
export function isAllowed(target, allowlist) {
  if (!target || target.method !== 'CONNECT' || typeof target.host !== 'string') return false;
  if (!Array.isArray(allowlist)) return false;
  const host = target.host.toLowerCase();
  return allowlist.some((entry) => {
    const parsed = parseAllowEntry(entry);
    return parsed !== null && parsed.host === host && parsed.port === target.port;
  });
}

/** The worker's proxy environment: everything through the bridge, nothing bypasses it. */
export function egressEnv(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`invalid bridge port: ${port}`);
  const proxy = `http://127.0.0.1:${port}`;
  return Object.freeze({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: '' });
}

function refuse(client, ctx, target, reason) {
  const entry = Object.freeze({ method: target.method, host: target.host, port: target.port, reason });
  ctx.refused.push(entry);
  ctx.log(entry);
  client.end(REPLY.forbidden);
}

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
const inCidr4 = (ip, net4, bits) => (bits === 0 ? true : Math.floor(v4ToInt(ip) / 2 ** (32 - bits)) === Math.floor(v4ToInt(net4) / 2 ** (32 - bits)));
/** IANA special-purpose IPv4 space (RFC 6890 and successors): nothing here is a public model endpoint. */
export const NON_PUBLIC_V4 = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]);

/** True for loopback, link-local, private, CGNAT, multicast, unspecified, documentation and reserved addresses (v4, v6, v4-mapped, 6to4/NAT64/Teredo-embedded). */
export function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return !NON_PUBLIC_V4.some(([net4, bits]) => inCidr4(ip, net4, bits));
  if (v === 6) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPublicAddress(mapped[1]);
    if (low === '::1' || low === '::') return false;
    if (/^f[cd]/.test(low)) return false;            // fc00::/7 unique local
    if (/^fe[89ab]/.test(low)) return false;         // fe80::/10 link-local
    if (/^ff/.test(low)) return false;               // multicast
    if (/^2001:db8:/.test(low)) return false;        // documentation
    if (/^100:(0:0:0:|:)/.test(low) || low.startsWith('100::')) return false; // discard-only
    if (/^2002:/.test(low)) return false;            // 6to4 (embeds an IPv4 the proxy cannot vet)
    if (/^2001:0?:/.test(low) || /^2001::/.test(low)) return false; // Teredo (obfuscated embedded IPv4)
    if (/^64:ff9b:/.test(low)) return false;         // NAT64 well-known prefix (embedded IPv4)
    return true;
  }
  return false;
}

/**
 * Resolve an allowlisted host to the ONE address the tunnel will dial. Every address the name
 * resolves to must be public — a name under the worker's control (DNS rebinding) cannot reach
 * loopback, link-local or RFC1918 space through the proxy (codex r14 #2). An IP LITERAL in the
 * allowlist is the operator's explicit intent and is dialled as written. The tunnel then dials the
 * vetted ADDRESS, never re-resolving the name.
 */
export async function resolveVettedAddress(host, lookup) {
  if (net.isIP(host)) return host;
  const found = await lookup(host, { all: true });
  const addrs = (Array.isArray(found) ? found : [found]).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  if (addrs.length === 0) throw new Error(`${host} resolved to no address`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new Error(`${host} resolves to a non-public address (${bad})`);
  return addrs[0];
}

function tunnel(client, target, leftover, ctx) {
  const upstream = ctx.connect(target.port, target.address ?? target.host);
  let established = false;
  upstream.on('error', () => {
    // Before the tunnel is up the client is still waiting on an HTTP reply, so it
    // gets one; afterwards the only honest signal is to drop both ends.
    if (!established && client.writable) client.end(REPLY.badGateway);
    else client.destroy();
    upstream.destroy();
  });
  upstream.on('connect', () => {
    established = true;
    client.write(REPLY.established);
    // A client may send the TLS ClientHello in the same packet as the head;
    // those bytes belong to the tunnel and must not be dropped.
    if (leftover.length > 0) upstream.write(leftover);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on('close', () => client.destroy());
  client.on('close', () => upstream.destroy());
}

function handleClient(client, ctx) {
  if (ctx.clients.size >= ctx.maxClients) {
    ctx.log({ event: 'egress-proxy-refused', reason: 'too-many-clients', clients: ctx.clients.size });
    client.destroy();
    return;
  }
  ctx.clients.add(client);
  // The head must arrive within the deadline: an idle or trickling client cannot
  // hold a descriptor and a buffer forever.
  const headTimer = ctx.setTimeoutFn(() => { ctx.log({ event: 'egress-proxy-refused', reason: 'head-timeout' }); client.destroy(); }, ctx.headTimeoutMs);
  client.on('close', () => { ctx.clearTimeoutFn(headTimer); ctx.clients.delete(client); });
  client.on('error', () => client.destroy());
  let buffered = Buffer.alloc(0);
  const onHead = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const idx = buffered.indexOf(HEAD_TERMINATOR);
    if (idx === -1 && buffered.length <= MAX_HEAD_BYTES) return;
    // A head larger than the limit is refused whether or not its terminator arrived (codex r15 #2).
    if (idx === -1 || idx + HEAD_TERMINATOR.length > MAX_HEAD_BYTES) {
      client.removeListener('data', onHead); ctx.clearTimeoutFn(headTimer); client.pause();
      return refuse(client, ctx, NO_TARGET, REFUSAL.MALFORMED);
    }
    // Decision point: stop consuming here and pause, so bytes that arrive before
    // the tunnel is up wait in the stream instead of being emitted to nobody.
    client.removeListener('data', onHead);
    ctx.clearTimeoutFn(headTimer);
    client.pause();
    if (idx === -1) return refuse(client, ctx, NO_TARGET, REFUSAL.MALFORMED);
    const target = parseConnectTarget(buffered.subarray(0, idx + HEAD_TERMINATOR.length).toString('latin1'));
    if (!target) return refuse(client, ctx, NO_TARGET, REFUSAL.MALFORMED);
    if (target.method !== 'CONNECT') return refuse(client, ctx, target, REFUSAL.METHOD);
    if (!isAllowed(target, ctx.allowlist)) return refuse(client, ctx, target, REFUSAL.NOT_ALLOWED);
    resolveVettedAddress(target.host, ctx.lookup).then(
      (address) => { if (!client.destroyed) tunnel(client, { ...target, address }, buffered.subarray(idx + HEAD_TERMINATOR.length), ctx); },
      (e) => { ctx.log({ event: 'egress-proxy-refused', reason: REFUSAL.PRIVATE, host: target.host, detail: e.message }); refuse(client, ctx, target, REFUSAL.PRIVATE); },
    );
    return undefined;
  };
  client.on('data', onHead);
}

/**
 * Start the proxy on a unix socket. Resolves to
 * `{ socketPath, allowlist, refused, close }` once listening; `allowlist` is the
 * normalised `host:port` list (what fleet's `--json` reports), `refused` grows
 * with every refused request, `close()` drops open clients and stops listening.
 * `connect(port, host)` is injectable for tests and must return a socket that
 * emits `connect`, `error` and `close`.
 */
export function startEgressProxy({ socketPath, allowlist, log = () => {}, connect = net.connect, lookup = dns.promises.lookup, headTimeoutMs = HEAD_TIMEOUT_MS, maxClients = MAX_CLIENTS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) throw new TypeError('socketPath is required');
  const normalized = normalizeAllowlist(allowlist);
  const ctx = { allowlist: normalized.map((e) => `${e.host}:${e.port}`), refused: [], clients: new Set(), log, connect, lookup, headTimeoutMs, maxClients, setTimeoutFn, clearTimeoutFn };
  const server = net.createServer((client) => handleClient(client, ctx));
  const close = () => new Promise((resolve) => {
    for (const client of ctx.clients) client.destroy();
    // The socket PATHNAME outlives the server: unlink it, or the next strike's
    // listen on the same path fails EADDRINUSE.
    server.close(() => { try { unlinkSync(socketPath); } catch { /* already gone */ } resolve(); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // A server error after listen must never take fleet down with it.
      server.on('error', (err) => log({ event: 'egress-proxy-error', message: err.message }));
      // Only this uid may talk to the proxy; the sandbox runs as the same uid.
      chmodSync(socketPath, 0o600);
      resolve({ socketPath, allowlist: Object.freeze([...ctx.allowlist]), refused: ctx.refused, close });
    });
  });
}
