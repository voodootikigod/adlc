// test/behavior-diff.test.mjs — node:test suite for behavior-diff
// Tests: structural diff engine, report rendering, capture (against local HTTP server),
//        config validation, compare logic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { diffJson, diffRoute, routeKey } from '../lib/diff.mjs';
import { validateConfig, runCapture, reachableCount } from '../lib/capture.mjs';
import { compareSnapshots, loadSnapshot } from '../lib/compare.mjs';
import { renderReport } from '../lib/report.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'behavior-diff-test-'));
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── diffJson (structural diff engine) ─────────────────────────────────────────

describe('diffJson', () => {
  test('identical objects produce no changes', () => {
    const { changes } = diffJson({ a: 1, b: 'hello' }, { a: 1, b: 'hello' });
    assert.equal(changes.length, 0);
  });

  test('detects added key', () => {
    const { changes } = diffJson({ a: 1 }, { a: 1, b: 2 });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'keyAdded');
    assert.equal(changes[0].path, 'b');
    assert.equal(changes[0].after, 2);
  });

  test('detects removed key', () => {
    const { changes } = diffJson({ a: 1, b: 2 }, { a: 1 });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'keyRemoved');
    assert.equal(changes[0].path, 'b');
    assert.equal(changes[0].before, 2);
  });

  test('detects value change', () => {
    const { changes } = diffJson({ a: 1 }, { a: 2 });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'valueChanged');
    assert.equal(changes[0].path, 'a');
    assert.equal(changes[0].before, 1);
    assert.equal(changes[0].after, 2);
  });

  test('detects type change', () => {
    const { changes } = diffJson({ a: 1 }, { a: '1' });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'typeChanged');
  });

  test('nested object changes produce dotted paths', () => {
    const { changes } = diffJson(
      { user: { name: 'Alice', age: 30 } },
      { user: { name: 'Bob', age: 30 } }
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'user.name');
    assert.equal(changes[0].before, 'Alice');
    assert.equal(changes[0].after, 'Bob');
  });

  test('deeply nested paths', () => {
    const { changes } = diffJson(
      { a: { b: { c: { d: 1 } } } },
      { a: { b: { c: { d: 2 } } } }
    );
    assert.equal(changes[0].path, 'a.b.c.d');
  });

  test('array length change reported', () => {
    const { changes } = diffJson({ items: [1, 2, 3] }, { items: [1, 2] });
    const lengthChange = changes.find((c) => c.type === 'arrayLengthChanged');
    assert.ok(lengthChange, 'should report arrayLengthChanged');
    assert.equal(lengthChange.before, 3);
    assert.equal(lengthChange.after, 2);
  });

  test('first divergent array index reported with bracket notation', () => {
    const { changes } = diffJson(
      { items: [{ id: 1, price: 10 }, { id: 2, price: 20 }] },
      { items: [{ id: 1, price: 10 }, { id: 2, price: 99 }] }
    );
    const priceChange = changes.find((c) => c.path === 'items[1].price');
    assert.ok(priceChange, `expected items[1].price change, got: ${JSON.stringify(changes)}`);
  });

  test('null vs object is typeChanged', () => {
    const { changes } = diffJson({ a: null }, { a: { x: 1 } });
    assert.equal(changes[0].type, 'typeChanged');
  });

  test('root-level primitive diff', () => {
    const { changes } = diffJson(42, 43);
    assert.equal(changes[0].type, 'valueChanged');
    assert.equal(changes[0].path, '(root)');
  });

  test('caps at 50 changes and sets capped flag', () => {
    const before = {};
    const after = {};
    for (let i = 0; i < 60; i++) {
      before[`key${i}`] = i;
      after[`key${i}`] = i + 1;
    }
    const { changes, capped } = diffJson(before, after);
    assert.ok(changes.length <= 50);
    assert.equal(capped, true);
  });
});

// ── diffRoute ─────────────────────────────────────────────────────────────────

