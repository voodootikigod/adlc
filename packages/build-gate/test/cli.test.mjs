// test/cli.test.mjs — end-to-end exercise of the build-gate CLI: exit codes,
// --json output, and the audited-override recording path via the real
// manifest ledger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'build-gate.mjs');

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function withTicketRepo(tickets, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-cli-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /build-gate/);
});

test('missing ticket id → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run([], { cwd: dir });
    assert.equal(r.code, 1);
  });
});

test('unknown ticket id → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run(['T404'], { cwd: dir });
    assert.equal(r.code, 1);
  });
});

test('normal-risk ticket, deep session → allow, exit 0', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'feature' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.riskTier, 'normal');
  });
});

// ---- fail closed on a malformed (non-array) scope/rails field, instead of
// crashing with an uncaught TypeError (issue #48 review round 3 finding) ----

test('non-array scope field → fails closed to high risk (deny once deep), not a crash', () => {
  withTicketRepo([{ id: 'T1', title: 'x', scope: 42 }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
    assert.equal(out.riskTier, 'high');
    assert.ok(out.signals.includes('malformed-scope'));
  });
});

test('non-array rails field (object) → fails closed to high risk, not a crash', () => {
  withTicketRepo([{ id: 'T1', title: 'x', rails: { foo: 'bar' } }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
    assert.equal(out.riskTier, 'high');
    assert.ok(out.signals.includes('malformed-rails'));
  });
});

test('high-risk ticket (contract), shallow session → allow, exit 0', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '1', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'allow');
    assert.equal(out.riskTier, 'high');
  });
});

test('high-risk ticket (contract), deep session, no bypass → DENY, exit 2', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'deny');
  });
});

test('--depth past --depth-threshold triggers deny; below a raised threshold allows', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const deny = run(['T1', '--depth', '50', '--json'], { cwd: dir });
    assert.equal(deny.code, 2);
    const allow = run(['T1', '--depth', '50', '--depth-threshold', '100', '--json'], { cwd: dir });
    assert.equal(allow.code, 0);
  });
});

test('--session-bytes past --bytes-threshold triggers deny', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--session-bytes', '500000', '--bytes-threshold', '100', '--json'], { cwd: dir });
    assert.equal(r.code, 2);
  });
});

test('no --depth/--session-bytes supplied at all → defaults to not-degraded (allow)', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
  });
});

test('--transcript derives depth from tool_use occurrences in the file', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const transcript = join(dir, 'session.jsonl');
    const line = JSON.stringify({ type: 'tool_use' });
    writeFileSync(transcript, Array.from({ length: 100 }, () => line).join('\n'));
    const r = run(['T1', '--transcript', transcript, '--json'], { cwd: dir });
    assert.equal(r.code, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.depth, 100);
  });
});

test('ADLC_BUILD_GATE_BYPASS=1 with a writable .adlc → allow + audited manifest entry', () => {
  withTicketRepo([{ id: 'T1', title: 'x', category: 'contract' }], (dir) => {
    const r = run(['T1', '--depth', '999', '--json'], { cwd: dir, env: { ADLC_BUILD_GATE_BYPASS: '1' } });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overridden, true);
    const manifestPath = join(dir, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(manifestPath));
    const entry = JSON.parse(readFileSync(manifestPath, 'utf8').trim().split('\n').pop());
    assert.equal(entry.gate, 'build-gate-bypass');
    assert.equal(entry.ticket, 'T1');
    // Chain-linkage fields required by gate-manifest's verify() (issue #48 review finding).
    assert.equal(entry.seq, 1);
    assert.equal(entry.prev, null);
  });
});

test('bad --depth-threshold value → operational error, exit 1', () => {
  withTicketRepo([{ id: 'T1', title: 'x' }], (dir) => {
    const r = run(['T1', '--depth-threshold', 'nope'], { cwd: dir });
    assert.equal(r.code, 1);
  });
});
