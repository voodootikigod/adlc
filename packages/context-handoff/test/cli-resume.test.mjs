import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('resume leaves the deny open and rolls back resume-auth when evidence fails', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'denier-ev');
    // Corrupt the ledger so the manifest append throws: evidence must be durable
    // before the deny flips, otherwise a failed record leaves a consumed deny
    // that nothing attests to.
    const manifestPath = join(cwd, '.adlc', 'manifest.jsonl');
    appendFileSync(manifestPath, '{not-json\n', 'utf8');

    const r = run(
      ['resume', '--session', 'consumer-ev', '--deny-session', 'denier-ev', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed to record evidence/);

    const deny = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', 'denier-ev.json'), 'utf8'),
    );
    assert.equal(deny.status, 'open', 'evidence failure must not consume the deny');
    assert.equal(
      existsSync(join(cwd, '.adlc', 'handoffs', 'consumer-ev.resume-auth.json')),
      false,
      'resume-auth must be rolled back',
    );
  });
});

test('resume writes artifacts and evidence under a non-default --dir', () => {
  withTempRepo((cwd) => {
    const ledger = join(cwd, 'nested', '.adlc');
    run(
      ['write', '--session', 'dir-denier', '--ticket', 'T155', '--dir', ledger, '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(existsSync(join(ledger, 'handoffs', 'denies', 'dir-denier.json')), true);

    const r = run(
      [
        'resume',
        '--session',
        'dir-consumer',
        '--deny-session',
        'dir-denier',
        '--dir',
        ledger,
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(r.code, 0);
    // Artifacts and evidence must land in the same tree — the split this guards
    // put denies under the repo root while the manifest followed --dir.
    assert.equal(existsSync(join(ledger, 'handoffs', 'dir-consumer.resume-auth.json')), true);
    assert.match(readFileSync(join(ledger, 'manifest.jsonl'), 'utf8'), /context-handoff-resume/);
    assert.equal(existsSync(join(cwd, '.adlc')), false, 'nothing may land outside --dir');
  });
});

test('a --dir that is not a .adlc directory is refused before any write', () => {
  withTempRepo((cwd) => {
    const r = run(
      ['write', '--session', 'dir-bad', '--ticket', 'T155', '--dir', 'ledger', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must end in "\.adlc"/);
    assert.equal(existsSync(join(cwd, 'ledger')), false);
    assert.equal(existsSync(join(cwd, '.adlc')), false);
  });
});
