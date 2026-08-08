import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLock } from '../lib/lock.mjs';
import { lockPath } from '../lib/paths.mjs';

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
    // Only true once writeDenyRecord landed — the evidence entry alone says
    // `authorized`, which is a weaker claim than a persisted consume.
    assert.equal(payload.consumePersisted, true);

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

test('resume evidence names the outcome it can actually attest', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'denier-out');
    run(['resume', '--session', 'consumer-out', '--deny-session', 'denier-out', '--write', '--json'], {
      cwd,
      env: { ADLC_MANIFEST_KEY: TEST_KEY },
    });
    const entries = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.gate === 'context-handoff-resume');
    assert.equal(entries.length, 1);
    // The entry lands before the marker flips, so it must say what it proves:
    // an aborted persist leaves `authorized` with the deny still open.
    assert.equal(entries[0].data.outcome, 'authorized');
  });
});

test('resume refuses while a live session holds the denier lock', () => {
  withTempRepo((cwd) => {
    seedDeny(cwd, 'denier-locked');
    writeLock(cwd, 'denier-locked', {
      schema: 1,
      session_id: 'denier-locked',
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: hostname(),
      nonce: 'held-by-someone-else',
    });

    const r = run(
      ['resume', '--session', 'consumer-l', '--deny-session', 'denier-locked', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY }, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /live pid/);

    const deny = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', 'denier-locked.json'), 'utf8'),
    );
    assert.equal(deny.status, 'open');
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'consumer-l.resume-auth.json')), false);
    const held = JSON.parse(readFileSync(lockPath(cwd, 'denier-locked'), 'utf8'));
    assert.equal(held.nonce, 'held-by-someone-else', "a refused resume must not drop the holder's lock");
  });
});

test('two concurrent resumes cannot both consume one deny', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-resume-race-'));
  try {
    seedDeny(cwd, 'denier-race');
    const start = (consumer) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [BIN, 'resume', '--session', consumer, '--deny-session', 'denier-race', '--write', '--json'],
          { cwd, env: { ...process.env, ADLC_MANIFEST_KEY: TEST_KEY } },
          (err) => resolve(err ? (err.code ?? 1) : 0),
        );
      });

    const codes = await Promise.all([start('race-a'), start('race-b')]);
    assert.equal(
      codes.filter((c) => c === 0).length,
      1,
      `exactly one resume may win, got ${JSON.stringify(codes)}`,
    );

    // One deny authorizes exactly one successor: the loser must not leave a
    // verified resume-auth or a second consume in the append-only manifest.
    const resumeEntries = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((e) => e.gate === 'context-handoff-resume');
    assert.equal(resumeEntries.length, 1);

    const deny = JSON.parse(
      readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', 'denier-race.json'), 'utf8'),
    );
    assert.equal(deny.status, 'consumed');
    assert.equal(deny.consumed_by, resumeEntries[0].data.consumer_session_id);
    const loser = deny.consumed_by === 'race-a' ? 'race-b' : 'race-a';
    assert.equal(
      existsSync(join(cwd, '.adlc', 'handoffs', `${loser}.resume-auth.json`)),
      false,
      'the loser must hold no resume-auth',
    );
    assert.equal(existsSync(lockPath(cwd, 'denier-race')), false, 'the lock must be released');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