describe('diffRoute', () => {
  function makeEntry(overrides) {
    return {
      method: 'GET',
      path: '/api/test',
      status: 200,
      contentType: 'application/json',
      body: { ok: true },
      ...overrides,
    };
  }

  test('identical routes return null', () => {
    const entry = makeEntry();
    assert.equal(diffRoute(entry, { ...entry }), null);
  });

  test('status change detected', () => {
    const result = diffRoute(makeEntry({ status: 200 }), makeEntry({ status: 404 }));
    assert.ok(result);
    const d = result.diffs.find((d) => d.field === 'status');
    assert.ok(d);
    assert.equal(d.before, 200);
    assert.equal(d.after, 404);
  });

  test('contentType change detected', () => {
    const result = diffRoute(
      makeEntry({ contentType: 'application/json' }),
      makeEntry({ contentType: 'text/plain' })
    );
    assert.ok(result);
    const d = result.diffs.find((d) => d.field === 'contentType');
    assert.ok(d);
  });

  test('JSON body structural diff detected', () => {
    const result = diffRoute(
      makeEntry({ body: { price: 10, name: 'Widget' } }),
      makeEntry({ body: { price: 20, name: 'Widget' } })
    );
    assert.ok(result);
    const d = result.diffs.find((d) => d.field === 'body' && d.type === 'json');
    assert.ok(d);
    const priceChange = d.changes.find((c) => c.path === 'price');
    assert.ok(priceChange);
  });

  test('text body hash difference detected', () => {
    const result = diffRoute(
      makeEntry({
        contentType: 'text/html',
        body: { textHash: 'aaa', bytes: 100 },
      }),
      makeEntry({
        contentType: 'text/html',
        body: { textHash: 'bbb', bytes: 200 },
      })
    );
    assert.ok(result);
    const d = result.diffs.find((d) => d.field === 'body' && d.type === 'text');
    assert.ok(d);
  });

  test('error on one side detected', () => {
    const result = diffRoute(
      makeEntry({ status: 200, body: { ok: true }, error: undefined }),
      { method: 'GET', path: '/api/test', error: 'timeout after 10000ms' }
    );
    assert.ok(result);
    const d = result.diffs.find((d) => d.field === 'error');
    assert.ok(d);
  });

  test('route key is METHOD path', () => {
    const entry = makeEntry({ method: 'POST', path: '/submit' });
    assert.equal(routeKey(entry), 'POST /submit');
  });

  // ── Regression: dead-in-both must NOT be treated as identical ──────────────
  test('same error string on BOTH sides is unreachable, not identical', () => {
    const dead = { method: 'GET', path: '/api/test', error: 'fetch failed' };
    const result = diffRoute(dead, { ...dead });
    assert.notEqual(result, null, 'must NOT be null (null means identical)');
    assert.equal(result.unreachable, true);
    assert.equal(result.error, 'fetch failed');
    assert.equal(result.route, 'GET /api/test');
  });

  test('differing error strings on both sides still report an error diff', () => {
    const result = diffRoute(
      { method: 'GET', path: '/api/test', error: 'fetch failed' },
      { method: 'GET', path: '/api/test', error: 'timeout after 10000ms' }
    );
    assert.ok(result);
    assert.ok(!result.unreachable, 'a changed error is a diff, not an unreachable marker');
    const d = result.diffs.find((d) => d.field === 'error');
    assert.ok(d);
    assert.equal(d.before, 'fetch failed');
    assert.equal(d.after, 'timeout after 10000ms');
  });
});

// ── reachableCount ──────────────────────────────────────────────────────────────

describe('reachableCount', () => {
  test('counts only routes without an error field', () => {
    const snapshot = {
      routes: [
        { method: 'GET', path: '/a', status: 200, body: {} },
        { method: 'GET', path: '/b', error: 'fetch failed' },
        { method: 'GET', path: '/c', status: 500, body: {} },
      ],
    };
    assert.equal(reachableCount(snapshot), 2);
  });

  test('all-errored snapshot has zero reachable', () => {
    const snapshot = {
      routes: [
        { method: 'GET', path: '/a', error: 'fetch failed' },
        { method: 'GET', path: '/b', error: 'fetch failed' },
      ],
    };
    assert.equal(reachableCount(snapshot), 0);
  });

  test('missing routes array is treated as zero reachable', () => {
    assert.equal(reachableCount({}), 0);
    assert.equal(reachableCount(null), 0);
  });
});

