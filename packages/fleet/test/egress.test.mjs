// Model-plane egress (issue-autopilot spec §6.4 "EGRESS", §14 item 13, AC 152).
//
// The worker runs under `bwrap --unshare-net`; its only way out is a loopback
// bridge → bind-mounted unix socket → host-side CONNECT proxy whose allowlist is
// the adapter's declared model hosts. Three layers are prosecuted here:
//   1. the pure parsers and the allow predicate (fixtures);
//   2. a REAL proxy on a temp unix socket fronting a local TCP echo server;
//   3. the REAL bridge as a subprocess — and then inside a REAL bwrap namespace,
//      where the client proves that only the allowlisted CONNECT gets through.
// The bwrap test SKIPS LOUDLY with the reason when it cannot run: a containment
// test that quietly passes because nothing contained anything is worse than none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, realpathSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

import {
  DEFAULT_BRIDGE_PORT, REFUSAL, parseConnectTarget, isAllowed, egressEnv, startEgressProxy,
} from '../lib/egress-proxy.mjs';
import { parseBridgeArgv, childExitCode } from '../lib/egress-bridge.mjs';
import { detectBackend } from '../lib/sandbox.mjs';
import { adapterCatalog, ADAPTERS, getAdapter } from '../lib/adapters/index.mjs';
import * as claudeCode from '../lib/adapters/claude-code.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'egress-bridge.mjs');
const HEAD = (line) => `${line}\r\nHost: x\r\n\r\n`;

// ── helpers ──────────────────────────────────────────────────────────────────

function scratch(prefix) { return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix))); }

/** A TCP echo server on 127.0.0.1 — the stand-in for "the model API". */
function startEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => { s.on('error', () => s.destroy()); s.pipe(s); });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Read from `socket` (starting from `initial`, bytes an earlier read already took)
 * until `predicate(buffered)` holds; rejects on error or a close before that.
 * Callers chain the returned buffer so a chunk that coalesces two logical
 * messages is never lost between reads.
 */
function readUntil(socket, predicate, initial = '') {
  return new Promise((resolve, reject) => {
    let buf = initial;
    if (predicate(buf)) return resolve(buf);
    const onData = (d) => { buf += d.toString('latin1'); if (predicate(buf)) { socket.removeListener('data', onData); resolve(buf); } };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => (predicate(buf) ? resolve(buf) : reject(new Error(`closed early with: ${JSON.stringify(buf)}`))));
  });
}

/** Send `head` down `path` (unix socket) and return the status line, the bytes after the reply head, and the socket. */
async function request({ path }, head) {
  const socket = net.connect(path);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(head);
  const reply = await readUntil(socket, (b) => b.includes('\r\n\r\n'));
  const end = reply.indexOf('\r\n\r\n');
  return { status: reply.slice(0, end).split('\r\n')[0], rest: reply.slice(end + 4), socket };
}

