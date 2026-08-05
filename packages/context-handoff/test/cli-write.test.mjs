import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