// ── validateConfig ─────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  test('valid config returns no errors', () => {
    const errors = validateConfig({
      baseUrl: 'http://localhost:3000',
      routes: [{ method: 'GET', path: '/health' }],
    });
    assert.deepEqual(errors, []);
  });

  test('missing baseUrl returns error', () => {
    const errors = validateConfig({ routes: [{ method: 'GET', path: '/' }] });
    assert.ok(errors.some((e) => e.includes('baseUrl')));
  });

  test('invalid URL returns error', () => {
    const errors = validateConfig({
      baseUrl: 'not-a-url',
      routes: [{ method: 'GET', path: '/' }],
    });
    assert.ok(errors.some((e) => e.includes('valid URL')));
  });

  test('empty routes array returns error', () => {
    const errors = validateConfig({ baseUrl: 'http://localhost', routes: [] });
    assert.ok(errors.some((e) => e.includes('routes')));
  });

  test('missing routes returns error', () => {
    const errors = validateConfig({ baseUrl: 'http://localhost' });
    assert.ok(errors.some((e) => e.includes('routes')));
  });

  test('route missing method returns error', () => {
    const errors = validateConfig({
      baseUrl: 'http://localhost',
      routes: [{ path: '/foo' }],
    });
    assert.ok(errors.some((e) => e.includes('method')));
  });

  test('route missing path returns error', () => {
    const errors = validateConfig({
      baseUrl: 'http://localhost',
      routes: [{ method: 'GET' }],
    });
    assert.ok(errors.some((e) => e.includes('path')));
  });

  test('null config returns error', () => {
    const errors = validateConfig(null);
    assert.ok(errors.length > 0);
  });
});

// ── renderReport ──────────────────────────────────────────────────────────────

describe('renderReport', () => {
  test('all identical headline', () => {
    const report = renderReport({
      identical: ['GET /a', 'GET /b'],
      changed: [],
      onlyInBefore: [],
      onlyInAfter: [],
    });
    assert.match(report, /2 routes identical, 0 changed, 0 errored/);
  });

  test('singular route identical', () => {
    const report = renderReport({
      identical: ['GET /a'],
      changed: [],
      onlyInBefore: [],
      onlyInAfter: [],
    });
    assert.match(report, /1 route identical/);
  });

  test('changed route appears in report', () => {
    const report = renderReport({
      identical: [],
      changed: [
        {
          route: 'GET /api/users',
          diffs: [{ field: 'status', before: 200, after: 503 }],
        },
      ],
      onlyInBefore: [],
      onlyInAfter: [],
    });
    assert.match(report, /GET \/api\/users/);
    assert.match(report, /status: 200 → 503/);
  });

  test('removed route appears with minus prefix', () => {
    const report = renderReport({
      identical: [],
      changed: [],
      onlyInBefore: ['DELETE /old'],
      onlyInAfter: [],
    });
    assert.match(report, /- DELETE \/old/);
  });

  test('added route appears with plus prefix', () => {
    const report = renderReport({
      identical: [],
      changed: [],
      onlyInBefore: [],
      onlyInAfter: ['POST /new'],
    });
    assert.match(report, /\+ POST \/new/);
  });

  test('json body diff rendered with change count', () => {
    const report = renderReport({
      identical: [],
      changed: [
        {
          route: 'GET /products',
          diffs: [
            {
              field: 'body',
              type: 'json',
              changes: [{ type: 'valueChanged', path: 'price', before: 10, after: 20 }],
              capped: false,
            },
          ],
        },
      ],
      onlyInBefore: [],
      onlyInAfter: [],
    });
    assert.match(report, /body \(json\): 1 change/);
    assert.match(report, /price/);
  });

  test('unreachable-in-both routes are surfaced in the report', () => {
    const report = renderReport({
      identical: [],
      changed: [],
      unreachable: [{ route: 'GET /health', error: 'fetch failed' }],
      onlyInBefore: [],
      onlyInAfter: [],
    });
    assert.match(report, /1 unreachable \(both\)/);
    assert.match(report, /! GET \/health: unreachable in both snapshots \(fetch failed\)/);
  });
});

// ── compareSnapshots ──────────────────────────────────────────────────────────

