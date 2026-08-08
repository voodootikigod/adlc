import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLock } from '../lib/lock.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const TEST_KEY = 'd'.repeat(64);

function run(args, { cwd, env = {}, expectOk = true } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const result = {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
    if (expectOk) {
      assert.fail(`handoff ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-repair-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function denyPathFor(cwd, session) {
  return join(cwd, '.adlc', 'handoffs', 'denies', `${session}.json`);
}

function readDeny(cwd, session) {
  return JSON.parse(readFileSync(denyPathFor(cwd, session), 'utf8'));
}

function seedDeny(cwd, session, ticket = 'T155') {
  return run(['write', '--session', session, '--ticket', ticket, '--write', '--json'], {
    cwd,
    env: { ADLC_MANIFEST_KEY: TEST_KEY },
  });
}

test('repair rebinds an open deny and refreshes the final', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'rep-open');
    const before = readDeny(cwd, 'rep-open');
    assert.equal(before.status, 'open');

    const r = run(
      [
        'repair',
        '--session',
        'rep-open',
        '--ticket',
        'T900',
        '--content-hash',
        'deadbeef',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.deny.ticket_id, 'T900');
    assert.equal(payload.deny.content_hash, 'deadbeef');
    assert.equal(payload.deny.status, 'open');

    const after = readDeny(cwd, 'rep-open');
    assert.equal(after.ticket_id, 'T900');
    assert.equal(after.content_hash, 'deadbeef');
    assert.equal(after.status, 'open');
    assert.equal(after.since, before.since, 'repair must not restart the deny');

    const final = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'finals', 'rep-open.json'), 'utf8'),
    );
    assert.equal(final.ticket_id, 'T900');
    assert.equal(final.content_hash, 'deadbeef');

    const manifest = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /context-handoff-repair/);
  });
});

test('repair refuses when no deny marker exists and mints nothing', () => {
  withTempRepo((cwd) => {
    const r = run(
      [
        'repair',
        '--session',
        'rep-missing',
        '--ticket',
        'T900',
        '--content-hash',
        'deadbeef',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not create one/);
    // The regression this guards: repair used to ensureDenyMarker, arming a
    // fresh repo-wide deny from a command meant to relax one.
    assert.equal(existsSync(denyPathFor(cwd, 'rep-missing')), false);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'finals', 'rep-missing.json')), false);
    assert.equal(existsSync(join(cwd, '.adlc', 'manifest.jsonl')), false);
  });
});

test('repair refuses a consumed deny instead of reporting success', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'rep-consumed');
    run(
      ['resume', '--session', 'consumer-1', '--deny-session', 'rep-consumed', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    const consumed = readDeny(cwd, 'rep-consumed');
    assert.equal(consumed.status, 'consumed');

    const r = run(
      [
        'repair',
        '--session',
        'rep-consumed',
        '--ticket',
        'T900',
        '--content-hash',
        'deadbeef',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /consumed/);

    const after = readDeny(cwd, 'rep-consumed');
    assert.deepEqual(after, consumed, 'a consumed record must be left untouched');
  });
});

test('repair rolls back the rebind and the final when evidence fails', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'rep-ev');
    const denyBefore = readDeny(cwd, 'rep-ev');
    const finalBefore = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'finals', 'rep-ev.json'), 'utf8'),
    );
    appendFileSync(join(cwd, '.adlc', 'manifest.jsonl'), '{not-json\n', 'utf8');

    const r = run(
      ['repair', '--session', 'rep-ev', '--ticket', 'T900', '--content-hash', 'cafe', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed to record evidence/);

    // A rebind the manifest never attested is a bind nobody can audit: both
    // files go back to what the last recorded command left.
    assert.deepEqual(readDeny(cwd, 'rep-ev'), denyBefore);
    assert.deepEqual(
      JSON.parse(readFileSync(join(cwd, '.adlc', 'handoffs', 'finals', 'rep-ev.json'), 'utf8')),
      finalBefore,
    );
  });
});

test('repair refuses while a live session holds the lock', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'rep-locked');
    const before = readDeny(cwd, 'rep-locked');
    writeLock(cwd, 'rep-locked', {
      schema: 1,
      session_id: 'rep-locked',
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: hostname(),
      nonce: 'held',
    });

    const r = run(
      [
        'repair',
        '--session',
        'rep-locked',
        '--ticket',
        'T900',
        '--content-hash',
        'deadbeef',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /live pid/);
    assert.deepEqual(readDeny(cwd, 'rep-locked'), before);
  });
});

test('repair dry-run reports the existing marker and writes nothing', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'rep-dry');
    const before = readDeny(cwd, 'rep-dry');

    const r = run(
      ['repair', '--session', 'rep-dry', '--ticket', 'T900', '--content-hash', 'cafe', '--json'],
      { cwd },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.denyBinds.ticket_id, 'T900');
    assert.deepEqual(readDeny(cwd, 'rep-dry'), before);
  });
});
