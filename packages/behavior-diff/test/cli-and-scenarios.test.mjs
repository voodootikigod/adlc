// test/cli-and-scenarios.test.mjs — tests for HTTP named scenarios (route.id) and CLI command capture/compare

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tmp } from '@adlc/core/test-kit';

import { routeKey, commandKey } from '../lib/diff.mjs';
import { validateConfig, runCapture, reachableCount } from '../lib/capture.mjs';
import { validateCommandsConfig, captureCommand } from '../lib/cli-capture.mjs';
import { compareSnapshots, loadSnapshot } from '../lib/compare.mjs';
import { renderReport } from '../lib/report.mjs';

const cliBin = fileURLToPath(new URL('../bin/behavior-diff.mjs', import.meta.url));

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('HTTP named scenarios (route.id)', () => {
  test('routeKey formats with and without scenario id', () => {
    assert.equal(routeKey({ method: 'post', path: '/api/auth' }), 'POST /api/auth');
    assert.equal(routeKey({ method: 'post', path: '/api/auth', id: 'admin' }), 'POST /api/auth [admin]');
    assert.equal(routeKey({ method: 'POST', path: '/api/auth', id: '  guest  ' }), 'POST /api/auth [guest]');
  });

  test('validateConfig accepts multiple routes to same method+path when distinct ids are provided', () => {
    const errors = validateConfig({
      baseUrl: 'http://localhost:3000',
      routes: [
        { id: 'valid-creds', method: 'POST', path: '/api/auth', body: { user: 'alice', pass: 'ok' } },
        { id: 'bad-creds', method: 'POST', path: '/api/auth', body: { user: 'alice', pass: 'wrong' } },
      ],
    });
    assert.deepEqual(errors, []);
  });

  test('validateConfig rejects duplicate same-id routes or empty id strings', () => {
    const dupErrors = validateConfig({
      baseUrl: 'http://localhost:3000',
      routes: [
        { id: 'same', method: 'POST', path: '/api/auth', body: { a: 1 } },
        { id: 'same', method: 'post', path: '/api/auth', body: { a: 2 } },
      ],
    });
    assert.equal(dupErrors.length, 1);
    assert.match(dupErrors[0], /duplicates an earlier "POST \/api\/auth \[same\]" route/);

    const emptyIdErrors = validateConfig({
      baseUrl: 'http://localhost:3000',
      routes: [
        { id: '   ', method: 'POST', path: '/api/auth' },
      ],
    });
    assert.ok(emptyIdErrors.some((e) => e.includes('routes[0].id')));
  });

  test('captures and diffs two POST /api/auth routes with distinct ids independently', async (t) => {
    let flipGuest = false;
    const server = await startServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (body.role === 'admin') {
        res.writeHead(200);
        res.end(JSON.stringify({ allowed: true, role: 'admin' }));
      } else {
        res.writeHead(flipGuest ? 200 : 403);
        res.end(JSON.stringify({ allowed: flipGuest, role: 'guest' }));
      }
    });
    t.after(() => stopServer(server));

    const { port } = server.address();
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      routes: [
        { id: 'admin-login', method: 'POST', path: '/api/auth', body: { role: 'admin' } },
        { id: 'guest-login', method: 'POST', path: '/api/auth', body: { role: 'guest' } },
      ],
    };

    const before = await runCapture(config);
    assert.equal(before.routes.length, 2);
    assert.equal(before.routes[0].id, 'admin-login');
    assert.equal(before.routes[0].status, 200);
    assert.equal(before.routes[1].id, 'guest-login');
    assert.equal(before.routes[1].status, 403);

    const sameResult = compareSnapshots(before, before);
    assert.deepEqual(sameResult.identical, [
      'POST /api/auth [admin-login]',
      'POST /api/auth [guest-login]',
    ]);
    assert.equal(sameResult.changed.length, 0);

    flipGuest = true;
    const after = await runCapture(config);
    const diffResult = compareSnapshots(before, after);
    assert.deepEqual(diffResult.identical, ['POST /api/auth [admin-login]']);
    assert.equal(diffResult.changed.length, 1);
    assert.equal(diffResult.changed[0].route, 'POST /api/auth [guest-login]');
    assert.ok(diffResult.changed[0].diffs.some((d) => d.field === 'status' && d.before === 403 && d.after === 200));
  });
});

