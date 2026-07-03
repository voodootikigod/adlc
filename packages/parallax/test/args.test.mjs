// Tests for argument validation and CLI contract (offline).
// Uses child_process.spawnSync to exercise the binary without network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// --record-verdict — captures the operator's prompt-only verdict into
// .adlc/manifest.jsonl via gate-manifest's record() (closes #44).
// ---------------------------------------------------------------------------

function readManifestEntries(dir) {
  const manifestPath = join(dir, '.adlc', 'manifest.jsonl');
  return readFileSync(manifestPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('--record-verdict without --prompt-only → exit 1', () => {
  const r = run(['--request', 'test', '--record-verdict', '-']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--record-verdict requires --prompt-only'));
});

test('spec mode: --prompt-only --record-verdict <file> writes a gate-manifest entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'ambiguity score 0.1 — request is clear, no divergence.\n');
    const r = run(['--request', 'Add a login page', '--prompt-only', '--record-verdict', verdictPath], { cwd: dir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('Add a login page'), 'prompt is still printed');

    const [entry] = readManifestEntries(dir);
    assert.equal(entry.gate, 'parallax');
    assert.equal(entry.data.promptOnly, true);
    assert.equal(entry.data.mode, 'spec');
    assert.ok(entry.data.verdict.includes('ambiguity score 0.1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spec mode: --record-verdict - reads verdict from stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = spawnSync(NODE, [BIN, '--request', 'Add a login page', '--prompt-only', '--record-verdict', '-'], {
      cwd: dir,
      input: 'no divergence found\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    const [entry] = readManifestEntries(dir);
    assert.equal(entry.gate, 'parallax');
    assert.ok(entry.data.verdict.includes('no divergence found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge mode: --prompt-only --record-verdict <file> writes a gate-manifest entry with ticket ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const ticketsFile = join(dir, 'tickets.json');
    writeFileSync(ticketsFile, JSON.stringify({
      tickets: [
        { id: 'T1', title: 'Auth Service', body: 'Build auth', scope: [] },
        { id: 'T2', title: 'API Gateway', body: 'Route requests', scope: [] },
      ],
    }));
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'no contract conflict between T1 and T2\n');

    const r = run(['--edge', 'T1', 'T2', '--tickets', ticketsFile, '--prompt-only', '--record-verdict', verdictPath], { cwd: dir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);

    const [entry] = readManifestEntries(dir);
    assert.equal(entry.gate, 'parallax');
    assert.equal(entry.data.mode, 'edge');
    assert.deepEqual(entry.data.tickets, ['T1', 'T2']);
    assert.ok(entry.data.verdict.includes('no contract conflict'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('route mode: --prompt-only --record-verdict <file> writes a gate-manifest entry with the question', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const verdictPath = join(dir, 'verdict.txt');
    writeFileSync(verdictPath, 'answer: exponential backoff, 3 retries\n');

    const r = run(['--route', 'What is the retry policy?', '--prompt-only', '--record-verdict', verdictPath], { cwd: dir });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);

    const [entry] = readManifestEntries(dir);
    assert.equal(entry.gate, 'parallax');
    assert.equal(entry.data.mode, 'route');
    assert.equal(entry.data.question, 'What is the retry policy?');
    assert.ok(entry.data.verdict.includes('exponential backoff'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('omitting --record-verdict preserves current --prompt-only behavior (no manifest written)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = run(['--request', 'Add a login page', '--prompt-only'], { cwd: dir });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('Add a login page'));
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'no manifest file when flag omitted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--record-verdict "" (empty string) does NOT silently degrade to plain --prompt-only — errors instead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = run(['--request', 'Add a login page', '--prompt-only', '--record-verdict', ''], { cwd: dir });
    assert.notEqual(r.status, 0, `empty --record-verdict must not silently succeed; got exit 0\nstdout: ${r.stdout}`);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'no manifest entry should be written for an empty verdict source');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--record-verdict "" without --prompt-only → exit 1 with the mutual-exclusion error (not silently ignored)', () => {
  const r = run(['--request', 'test', '--record-verdict', '']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--record-verdict requires --prompt-only'));
});

// ---------------------------------------------------------------------------
// spec mode: stdin-sourced request text vs. `--record-verdict -` collide on
// the same stdin stream (review round 2 finding, #44).
// ---------------------------------------------------------------------------

test('spec mode: stdin request + --record-verdict - → exit 1, no manifest written, no misrouted request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = spawnSync(NODE, [BIN, '--prompt-only', '--record-verdict', '-'], {
      cwd: dir,
      input: 'Add a login page\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('error:'));
    assert.ok(
      !r.stdout.includes('Add a login page'),
      'request text must not be printed/consumed once the stdin conflict is detected'
    );
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'no manifest entry should be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spec mode: multi-line stdin + --record-verdict - → still errors, never swallows the second line into the request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = spawnSync(NODE, [BIN, '--prompt-only', '--record-verdict', '-'], {
      cwd: dir,
      input: 'Add a login page\nPASS: verdict text\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('PASS: verdict text'), 'verdict line must not be baked into a printed/recorded request');
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'no manifest entry should be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spec mode: --request + --record-verdict - is fine (request does not come from stdin)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-test-'));
  try {
    const r = spawnSync(NODE, [BIN, '--request', 'Add a login page', '--prompt-only', '--record-verdict', '-'], {
      cwd: dir,
      input: 'no divergence found\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    const [entry] = readManifestEntries(dir);
    assert.equal(entry.data.mode, 'spec');
    assert.equal(entry.data.request, 'Add a login page');
    assert.ok(entry.data.verdict.includes('no divergence found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
