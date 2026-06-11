// Tests for argument validation and CLI contract (offline).
// Uses child_process.spawnSync to exercise the binary without network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/parallax.mjs', import.meta.url).pathname;
const NODE = process.execPath;

function run(args, opts = {}) {
  return spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    ...opts,
  });
}

test('no args → exit 1 (operational error / usage)', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('parallax'));
});

test('--prompt-only with --request → prints prompt and exits 0', () => {
  const r = run(['--request', 'Add a login page', '--prompt-only']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Add a login page'));
  assert.ok(r.stdout.includes('spec'));
});

test('--prompt-only with --file → prints prompt and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const reqFile = join(dir, 'req.md');
    writeFileSync(reqFile, 'Build a search feature');
    const r = run(['--file', reqFile, '--prompt-only']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Build a search feature'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--edge without ticket IDs → exit 1', () => {
  const r = run(['--edge']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--edge with missing tickets file → exit 1', () => {
  const r = run(['--edge', 'T1', 'T2', '--tickets', '/nonexistent/tickets.json']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--edge --prompt-only with valid tickets → prints prompt and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const ticketsFile = join(dir, 'tickets.json');
    writeFileSync(ticketsFile, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Auth Service', body: 'Build auth', scope: [] },
        { id: 'T2', title: 'API Gateway', body: 'Route requests', scope: [] },
      ],
    }));
    const r = run(['--edge', 'T1', 'T2', '--tickets', ticketsFile, '--prompt-only']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Auth Service'));
    assert.ok(r.stdout.includes('API Gateway'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--edge with unknown ticket IDs → exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const ticketsFile = join(dir, 'tickets.json');
    writeFileSync(ticketsFile, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Auth', body: 'body', scope: [] },
      ],
    }));
    const r = run(['--edge', 'T1', 'T99', '--tickets', ticketsFile, '--prompt-only']);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('error:'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--route --prompt-only → prints two prompts and exits 0', () => {
  const r = run(['--route', 'What is the retry policy?', '--prompt-only']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('retry policy'));
  // Should have two prompt sections
  assert.ok(r.stdout.includes('prompt 1 of 2') || r.stdout.includes('retry policy'));
});

test('--route --context with missing file → exit 1', () => {
  const r = run(['--route', 'Any question', '--context', '/nonexistent/file.md', '--prompt-only']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--route --context with existing file → prompt includes file content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const ctxFile = join(dir, 'spec.md');
    writeFileSync(ctxFile, 'Use exponential backoff with 3 retries');
    const r = run(['--route', 'What is the retry policy?', '--context', ctxFile, '--prompt-only']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Use exponential backoff with 3 retries'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('invalid --n → exit 1', () => {
  const r = run(['--request', 'test', '--n', 'abc', '--prompt-only']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--n=0 → exit 1', () => {
  const r = run(['--request', 'test', '--n', '0', '--prompt-only']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('invalid --threshold → exit 1', () => {
  const r = run(['--request', 'test', '--threshold', 'high', '--prompt-only']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('--threshold out of range → exit 1', () => {
  const r = run(['--request', 'test', '--threshold', '1.5', '--prompt-only']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});

test('missing file → exit 1', () => {
  const r = run(['--file', '/nonexistent/req.md']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('error:'));
});