describe('CLI command validation and capture (cli-capture.mjs)', () => {
  test('validateCommandsConfig rejects shells, .. traversal, duplicate ids, and outside cwd', () => {
    for (const sh of ['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', '/bin/sh', '/usr/bin/bash', 'cmd.exe']) {
      const errs = validateCommandsConfig([{ id: 's', cmd: sh }]);
      assert.ok(errs.some((e) => e.includes('forbids shell binary')), `expected shell rejection for ${sh}: ${JSON.stringify(errs)}`);
    }

    const dotDotErrs = validateCommandsConfig([{ id: 'trav', cmd: '../bin/tool' }]);
    assert.ok(dotDotErrs.some((e) => e.includes('path traversal')));

    const dupErrs = validateCommandsConfig([
      { id: 'c1', cmd: process.execPath },
      { id: 'c1', cmd: process.execPath },
    ]);
    assert.ok(dupErrs.some((e) => e.includes('duplicates an earlier "c1"')));

    const badArgsErrs = validateCommandsConfig([{ id: 'c1', cmd: process.execPath, args: [123] }]);
    assert.ok(badArgsErrs.some((e) => e.includes('array of strings')));

    const escapeCwdErrs = validateCommandsConfig([{ id: 'c1', cmd: process.execPath, cwd: '..' }]);
    assert.ok(escapeCwdErrs.some((e) => e.includes('cwd is invalid')));
  });

  test('captureCommand scrubs ADLC_MANIFEST_KEY, captures JSON/text stdout, stderr, stdin, and timeout', async () => {
    const prevSecret = process.env.ADLC_MANIFEST_KEY;
    process.env.ADLC_MANIFEST_KEY = 'super-secret-manifest-key';
    try {
      const rec = await captureCommand({
        id: 'env-check',
        cmd: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ key: process.env.ADLC_MANIFEST_KEY ?? null, arg: process.argv[1] })); process.stderr.write("warn-line");',
          '$(echonotexpanded)',
        ],
      });
      assert.equal(rec.error, undefined);
      assert.equal(rec.exitCode, 0);
      assert.equal(rec.stdoutFormat, 'json');
      assert.deepEqual(rec.stdout, { key: null, arg: '$(echonotexpanded)' });
      assert.equal(rec.stderr, 'warn-line');
    } finally {
      if (prevSecret === undefined) delete process.env.ADLC_MANIFEST_KEY;
      else process.env.ADLC_MANIFEST_KEY = prevSecret;
    }

    const textRec = await captureCommand({
      id: 'stdin-echo',
      cmd: process.execPath,
      args: ['-e', 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{process.stdout.write("plain:"+d); process.exit(3);});'],
      stdin: 'hello',
    });
    assert.equal(textRec.exitCode, 3);
    assert.equal(textRec.stdoutFormat, 'text');
    assert.equal(typeof textRec.stdout.textHash, 'string');
    assert.equal(textRec.stdout.bytes, 11);

    const timeoutRec = await captureCommand({
      id: 'slow-cmd',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 5000)'],
      timeoutMs: 100,
    });
    assert.ok(timeoutRec.error);
    assert.match(timeoutRec.error, /timeout after 100ms/);
  });
});

