import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const TEST_KEY = 'b'.repeat(64);

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
  const dir = mkdtempSync(join(tmpdir(), 'handoff-resume-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedDeny(cwd, session = 'denier-1') {
  return run(
    ['write', '--session', session, '--ticket', 'T155', '--write', '--json'],
    { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
  );
}

test('resume other-session consumes open deny and writes resume-auth', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'denier-1');
    const r = run(
      [
        'resume',
        '--session',
        'consumer-9',
        '--deny-session',
        'denier-1',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.record.status, 'consumed');
    assert.equal(payload.record.consumed_by, 'consumer-9');
    assert.equal(payload.resumeAuth.verified, true);
    assert.equal(payload.resumeAuth.deny_session_id, 'denier-1');

    const deny = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', 'denier-1.json'), 'utf8'),
    );
    assert.equal(deny.status, 'consumed');
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'consumer-9.resume-auth.json')), true);
    const manifest = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /context-handoff-resume/);
  });
});

test('resume same-session exits 2', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'same-sess');
    const r = run(
      [
        'resume',
        '--session',
        'same-sess',
        '--deny-session',
        'same-sess',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /same-session/);
    const deny = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', 'same-sess.json'), 'utf8'),
    );
    assert.equal(deny.status, 'open', 'same-session reject must not consume');
  });
});
