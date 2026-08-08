import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const TEST_KEY = 'a'.repeat(64);

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
  const dir = mkdtempSync(join(tmpdir(), 'handoff-write-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEYED = { ADLC_MANIFEST_KEY: TEST_KEY };

function readDeny(cwd, session) {
  return JSON.parse(
    readFileSync(join(cwd, '.adlc', 'handoffs', 'denies', `${session}.json`), 'utf8'),
  );
}

function readFinalFile(cwd, session) {
  return JSON.parse(
    readFileSync(join(cwd, '.adlc', 'handoffs', 'finals', `${session}.json`), 'utf8'),
  );
}

test('handoff --help lists write|resume|bypass|repair|unlock', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  for (const sub of ['write', 'resume', 'bypass', 'repair', 'unlock']) {
    assert.match(stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test('write dry-run creates no files', () => {
  withTempRepo((cwd) => {
    const r = run(
      ['write', '--session', 's-write-1', '--ticket', 'T155', '--json'],
      { cwd },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.final.session_id, 's-write-1');
    assert.equal(typeof payload.final.content_hash, 'string');
    assert.ok(payload.final.content_hash.length > 0);
    assert.equal(existsSync(join(cwd, '.adlc')), false);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs')), false);
  });
});

test('write --write without key exits 1 and creates nothing durable', () => {
  withTempRepo((cwd) => {
    const r = run(
      ['write', '--session', 's-write-2', '--ticket', 'T155', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: '' }, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ADLC_MANIFEST_KEY/);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'finals', 's-write-2.json')), false);
  });
});

test('write --write creates final + deny + sentinel with key', () => {
  withTempRepo((cwd) => {
    const r = run(
      ['write', '--session', 's-write-3', '--ticket', 'T155', '--host', 'test-host', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, false);
    // A first write mints the marker at the binds it asked for, so there is
    // nothing to rebind — only a refresh that moved them reports true.
    assert.equal(payload.deny.ok, true);
    assert.equal(payload.deny.rebound, false);
    assert.equal(payload.final.schema, 1);
    assert.equal(payload.final.session_id, 's-write-3');
    assert.equal(payload.final.ticket_id, 'T155');
    assert.equal(payload.final.host, 'test-host');
    assert.ok(payload.final.content_hash);

    const finalPath = join(cwd, '.adlc', 'handoffs', 'finals', 's-write-3.json');
    const denyPath = join(cwd, '.adlc', 'handoffs', 'denies', 's-write-3.json');
    const sentinel = join(cwd, '.adlc', '.deny-store');
    assert.equal(existsSync(finalPath), true);
    assert.equal(existsSync(denyPath), true);
    assert.equal(existsSync(sentinel), true);

    const final = JSON.parse(readFileSync(finalPath, 'utf8'));
    const deny = JSON.parse(readFileSync(denyPath, 'utf8'));
    assert.equal(final.content_hash, deny.content_hash);
    assert.equal(deny.status, 'open');
    assert.equal(deny.ticket_id, 'T155');

    const manifest = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /context-handoff-write/);
  });
});

test('a refresh with a new --content-hash rebinds the deny and resume still consumes', () => {
  withTempRepo((cwd) => {
    run(['write', '--session', 's-refresh', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const first = readDeny(cwd, 's-refresh');

    const r = run(
      [
        'write',
        '--session',
        's-refresh',
        '--ticket',
        'T155',
        '--content-hash',
        'refreshed-hash',
        '--write',
        '--json',
      ],
      { cwd, env: KEYED },
    );
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).deny.rebound, true);

    // ensureDenyMarker is idempotent, so before the rebind the refreshed final
    // pointed at a hash the marker had never heard of and resume was refused
    // forever — the deny stayed open and D3-blocked every other session.
    const deny = readDeny(cwd, 's-refresh');
    assert.equal(deny.content_hash, 'refreshed-hash');
    assert.equal(deny.content_hash, readFinalFile(cwd, 's-refresh').content_hash);
    assert.equal(deny.status, 'open');
    assert.equal(deny.since, first.since, 'a rebind must not restart the deny');

    const resumed = run(
      ['resume', '--session', 'c-refresh', '--deny-session', 's-refresh', '--write', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(resumed.code, 0);
    assert.equal(readDeny(cwd, 's-refresh').status, 'consumed');
  });
});

test('write rolls back the final and the rebind when evidence fails', () => {
  withTempRepo((cwd) => {
    run(['write', '--session', 's-ev', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const denyBefore = readDeny(cwd, 's-ev');
    const finalBefore = readFinalFile(cwd, 's-ev');

    appendFileSync(join(cwd, '.adlc', 'manifest.jsonl'), '{not-json\n', 'utf8');

    const r = run(
      [
        'write',
        '--session',
        's-ev',
        '--ticket',
        'T155',
        '--content-hash',
        'unattested-hash',
        '--write',
        '--json',
      ],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed to record evidence/);

    // Un-evidenced state is un-auditable state: neither file may keep a hash
    // the manifest never attested.
    assert.deepEqual(readDeny(cwd, 's-ev'), denyBefore);
    assert.deepEqual(readFinalFile(cwd, 's-ev'), finalBefore);
  });
});

test('write removes the final it created when the first evidence append fails', () => {
  withTempRepo((cwd) => {
    // Seed a manifest that cannot be appended to, so the very first write for
    // this session fails at evidence with no prior final to restore.
    run(['write', '--session', 's-seed', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    appendFileSync(join(cwd, '.adlc', 'manifest.jsonl'), '{not-json\n', 'utf8');

    const r = run(['write', '--session', 's-fresh', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'finals', 's-fresh.json')), false);
    // The marker stays: the sentinel already names s-fresh, so deleting it
    // would trade an open deny for a D3 nobody can clear.
    assert.equal(readDeny(cwd, 's-fresh').status, 'open');
  });
});


test('a failed final write leaves an existing deny\'s binds alone', () => {
  withTempRepo((cwd) => {
    run(['write', '--session', 's-final-fail', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const denyBefore = readDeny(cwd, 's-final-fail');
    const finalPath = join(cwd, '.adlc', 'handoffs', 'finals', 's-final-fail.json');
    // Turn the final path into a directory so the atomic rename fails (EISDIR)
    // after the prior successful write — deny must not rebind ahead of that.
    unlinkSync(finalPath);
    mkdirSync(finalPath);

    const r = run(
      [
        'write',
        '--session',
        's-final-fail',
        '--ticket',
        'T155',
        '--content-hash',
        'never-landed',
        '--write',
        '--json',
      ],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed to write final/);
    assert.deepEqual(readDeny(cwd, 's-final-fail'), denyBefore);
  });
});

test('write refuses to unbind an open deny instead of wedging resume', () => {
  withTempRepo((cwd) => {
    run(['write', '--session', 's-unbind', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const before = readDeny(cwd, 's-unbind');
    const finalBefore = readFinalFile(cwd, 's-unbind');

    const r = run(['write', '--session', 's-unbind', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--ticket/);
    assert.deepEqual(readDeny(cwd, 's-unbind'), before);
    assert.deepEqual(readFinalFile(cwd, 's-unbind'), finalBefore);
  });
});

test('write refuses to refresh a consumed deny', () => {
  withTempRepo((cwd) => {
    run(['write', '--session', 's-consumed', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    run(['resume', '--session', 'c-1', '--deny-session', 's-consumed', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const consumed = readDeny(cwd, 's-consumed');
    assert.equal(consumed.status, 'consumed');

    const r = run(
      ['write', '--session', 's-consumed', '--ticket', 'T900', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /consumed/);
    assert.deepEqual(readDeny(cwd, 's-consumed'), consumed);
  });
});
