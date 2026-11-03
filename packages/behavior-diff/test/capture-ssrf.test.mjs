import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateConfig, runCapture } from '../lib/capture.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('behavior-diff SSRF & origin hardening (#585)', () => {
  test('validateConfig rejects non-http/https baseUrl schemes', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'data:text/plain,hi']) {
      const errs = validateConfig({ baseUrl: bad, routes: [{ method: 'GET', path: '/ok' }] });
      assert.ok(errs.some((e) => e.includes('http: or https:')), `expected scheme error for ${bad}, got ${JSON.stringify(errs)}`);
    }
    const okHttp = validateConfig({ baseUrl: 'http://127.0.0.1:8080', routes: [{ method: 'GET', path: '/ok' }] });
    assert.deepEqual(okHttp, []);
    const okHttps = validateConfig({ baseUrl: 'https://example.com', routes: [{ method: 'GET', path: '/ok' }] });
    assert.deepEqual(okHttps, []);
  });

  test('validateConfig rejects route paths that do not start with / or contain // or .. or escape origin', () => {
    for (const badPath of ['.attacker.example/x', 'relative/path', '//evil.example/p', '/a/../b', '/..', '/x/..']) {
      const errs = validateConfig({ baseUrl: 'http://localhost:3000', routes: [{ method: 'GET', path: badPath }] });
      assert.ok(errs.length > 0, `expected error for ${badPath}`);
    }
    const errsEscape = validateConfig({ baseUrl: 'http://localhost:3000', routes: [{ method: 'GET', path: '/\\evil.example/x' }] });
    assert.ok(errsEscape.some((e) => e.includes('resolves outside baseUrl origin')), JSON.stringify(errsEscape));
  });

  test('runCapture enforces scheme, leading-slash, and same-origin even if validateConfig was bypassed', async () => {
    const resScheme = await runCapture({ baseUrl: 'file:///tmp', routes: [{ method: 'GET', path: '/a' }] });
    assert.match(resScheme.routes[0].error, /unsupported baseUrl protocol/);

    const resHttps = await runCapture({ baseUrl: 'https://127.0.0.1:1', routes: [{ method: 'GET', path: '.attacker.example/x' }] });
    assert.match(resHttps.routes[0].error, /invalid route path/);

    const resDotDot = await runCapture({ baseUrl: 'http://127.0.0.1:1', routes: [{ method: 'GET', path: '/a/../b' }] });
    assert.match(resDotDot.routes[0].error, /invalid route path/);

    const resDoubleSlash = await runCapture({ baseUrl: 'http://127.0.0.1:1', routes: [{ method: 'GET', path: '//evil.example/x' }] });
    assert.match(resDoubleSlash.routes[0].error, /invalid route path/);

    const resBackslash = await runCapture({ baseUrl: 'http://127.0.0.1:1', routes: [{ method: 'GET', path: '/\\evil.example/x' }] });
    assert.match(resBackslash.routes[0].error, /escapes baseUrl origin/);
  });

  test('runCapture uses redirect: manual so off-origin redirects are recorded as 3xx rather than followed', async () => {
    let hitSecret = false;
    const targetServer = await startServer((_req, res) => {
      hitSecret = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: 'leaked' }));
    });
    const targetPort = targetServer.address().port;

    const redirectServer = await startServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/secret` });
      res.end();
    });
    const redirectPort = redirectServer.address().port;

    try {
      const snap = await runCapture({
        baseUrl: `http://127.0.0.1:${redirectPort}/`,
        routes: [{ method: 'GET', path: '/ bounce'.replace(' ', '') }],
      });
      assert.equal(snap.routes[0].status, 302);
      assert.equal(hitSecret, false, 'redirect target must NOT be followed');
    } finally {
      await stopServer(redirectServer);
      await stopServer(targetServer);
    }
  });
});