async function withProxy(allowlist, fn) {
  const dir = scratch('egress-');
  const log = [];
  const proxy = await startEgressProxy({ socketPath: join(dir, 'p.sock'), allowlist, log: (e) => log.push(e) });
  try { return await fn(proxy, log); } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('close() unlinks the socket pathname, so a second proxy on the SAME path (the next strike) can listen', async () => {
  const dir = scratch('egress-relisten-');
  try {
    const path = join(dir, 'p.sock');
    const first = await startEgressProxy({ socketPath: path, allowlist: ['api.anthropic.com:443'] });
    assert.ok(existsSync(path), 'the socket exists while listening');
    await first.close();
    assert.ok(!existsSync(path), 'the pathname is unlinked on close');
    const second = await startEgressProxy({ socketPath: path, allowlist: ['api.anthropic.com:443'] });
    assert.ok(existsSync(path), 'a re-listen on the same path succeeds (no EADDRINUSE)');
    await second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 1. parsers and the allow predicate ───────────────────────────────────────

test('parseConnectTarget accepts only a complete `CONNECT host:port HTTP/1.x` head, lower-casing the host', () => {
  assert.deepEqual(parseConnectTarget(HEAD('CONNECT Api.Anthropic.com:443 HTTP/1.1')), { method: 'CONNECT', host: 'api.anthropic.com', port: 443 });
  assert.deepEqual(parseConnectTarget(HEAD('CONNECT [::1]:8443 HTTP/1.0')), { method: 'CONNECT', host: '::1', port: 8443 });
  assert.deepEqual(parseConnectTarget(HEAD('GET / HTTP/1.1')), { method: 'GET', host: null, port: null }, 'a GET is well-formed but has no tunnel target');
  for (const bad of [
    'CONNECT api.anthropic.com HTTP/1.1', // no port: never an implicit 443 at the parser
    'CONNECT api.anthropic.com:0 HTTP/1.1', 'CONNECT api.anthropic.com:70000 HTTP/1.1',
    'CONNECT https://api.anthropic.com:443 HTTP/1.1', 'CONNECT api.anthropic.com:443 HTTP/2',
    'connect api.anthropic.com:443 HTTP/1.1', 'CONNECT  api.anthropic.com:443 HTTP/1.1', 'garbage',
  ]) assert.equal(parseConnectTarget(HEAD(bad)), null, bad);
  assert.equal(parseConnectTarget('CONNECT a:443 HTTP/1.1\r\n'), null, 'an incomplete head is not a head');
  assert.equal(parseConnectTarget(undefined), null);
});

test('isAllowed is an exact host:port match — case-insensitive host, no wildcard, no implicit any-port', () => {
  const list = ['api.anthropic.com:443', 'console.anthropic.com'];
  const t = (host, port) => ({ method: 'CONNECT', host, port });
  assert.equal(isAllowed(t('api.anthropic.com', 443), list), true);
  assert.equal(isAllowed(t('API.ANTHROPIC.COM', 443), list), true);
  assert.equal(isAllowed(t('console.anthropic.com', 443), list), true, 'a bare entry means 443');
  assert.equal(isAllowed(t('console.anthropic.com', 8443), list), false, 'and ONLY 443');
  assert.equal(isAllowed(t('api.anthropic.com', 80), list), false, 'the right host on the wrong port');
  assert.equal(isAllowed(t('evil.anthropic.com', 443), list), false);
  assert.equal(isAllowed(t('api.anthropic.com.evil.io', 443), list), false);
  assert.equal(isAllowed(t('anything.example', 443), ['*:443', '*']), false, 'a wildcard entry matches NOTHING');
  assert.equal(isAllowed({ method: 'GET', host: null, port: null }, list), false);
  assert.equal(isAllowed(null, list), false);
  assert.equal(isAllowed(t('api.anthropic.com', 443), []), false, 'an empty allowlist admits nobody');
});

test('egressEnv points both proxies at the bridge and leaves NO_PROXY empty so nothing bypasses it', () => {
  assert.deepEqual(egressEnv(8118), { HTTPS_PROXY: 'http://127.0.0.1:8118', HTTP_PROXY: 'http://127.0.0.1:8118', NO_PROXY: '' });
  assert.equal(DEFAULT_BRIDGE_PORT, 8118);
  assert.throws(() => egressEnv(0));
  assert.throws(() => egressEnv('8118'));
});

// ── 2. the real proxy over a unix socket ─────────────────────────────────────

test('an allowlisted CONNECT gets 200 and a byte-transparent tunnel; the socket is 0600', async () => {
  const echo = await startEcho();
  try {
    await withProxy([`127.0.0.1:${echo.port}`], async (proxy) => {
      assert.equal(statSync(proxy.socketPath).mode & 0o777, 0o600);
      assert.deepEqual(proxy.allowlist, [`127.0.0.1:${echo.port}`]);
      // ClientHello-style coalescing: payload in the SAME write as the head must reach the target.
      const { status, rest, socket } = await request({ path: proxy.socketPath }, `${HEAD(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1`)}early`);
      assert.equal(status, 'HTTP/1.1 200 Connection Established');
      const first = await readUntil(socket, (b) => b.includes('early'), rest);
      assert.equal(first, 'early', 'bytes after the head belong to the tunnel, not the floor');
      socket.write('ping');
      const echoed = await readUntil(socket, (b) => b.includes('earlyping'), first);
      assert.equal(echoed, 'earlyping');
      socket.destroy();
      assert.deepEqual(proxy.refused, []);
    });
  } finally { await echo.close(); }
});

test('an unlisted host, the right host on the wrong port, a GET and a malformed head are all 403 and recorded', async () => {
  const echo = await startEcho();
  try {
    await withProxy([`127.0.0.1:${echo.port}`], async (proxy, log) => {
      const cases = [
        [HEAD('CONNECT example.com:443 HTTP/1.1'), { method: 'CONNECT', host: 'example.com', port: 443, reason: REFUSAL.NOT_ALLOWED }],
        [HEAD(`CONNECT 127.0.0.1:${echo.port + 1} HTTP/1.1`), { method: 'CONNECT', host: '127.0.0.1', port: echo.port + 1, reason: REFUSAL.NOT_ALLOWED }],
        [HEAD('GET / HTTP/1.1'), { method: 'GET', host: null, port: null, reason: REFUSAL.METHOD }],
        ['not http at all\r\n\r\n', { method: null, host: null, port: null, reason: REFUSAL.MALFORMED }],
      ];
      for (const [head, expected] of cases) {
        const { status, socket } = await request({ path: proxy.socketPath }, head);
        assert.equal(status, 'HTTP/1.1 403 Forbidden', head);
        await new Promise((r) => socket.once('close', r));
      }
      assert.deepEqual(proxy.refused, cases.map(([, e]) => e));
      assert.deepEqual(log, proxy.refused, 'every refusal is also logged');
    });
  } finally { await echo.close(); }
});

test('a head that never terminates is cut off, not buffered forever', async () => {
  await withProxy([], async (proxy) => {
    const { status } = await request({ path: proxy.socketPath }, `CONNECT ${'a'.repeat(9000)}:443 HTTP/1.1\r\n`);
    assert.equal(status, 'HTTP/1.1 403 Forbidden');
    assert.equal(proxy.refused[0].reason, REFUSAL.MALFORMED);
  });
});

test('an allowlisted target that refuses the connection yields 502, and the proxy survives', async () => {
  const dead = await freePort();
  await withProxy([`127.0.0.1:${dead}`], async (proxy) => {
    const { status } = await request({ path: proxy.socketPath }, HEAD(`CONNECT 127.0.0.1:${dead} HTTP/1.1`));
    assert.equal(status, 'HTTP/1.1 502 Bad Gateway');
    const again = await request({ path: proxy.socketPath }, HEAD('GET / HTTP/1.1'));
    assert.equal(again.status, 'HTTP/1.1 403 Forbidden', 'still serving after an upstream failure');
    again.socket.destroy();
  });
});

test('startEgressProxy refuses to start on an allowlist it cannot honour (fail closed)', () => {
  assert.throws(() => startEgressProxy({ socketPath: '/x', allowlist: ['*.anthropic.com:443'] }), /invalid egress allowlist entry/);
  assert.throws(() => startEgressProxy({ socketPath: '/x', allowlist: 'api.anthropic.com:443' }), TypeError);
});

// ── 3. the bridge ────────────────────────────────────────────────────────────

test('parseBridgeArgv requires --socket, --port and a "--"-separated command, and rejects everything else', () => {
  assert.deepEqual(parseBridgeArgv(['--socket', '/s', '--port', '8118', '--', 'node', '-e', '1']), { socketPath: '/s', port: 8118, command: ['node', '-e', '1'] });
  assert.deepEqual(parseBridgeArgv(['--port', '80', '--socket', '/s', '--', 'sh']).command, ['sh'], 'flag order is free');
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--port', '8118']), /missing "--"/);
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--port', '8118', 'node', '-e', '1']), /unknown bridge argument/, 'a command without "--" is not guessed at');
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--port', '8118', '--']), /missing command/);
  assert.throws(() => parseBridgeArgv(['--socket', '--port', '8118', '--', 'x']), /--socket requires a value/);
  assert.throws(() => parseBridgeArgv(['--port', '8118', '--', 'x']), /missing --socket/);
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--', 'x']), /missing --port/);
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--port', 'abc', '--', 'x']), /--port must be/);
  assert.throws(() => parseBridgeArgv(['--socket', '/s', '--port', '8118', '--verbose', '--', 'x']), /unknown bridge argument/);
  assert.equal(childExitCode(null, 'SIGTERM'), 143);
  assert.equal(childExitCode(3, null), 3);
});

// Runs under `node -e` as the bridge's child. Proves the proxy path end to end from
// INSIDE (the bridge, or the sandbox): exits EXIT_OK only when every check holds.
// SANDBOX_CHECKS=1 adds the two namespace checks — direct TCP and DNS both fail.
const CLIENT = `
const net=require('node:net'),dns=require('node:dns');
const B=+process.env.BRIDGE_PORT,E=+process.env.ECHO_PORT,OK=+process.env.EXIT_OK;
const fail=(m)=>{console.error('client: '+m);process.exit(1)};
const connect=(t)=>new Promise((res,rej)=>{const s=net.connect(B,'127.0.0.1');let b='';s.on('error',rej);
  s.on('data',(d)=>{b+=d;const i=b.indexOf('\\r\\n\\r\\n');if(i!==-1){s.removeAllListeners('data');res({s,status:b.slice(0,i).split(' ')[1]})}});
  s.write('CONNECT '+t+' HTTP/1.1\\r\\nHost: '+t+'\\r\\n\\r\\n')});
(async()=>{
  const a=await connect('127.0.0.1:'+E); if(a.status!=='200')fail('allowed CONNECT got '+a.status);
  const echoed=await new Promise((res,rej)=>{a.s.once('data',(d)=>res(String(d)));a.s.on('error',rej);a.s.write('ping')});
  if(echoed!=='ping')fail('echo mismatch: '+echoed); a.s.destroy();
  const b=await connect('example.com:443'); if(b.status!=='403')fail('example.com got '+b.status); b.s.destroy();
  if(process.env.SANDBOX_CHECKS==='1'){
    const direct=await new Promise((res)=>{const s=net.connect(E,'127.0.0.1');s.once('connect',()=>{s.destroy();res('connected')});s.once('error',(e)=>res(e.code))});
    if(direct==='connected')fail('direct TCP reached the host echo server');
    const looked=await new Promise((res)=>dns.lookup('example.com',(e,addr)=>res(e?e.code:'resolved '+addr)));
    if(looked.startsWith('resolved'))fail('dns '+looked);
  }
  process.exit(OK);
})().catch((e)=>fail(e.stack||e));
`;

/**
 * Run the REAL bridge (optionally under a wrapper such as bwrap) with CLIENT as
 * its child. Asynchronous on purpose: the proxy under test lives in THIS process,
 * and a blocking spawnSync would starve it of the event loop it needs to answer.
 */
function runBridge({ wrapper = [], socketPath, bridgePort, env }) {
  const argv = [...wrapper, process.execPath, BRIDGE, '--socket', socketPath, '--port', String(bridgePort), '--', process.execPath, '-e', CLIENT];
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env, BRIDGE_PORT: String(bridgePort) } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`bridge run timed out; stderr: ${stderr}`)); }, 20_000);
    child.once('error', reject);
    child.once('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stderr }); });
  });
}

test('the bridge forwards its loopback port to the proxy end to end and exits with its child\'s code', { timeout: 30_000 }, async () => {
  const echo = await startEcho();
  try {
    await withProxy([`127.0.0.1:${echo.port}`], async (proxy) => {
      const bridgePort = await freePort();
      // EXIT_OK=3: the child exits 3 only after the tunnel round-trip and the 403 both
      // held, so a bridge exit of 3 proves forwarding AND exit-code propagation at once.
      const res = await runBridge({ socketPath: proxy.socketPath, bridgePort, env: { ECHO_PORT: String(echo.port), EXIT_OK: '3' } });
      assert.equal(res.status, 3, `stderr: ${res.stderr}`);
      assert.deepEqual(proxy.refused.map((r) => r.host), ['example.com']);
    });
  } finally { await echo.close(); }
});

test('the bridge relays SIGTERM to its child and exits 128+signal', { timeout: 30_000 }, async () => {
  const bridgePort = await freePort();
  const pidfile = join(scratch('egress-bridge-child-'), 'inner.pid');
  const child = spawn(process.execPath, [BRIDGE, '--socket', '/nonexistent.sock', '--port', String(bridgePort), '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(()=>{},1000)`], { stdio: 'ignore' });
  // Wait until the loopback port answers — that is the moment the child has been spawned. A loaded
  // host may take seconds to start two node processes: wait up to 20 s and FAIL LOUDLY if it never
  // listens, instead of signalling a bridge that is not up yet.
  let up = false;
  for (let i = 0; i < 400 && !up; i += 1) {
    up = await new Promise((r) => { const s = net.connect(bridgePort, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (!up) await new Promise((r) => setTimeout(r, 50));
  }
  try {
    assert.equal(up, true, 'the bridge listened within 20 s');
    // The INNER worker must be provably alive before the signal: wait for its pidfile (a loaded
    // host can take a second to boot the second node), so the relay is exercised for real.
    let inner = 0;
    for (let i = 0; i < 400 && !inner; i += 1) {
      try { inner = Number(readFileSync(pidfile, 'utf8').trim()); } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(inner > 1, 'the inner worker started (pidfile) within 20 s');
    child.kill('SIGTERM');
    const status = await new Promise((r) => child.once('exit', (code) => r(code)));
    assert.equal(status, 143, 'the child died of SIGTERM (128+15), so that is what the bridge reports');
    // The INNER child (the worker) is gone too — the bridge relayed the signal, it did not just die itself.
    let alive = true; for (let i = 0; i < 40 && alive; i++) { try { process.kill(inner, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } }
    if (alive) { try { process.kill(inner, 'SIGKILL'); } catch { /* gone */ } }
    assert.equal(alive, false, 'the inner worker process was terminated with the bridge');
  } finally { try { child.kill('SIGKILL'); } catch { /* gone */ } rmSync(dirname(pidfile), { recursive: true, force: true }); }
});

test('the bridge relays SIGINT too (fleet stops a run with either signal) and exits 128+2', { timeout: 30_000 }, async () => {
  // Both forwarded signals are load-bearing: a bridge that relayed only SIGTERM
  // would leave a worker running past a Ctrl-C / SIGINT stop.
  const bridgePort = await freePort();
  const child = spawn(process.execPath, [BRIDGE, '--socket', '/nonexistent.sock', '--port', String(bridgePort), '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    const up = await new Promise((r) => { const s = net.connect(bridgePort, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGINT');
  const status = await new Promise((r) => child.once('exit', (code) => r(code)));
  assert.equal(status, 130, 'the child died of SIGINT (128+2), so that is what the bridge reports');
});

test('the bridge exits 1 and never spawns the command when its port is already taken', { timeout: 30_000 }, async () => {
  // A worker started with HTTPS_PROXY pointing at a port the bridge does not own
  // would talk to whatever IS there; refusing to start is the only safe outcome.
  const dir = scratch('egress-mark-');
  const taken = net.createServer();
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  try {
    const mark = join(dir, 'ran');
    const res = spawnSync(process.execPath, [BRIDGE, '--socket', '/s', '--port', String(taken.address().port), '--', process.execPath, '-e', 'require("fs").writeFileSync(process.env.MARK,"ran")'],
      { encoding: 'utf8', env: { ...process.env, MARK: mark }, timeout: 20_000 });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /egress-bridge: .*EADDRINUSE/);
    assert.equal(existsSync(mark), false, 'the command must not have run');
  } finally { taken.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. inside a REAL bwrap network namespace ─────────────────────────────────

/** Probe once: bwrap present AND able to unshare the network with node bound as a file. */
function bwrapArgv(extra = []) {
  const argv = ['bwrap', '--unshare-net', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib'];
  for (const p of ['/lib64', '/bin', '/etc']) if (existsSync(p)) argv.push('--ro-bind', p, p);
  argv.push('--ro-bind', process.execPath, process.execPath, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', ...extra, '--die-with-parent', '--');
  return argv;
}

function probeBwrap() {
  const backend = detectBackend();
  if (backend?.name !== 'bubblewrap') return { ok: false, reason: `no bubblewrap backend on this host (detected: ${backend?.name ?? 'none'})` };
  const argv = bwrapArgv();
  const res = spawnSync(argv[0], [...argv.slice(1), process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 10_000 });
  if (res.status === 0) return { ok: true };
  return { ok: false, reason: `bwrap --unshare-net cannot run here (user namespaces unavailable?): ${(res.stderr || res.error?.message || '').trim()}` };
}
const bwrap = probeBwrap();

test('inside bwrap --unshare-net ONLY the allowlisted CONNECT gets out; direct TCP and DNS fail; the proxy names the refused host', { skip: bwrap.ok ? false : bwrap.reason, timeout: 60_000 }, async () => {
  const echo = await startEcho();
  try {
    await withProxy([`127.0.0.1:${echo.port}`], async (proxy) => {
      // `--tmpfs /tmp` must come BEFORE the socket-dir bind or it would shadow it.
      const wrapper = bwrapArgv(['--bind', dirname(proxy.socketPath), dirname(proxy.socketPath), '--ro-bind', BRIDGE, BRIDGE]);
      const res = await runBridge({
        wrapper, socketPath: proxy.socketPath, bridgePort: DEFAULT_BRIDGE_PORT,
        env: { ECHO_PORT: String(echo.port), EXIT_OK: '0', SANDBOX_CHECKS: '1' },
      });
      assert.equal(res.status, 0, `client inside the sandbox failed a check: ${res.stderr}`);
      assert.deepEqual(proxy.refused, [{ method: 'CONNECT', host: 'example.com', port: 443, reason: REFUSAL.NOT_ALLOWED }]);
    });
  } finally { await echo.close(); }
});

// ── 5. the adapter declaration ───────────────────────────────────────────────

test('claude-code declares its model API and OAuth hosts, all on 443, and the catalog carries them', () => {
  assert.deepEqual([...claudeCode.egressHosts], ['api.anthropic.com:443', 'console.anthropic.com:443', 'platform.claude.com:443']);
  assert.deepEqual(adapterCatalog()['claude-code'].egressHosts, [...claudeCode.egressHosts]);
  for (const host of claudeCode.egressHosts) assert.ok(isAllowed(parseConnectTarget(HEAD(`CONNECT ${host} HTTP/1.1`)), claudeCode.egressHosts), host);
});

test('an adapter that declares no egress hosts gets NONE — never an implicit open proxy', () => {
  for (const name of ADAPTERS) {
    const declared = getAdapter(name).egressHosts;
    assert.deepEqual(adapterCatalog()[name].egressHosts, declared ? [...declared] : [], name);
  }
  assert.equal(isAllowed(parseConnectTarget(HEAD('CONNECT api.openai.com:443 HTTP/1.1')), adapterCatalog().codex.egressHosts), false,
    'codex declares nothing yet, so under allowlist mode it reaches nothing');
});

import { HEAD_TIMEOUT_MS, MAX_CLIENTS } from '../lib/egress-proxy.mjs';
test('a client that never finishes its CONNECT head is dropped at the head deadline, and clients beyond the cap are refused (codex r4)', async () => {
  assert.equal(HEAD_TIMEOUT_MS, 10_000); assert.equal(MAX_CLIENTS, 64);
  const dir = scratch('egress-bounds-');
  const log = [];
  const proxy = await startEgressProxy({ socketPath: join(dir, 'p.sock'), allowlist: ['api.anthropic.com:443'], log: (e) => log.push(e), headTimeoutMs: 50, maxClients: 2 });
  try {
    const idle = net.connect(proxy.socketPath);
    await new Promise((r) => idle.once('connect', r));
    idle.write('CONNECT api.anthropic.com:443'); // never terminates the head
    await new Promise((r) => idle.once('close', r));
    assert.ok(log.some((e) => e.reason === 'head-timeout'), 'the idle client was dropped at the deadline');
    const a = net.connect(proxy.socketPath); const b = net.connect(proxy.socketPath);
    await Promise.all([a, b].map((s) => new Promise((r) => s.once('connect', r))));
    await new Promise((r) => setTimeout(r, 10));
    const c = net.connect(proxy.socketPath);
    await new Promise((r) => c.once('close', r));
    assert.ok(log.some((e) => e.reason === 'too-many-clients'), 'the third client is refused at the cap');
    a.destroy(); b.destroy();
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

import { PassThrough } from 'node:stream';
import { isPublicAddress, resolveVettedAddress, REFUSAL as EGRESS_REFUSAL } from '../lib/egress-proxy.mjs';

test('isPublicAddress: loopback, RFC1918, link-local, CGNAT, multicast, unspecified, ULA and v4-mapped private are NOT public; ordinary unicast is', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '240.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.0.2.1', '2001:db8::1', '2002:c000:0204::1', '64:ff9b::7f00:1', '2001::1', '100::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '198.17.0.1', '198.20.0.1', '192.0.3.1', '2606:4700::1111', '2a00:1450::1', '::ffff:93.184.216.34']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('not-an-ip'), false);
  // Every SPELLING of a private IPv6 address lands in the same bucket (classified on the bytes).
  for (const ip of ['::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '0::1', '::127.0.0.1', '::0a00:1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '2002:7f00:1::', '2002:c0a8:101::1', 'FE80::1', 'fe80:0:0:0:0:0:0:1', 'FC00::1', 'fd00:0:0:0:0:0:0:1', '::FFFF:192.168.0.1', '2001:0:0:0:0:0:0:1', '0100::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['::ffff:5db8:d822', '::ffff:8.8.8.8', '2002:0808:0808::1', '64:ff9b::8.8.8.8', '2a00:1450:4001:0:0:0:0:8a', '2606:4700:0:0:0:0:0:1111']) assert.equal(isPublicAddress(ip), true, ip);
  const { parseIPv6 } = await import('../lib/egress-proxy.mjs');
  assert.equal(parseIPv6('1::2::3'), null); assert.equal(parseIPv6('12345::1'), null); assert.equal(parseIPv6('::1.2.3'), null);
  assert.deepEqual([...parseIPv6('::ffff:1.2.3.4').slice(10)], [0xff, 0xff, 1, 2, 3, 4]);
});

test('resolveVettedAddress: a name whose ANY address is non-public is refused (DNS rebinding); a public name yields its first address; an IP literal is the operator\'s explicit intent', async () => {
  await assert.rejects(() => resolveVettedAddress('rebind.example', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]), /non-public address \(127\.0\.0\.1\)/);
  await assert.rejects(() => resolveVettedAddress('empty.example', async () => []), /no address/);
  assert.equal(await resolveVettedAddress('api.example', async () => [{ address: '93.184.216.34', family: 4 }]), '93.184.216.34');
  assert.equal(await resolveVettedAddress('10.0.0.5', async () => { throw new Error('never resolved'); }), '10.0.0.5');
});

test('the proxy dials the VETTED address of an allowlisted name and refuses (403, private-destination) a name that rebinds to loopback — upstream connect is never attempted', async () => {
  const dir = scratch('egress-dns-');
  const dialed = [];
  const connect = (port, host) => { dialed.push(`${host}:${port}`); const s = new PassThrough(); process.nextTick(() => s.emit('connect')); return s; };
  const lookup = async (name) => (name === 'rebind.example' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const log = [];
  const proxy = await startEgressProxy({ socketPath: join(dir, 'p.sock'), allowlist: ['rebind.example:443', 'api.example:443'], connect, lookup, log: (e) => log.push(e) });
  try {
    const bad = await request({ path: proxy.socketPath }, 'CONNECT rebind.example:443 HTTP/1.1\r\nHost: rebind.example:443\r\n\r\n');
    assert.match(bad.status, /^HTTP\/1\.1 403/, `refused: ${bad.status}`);
    assert.deepEqual(dialed, [], 'no upstream dial for a rebinding name');
    assert.ok(proxy.refused.some((r) => r.reason === EGRESS_REFUSAL.PRIVATE && r.host === 'rebind.example'), JSON.stringify(proxy.refused));
    const ok = await request({ path: proxy.socketPath }, 'CONNECT api.example:443 HTTP/1.1\r\nHost: api.example:443\r\n\r\n');
    assert.match(ok.status, /^HTTP\/1\.1 200/, `established: ${ok.status}`);
    assert.deepEqual(dialed, ['93.184.216.34:443'], 'the tunnel dials the vetted ADDRESS, not the name');
    ok.socket.destroy();
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a CONNECT head larger than the limit is refused (403 malformed-head) even when its terminator arrives — the size limit is not bypassable by terminating the head', async () => {
  const dir = scratch('egress-bighead-');
  const dialed = [];
  const proxy = await startEgressProxy({ socketPath: join(dir, 'p.sock'), allowlist: ['api.example:443'], connect: (port, host) => { dialed.push(host); const s = new PassThrough(); process.nextTick(() => s.emit('connect')); return s; }, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  try {
    const big = `CONNECT api.example:443 HTTP/1.1\r\nHost: api.example:443\r\nX-Pad: ${'p'.repeat(9000)}\r\n\r\n`;
    const r = await request({ path: proxy.socketPath }, big);
    assert.match(r.status, /^HTTP\/1\.1 403/, r.status);
    assert.deepEqual(dialed, [], 'nothing dialled');
    assert.ok(proxy.refused.some((x) => x.reason === EGRESS_REFUSAL.MALFORMED), JSON.stringify(proxy.refused));
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a stop signal that lands during the bridge start-up window is HELD and delivered to the child once spawned (never lost, never kills the bridge alone)', async () => {
  const { runBridge } = await import('../lib/egress-bridge.mjs');
  const { EventEmitter } = await import('node:events');
  const fakeProc = new EventEmitter(); fakeProc.env = { PATH: process.env.PATH };
  const dir = scratch('egress-bridge-hold-');
  const killed = [];
  const fakeChild = new EventEmitter(); fakeChild.exitCode = null; fakeChild.kill = (sig) => { killed.push(sig); fakeChild.exitCode = 143; process.nextTick(() => fakeChild.emit('exit', null, 'SIGTERM')); };
  let spawned = false;
  const spawnFn = () => { spawned = true; return fakeChild; };
  const p = runBridge({ socketPath: join(dir, 'x.sock'), port: await (async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise((r) => s.close(r)); return port; })(), command: ['/bin/true'], spawnFn, proc: fakeProc });
  // The signal arrives before the spawn: the relay is already installed and holds it.
  assert.equal(spawned, false); fakeProc.emit('SIGTERM');
  const code = await p;
  assert.equal(spawned, true, 'the child was spawned');
  assert.deepEqual(killed, ['SIGTERM'], 'the held signal was delivered to the child');
  assert.equal(code, 143);
  rmSync(dir, { recursive: true, force: true });
});

test('a resolver that never answers does not hold the client: the CONNECT is refused (403, dns-timeout) at the lookup deadline and nothing is dialled', async () => {
  const dir = scratch('egress-dns-hang-');
  const dialed = [];
  const proxy = await startEgressProxy({ socketPath: join(dir, 'p.sock'), allowlist: ['slow.example:443'], connect: (port, host) => { dialed.push(host); const s = new PassThrough(); process.nextTick(() => s.emit('connect')); return s; }, lookup: () => new Promise(() => {}), dnsTimeoutMs: 100 });
  try {
    const r = await request({ path: proxy.socketPath }, 'CONNECT slow.example:443 HTTP/1.1\r\nHost: slow.example:443\r\n\r\n');
    assert.match(r.status, /^HTTP\/1\.1 403/, r.status);
    assert.deepEqual(dialed, []);
    assert.ok(proxy.refused.some((x) => x.reason === EGRESS_REFUSAL.DNS_TIMEOUT), JSON.stringify(proxy.refused));
  } finally { await proxy.close(); rmSync(dir, { recursive: true, force: true }); }
});
