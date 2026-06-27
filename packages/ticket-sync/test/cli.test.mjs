import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from '../bin/ticket-sync.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ticket-sync.mjs');

test('parseFlags: dry-run is the default (write/force/allow-rail-narrowing all false)', () => {
  const f = parseFlags([]);
  assert.equal(f.write, false);
  assert.equal(f.force, false);
  assert.equal(f['allow-rail-narrowing'], false);
  assert.equal(f.json, false);
  assert.equal(parseFlags(['--write']).write, true);
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

test('push / sync / doctor → exit 1 (not implemented yet)', () => {
  for (const sub of ['push', 'sync', 'doctor']) {
    const r = run([sub], process.cwd());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not implemented yet/);
  }
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