describe('CLI compareSnapshots & end-to-end bin/behavior-diff.mjs', () => {
  test('compareSnapshots keys commands as CMD <id>, classifies errors and diffs exitCode/stdout/stderr', async () => {
    const baseRec = await captureCommand({
      id: 'probe',
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({v:1})); process.stderr.write("e1");'],
    });
    const changedRec = await captureCommand({
      id: 'probe',
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({v:2})); process.stderr.write("e2"); process.exit(1);'],
    });

    const snapBefore = { capturedAt: '2026-01-01T00:00:00Z', commands: [baseRec] };
    const snapAfter = { capturedAt: '2026-01-01T00:00:00Z', commands: [changedRec] };

    const identicalRes = compareSnapshots(snapBefore, snapBefore);
    assert.deepEqual(identicalRes.identical, ['CMD probe']);
    assert.equal(identicalRes.changed.length, 0);

    const diffRes = compareSnapshots(snapBefore, snapAfter);
    assert.equal(diffRes.changed.length, 1);
    const ch = diffRes.changed[0];
    assert.equal(ch.kind, 'command');
    assert.equal(ch.route, 'CMD probe');
    assert.ok(ch.diffs.some((d) => d.field === 'exitCode' && d.before === 0 && d.after === 1));
    assert.ok(ch.diffs.some((d) => d.field === 'stdout' && d.type === 'json'));
    assert.ok(ch.diffs.some((d) => d.field === 'stderr'));

    const report = renderReport(diffRes);
    assert.match(report, /~ CMD probe:/);
    assert.match(report, /exitCode: 0 → 1/);
    assert.match(report, /stdout \(json\): 1 change:/);
    assert.match(report, /stderr: hash changed/);

    // Error in both -> unreachable; error in one -> changed
    const errSnap1 = { capturedAt: '2026-01-01T00:00:00Z', commands: [{ id: 'dead', cmd: 'node', args: [], error: 'ENOENT' }] };
    const errSnap2 = { capturedAt: '2026-01-01T00:00:00Z', commands: [{ id: 'dead', cmd: 'node', args: [], error: 'timeout' }] };
    const bothErrRes = compareSnapshots(errSnap1, errSnap2);
    assert.equal(bothErrRes.unreachable.length, 1);
    assert.equal(bothErrRes.unreachable[0].route, 'CMD dead');

    const oneErrRes = compareSnapshots(
      { capturedAt: '2026-01-01T00:00:00Z', commands: [{ ...baseRec, id: 'dead' }] },
      errSnap1
    );
    assert.equal(oneErrRes.changed.length, 1);
    assert.equal(oneErrRes.changed[0].kind, 'command');
    assert.ok(oneErrRes.changed[0].diffs.some((d) => d.field === 'error'));
  });

  test('end-to-end CLI capture and compare exits 0 when identical and 2 when CLI behavior changes', (t) => {
    const dir = tmp(t, 'behavior-diff-cli-e2e-');
    const cfgBefore = join(dir, 'cfg-before.json');
    const cfgAfter = join(dir, 'cfg-after.json');
    const snapBefore = join(dir, 'before.json');
    const snapAfter = join(dir, 'after.json');

    writeFileSync(cfgBefore, JSON.stringify({
      commands: [
        {
          id: 'check-json',
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write(JSON.stringify({ status: "healthy", count: 1, leaked: process.env.ADLC_MANIFEST_KEY ?? null })); process.stderr.write("ok\\n");'],
        },
      ],
    }));

    writeFileSync(cfgAfter, JSON.stringify({
      commands: [
        {
          id: 'check-json',
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write(JSON.stringify({ status: "degraded", count: 2, leaked: process.env.ADLC_MANIFEST_KEY ?? null })); process.stderr.write("warn\\n"); process.exit(2);'],
        },
      ],
    }));

    const capEnv = { ...process.env, ADLC_MANIFEST_KEY: 'must-not-leak' };
    const c1 = spawnSync(process.execPath, [cliBin, 'capture', '--config', cfgBefore, '--out', snapBefore], {
      encoding: 'utf8',
      env: capEnv,
    });
    assert.equal(c1.status, 0, `capture before failed: ${c1.stderr}`);

    const parsedBefore = loadSnapshot(snapBefore);
    assert.equal(parsedBefore.commands.length, 1);
    assert.equal(parsedBefore.commands[0].stdout.leaked, null);
    assert.equal(reachableCount(parsedBefore), 1);

    const cmpSame = spawnSync(process.execPath, [cliBin, 'compare', snapBefore, snapBefore], { encoding: 'utf8' });
    assert.equal(cmpSame.status, 0, `compare identical failed: ${cmpSame.stderr}`);

    const c2 = spawnSync(process.execPath, [cliBin, 'capture', '--config', cfgAfter, '--out', snapAfter], {
      encoding: 'utf8',
      env: capEnv,
    });
    assert.equal(c2.status, 0, `capture after failed: ${c2.stderr}`);

    const cmpDiff = spawnSync(process.execPath, [cliBin, 'compare', snapBefore, snapAfter], { encoding: 'utf8' });
    assert.equal(cmpDiff.status, 2, `expected compare exit 2 on CLI diff, got ${cmpDiff.status}`);
    assert.match(cmpDiff.stdout, /CMD check-json/);
    assert.match(cmpDiff.stdout, /exitCode: 0 → 2/);
  });
});