describe('compareSnapshots', () => {
  function snapshot(routes) {
    return { baseUrl: 'http://localhost', capturedAt: '2024-01-01T00:00:00Z', routes };
  }

  test('identical snapshots produce empty changed arrays', () => {
    const s = snapshot([{ method: 'GET', path: '/a', status: 200, contentType: 'application/json', body: { ok: true } }]);
    const result = compareSnapshots(s, { ...s, routes: [...s.routes] });
    assert.equal(result.identical.length, 1);
    assert.equal(result.changed.length, 0);
  });

  test('route only in before shows up in onlyInBefore', () => {
    const before = snapshot([{ method: 'GET', path: '/a', status: 200, contentType: 'text/plain', body: { textHash: 'x', bytes: 1 } }]);
    const after = snapshot([]);
    const result = compareSnapshots(before, after);
    assert.ok(result.onlyInBefore.includes('GET /a'));
  });

  test('route only in after shows up in onlyInAfter', () => {
    const before = snapshot([]);
    const after = snapshot([{ method: 'GET', path: '/new', status: 201, contentType: 'text/plain', body: { textHash: 'y', bytes: 2 } }]);
    const result = compareSnapshots(before, after);
    assert.ok(result.onlyInAfter.includes('GET /new'));
  });

  test('changed route appears in changed', () => {
    const before = snapshot([{ method: 'GET', path: '/b', status: 200, contentType: 'application/json', body: { val: 1 } }]);
    const after = snapshot([{ method: 'GET', path: '/b', status: 200, contentType: 'application/json', body: { val: 2 } }]);
    const result = compareSnapshots(before, after);
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0].route, 'GET /b');
  });

  // ── Regression: a route dead in both snapshots is surfaced, not "identical" ──
  test('route errored in both snapshots lands in unreachable, not identical', () => {
    const before = snapshot([{ method: 'GET', path: '/dead', error: 'fetch failed' }]);
    const after = snapshot([{ method: 'GET', path: '/dead', error: 'fetch failed' }]);
    const result = compareSnapshots(before, after);
    assert.equal(result.identical.length, 0, 'must NOT be reported as identical');
    assert.equal(result.changed.length, 0);
    assert.equal(result.unreachable.length, 1);
    assert.equal(result.unreachable[0].route, 'GET /dead');
    assert.equal(result.unreachable[0].error, 'fetch failed');
  });

  test('all-dead before/after never yields a clean (all-identical) verdict', () => {
    const before = snapshot([
      { method: 'GET', path: '/a', error: 'fetch failed' },
      { method: 'GET', path: '/b', error: 'fetch failed' },
    ]);
    const after = snapshot([
      { method: 'GET', path: '/a', error: 'fetch failed' },
      { method: 'GET', path: '/b', error: 'fetch failed' },
    ]);
    const result = compareSnapshots(before, after);
    const totalChanged = result.changed.length + result.onlyInBefore.length + result.onlyInAfter.length;
    // The bin treats (totalChanged === 0 && unreachable === 0) as exit-0 pass.
    // A dead service must break that condition so the human gate does not pass.
    assert.ok(
      totalChanged !== 0 || result.unreachable.length !== 0,
      'a dead service must not produce an exit-0 clean verdict'
    );
    assert.equal(result.identical.length, 0);
    assert.equal(result.unreachable.length, 2);
  });
});

// ── loadSnapshot ──────────────────────────────────────────────────────────────

