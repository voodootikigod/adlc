import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, syncFlow } from '../bin/ticket-sync.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ticket-sync.mjs');

test('parseFlags: dry-run is the default (write/force/allow-rail-narrowing all false)', () => {
  const f = parseFlags([]);
  assert.equal(f.write, false);
  assert.equal(f.force, false);
  assert.equal(f['allow-rail-narrowing'], false);
  assert.equal(f.json, false);
  assert.equal(parseFlags(['--write']).write, true);
  assert.equal(parseFlags(['--force']).force, true);
  assert.equal(parseFlags(['--allow-rail-narrowing'])['allow-rail-narrowing'], true);
});

test('syncFlow: a clean pull runs push and returns its exit code', async () => {
  let pushed = false;
  const r = await syncFlow(async () => ({ exitCode: 0, plan: [] }), async () => { pushed = true; return { exitCode: 0 }; });
  assert.equal(pushed, true, 'push runs after a clean pull');
  assert.equal(r.exitCode, 0);
});

test('syncFlow: a non-clean pull ABORTS before push (never push on an unreconciled pull)', async () => {
  let pushed = false;
  const r = await syncFlow(async () => ({ exitCode: 2, errors: ['conflict'] }), async () => { pushed = true; return { exitCode: 0 }; });
  assert.equal(pushed, false, 'push must NOT run when pull is non-clean');
  assert.equal(r.exitCode, 2, 'the pull exit code propagates');
  assert.equal(r.pushed, null);
});

test('syncFlow: push exit code propagates when pull is clean but push fails', async () => {
  const r = await syncFlow(async () => ({ exitCode: 0 }), async () => ({ exitCode: 1, errors: ['partial'] }));
  assert.equal(r.exitCode, 1);
});

/** Run the bin; return { code, stdout, stderr }. */
function run(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('no subcommand → usage, exit 1', () => {
  const r = run([], process.cwd());
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /usage: adlc ticket/);
});

test('--help → exit 0 with usage', () => {
  const r = run(['--help'], process.cwd());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pull/);
});

test('unknown subcommand → exit 1', () => {
  const r = run(['frobnicate'], process.cwd());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown subcommand/);
});

test('doctor runs read-only checks: exit 2 with a FAIL row when config is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  mkdirSync(join(dir, '.adlc'));
  try {
    const r = run(['doctor'], dir);
    assert.equal(r.code, 2, 'problems → exit 2');
    assert.match(r.stdout, /FAIL\tconfig-valid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor --json emits a machine-readable result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  mkdirSync(join(dir, '.adlc'));
  try {
    const r = run(['doctor', '--json'], dir);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed.exitCode, 'number');
    assert.ok(Array.isArray(parsed.checks));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('push / sync with no .adlc/config.json → exit 1 (operational, before any network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  mkdirSync(join(dir, '.adlc'));
  try {
    for (const sub of ['push', 'sync']) {
      const r = run([sub], dir);
      assert.equal(r.code, 1, `${sub} should exit 1 without config`);
      assert.match(r.stdout + r.stderr, /config not found/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown flag → exit 1', () => {
  const r = run(['pull', '--bogus'], process.cwd());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag/);
});

test('pull with no .adlc/config.json → exit 1 (operational, before any network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cli-'));
  mkdirSync(join(dir, '.adlc'));
  try {
    const r = run(['pull'], dir);
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /config not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