describe('loadSnapshot', () => {
  test('throws on missing file', () => {
    assert.throws(() => loadSnapshot('/nonexistent/path/file.json'), /cannot read/);
  });

  test('throws on invalid JSON', () => {
    const dir = tmpDir();
    const file = join(dir, 'bad.json');
    writeFileSync(file, 'not json');
    try {
      assert.throws(() => loadSnapshot(file), /not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('throws on missing routes array', () => {
    const dir = tmpDir();
    const file = join(dir, 'snap.json');
    writeFileSync(file, JSON.stringify({ baseUrl: 'http://localhost' }));
    try {
      assert.throws(() => loadSnapshot(file), /missing required .routes/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('loads valid snapshot', () => {
    const dir = tmpDir();
    const file = join(dir, 'snap.json');
    const data = { baseUrl: 'http://localhost', capturedAt: '2024-01-01T00:00:00Z', routes: [] };
    writeFileSync(file, JSON.stringify(data));
    try {
      const snap = loadSnapshot(file);
      assert.deepEqual(snap, data);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ── runCapture against real HTTP server ───────────────────────────────────────

describe('runCapture', () => {
  test('captures JSON endpoint correctly', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', count: 42 }));
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/api/test' }],
    };

    try {
      const snapshot = await runCapture(config);
      assert.equal(snapshot.routes.length, 1);
      const route = snapshot.routes[0];
      assert.equal(route.status, 200);
      assert.ok(route.contentType.includes('application/json'));
      assert.deepEqual(route.body, { hello: 'world', count: 42 });
      assert.equal(route.method, 'GET');
      assert.equal(route.path, '/api/test');
      assert.ok(!route.error);
    } finally {
      await stopServer(server);
    }
  });

  test('captures text endpoint with hash', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello text');
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/text' }],
    };

    try {
      const snapshot = await runCapture(config);
      const route = snapshot.routes[0];
      assert.ok(route.body.textHash, 'should have textHash');
      assert.equal(typeof route.body.textHash, 'string');
      assert.ok(route.body.bytes > 0);
    } finally {
      await stopServer(server);
    }
  });

  test('records error for unreachable route without aborting run', async () => {
    // Use a port that is definitely not listening
    const config = {
      baseUrl: 'http://127.0.0.1:1',  // port 1 is typically unavailable
      routes: [
        { method: 'GET', path: '/unreachable' },
      ],
    };

    const snapshot = await runCapture(config, 2000);
    assert.equal(snapshot.routes.length, 1);
    assert.ok(snapshot.routes[0].error, 'should have error recorded');
  });

  test('captures POST with body', async () => {
    let receivedBody = '';
    const server = await startServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: true }));
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'POST', path: '/items', body: { name: 'test' } }],
    };

    try {
      const snapshot = await runCapture(config);
      const route = snapshot.routes[0];
      assert.equal(route.status, 201);
      assert.deepEqual(route.body, { created: true });
      assert.deepEqual(JSON.parse(receivedBody), { name: 'test' });
    } finally {
      await stopServer(server);
    }
  });

  test('records correct capturedAt timestamp', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/' }],
    };

    try {
      const before = Date.now();
      const snapshot = await runCapture(config);
      const after = Date.now();
      const ts = new Date(snapshot.capturedAt).getTime();
      assert.ok(ts >= before && ts <= after, 'capturedAt should be within test window');
    } finally {
      await stopServer(server);
    }
  });

  test('timeout produces error entry not crash', async () => {
    // Server that never responds
    const server = await startServer((_req, _res) => {
      // intentionally no response — connection hangs
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/slow' }],
    };

    try {
      const snapshot = await runCapture(config, 100); // very short timeout
      assert.ok(snapshot.routes[0].error, 'should record timeout error');
      assert.match(snapshot.routes[0].error, /timeout/);
    } finally {
      await stopServer(server);
    }
  });
});

// ── Integration: full round-trip capture + compare ────────────────────────────

describe('round-trip: capture → compare', () => {
  test('identical before/after produces no changes', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 1 }));
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/version' }],
    };

    try {
      const snap1 = await runCapture(config);
      const snap2 = await runCapture(config);
      const result = compareSnapshots(snap1, snap2);
      assert.equal(result.identical.length, 1);
      assert.equal(result.changed.length, 0);
    } finally {
      await stopServer(server);
    }
  });

  test('changed response body detected in compare', async () => {
    let count = 0;
    const server = await startServer((_req, res) => {
      count++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count }));
    });

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [{ method: 'GET', path: '/counter' }],
    };

    try {
      const before = await runCapture(config);
      const after = await runCapture(config);
      const result = compareSnapshots(before, after);
      assert.equal(result.changed.length, 1);
      const bodyDiff = result.changed[0].diffs.find((d) => d.field === 'body');
      assert.ok(bodyDiff);
    } finally {
      await stopServer(server);
    }
  });

  // ── Regression: operator forgot to start the server for BOTH captures ───────
  test('server down for both captures: zero reachable + no clean identical pass', async () => {
    // Port 1 is not listening, so every route errors in both snapshots.
    const config = {
      baseUrl: 'http://127.0.0.1:1',
      routes: [
        { method: 'GET', path: '/health' },
        { method: 'GET', path: '/api/users' },
      ],
    };

    const before = await runCapture(config, 2000);
    const after = await runCapture(config, 2000);

    // (a) Capture: zero routes reachable — the bin's reachability gate fails on this.
    assert.equal(reachableCount(before), 0, 'before snapshot should have zero reachable routes');
    assert.equal(reachableCount(after), 0, 'after snapshot should have zero reachable routes');

    // (b) Compare: the dead routes must surface as unreachable, never identical.
    const result = compareSnapshots(before, after);
    assert.equal(result.identical.length, 0, 'a dead service must not be reported identical');
    assert.equal(result.unreachable.length, 2);

    // The bin's exit-0 condition is (totalChanged === 0 && unreachable === 0);
    // a dead service must violate it so the human gate cannot silently pass.
    const totalChanged = result.changed.length + result.onlyInBefore.length + result.onlyInAfter.length;
    assert.ok(
      totalChanged !== 0 || result.unreachable.length !== 0,
      'dead-in-both must not yield an exit-0 all-clear'
    );
  });
});
